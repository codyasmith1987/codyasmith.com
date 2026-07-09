# Data coverage tracking — implementation plan

> **For workers:** Implement task-by-task with TDD. Tests assert against raw-CSV/fixture truth and hand-counts, NEVER against old-code output. No Claude attribution in commits/PRs/comments. Follow existing file patterns. Run `npm test` and `npm run build` before declaring a task done.

**Goal:** Store, at ingest and via backfill, an explicit per-(client, month, category) record of what the portal actually measured vs what is merely present-but-blank, and make the widgets/health page read it so missing data never reads as a measured "0 / all clear."

**Architecture:** A new `data_coverage` table, a single source-of-truth matrix module, a coverage upsert folded into the existing atomic ingest path (and the Class-B/standalone path), an aggregate-parser fix, a backfill migration, and read-layer changes.

**Spec:** `docs/superpowers/specs/2026-06-02-data-coverage-tracking-design.md` (read it; this plan pins the contracts).

---

## The coverage matrix (canonical — Task 1 encodes this exactly)

**File-present** (`measured = 1` when the format was ingested, even with 0 rows):

| category | primary table | feeding detected_format(s) |
|---|---|---|
| `crawl` | crawl_urls | crawl_internal |
| `links` | link_graph | links |
| `images` | image_urls | images |
| `redirects` | redirect_chains | redirects |
| `security` | security_urls | security_urls |
| `keywords` | keyword_rankings | position_tracking, keyword_research, keyword_suggestions |
| `ga4` | ga4_channels | ga4_traffic_acquisition, ga4_pages, ga4_tech, ga4_geography, ga4_reports_snapshot |
| `gsc` | gsc_dimensions | gsc_pages, gsc_queries, gsc_countries, gsc_devices, gsc_search_appearance, gsc_chart, gsc_filters |
| `issues` | site_issues | issues_overview, site_audit |

**Signal** (`measured = 1` only if ≥1 row has a non-NULL value in the signal columns):

| category | table | DB signal columns (backfill) | builder insert-arg indices (ingest) |
|---|---|---|---|
| `accessibility` | accessibility_urls | `all_violations`, `best_practice_violations`, `wcag_20a_violations`, `wcag_20aa_violations`, `wcag_21aa_violations` | derive from `accessibility-urls.ts` insert column order |
| `structured_data` | structured_data_urls | `error_count`, `warning_count`, `total_types` | derive from `structured-data-urls.ts` insert column order |
| `content_quality` | content_urls | `flesch_reading_ease`, `spelling_errors`, `grammar_errors`, `near_duplicate_count` | derive from `content-urls.ts` insert column order |

**Accuracy rule:** `rows_total` and `rows_measured` are computed from the builder's returned `parserStatements` (the actual deduped, filtered inserted rows) — NOT from a fresh re-parse of the raw CSV, which would over-count (the builders dedupe by URL and skip rows with no URL/hostname). `rows_total = parserStatements.length`. For signal categories, `rows_measured = count of statements where ANY signal-arg position is non-null`. The per-category arg indices are read straight from each builder's `INSERT` column list (Task 1 step 3) and locked by a fixture test, so a future column-order change fails the test rather than silently miscounting.

Formats NOT tracked: `crawl_overview`, `image_optimization` (legacy metrics writers), `issue_urls` (supplementary URL detail under `issues`), `unknown_stored`/raw-csv (catch-all). Ingest simply writes no coverage row for these.

---

## Task 1: coverage-signals.ts (source of truth) + unit test

**Files:**
- Create: `src/lib/csv/coverage-signals.ts`
- Test: `tests/run-coverage-signals-tests.mjs` (add to `package.json` `test` script, end of chain)

- [ ] **Step 1: Write failing test** asserting: every `FORMAT_TO_CATEGORY` value exists in `COVERAGE_CATEGORIES`; every signal category lists ≥1 `dbSignalColumns` and ≥1 `signalArgIndices`; build a small array of fake accessibility insert statements (matching the real arg layout) where all signal-arg positions are null → `coverageCountsFromStatements('accessibility', stmts)` returns `{rowsTotal:5, rowsMeasured:0, measured:0}`; flip one statement's `all_violations` position to `3` → `measured:1, rows_measured:1`; a statement with a literal `0` at that position counts as measured (0 is a real value, not null); `coverageCountsFilePresent(7)` → `{rowsTotal:7, rowsMeasured:7, measured:1}`; `buildCoverageUpsert(...)` SQL contains `ON CONFLICT(client_id, month, category)` and returns 8 args (source is the literal `'csv_upload'`).
- [ ] **Step 2:** Run it, confirm fail.
- [ ] **Step 3: Implement.** Exact API:

```ts
export type CoverageKind = 'file-present' | 'signal';
export interface CoverageCategory {
  category: string;
  table: string;
  kind: CoverageKind;
  dbSignalColumns?: string[];   // signal only — column names for backfill SQL
  signalArgIndices?: number[];  // signal only — positions in that category's builder INSERT args
}
export const FORMAT_TO_CATEGORY: Record<string, string>;            // matrix above
export const COVERAGE_CATEGORIES: Record<string, CoverageCategory>; // matrix above

// Counts from the builder's actual inserted statements (deduped/filtered rows).
// rowsTotal = statements.length. Signal: rowsMeasured = # statements where ANY
// signalArgIndices position is non-null; measured = rowsMeasured > 0.
// File-present: rowsMeasured = rowsTotal; measured = 1.
export function coverageCountsFromStatements(
  category: string, statements: Array<{ sql: string; args: any[] }>,
): { rowsTotal: number; rowsMeasured: number; measured: 0 | 1 };

// File-present convenience for the Class-B path (no statements array on hand).
export function coverageCountsFilePresent(rowCount: number): {
  rowsTotal: number; rowsMeasured: number; measured: 1;
};

export function buildCoverageUpsert(p: {
  clientId: string; month: string; category: string; uploadId: string;
  rowsTotal: number; rowsMeasured: number; measured: 0 | 1;
}): { sql: string; args: any[] };
```

To set `signalArgIndices`, OPEN each signal category's builder (`accessibility-urls.ts`, `structured-data-urls.ts`, `content-urls.ts`), read its `INSERT (...)` column list, and record the 0-based positions of the DB signal columns above. A fixture test locks these (a wrong index fails the hand-counted assertion).

`buildCoverageUpsert` SQL:

```sql
INSERT INTO data_coverage
  (id, client_id, month, category, measured, rows_total, rows_measured, source, csv_upload_id)
VALUES (?, ?, ?, ?, ?, ?, ?, 'csv_upload', ?)
ON CONFLICT(client_id, month, category) DO UPDATE SET
  measured = excluded.measured, rows_total = excluded.rows_total,
  rows_measured = excluded.rows_measured, csv_upload_id = excluded.csv_upload_id,
  detected_at = datetime('now')
```

(`measured` computed by the caller and passed as the 5th arg; `id` = nanoid().)
- [ ] **Step 4:** Run test, confirm pass. **Step 5:** Commit.

## Task 2: migration 056 — data_coverage table

**Files:** Create `src/lib/migrations/056-data-coverage.ts` (mirror 055's `Migration` shape).

- [ ] DDL exactly:

```sql
CREATE TABLE IF NOT EXISTS data_coverage (
  id            TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL,
  month         TEXT NOT NULL,
  category      TEXT NOT NULL,
  measured      INTEGER NOT NULL,
  rows_total    INTEGER,
  rows_measured INTEGER,
  source        TEXT,
  csv_upload_id TEXT REFERENCES csv_uploads(id),
  detected_at   TEXT DEFAULT (datetime('now')),
  UNIQUE(client_id, month, category)
);
CREATE INDEX IF NOT EXISTS idx_data_coverage_client_month ON data_coverage(client_id, month);
```
- [ ] Commit. (No standalone test; the table is exercised by Task 3/5 tests against an in-memory replica of this DDL.)

## Task 3: write coverage at ingest + tests

**Files:**
- Modify: `src/lib/csv/index.ts` (`runAtomicIngest`, the Class-A branch, the Class-B branch)
- Test: extend `tests/run-ingest-atomic-tests.mjs` (or new `tests/run-coverage-ingest-tests.mjs`)

- [ ] **`runAtomicIngest`**: add optional `coverageStatement?: { sql: string; args: any[] }`; when present, append it AFTER `parserStatements` and before `rowCountUpdate` so it runs after `uploadInsert` (FK parent exists in the same tx — same ordering lesson as the accessibility FK fix). `row_count` still = `parserStatements.length` (coverage is not a parser row).
- [ ] **Class-A branch** (`if (builder)`): after building `parserStatements`, if `FORMAT_TO_CATEGORY[format]` exists, compute `{rowsTotal, rowsMeasured, measured} = coverageCountsFromStatements(category, parserStatements)`, build the upsert with `buildCoverageUpsert`, and pass it to `runAtomicIngest` as `coverageStatement` so it commits atomically with the data.
- [ ] **Class-B branch**: after the `rowCountUpdate` execute, if `FORMAT_TO_CATEGORY[format]` exists (all Class-B tracked categories are file-present), `coverageCountsFilePresent(rowCount)` then `await turso.execute(buildCoverageUpsert(...))`. A coverage-write failure must not throw past the function (wrap in try/catch that logs, mirroring the accessibility metrics guard).
- [ ] **Tests** (in-memory libsql, FK ON, replicate csv_uploads + data_coverage + the relevant per-URL DDL):
  - Class-A accessibility, blank-violation fixture → after ingest, `data_coverage` row for `accessibility` has `rows_total=5, rows_measured=0, measured=0`, and it is in the SAME committed state as accessibility_urls (forced parser failure rolls back BOTH the data and the coverage row — no coverage without data).
  - Class-A accessibility, real-values fixture (one page "3", one "0") → `measured=1`, `rows_measured` counts pages with a real value.
  - Class-B keywords fixture → `data_coverage` row `keywords` `measured=1`, counts == inserted rows; a 0-row standalone file still yields `measured=1`.
- [ ] Run, pass, commit.

## Task 4: accessibility.ts aggregate parser — stop coercing blank to 0

**Files:** Modify `src/lib/csv/parsers/accessibility.ts`; Test: `tests/run-accessibility-aggregate-tests.mjs` (new).

- [ ] Replace `total += (row['All Violations'] || 0)` with logic that (a) ignores blank/undefined cells and (b) tracks whether ANY real numeric value was seen across the violation columns. If none were seen (free-SF blank export), write NO metrics rows (return early after the parent row exists) rather than 5 misleading zeros. If real values were seen, write the sums as today (a genuine 0 stays 0).
- [ ] Test: blank fixture → 0 metrics rows written; real-values fixture → 5 rows with correct sums; a genuine all-zero-but-measured fixture (cells literally `"0"`) → rows written with value 0 (measured-clean preserved).
- [ ] Run, pass, commit.

## Task 5: migration 057 — backfill data_coverage

**Files:** Create `src/lib/migrations/057-backfill-data-coverage.ts`; Test: `tests/run-coverage-backfill-tests.mjs` (new).

- [ ] For each category in `COVERAGE_CATEGORIES`, upsert coverage for every `(client_id, month)` it applies to, using the same matrix:
  - **file-present:** the set of `(client_id, month)` = rows present in the table UNION live `csv_uploads` rows whose `detected_format` feeds the category (so a clean 0-row upload still records `measured=1`). `rows_total=rows_measured=COUNT(*)` in the table; `measured=1`. `source='backfill'`, `csv_upload_id=NULL`.
  - **signal:** for each `(client_id, month)` with rows in the table: `rows_total=COUNT(*)`, `rows_measured=COUNT(*) WHERE (col1 IS NOT NULL OR col2 IS NOT NULL OR ...)` over `dbSignalColumns`, `measured = rows_measured>0`.
  - Upsert via the same `ON CONFLICT(client_id, month, category)` clause. Idempotent.
- [ ] Test (in-memory): seed accessibility_urls with 5 rows, all signal cols NULL → backfill yields `measured=0, rows_total=5, rows_measured=0`; seed crawl_urls rows → `crawl measured=1`; re-run backfill → no duplicate rows (upsert).
- [ ] Run, pass, commit.

## Task 6: url-insights.ts reads coverage + per-metric NULL-awareness

**Files:** Modify `src/pages/portal/api/dashboard/url-insights.ts`; extend `tests/run-accessibility-insights-tests.mjs` (+ structured/content insight tests).

- [ ] Load `data_coverage` for the client (latest month per category as today, but gate on `measured`). Replace `has_accessibility_data = !!accessibilityMonth` etc. with `has_X = coverage.measured === 1` for the three signal categories (file-present categories keep current behavior). Add a `category_coverage` block to the response: `{ accessibility: {measured, rows_total, rows_measured}, structured_data: {...}, content_quality: {...} }` so the client can render an explicit "not measured" state distinct from "measured, 0 issues."
- [ ] **Per-metric NULL-awareness** inside `content_quality` (a category can be measured overall while one sub-metric column is blank): compute each sub-metric (`near_duplicate_count`, `spelling/grammar`, `flesch`) only over rows where that column `IS NOT NULL`, and expose a per-sub-metric `measured` boolean; a sub-metric with zero non-NULL rows is `measured:false`, not `0`. (Accessibility/structured already key their counts off `> 0`; ensure they do not present a clean 0 when the category is unmeasured — covered by the category gate.)
- [ ] Tests: `measured=0` → `has_accessibility_data=false` and no "0 violations" surfaced; `measured=1` with a real 0 → "measured, 0 issues" path; content fixture with readability present but spelling blank → readability `measured:true`, spelling `measured:false` (not 0).
- [ ] Run, pass, commit.

## Task 7: health.astro renders the not-measured state

**Files:** Modify `src/pages/portal/health.astro`.

- [ ] Where the accessibility/structured/content widgets render (`if (data.has_accessibility_data)` etc.), use `category_coverage[x].measured`. When a category was provided-but-unmeasured (`rows_total>0 && !measured`), render a neutral muted line — e.g. "Accessibility wasn't included in this crawl" — NOT the green "No accessibility issues flagged" all-clear. When never provided, omit as today. Follow the no-developer-jargon and client-facing rules; no internal terms.
- [ ] Manual-render sanity: build clean; the empty-state branch compiles. Commit.

## Final: suite + build + ship

- [ ] `npm test` fully green; `npm run build` clean.
- [ ] PR → main; merge; deploy to ACTIVE.
- [ ] Post-deploy READ-ONLY prod check: `data_coverage` for Raised Bar Group shows `accessibility measured=0` after backfill (or absent if never provided), and crawl/links/etc. `measured=1`. Confirm the health page no longer implies a clean accessibility result. Report counts; do not write to prod beyond the migration's own backfill.

## Non-goals (unchanged from spec)

No score-component change this build (hook only). No manufacturing of accessibility data. No page-count/detector/supersession-key changes.
