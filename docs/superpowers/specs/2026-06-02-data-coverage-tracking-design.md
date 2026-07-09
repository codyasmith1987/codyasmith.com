# Data coverage tracking — design

Date: 2026-06-02
Status: design, pre-plan

## Problem (proven this session)

The portal cannot tell "we measured this and it is clean (0)" apart from "we never measured this." Concretely:

- Free Screaming Frog exports `accessibility_all.csv` with the page rows present but every violation column blank. The per-URL parser correctly stores those as NULL, but two layers collapse NULL into a measured zero:
  - The aggregate parser `accessibility.ts` does `total += (row['All Violations'] || 0)`, turning blank into 0, and writes `accessibility_pages_audited = rowCount`. Result stored for F3: "audited 5 pages, 0 violations" = looks perfect, was never measured.
  - The widget (`url-insights.ts`) gates on rows-exist (`has_accessibility_data = !!accessibilityMonth`) and computes `total_violations = COALESCE(SUM(all_violations), 0)`. Five NULL rows render as "0 violations across all pages."
- The same shape exists for `structured_data` (`COALESCE(SUM(error_count),0)`). `content_quality` is half-right (readability checks `IS NOT NULL`, but spelling/grammar coalesce to 0).
- Today the composite `score.ts` does NOT consume these three categories, so score-inflation is a *future* risk (when they get wired in under the dashboard-as-hub lens). It already implements the correct discipline for its four current components ("any component lacking upload data EXCLUDED rather than zeroed") — that is the template.

The portal's thesis is to parse and hold everything. The corollary chosen here: the portal must also hold, as first-class data, **what it did and did not measure** — not re-derive it from NULLs at read time.

## Decision (Cody)

1. Explicit coverage flag, stored at ingest, not inferred at read time.
2. Track coverage for **every ingestable category**, so the portal holds a complete measured-vs-missing map.

## Architecture

### New table `data_coverage`

One row per `(client_id, month, category)`.

```sql
CREATE TABLE data_coverage (
  id            TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL,
  month         TEXT NOT NULL,
  category      TEXT NOT NULL,        -- canonical category key (see matrix below)
  measured      INTEGER NOT NULL,     -- 1 = the measurement ran and produced values; 0 = present-but-unmeasured OR not provided
  rows_total    INTEGER,              -- rows/pages seen for this category this month
  rows_measured INTEGER,              -- rows/pages with at least one real (non-blank) signal value
  source        TEXT,                 -- 'csv_upload' now; 'audit_engine' later
  csv_upload_id TEXT REFERENCES csv_uploads(id),
  detected_at   TEXT DEFAULT (datetime('now')),
  UNIQUE(client_id, month, category)
);
```

`measured = (rows_measured > 0) ? 1 : 0`. Keeping the counts (not just the boolean) lets surfaces say "measured 3 of 5 pages" and gives the future audit engine and monthly reports an honest coverage record.

### How "measured" is defined per category

"Measured" is category-specific. Two families, and the distinction matters for correctness:

**File-present family** — `measured = 1` whenever the file/format for this category was ingested this month, *even with zero data rows*. A redirect export with no rows means "we looked, there are no redirects" (clean), not "not measured." Keying these off row existence would wrongly hide a clean result.

| Category (key) | Table | Measured when | Notes |
|---|---|---|---|
| `crawl` | crawl_urls | crawl file ingested | foundational |
| `links` | link_graph | links file ingested | 0 rows = no links found, still measured |
| `images` | image_urls | images file ingested | 0 rows = no images, still measured |
| `redirects` | redirect_chains | redirects file ingested | 0 rows = no redirects, clean |
| `keywords` | keyword_rankings | file ingested | standalone upload |
| `ga4` | ga4_channels | file ingested | standalone upload |
| `gsc` | gsc_chart | file ingested | standalone upload |
| `issues` | site_issues | file ingested | standalone; already feeds score |

For this family `rows_measured = rows_total = inserted count`, and `measured = 1` because the file was provided.

**Signal-column family** — the file rows can be present while the actual measurement did not run (free SF exports the page list but leaves the analysis columns blank). `measured = 1` only if at least one row has a real value in the signal column(s).

| Category (key) | Table | Signal column(s) | Notes |
|---|---|---|---|
| `accessibility` | accessibility_urls | `all_violations`, any `wcag_*`, `best_practice_violations` | axe integration is paid; free SF leaves blank |
| `structured_data` | structured_data_urls | `error_count`, `warning_count`, `total_types` | validation vs bare extraction |
| `content_quality` | content_urls | `flesch_reading_ease`, `spelling_errors`, `grammar_errors`, `near_duplicate_count` | paid content analysis; word_count alone does NOT count |

For this family `rows_measured = COUNT(rows where any signal column IS NOT NULL)`; `measured = rows_measured > 0`. Two states collapse to `measured = 0` — "file present but blank columns" (free-SF accessibility) and "file never provided." The client sees the same neutral "not measured" surface either way; `rows_total` (0 vs >0) preserves the internal distinction. The `content_quality` signal set is the one most worth Cody confirming, since it depends on which content columns free SF actually populates.

A single source-of-truth module (`src/lib/csv/coverage-signals.ts`) holds the matrix: `category -> { table, format, kind: 'file-present' | 'signal', signalColumns?: string[] }`. Ingest, backfill, and every reader import it so the definition never drifts (same lesson as the page-count SQL consolidation).

### Written at ingest, atomically

Coverage is written by `ingestCSV` for the category of the format it just ingested (it already knows `detected_format`, which maps to a category via `coverage-signals.ts`). The upsert is `INSERT ... ON CONFLICT(client_id, month, category) DO UPDATE`.

- **Class-A (supersede) formats:** the coverage upsert is built as an additional `{sql,args}` statement folded into the existing per-file `turso.batch([...], 'write')`, so coverage commits in the same transaction as the data it describes and can never disagree with it. The parser walks every row anyway; it returns `rows_total` and `rows_measured` (signal-family parsers count rows with a non-blank signal column; file-present parsers set `rows_measured = rows_total`).
- **Standalone formats (keywords, ga4, gsc, issues):** coverage is written on their own write path. File-present family → `measured = 1`, `rows_total = rows_measured = inserted count`, even when the file had zero data rows (file provided = measured).

`measured = (kind === 'file-present') ? 1 : (rows_measured > 0 ? 1 : 0)`.

### Read everywhere

- `url-insights.ts`: replace each `has_X_data = !!xMonth` with a `data_coverage` lookup → `measured`. When `measured = 0`, return the empty/`not_measured` state and a flag the client renders as "not included in this crawl" (distinct from "measured, 0 issues"). When `measured = 1`, real counts flow, and a legitimate `0` reads as a clean measured result.
- `health.astro`: render the neutral "not measured" state for `measured = 0` categories instead of a zero/clean chip.
- `score.ts`: unchanged for now (does not consume these categories). When accessibility/structured/content are later added as score components, each reads `data_coverage.measured` and returns `available: false` when unmeasured — mirroring the four existing components. Out of scope for this build; noted so the hook is obvious.

### Aggregate parser fix (`accessibility.ts`)

Stop `|| 0`-coercing blanks. Sum only non-blank cells; track whether any real value was seen. If nothing real was measured, do not write the misleading `_total_violations = 0` / `_pages_audited = N` rows (write nothing, or NULL). This parser's metrics may feed monthly reports, so the misleading zeros must not persist regardless of the widget fix.

### Backfill migration

A migration recomputes `data_coverage` for every existing `(client_id, month, category)` using the same `coverage-signals.ts` matrix. "Provided this month" is established from `csv_uploads` (a live row for the category's format) joined with the data table, so a clean zero-row upload still records `measured = 1`:

- **File-present categories:** `measured = 1` for each `(client, month)` that has a live `csv_uploads` row for the format (or rows in the table); `rows_total = rows_measured = COUNT(*)` in the table.
- **Signal categories:** `rows_total = COUNT(*)`, `rows_measured = COUNT(*) WHERE <signal columns> IS NOT NULL`, `measured = rows_measured > 0`.

Idempotent (upsert on the unique key). This gives historical uploads an honest coverage record and immediately corrects F3's accessibility from "0 violations" to "not measured."

## Error handling

Coverage statements ride inside the existing atomic batch (Class-A) or the standalone format's own write; no new failure surface. If a category produces no rows at all, no coverage row is written for it that month (absence == not provided), which the readers treat identically to `measured = 0` with `rows_total = 0`. The backfill is read-then-upsert and safe to re-run.

## Testing — against raw truth, not old code

- `coverage-signals.ts`: unit test the matrix (every category maps to a real table + valid columns).
- Per category, feed a real sample CSV and assert `rows_total` / `rows_measured` / `measured` match a hand-count of the fixture:
  - F3 `accessibility_all.csv` (blank violations) → `rows_total = 5`, `rows_measured = 0`, `measured = 0`.
  - A synthesized accessibility file with real "0" and positive values → `measured = 1`, and a legit-0 page counts as measured.
  - `structured_data` and `content_quality` fixtures: blank vs populated.
  - A standalone upload (keywords/ga4) → `measured = 1`, counts == inserted rows.
- Ingest atomicity test: a Class-A file writes its data AND its coverage row in one batch; a forced parser failure rolls back both (no coverage row without data, no data without coverage).
- Backfill test: seed per-URL rows with mixed NULL/real signals in-memory, run the recompute, assert coverage matches.
- `url-insights` test: `measured = 0` returns the not-measured state (not "0 violations"); `measured = 1` with a real 0 returns "0, clean."
- Full suite green; `npm run build` clean.
- Post-deploy READ-ONLY prod check: F3 (Raised Bar Group) accessibility coverage reads `measured = 0` after backfill, and the widget no longer implies a clean accessibility result.

## Sequence (for the plan)

1. `coverage-signals.ts` matrix + unit test.
2. Migration: create `data_coverage` + indexes.
3. Coverage computation at ingest (Class-A into the atomic batch; standalone formats on their own write) + parity tests per category.
4. Aggregate parser (`accessibility.ts`) fix + test.
5. Backfill migration from existing tables + test.
6. `url-insights.ts` reads coverage; not-measured state + test.
7. `health.astro` renders the not-measured state.
8. Full suite + build; ship via PR; merge; deploy.
9. Post-deploy read-only prod verification (F3 accessibility = not measured).

## Non-goals

- No change to the composite score components in this build (they do not consume these categories yet). The reader hook is specified so the later wiring is trivial.
- No new ingestion of real accessibility data (free SF cannot produce it); this build makes absence honest, it does not manufacture data.
- No change to the page-count definition, detector, or supersession key.
