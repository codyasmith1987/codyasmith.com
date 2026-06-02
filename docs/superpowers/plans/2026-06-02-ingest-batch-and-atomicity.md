# Ingest Batch + Atomicity Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Each parser task is gated by a row-parity test.

**Goal:** Convert all CSV parsers from per-row network round-trips to real `turso.batch()` inserts (fix the 524 timeout), make supersede-class parsers' clear+insert atomic (fix half-write + race), proven by per-parser row-parity tests.

**Architecture:** `turso.batch([{sql,args},...], 'write')` sends many statements in one round-trip (proven pattern, `crawl-overview.ts:190-194` and migration 001). Class-B (self-dedup) parsers swap `Promise.all(chunk.map(execute))` for batched `turso.batch`. Class-A (supersede) parsers are refactored to RETURN `{sql,args}[]` so `ingestCSV` runs supersede+delete+insert+parser-rows+rowcount in ONE atomic transaction per file.

**Tech Stack:** Astro SSR + TypeScript, Turso/libsql (remote; `turso.execute` / `turso.batch`), tsx `.mjs` tests with `node:assert` + in-memory `@libsql/client`.

**Canonical transform (apply everywhere a parser does inserts):**
```typescript
// BEFORE (per-row round-trips — the bug):
for (let i = 0; i < inserts.length; i += BATCH_SIZE) {
  const chunk = inserts.slice(i, i + BATCH_SIZE);
  await Promise.all(chunk.map(args => turso.execute({ sql, args })));
}
// AFTER (one round-trip per ~100 statements):
const statements = inserts.map(args => ({ sql, args }));
for (let i = 0; i < statements.length; i += 100) {
  await turso.batch(statements.slice(i, i + 100), 'write');
}
```

**Row-parity test pattern (every parser task uses this):** spin up `createClient({ url: 'file::memory:?cache=shared' })`, create the target table, run the parser against a real sample CSV (committed fixtures in `src/data/raised-bar-f3-csvs/`), then assert the resulting table rows (count + every column value, order-independent) equal a hard-coded expected set derived by reading the sample CSV by hand. The test proves the batch path writes exactly what the data says — independent of the implementation.

---

## File Structure

- `src/lib/csv/parsers/_bulk-insert.ts` — Class-B chokepoint; rewrite `bulkInsert` to `turso.batch`. (Task 1)
- `src/lib/csv/parsers/{ga4,gsc}.ts` — Class-B; their local `bulkInsert` → `turso.batch`; fix `gsc.parseGscFilters` per-row loop; fix `ga4.splitIntoBlocks` per-line parse. (Tasks 2-3)
- `src/lib/csv/parsers/{links,issue-urls,raw-csv}.ts` — Class-B; route inserts through batch. (Task 4)
- `src/lib/csv/parsers/{crawl-internal,content-urls,security-urls,structured-data-urls,accessibility-urls,images,redirects}.ts` — Class-A; refactor to export a `build…Statements()` that RETURNS `{sql,args}[]`, keep a thin executing wrapper for back-compat. (Tasks 5-7)
- `src/lib/csv/index.ts` — `ingestCSV`: Class-A path assembles one `turso.batch` transaction (supersede+delete+csv_uploads insert+parser stmts+rowcount); remove catch-and-restore for Class A. (Task 8)
- `src/pages/portal/api/csv/upload.ts` — concurrency limiter (~5 parallel files); trim `ingestWithRetry`. (Task 9)
- `tests/run-*-parity-tests.mjs` — one per parser. (within each task)

---

## Task 1: `_bulk-insert.ts` → turso.batch (Class-B chokepoint)

**Files:** Modify `src/lib/csv/parsers/_bulk-insert.ts`; Test `tests/run-bulk-insert-parity-tests.mjs`

- [ ] **Step 1: Write the failing parity test**

```javascript
import assert from 'node:assert';
import { createClient } from '@libsql/client';
import { bulkInsert } from '../src/lib/csv/parsers/_bulk-insert.ts';
let passed=0, failed=0;
async function test(n,f){try{await f();console.log(`[PASS] ${n}`);passed++}catch(e){console.error(`[FAIL] ${n}: ${e.message}`);failed++}}

await test('bulkInsert writes all rows via batch, exact values', async () => {
  const db = createClient({ url: 'file::memory:?cache=shared' });
  await db.execute(`CREATE TABLE t (a TEXT, b INTEGER)`);
  // bulkInsert uses the module turso singleton; inject the test db.
  const sql = `INSERT INTO t (a,b) VALUES (?,?)`;
  const rows = Array.from({length: 250}, (_,i) => [`k${i}`, i]);
  await bulkInsert(sql, rows, db); // db arg added in Step 3
  const out = await db.execute(`SELECT a,b FROM t ORDER BY b`);
  assert.strictEqual(out.rows.length, 250);
  assert.strictEqual(out.rows[0].a, 'k0');
  assert.strictEqual(Number(out.rows[249].b), 249);
});
console.log(`\n${passed}/${passed+failed} passed`); if(failed>0) process.exit(1);
```

- [ ] **Step 2: Run, verify it fails** — `npx tsx tests/run-bulk-insert-parity-tests.mjs` → FAIL (bulkInsert has no db param / still Promise.all).

- [ ] **Step 3: Rewrite `_bulk-insert.ts`**

```typescript
import turso from '../../turso';

// One network round-trip per BATCH_CHUNK statements via turso.batch (remote
// libsql). Replaces the old Promise.all(chunk.map(execute)) which did one
// round-trip PER ROW — a 2,118-row export was ~43 round-trips and 524'd.
export const BATCH_CHUNK = 100;

export async function bulkInsert(
  sql: string,
  allArgs: any[][],
  db: typeof turso = turso,
): Promise<void> {
  const statements = allArgs.map(args => ({ sql, args }));
  for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
    await db.batch(statements.slice(i, i + BATCH_CHUNK), 'write');
  }
}
```
(The optional `db` param defaults to the prod singleton; tests inject in-memory. All existing callers pass `(sql, allArgs)` unchanged.)

- [ ] **Step 4: Run, verify pass** — `npx tsx tests/run-bulk-insert-parity-tests.mjs` → `1/1 passed`.

- [ ] **Step 5: Wire into suite + full run** — append `&& tsx tests/run-bulk-insert-parity-tests.mjs` to `package.json` test script; `npm test` green.

- [ ] **Step 6: Commit** — `git add src/lib/csv/parsers/_bulk-insert.ts tests/run-bulk-insert-parity-tests.mjs package.json && git commit -m "perf: bulkInsert uses turso.batch (one round-trip per 100 rows)"`

---

## Task 2: `ga4.ts` — batch + single-parse splitIntoBlocks

**Files:** Modify `src/lib/csv/parsers/ga4.ts`; Test `tests/run-ga4-parity-tests.mjs`

- [ ] **Step 1: Write parity test** — feed `src/data/raised-bar-f3-csvs/` GA4 fixture if present, else a hand-built GA4 reports-snapshot string covering 2+ blocks; assert `ga4_topline`/`ga4_channels` rows match hand-derived expected counts+values. (Use the in-memory db pattern; import the parse fn with an injected db — add a `db` param mirroring Task 1.)

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** — (a) replace the local `bulkInsert` (ga4.ts ~48-53) body with the same `turso.batch` loop from Task 1 (or import the shared `bulkInsert`); (b) in `splitIntoBlocks` (~69-123) replace the per-line `Papa.parse` calls with a single `Papa.parse(raw, {header:false})` then iterate `result.data`. Show the full replaced functions in the implementer prompt.

- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Suite + commit** — `perf: ga4 parser batches inserts + single-parse block split`

---

## Task 3: `gsc.ts` — batch + fix parseGscFilters per-row loop

**Files:** Modify `src/lib/csv/parsers/gsc.ts`; Test `tests/run-gsc-parity-tests.mjs`

- [ ] **Step 1: Parity test** — feed a GSC dimensions fixture + a filters fixture; assert `gsc_dimensions` and `gsc_filters` rows match hand-derived expected.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** — (a) local `bulkInsert` → `turso.batch`; (b) `parseGscFilters` (~148-166): replace `for (const row…) await turso.execute(…)` with accumulate-then-`turso.batch`.
- [ ] **Step 4: Verify pass.** **Step 5: Suite + commit** — `perf: gsc parser batches inserts incl. filters`

---

## Task 4: `links.ts`, `issue-urls.ts`, `raw-csv.ts` — Class-B batch

**Files:** Modify the three; Tests `tests/run-links-parity-tests.mjs`, `run-issue-urls-parity-tests.mjs`, `run-raw-csv-parity-tests.mjs`

- [ ] **Step 1: Parity tests** — `links.ts`: feed `all_outlinks.csv` fixture, assert `link_graph` row count == data rows and source_file/destination/anchor preserved. `issue-urls.ts`: feed `h1_missing.csv`-style fixture, assert `site_issue_urls` by issue_name. `raw-csv.ts`: feed an unknown CSV, assert `raw_csv_data` stores it by filename.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** — each: replace its `Promise.all(chunk.map(execute))` with the canonical `turso.batch` loop. `issue-urls.ts` keeps its DELETE-by-issue_name (single stmt) then batches inserts. `links.ts` keeps DELETE-by-source_file then batches. Preserve all dedup keys exactly.
- [ ] **Step 4: Verify pass.** **Step 5: Suite + commit** — `perf: links/issue-urls/raw-csv parsers batch inserts`

---

## Task 5: Class-A — `crawl-internal.ts` returns statements

**Files:** Modify `src/lib/csv/parsers/crawl-internal.ts`; Test `tests/run-crawl-internal-parity-tests.mjs`

- [ ] **Step 1: Parity test** — feed the real `src/data/raised-bar-f3-csvs/internal_all.csv` (477 rows); assert `buildCrawlInternalStatements(...)` returns statements that, when run via `db.batch`, produce `crawl_urls` rows whose count and key columns (url, status_code, content_type, indexability) match a hand-derived expected (e.g. 477 rows; the 5 real-user-page URLs present with status 200/html/indexable).

- [ ] **Step 2: Verify fail.**

- [ ] **Step 3: Implement** — split the parser into a pure builder + thin executor:
```typescript
// Pure: parse raw -> array of INSERT statements. No DB.
export function buildCrawlInternalStatements(
  raw: string, clientId: string, month: string, uploadId: string,
): Array<{ sql: string; args: any[] }> {
  // ... existing parse logic up to building `inserts: any[][]` ...
  const sql = `INSERT INTO crawl_urls (...) VALUES (...)`; // unchanged column list
  return inserts.map(args => ({ sql, args }));
}
// Back-compat executor for any direct caller (executes via batch).
export async function parse(raw, clientId, month, uploadId): Promise<number> {
  const stmts = buildCrawlInternalStatements(raw, clientId, month, uploadId);
  for (let i = 0; i < stmts.length; i += 100) await turso.batch(stmts.slice(i, i+100), 'write');
  return stmts.length;
}
```

- [ ] **Step 4: Verify pass.** **Step 5: Suite + commit** — `refactor: crawl-internal returns statements (atomic-ingest ready)`

---

## Task 6: Class-A URL parsers return statements

**Files:** Modify `content-urls.ts`, `security-urls.ts`, `structured-data-urls.ts`, `accessibility-urls.ts`; Tests one parity file each.

- [ ] Per parser, mirror Task 5: add `build<Name>Statements(raw, clientId, month, uploadId) => {sql,args}[]` (pure), keep `parse(...)` as a thin batch executor calling it. accessibility-urls keeps BOTH its outputs — note that the aggregate `parseAccessibility` (metrics) is separate and stays Class-B-batched; only the per-URL `accessibility_urls` builder returns statements.
- [ ] Parity test each against its F3 fixture (`content_all.csv`, `security_all.csv`, `structured_data_all.csv`, `accessibility_all.csv`): assert row count + key columns match hand-derived expected.
- [ ] Verify fail→pass; suite; commit per parser — `refactor: <name> returns statements`.

---

## Task 7: Class-A `images.ts` + `redirects.ts` return statements

**Files:** Modify both; parity test each (`images` via an images fixture, `redirects` via `redirects.csv`).

- [ ] Same builder+executor split as Task 5. redirects is Class-A because it clears a slice. Assert `image_urls` / `redirect_chains` parity. Verify fail→pass; suite; commit — `refactor: images/redirects return statements`.

---

## Task 8: `ingestCSV` atomic transaction for Class-A

**Files:** Modify `src/lib/csv/index.ts`; Test extend `tests/run-supersession-key-tests.mjs` + new `tests/run-ingest-atomic-tests.mjs`

- [ ] **Step 1: Write atomicity test** — in-memory db with csv_uploads + crawl_urls + ux index; simulate a Class-A ingest where the parser statements include one that VIOLATES a constraint (forcing batch failure); assert that after the failed `db.batch`, the PRIOR upload's rows are still present (no half-write) and no new live row exists. Then a success case: prior superseded, new rows present, exactly one live upload, row_count correct.

- [ ] **Step 2: Verify fail** (current code does separate executes, would leave a half-write).

- [ ] **Step 3: Implement** — for Class-A formats, replace the sequence (clearPreviousData → INSERT csv_uploads → parser execute → UPDATE rowcount) with assembling one statement array and a single `turso.batch([...], 'write')`:
  - supersede UPDATE(s) for the prior live row of this key,
  - per-table DELETE(s) of the prior upload's rows,
  - INSERT csv_uploads (new live row),
  - ...`build<Name>Statements(...)` spread in,
  - UPDATE csv_uploads SET row_count, processed_at.
  Run as one atomic batch. On caught error, return `{error}` — no manual restore needed (batch rolled back). Class-B formats keep their current path (parser self-executes via batch). Map format→builder so the switch dispatches Class-A to the transaction path. Show the full assembled-array code in the implementer prompt.

- [ ] **Step 4: Verify pass** (both atomicity + existing supersession tests). **Step 5: Suite + commit** — `feat: atomic per-file ingest transaction for supersede-class parsers`

---

## Task 9: `upload.ts` concurrency limiter + trim retry

**Files:** Modify `src/pages/portal/api/csv/upload.ts`; Test `tests/run-upload-concurrency-tests.mjs`

- [ ] **Step 1: Test** — unit-test a small `mapLimit(items, limit, fn)` helper: assert it never runs more than `limit` concurrently (track an in-flight counter, max observed ≤ limit) and processes all items.
- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Implement** — add a tiny `mapLimit` (no new dep) and wrap the batch processing: `await mapLimit(files, 5, file => processOne(...))` instead of `Promise.allSettled(files.map(...))`. Keep result aggregation. Since Task 8 makes the race impossible for Class-A and Class-B self-dedups, `ingestWithRetry` is no longer load-bearing: reduce it to a single attempt OR keep one retry as cheap insurance — implementer decides per a code comment, but remove the multi-retry backoff loop. Document the change in the stale 196-205 comment.
- [ ] **Step 4: Verify pass.** **Step 5: Suite + build + commit** — `perf: cap upload file concurrency at 5; drop multi-retry now that ingest is atomic`

---

## Task 10: Ship + verify (gated on Cody)

- [ ] PR to main (no attribution), merge, deploy, confirm ACTIVE + migrations unchanged (no new migration in this plan).
- [ ] **Post-deploy ZKH ingest:** Cody (or CC via browser-equivalent) uploads the June scrape folder `C:\Users\codya\OneDrive - Cody A Smith LLC\Projects\Zip Kit Homes\June\Screaming frog scrape june 1` through the real `/portal/admin/csv` tool (now fast). Confirm it completes WITHOUT a 524.
- [ ] **Read-only verification:** `crawl_urls` for ZKH ≈ 477; `page_count` == **62** (the independent hand-count oracle); the three per-URL widgets populate. Show Cody the before(25)/after(62) page_count and confirm the band stays Ecosystem B (≤150) = no pricing change, before anything locks.

---

## Notes / guardrails
- No new migration. No change to page-count definition, detector, or supersession key (already correct).
- No Claude/AI attribution on commits/PR.
- Nothing touches Raised Bar proposal / raised_bar files.
- Every parser task is gated by a row-parity test that proves batch output == data, against real fixtures — this is the safety net for money-adjacent (page_count) data.
- `turso.batch(..., 'write')` is atomic (proven: migration 001 uses batch); a failed statement rolls back the batch, which is why Class-A no longer needs catch-and-restore.
