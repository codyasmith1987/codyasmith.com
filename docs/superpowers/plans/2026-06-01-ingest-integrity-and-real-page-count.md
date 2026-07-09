# Ingest Integrity + Real-User-Page-Count Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CSV ingest preserve every uploaded file's data (no sibling-file cannibalization), and make ONE real-user-page definition the single source feeding multi-site pricing, validated against the F3=6 / ZKH=70 benchmarks.

**Architecture:** Three coupled fixes. (1) Change `clearPreviousData`'s supersession key from `(client,month,format)` to `(client,month,format,original_name)` so re-uploading a filename replaces only that file's rows while distinct sibling files coexist — mirrors the proven `issue_urls`/`links` per-key dedup. This makes `crawl_urls` hold the complete URL superset again. (1b) Make each file's supersede+insert ATOMIC by wrapping `clearPreviousData` + the parser's writes in a single libsql transaction (`turso.batch`/`transaction`), so the concurrent batch processing in `upload.ts` (`Promise.allSettled`) cannot interleave a SELECT→DELETE→INSERT across two writers for the same key. This is the robust fix for the residual concurrency race (chosen over a blunt UNIQUE index, which would reject legitimate re-uploads since the model keeps historical upload rows with latest-wins). (2) Replace the loose `text/html`-only page count in `syncPerSitePageCounts` (the pricing input) with the strict real-user-page filter already proven in `crawl-read.ts` (status 200 + html + indexable, minus taxonomy/utility/noindex URL patterns), extracted into one shared SQL helper so pricing, dashboard, and report all use the identical definition.

**Tech Stack:** Astro SSR + TypeScript, Turso/libSQL (`turso.execute`), tsx test runner (`.mjs` + `node:assert`).

**Benchmarks (pass/fail oracle, from `reference_real_user_page_count`):** f3properties.com = 6 real user pages; zipkithomes.com = 70. The page-count filter is correct only if it reproduces these against the real crawl data.

---

## File Structure

- **Modify:** `src/lib/csv/index.ts` — `clearPreviousData` signature + WHERE clause + the two call sites. Core data-integrity fix.
- **Create:** `src/lib/csv/page-count-sql.ts` — shared SQL fragments `realUserPageRowFilters()` + `realUserPageUrlExclusions(col)`, the single definition of a real user page. (Extracted so crawl-read.ts, client-sites.ts, and crawl-stats.ts cannot drift.)
- **Modify:** `src/lib/crawl-read.ts` — `getNavigablePageCount` uses the shared helper (behavior identical; removes the duplicate inline copy).
- **Modify:** `src/lib/client-sites.ts` — `syncPerSitePageCounts` uses the shared helper grouped by hostname, replacing the loose `text/html`-only count. This is the money fix.
- **Create:** `tests/run-page-count-sql-tests.mjs` — unit tests for the pure SQL-builder helpers (string-shape assertions, no DB).
- **Create:** `tests/run-supersession-key-tests.mjs` — unit test for the key behavior using a throwaway in-memory libsql DB (the repo ships `@libsql/client`, which supports `file::memory:`).
- **Modify:** `package.json` — add both test files to the `test` chain.

No migration. No schema change. The crawl superset is captured by the existing per-URL insert once the key fix stops the wipe.

---

## Task 1: Per-filename supersession key (data-integrity root fix)

**Files:**
- Modify: `src/lib/csv/index.ts` (clearPreviousData ~78-110; call sites ~143 and ~162)
- Test: `tests/run-supersession-key-tests.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/run-supersession-key-tests.mjs`. It builds a tiny in-memory DB with the two columns `clearPreviousData` reads, seeds two DIFFERENT filenames of the same format, and asserts the function only clears the matching filename. Because `clearPreviousData` is not exported, this test imports it via a thin re-export added in Step 3; until then it fails on import.

```javascript
import assert from 'node:assert';
import { createClient } from '@libsql/client';

let passed = 0, failed = 0;
function test(name, fn) {
  return fn().then(() => { console.log(`[PASS] ${name}`); passed++; })
    .catch(err => { console.error(`[FAIL] ${name}: ${err.message}`); failed++; });
}

// __clearPreviousDataForTest is a test-only re-export of the private
// clearPreviousData, parameterized to accept a db handle so we can run
// it against an in-memory libsql instance (no prod, no network).
const { __clearPreviousDataForTest } = await import('../src/lib/csv/index.ts');

async function seed() {
  const db = createClient({ url: 'file::memory:?cache=shared' });
  await db.execute(`CREATE TABLE csv_uploads (id TEXT PRIMARY KEY, client_id TEXT, original_name TEXT, detected_format TEXT, month TEXT, row_count INTEGER, error TEXT, created_at TEXT DEFAULT (datetime('now')))`);
  await db.execute(`CREATE TABLE crawl_urls (id TEXT PRIMARY KEY, client_id TEXT, csv_upload_id TEXT, month TEXT, url TEXT)`);
  return db;
}

await test('clearPreviousData clears only the SAME filename, leaving sibling files intact', async () => {
  const db = await seed();
  // internal_all.csv prior upload with 3 rows
  await db.execute({ sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month) VALUES ('up_all','c1','internal_all.csv','crawl_internal','2026-05')`, args: [] });
  for (const u of ['a','b','c']) await db.execute({ sql: `INSERT INTO crawl_urls (id, client_id, csv_upload_id, month, url) VALUES (?, 'c1','up_all','2026-05', ?)`, args: [`r_${u}`, `https://x/${u}`] });
  // internal_html.csv prior upload with 1 row
  await db.execute({ sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month) VALUES ('up_html','c1','internal_html.csv','crawl_internal','2026-05')`, args: [] });
  await db.execute({ sql: `INSERT INTO crawl_urls (id, client_id, csv_upload_id, month, url) VALUES ('r_h','c1','up_html','2026-05','https://x/h')`, args: [] });

  // Simulate re-uploading internal_html.csv (new upload id 'up_html2').
  await db.execute({ sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month) VALUES ('up_html2','c1','internal_html.csv','crawl_internal','2026-05')`, args: [] });
  await __clearPreviousDataForTest(db, 'c1', '2026-05', 'crawl_internal', 'internal_html.csv', 'up_html2');

  const all = await db.execute(`SELECT COUNT(*) FROM crawl_urls WHERE csv_upload_id='up_all'`);
  const html = await db.execute(`SELECT COUNT(*) FROM crawl_urls WHERE csv_upload_id='up_html'`);
  assert.strictEqual(Number(all.rows[0][0]), 3, 'internal_all.csv rows MUST survive (different filename)');
  assert.strictEqual(Number(html.rows[0][0]), 0, 'prior internal_html.csv rows should be cleared (same filename)');
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx tsx tests/run-supersession-key-tests.mjs`
Expected: FAIL on import — `__clearPreviousDataForTest` is not exported yet.

- [ ] **Step 3: Implement the key change + test seam**

In `src/lib/csv/index.ts`, change `clearPreviousData` to accept `filename` and a `db` handle (defaulting to the module `turso`), and add `original_name` to the WHERE clause. Replace the existing function (lines ~78-110) with:

```typescript
async function clearPreviousData(
  clientId: string,
  month: string,
  format: string,
  filename: string,
  currentUploadId: string,
  db: typeof turso = turso,
): Promise<string | null> {
  const config = FORMAT_SOURCES[format];
  if (!config) return null;

  // Find previous uploads for this client+month+format+FILENAME (not the
  // current one). Keying on original_name is what lets sibling files of the
  // same detected_format (e.g. internal_all.csv vs internal_html.csv, or the
  // 60+ accessibility_*.csv per-issue files) coexist instead of wiping each
  // other. Mirrors the per-key dedup proven for issue_urls (by issue_name)
  // and links (by source_file).
  const prevUploads = await db.execute({
    sql: 'SELECT id FROM csv_uploads WHERE client_id = ? AND month = ? AND detected_format = ? AND original_name = ? AND id != ? ORDER BY created_at ASC',
    args: [clientId, month, format, filename, currentUploadId],
  });

  if (prevUploads.rows.length === 0) return null;

  const prevIds = prevUploads.rows.map(r => r[0] as string);
  const latestPrevId = prevIds[prevIds.length - 1];
  for (const table of config.tables) {
    await db.execute({
      sql: `DELETE FROM ${table} WHERE client_id = ? AND month = ? AND csv_upload_id = ?`,
      args: [clientId, month, latestPrevId],
    });
  }

  await db.execute({
    sql: 'UPDATE csv_uploads SET error = ? WHERE id = ?',
    args: ['Superseded by newer upload', latestPrevId],
  });

  return latestPrevId;
}

// Test-only seam: lets the unit test exercise clearPreviousData against an
// in-memory libsql db without prod. Not used in app code.
export async function __clearPreviousDataForTest(
  db: typeof turso, clientId: string, month: string, format: string, filename: string, currentUploadId: string,
): Promise<string | null> {
  return clearPreviousData(clientId, month, format, filename, currentUploadId, db);
}
```

Then update BOTH call sites to pass `filename` (the `filename` param already in scope in `ingestCSV`):
- the `unknown` branch call (~line 143): `await clearPreviousData(clientId, month, 'unknown_stored', filename, uploadId);`
- the main branch call (~line 162): `const clearedUploadId = await clearPreviousData(clientId, month, format, filename, uploadId);`

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx tsx tests/run-supersession-key-tests.mjs`
Expected: `1/1 passed`, exit 0.

- [ ] **Step 5: Add to the suite and run full tests**

In `package.json`, append ` && tsx tests/run-supersession-key-tests.mjs` to the end of the `test` script. Run `npm test`. Expected: full suite passes.

- [ ] **Step 6: Commit**

```bash
git add src/lib/csv/index.ts tests/run-supersession-key-tests.mjs package.json
git commit -m "fix: per-filename supersession key so sibling CSV uploads stop wiping each other"
```

---

## Task 1b: DB-enforced single-live-upload invariant (robust concurrency fix)

**Why DB-enforced, not an app lock:** `upload.ts` processes the batch with `Promise.allSettled` (concurrent). An in-process mutex would not hold if DO App Platform runs more than one instance. A partial UNIQUE index makes the database itself reject a second *live* upload for the same key — correct under any concurrency or instance count. It does NOT use a plain UNIQUE (which would reject legitimate re-uploads); the model keeps historical rows, so the index only constrains rows that are NOT superseded/errored.

**Files:**
- Create: `src/lib/migrations/055-csv-uploads-live-unique.ts`
- Modify: `src/lib/csv/index.ts` (the `ingestCSV` supersede+insert ordering)
- Test: extend `tests/run-supersession-key-tests.mjs`

- [ ] **Step 1: Write the failing test (concurrent same-filename ingest keeps exactly one live upload)**

Append to `tests/run-supersession-key-tests.mjs` a case that creates the partial unique index, then attempts two INSERTs of the same `(client,month,format,original_name)` with `error IS NULL` and asserts the second fails:

```javascript
await test('partial unique index allows one LIVE upload per key, rejects a second live duplicate', async () => {
  const db = await seed();
  await db.execute(`CREATE UNIQUE INDEX ux_csv_uploads_live ON csv_uploads (client_id, month, detected_format, original_name) WHERE error IS NULL`);
  await db.execute({ sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month) VALUES ('u1','c1','internal_all.csv','crawl_internal','2026-05')`, args: [] });
  let rejected = false;
  try {
    await db.execute({ sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month) VALUES ('u2','c1','internal_all.csv','crawl_internal','2026-05')`, args: [] });
  } catch { rejected = true; }
  assert.ok(rejected, 'second LIVE upload of same key must be rejected by the partial unique index');
  // After superseding u1 (set error), a new live row IS allowed (re-upload works):
  await db.execute(`UPDATE csv_uploads SET error='Superseded by newer upload' WHERE id='u1'`);
  await db.execute({ sql: `INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month) VALUES ('u3','c1','internal_all.csv','crawl_internal','2026-05')`, args: [] });
  const live = await db.execute(`SELECT COUNT(*) FROM csv_uploads WHERE client_id='c1' AND original_name='internal_all.csv' AND error IS NULL`);
  assert.strictEqual(Number(live.rows[0][0]), 1, 'exactly one live upload after supersede + re-upload');
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx tsx tests/run-supersession-key-tests.mjs`
Expected: FAIL (no index creation in the seed yet / behavior not implemented). It defines the target invariant.

- [ ] **Step 3: Write the migration**

Create `src/lib/migrations/055-csv-uploads-live-unique.ts`. It first DEDUPES existing rows (supersede all-but-newest per key so the index can be created on dirty prod data — the F3 bundle already has duplicate live rows), then creates the partial unique index:

```typescript
import turso from '../turso';
import type { Migration } from '../migrate';

// Enforce: at most ONE live (non-superseded, non-errored) csv_uploads row
// per (client_id, month, detected_format, original_name). Historical
// superseded/errored rows are unconstrained (kept for audit). This makes
// the per-filename supersession invariant DB-enforced, so the concurrent
// batch upload path cannot create two live duplicates for the same key.
const migration: Migration = {
  id: '055-csv-uploads-live-unique',
  async up() {
    // 1. Dedupe existing LIVE duplicates: keep the newest per key, mark the
    //    rest superseded. Without this, creating the unique index on dirty
    //    data (e.g. the F3 bundle's repeated uploads) would fail.
    await turso.execute(`
      UPDATE csv_uploads
         SET error = 'Superseded by newer upload'
       WHERE error IS NULL
         AND id NOT IN (
           SELECT id FROM (
             SELECT id,
                    ROW_NUMBER() OVER (
                      PARTITION BY client_id, month, detected_format, original_name
                      ORDER BY created_at DESC, id DESC
                    ) AS rn
             FROM csv_uploads
             WHERE error IS NULL
           ) WHERE rn = 1
         )
    `);
    // 2. Partial unique index: only constrains live rows.
    await turso.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_csv_uploads_live
      ON csv_uploads (client_id, month, detected_format, original_name)
      WHERE error IS NULL
    `);
  },
};

export default migration;
```

(Note: dedup here only marks the upload rows superseded; it does NOT delete child data. Child rows are reconciled by the Task 6 re-ingest. This migration's job is solely to make the index creatable and the invariant enforced going forward.)

- [ ] **Step 4: Make `ingestCSV` supersede-before-insert so re-uploads don't trip the index**

In `src/lib/csv/index.ts`, the current order is: INSERT new csv_uploads row (line ~131) THEN `clearPreviousData` (which marks the PRIOR row superseded). With the partial unique index, inserting the new live row BEFORE the prior is superseded would violate the index. Reorder so the prior live row of the same key is superseded FIRST, then insert the new row. Replace the top of `ingestCSV` (the initial INSERT + later clear) so the sequence is:

```typescript
  const { format, headers } = detectFormat(raw, filename);
  const uploadId = nanoid();

  // Supersede any prior LIVE upload of this exact key BEFORE inserting the
  // new row, so the partial unique index (migration 055) is never violated
  // by a legitimate re-upload. Also clears the prior upload's child rows for
  // formats in FORMAT_SOURCES (per-filename key from Task 1).
  await supersedePriorLiveUpload(clientId, month, format, filename);

  await turso.execute({
    sql: 'INSERT INTO csv_uploads (id, client_id, original_name, detected_format, month, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)',
    args: [uploadId, clientId, filename, format, month, uploadedBy],
  });
```

where `supersedePriorLiveUpload` folds in the Task 1 clearing logic (mark prior live row(s) of this key superseded + delete their child rows for FORMAT_SOURCES formats). This MERGES the Task 1 `clearPreviousData` into the pre-insert step. Keep the existing failure-path cleanup (the `catch` that deletes the new upload's partial rows and un-supersedes on error) intact, adjusted to the new ordering. If a concurrent duplicate still races to INSERT, the index throws a UNIQUE violation; catch it and return a clean per-file error (`'A concurrent upload of this file is already being processed'`) rather than a 500 — the losing writer simply yields, no data corruption.

- [ ] **Step 5: Run the test + full suite**

Run: `npx tsx tests/run-supersession-key-tests.mjs` (expect all cases pass), then `npm test` (full suite green), then `npm run build`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/migrations/055-csv-uploads-live-unique.ts src/lib/csv/index.ts tests/run-supersession-key-tests.mjs
git commit -m "fix: DB-enforce one live csv_upload per filename key (atomic supersede-before-insert)"
```

---

## Task 2: Shared real-user-page SQL definition (single source)

**Files:**
- Create: `src/lib/csv/page-count-sql.ts`
- Test: `tests/run-page-count-sql-tests.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/run-page-count-sql-tests.mjs`:

```javascript
import assert from 'node:assert';
import { realUserPageRowFilters, realUserPageUrlExclusions } from '../src/lib/csv/page-count-sql.ts';

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); console.log(`[PASS] ${name}`); passed++; } catch (e) { console.error(`[FAIL] ${name}: ${e.message}`); failed++; } }

test('realUserPageRowFilters enforces 200 + html + indexable', () => {
  const s = realUserPageRowFilters('cu');
  assert.match(s, /cu\.status_code = 200/);
  assert.match(s, /cu\.content_type.*LIKE '%html%'/);
  assert.match(s, /cu\.indexability.*!= 'non-indexable'/);
});

test('realUserPageRowFilters with no prefix targets bare columns', () => {
  const s = realUserPageRowFilters('');
  assert.match(s, /status_code = 200/);
  assert.doesNotMatch(s, /\.\s*status_code/); // no stray "<dot>status_code"
});

test('realUserPageUrlExclusions covers taxonomy + utility + pagination', () => {
  const s = realUserPageUrlExclusions('url');
  for (const frag of ['/tag/', '/category/', '/author/', '/feed', '/wp-content/', '/wp-admin/', '/wp-json/', '?paged=', '/page/[0-9]']) {
    assert.ok(s.includes(frag), `missing exclusion: ${frag}`);
  }
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx tsx tests/run-page-count-sql-tests.mjs`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the shared helper**

Create `src/lib/csv/page-count-sql.ts` with the EXACT filter currently in `crawl-read.ts` (this is the definition memory confirms yields F3=6), now parameterized by column prefix so any caller — pricing, dashboard, report — uses one definition:

```typescript
// THE single definition of a "real user page": a published destination a
// human navigates to. status 200 + text/html + indexable, minus taxonomy,
// utility/system, attachment, and pagination URLs. This is the count WM
// ecosystem routing / pricing MUST use (benchmarks: f3=6, zipkit=70).
// Extracted so crawl-read.ts (dashboard/report) and client-sites.ts
// (pricing) cannot drift to different definitions.

// Row-level predicates. `prefix` is an optional table alias (e.g. 'cu').
export function realUserPageRowFilters(prefix = ''): string {
  const p = prefix ? `${prefix}.` : '';
  return `
    AND ${p}status_code = 200
    AND LOWER(IFNULL(${p}content_type, '')) LIKE '%html%'
    AND LOWER(IFNULL(${p}indexability, '')) != 'non-indexable'
  `;
}

// URL-pattern exclusions. `col` is the fully-qualified url column (e.g.
// 'url' or 'cu.url').
export function realUserPageUrlExclusions(col: string): string {
  return `
    AND ${col} NOT LIKE '%/tag/%'
    AND ${col} NOT LIKE '%/category/%'
    AND ${col} NOT LIKE '%/author/%'
    AND ${col} NOT LIKE '%/feed/%'
    AND ${col} NOT LIKE '%/feed'
    AND ${col} NOT LIKE '%/embed/%'
    AND ${col} NOT LIKE '%/embed'
    AND ${col} NOT LIKE '%/attachment/%'
    AND ${col} NOT LIKE '%/wp-content/%'
    AND ${col} NOT LIKE '%/wp-includes/%'
    AND ${col} NOT LIKE '%/wp-admin/%'
    AND ${col} NOT LIKE '%/wp-json/%'
    AND ${col} NOT LIKE '%/cdn-cgi/%'
    AND ${col} NOT LIKE '%?attachment_id=%'
    AND ${col} NOT LIKE '%?attachment=%'
    AND ${col} NOT LIKE '%?replytocom=%'
    AND ${col} NOT LIKE '%?p=%'
    AND ${col} NOT LIKE '%?paged=%'
    AND ${col} NOT GLOB '*/page/[0-9]*'
  `;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `npx tsx tests/run-page-count-sql-tests.mjs`
Expected: `3/3 passed`.

- [ ] **Step 5: Add to the suite**

In `package.json`, append ` && tsx tests/run-page-count-sql-tests.mjs` to the `test` script. Run `npm test`. Expected: full suite passes.

- [ ] **Step 6: Commit**

```bash
git add src/lib/csv/page-count-sql.ts tests/run-page-count-sql-tests.mjs package.json
git commit -m "feat: shared single-source real-user-page SQL definition"
```

---

## Task 3: Point crawl-read.ts at the shared definition (no behavior change)

**Files:**
- Modify: `src/lib/crawl-read.ts` (the inline `urlPatternExclusions` + `pageRowFilters` ~38-68, and `getNavigablePageCount` ~137-150)

- [ ] **Step 1: Replace the inline copies with imports**

At the top of `src/lib/crawl-read.ts` add:
```typescript
import { realUserPageRowFilters, realUserPageUrlExclusions } from './csv/page-count-sql';
```
Delete the local `function urlPatternExclusions(col)` (lines ~38-60) and `function pageRowFilters(prefix)` (lines ~61-68). Update `getNavigablePageCount`'s query to call the shared helpers:

```typescript
export async function getNavigablePageCount(clientId: string, month?: string): Promise<number> {
  const monthClause = month ? 'AND month = ?' : '';
  const args = month ? [clientId, month] : [clientId];
  const res = await turso.execute({
    sql: `SELECT COUNT(DISTINCT url) AS n
          FROM crawl_urls
          WHERE client_id = ?
          ${monthClause}
          ${realUserPageRowFilters()}
          ${realUserPageUrlExclusions('url')}`,
    args,
  });
  return (res.rows[0]?.[0] as number) || 0;
}
```
If any OTHER function in `crawl-read.ts` referenced the deleted local `pageRowFilters`/`urlPatternExclusions`, point it at the imported names too (grep the file for both names before finishing; replace every call).

- [ ] **Step 2: Build to confirm it compiles**

Run: `npm run build`
Expected: clean build, no TS errors (the deleted locals must have no remaining references).

- [ ] **Step 3: Run full tests**

Run: `npm test`. Expected: full suite passes (contract-render / report suites that exercise crawl-read stay green; the filter string is byte-identical so counts are unchanged).

- [ ] **Step 4: Commit**

```bash
git add src/lib/crawl-read.ts
git commit -m "refactor: crawl-read uses the shared real-user-page definition"
```

---

## Task 4: Fix the pricing page count (the money fix)

**Files:**
- Modify: `src/lib/client-sites.ts` (`syncPerSitePageCounts` ~275-316)

- [ ] **Step 1: Replace the loose count with the shared strict definition, grouped by hostname**

The current query counts ALL `text/html` rows with no exclusions — overcounting and contradicting its own comment. Replace the `turso.execute` query inside `syncPerSitePageCounts` (the SELECT at ~279-286) with the shared real-user-page definition, grouped by hostname:

```typescript
    const result = await turso.execute({
      sql: `SELECT hostname, COUNT(DISTINCT url) as cnt
            FROM crawl_urls
            WHERE client_id = ?
            ${realUserPageRowFilters()}
            ${realUserPageUrlExclusions('url')}
            GROUP BY hostname`,
      args: [clientId],
    });
```

Add the import at the top of `src/lib/client-sites.ts`:
```typescript
import { realUserPageRowFilters, realUserPageUrlExclusions } from './csv/page-count-sql';
```

Update the comment above `syncPerSitePageCounts` so it matches the code (it currently claims it excludes resources, which the old SQL did NOT do):
```typescript
// Auto-bind per-site page_count from uploaded crawl data using the SINGLE
// real-user-page definition (page-count-sql.ts): status 200 + html +
// indexable, minus taxonomy/utility/noindex URLs. This is the pricing input
// for WM ecosystem routing, so it MUST match the dashboard/report count and
// the F3=6 / ZipKit=70 benchmarks — NOT a raw "text/html rows" count.
```

Leave the existing `UPDATE client_sites ... page_count` overwrite-guard logic (lines ~296-313) unchanged — it only controls when a stored value is replaced, not how the count is derived.

- [ ] **Step 2: Build to confirm it compiles**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 3: Run full tests**

Run: `npm test`
Expected: full suite passes. (Note: `client-sites-sync` tests may assert the old loose behavior — if a test now fails because it expected the loose count, update that test's expectation to the strict definition and note it; do NOT revert the fix. Report any such test in the commit.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/client-sites.ts
git commit -m "fix: pricing page_count uses the real-user-page definition, not loose text/html count"
```

---

## Task 5: Benchmark validation (the pass/fail oracle) — read-only, gated

**Files:** none (verification task; produces a report, not code)

- [ ] **Step 1: After Tasks 1-4 are merged + deployed, re-ingest F3 and verify**

This step requires the supersession-key fix to be LIVE and the F3 bundle re-ingested (Task 6 repopulation). Once done, read-only verify against benchmarks:
- Via the admin schema-diagnostic endpoint (read-only GET), confirm Raised Bar `crawl_urls_total` is the full crawl (~94 all-URL rows), not 13.
- Compute the real-user-page count for f3properties.com and zipkithomes.com using `getNavigablePageCount` (or the same SQL) and assert: **f3properties.com == 6, zipkithomes.com == 70.**
- If either misses, the filter is wrong — STOP and reconcile against the Yoast sitemap (`page-sitemap.xml` + `post-sitemap.xml` `<loc>` counts) before trusting pricing. Do NOT adjust benchmarks to match code.

- [ ] **Step 2: Record the result**

Append the verified numbers to `docs/audits/ingest-and-pagecount-root-findings-2026-06-01.md` under a "Benchmark verification" heading. No commit of code; this is the evidence the fix is correct.

---

## Task 6: SOP-compliant repopulation of Raised Bar (no manual SQL)

**Files:** none (operational; uses existing endpoints). Gated on Tasks 1-4 deployed.

- [ ] **Step 1: Confirm the cascade question before deleting anything**

Read migrations 030/031/034/036/041 for the per-URL tables. Confirm whether deleting a `csv_uploads` row cascades to its child rows. If NO cascade exists, do NOT rely on delete-upload to clean child rows — the re-ingest must overwrite by the new per-filename key instead. Record the finding.

- [ ] **Step 2: Re-ingest the F3 bundle with the fix live**

Use the EXISTING ingest endpoint with `force=true` (the bundle ingest at `raised-bar-f3-ingest.ts`, exposed via its admin endpoint). With Task 1 live, re-ingesting processes every bundle file and they no longer wipe each other (per-filename key). NO manual SQL. This is scoped to `raised-bar-group` only (the ingest is hard-scoped to that client slug).

- [ ] **Step 3: Re-sync domains + page counts via existing admin endpoints**

Call the existing admin sites sync (`POST /portal/api/admin/clients/sites` action=sync, and the per-site page-count sync path) for raised-bar-group so `client_sites.page_count` recomputes from the now-complete crawl using the strict definition.

- [ ] **Step 4: Verify (feeds Task 5)**

Read-only diagnostic: Raised Bar `crawl_urls_total` ~94; real-user-page count for f3properties.com == 6; the three widgets (accessibility/structured/content) now populate for Raised Bar. Confirm no other client was touched.

---

## Notes / guardrails
- No manual prod SQL anywhere (SOP). Repopulation uses existing `force` re-ingest + admin sync endpoints only.
- No data discarded: the fix preserves all uploaded data by keying on filename; `crawl_urls` holds the URL superset; real-user-pages are derived.
- No Claude/AI attribution on any commit or PR.
- Nothing touches the Raised Bar PROPOSAL or any `raised_bar_*` file (off-limits); this touches the ingest + page-count pipeline only.
- Parser backlog (PageSpeed etc.) and scoring enrichment are explicitly OUT of this plan — separate slices once integrity + page-count are solid.
