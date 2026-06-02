# Ingest performance + atomicity refactor — design

Date: 2026-06-02
Status: approved (design), pre-plan

## Problem (proven by the 2026-06-02 full ingest audit)

The CSV ingest pipeline does **per-row network round-trips** to Turso (a remote libsql DB). Every parser except `crawl-overview.ts` inserts via `Promise.all(chunk.map(args => turso.execute({sql, args})))` with `BATCH_SIZE=50` — that is N concurrent single-row round-trips, not a batch. Quantified:
- `all_outlinks.csv` (8013 rows) = ~161 round-trips for one file.
- A 22MB Screaming Frog folder (~30k rows across link/url files) + per-file overhead (clearPreviousData SELECT + per-table DELETE + supersede UPDATE + csv_uploads INSERT + row_count UPDATE, none coalesced) ≈ **~12,000 round-trips**. At ~100ms each, that exceeds Cloudflare's 100s origin window → **524 timeout**. This is why the ZKH 155-file upload failed.

Secondary issues the audit found:
- The supersede→insert→parse sequence in `ingestCSV` is **not atomic**: if a parser throws after `clearPreviousData` deleted the prior rows, the client is left with old data gone and new data not written (half-write). Today this is patched by a catch-and-restore + an `ingestWithRetry` band-aid for the unique-index race.
- `upload.ts` processes up to 50 files per request via `Promise.allSettled` with no concurrency cap → can fire thousands of concurrent round-trips at once.

## Goal

1. **Speed:** a real SF folder (22MB, ~30k rows) ingests well under 100s. Every parser stops per-row round-trips and uses real `turso.batch([...], 'write')` (one round-trip per ~100 statements). `turso.batch` is already proven in-codebase (migration 001).
2. **No data loss:** every parseable row lands; nothing silently dropped (parse-everything rule).
3. **No half-write:** a file that fails mid-parse leaves the prior data intact (atomic clear+insert+parse for the parser class that clears-then-replaces).
4. **No race:** concurrent same-key files cannot collide; the `ingestWithRetry` band-aid is removed once atomicity makes the race impossible.
5. **Maintainable:** one batch pattern, applied consistently.

## Architecture: two parser classes by requirement

The parsers fall into two behavioral classes with genuinely different correctness needs. Do not force one uniform mechanism.

### Class A — supersede-class (clear-then-replace a table slice per upload)
`crawl_internal` (crawl_urls), `content_urls`, `security_urls`, `structured_data_urls`, `accessibility` (accessibility_urls), `images` (image_urls), `redirects` (redirect_chains).

These are in `FORMAT_SOURCES`; `clearPreviousData` deletes the prior upload's slice before they insert. Requirement #3 (no half-write) demands their **clear + insert be atomic**. Refactor: each Class-A parser is changed to **return** its rows as `{sql, args}[]` statements (a "build statements, don't execute" contract) instead of executing them. `ingestCSV` then assembles ONE `turso.batch([...], 'write')` transaction per file containing: the supersede UPDATE(s) + the per-table DELETE(s) + the csv_uploads INSERT + the parser's INSERT statements + the row_count UPDATE. All-or-nothing. This makes the half-write impossible and the unique-index race impossible.

### Class B — self-dedup class (key their own data, incremental)
`links` (by source_file), `issue_urls` (by issue_name), `raw-csv` (by filename), `keyword_research` / `keyword_suggestions` / `position_tracking` (keyword_rankings, via `_bulk-insert.ts`), `ga4_*`, `gsc_*`.

These are deliberately OUT of the format-level supersede sweep (they DELETE by their own key inside the parser) and do not hit the unique-index race. They need speed (#1) but NOT the transaction rework. Refactor: they keep executing their own writes but via real `turso.batch()` instead of `Promise.all`. The shared `_bulk-insert.ts` helper is the chokepoint for keyword/ga4/gsc/issue-urls — fixing it upgrades all of them; the others swap their local `Promise.all` for a batch helper. Signatures unchanged.

## Components

- **`src/lib/csv/parsers/_bulk-insert.ts`** — rewrite `bulkInsert` to use `turso.batch([...], 'write')` chunked at ~100 statements. Single change upgrades all Class-B helper consumers.
- **Each Class-B parser** (`links.ts`, `issue-urls.ts`, `redirects.ts` if it stays B, `ga4.ts`, `gsc.ts`, keyword parsers, `raw-csv.ts`) — ensure inserts route through batch; fix `gsc.ts` `parseGscFilters` sequential per-row loop; fix `ga4.ts` `splitIntoBlocks` per-line `Papa.parse` (single parse, iterate).
- **Each Class-A parser** (`crawl-internal.ts`, `content-urls.ts`, `security-urls.ts`, `structured-data-urls.ts`, `accessibility-urls.ts`, `images.ts`, and `redirects.ts` — redirects clears a slice so it is Class A) — refactor to a `build*Statements(...) => {sql,args}[]` function. Keep a thin wrapper that executes (for any direct caller / the F3 ingest path) but the primary path returns statements to `ingestCSV`.
- **`src/lib/csv/index.ts` `ingestCSV`** — for Class-A formats, assemble and run one `turso.batch` transaction per file (supersede + delete + csv_uploads insert + parser statements + row_count). Remove the now-unnecessary catch-and-restore for these. Class-B path stays as-is (parser self-executes via batch).
- **`src/pages/portal/api/csv/upload.ts`** — add a concurrency limiter (~5 files in parallel) around the `Promise.allSettled`; remove `ingestWithRetry` once the race is gone (or keep as a thin belt-and-suspenders — decided in plan).
- **`src/lib/raised-bar-f3-ingest.ts`** — verify it still works with the new parser contract (it calls `ingestCSV`, so it inherits the fix).

## Error handling

`turso.batch([...], 'write')` is atomic: any failing statement rolls back the whole batch. So a parse/insert failure leaves the prior data intact with no manual restore. This is strictly simpler and safer than the current catch-and-restore + retry. The `accessibility` branch (which runs two parsers, aggregate metrics + per-URL) folds both parsers' statements into the one transaction.

## Testing — row-parity per parser (the safety net)

For EACH parser, a test feeds a real sample CSV (use the committed F3 bundle files in `src/data/raised-bar-f3-csvs/` and the ZKH June scrape as fixtures where possible) and asserts the rows written via the NEW batch path are byte-identical to what the OLD per-row path produced: same row count, same column values, same order-independent set. Run against an in-memory libsql DB so no prod. This catches conversion bugs (dropped rows, wrong arg order, off-by-one, wrong column) before they touch real client data — critical because crawl_urls feeds page_count feeds pricing.

Plus: full existing suite green, `npm run build` clean, and a post-deploy READ-ONLY ZKH verification (after the upload: crawl_urls ≈ 477, page_count == 62, the three per-URL widgets populate). Per "local tests don't validate prod," the ZKH check is what closes it.

## Sequence (for the plan)

1. `_bulk-insert.ts` → `turso.batch` + its row-parity test (unblocks keyword/ga4/gsc/issue-urls Class B).
2. Remaining Class-B parsers self-batch + `gsc`/`ga4` hotspot fixes + their parity tests.
3. Class-A parsers refactored to return statements + parity tests.
4. `ingestCSV` transaction orchestration for Class A; remove catch-and-restore.
5. `upload.ts` concurrency limiter; remove/trim `ingestWithRetry`.
6. Full suite + build; ship via PR.
7. Post-deploy: ingest ZKH June scrape; verify counts (read-only) before confirming pricing impact.

## Non-goals

- No move to a background-job/async server model — the audit confirmed batch inserts + concurrency limiting bring a 22MB folder to ~15-30s, comfortably under 100s. Async is the audit-engine effort, out of scope here.
- No change to the page-count definition, the detector, or the supersession KEY (already correct from prior work). This is purely the write-path performance + atomicity.
- No new parsers / no unknown_stored backlog work (separate slice).

## Open decisions (resolve in plan or with Cody)

1. `turso.batch` chunk size: 100 statements/batch to start, benchmark-tunable.
2. Concurrency limiter value: start at 5 parallel files.
3. Whether to fully delete `ingestWithRetry` or keep it as a thin no-op-in-practice safety net once atomicity lands. Lean: remove it, since keeping a band-aid for an impossible case is dead code — but confirm the F3 bundle path (which also calls ingestCSV) is covered.
