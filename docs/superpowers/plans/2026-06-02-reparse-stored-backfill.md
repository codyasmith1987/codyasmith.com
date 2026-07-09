# Reparse-stored backfill

Goal: move data that's sitting in `raw_csv_data` (uploaded as `unknown_stored` before a parser existed) into typed tables, for ALL clients/months, by re-running each stored file through the current detector + ingest. Non-destructive, idempotent, chunked. This is what pulls ZipKit's existing canonicals/directives/page-weight/sitemaps (and any other client's) out of raw storage now that the parsers exist.

`raw_csv_data` stores the full verbatim CSV in `raw_text` (confirmed), so reparse needs no re-upload.

## Core: `src/lib/csv/reparse-stored.ts`

```
export interface ReparseSummary { processed: number; retyped: Array<{filename, format, rows}>; skippedUnknown: number; errors: Array<{filename, error}>; }

export async function reparseStoredChunk(
  db,                  // libsql client (prod singleton in the endpoint; injected in tests)
  opts: { limit: number; offset: number },
  ingestFn = ingestCSV,   // injectable for tests
): Promise<ReparseSummary>
```
Logic per chunk:
1. `SELECT id, client_id, month, filename, raw_text, csv_upload_id FROM raw_csv_data ORDER BY created_at LIMIT ? OFFSET ?`.
2. For each row: `const { format } = detectFormat(raw_text, filename)`.
   - `format === 'unknown'` -> skippedUnknown++ (still no parser; leave as-is).
   - else (now typed) -> `await ingestFn(raw_text, client_id, month, filename, 'reparse-backfill')` (writes the typed table + a new csv_uploads row of the real format + recomputes coverage via the standard ingest path), then supersede the OLD unknown_stored upload row: `UPDATE csv_uploads SET error = 'Reparsed into <format>' WHERE id = <csv_upload_id> AND error IS NULL`. retyped.push(...).
   - Wrap each row in try/catch -> errors.push on failure, continue (one bad row never stops the chunk).
3. Return the summary.

Non-destructive: `raw_csv_data` rows are KEPT (raw preserved). Idempotent: a re-run re-detects an already-typed file, re-ingests (the typed path supersedes its own prior upload by key — no dupes), and the unknown_stored UPDATE is a no-op the second time (already errored). The "Stored, not yet visualized" UI reads the csv_uploads row's `detected_format`; superseding it removes the file from that display.

## Trigger: admin endpoint + button (recurring tool)

- `src/pages/portal/api/admin/csv/reparse-stored.ts`: admin-only (role check), session + CSRF (mirror `clear-superseded.ts` / `clear-failed.ts`). Accepts `{ offset, limit }` (default limit 25), calls `reparseStoredChunk(turso, {offset, limit})`, returns the summary + a `total` count of raw_csv_data rows so the client knows when to stop. Chunked so each request stays well under Cloudflare's 100s.
- `src/pages/portal/admin/csv.astro`: a "Reparse stored files" button in the admin tools row (next to Clear superseded / Clear failed). On click it loops `reparse-stored` in chunks (like the upload loop), accumulating the summary, and shows progress + a final tally (X retyped, Y still unknown). Recurring by design — re-run it whenever new parsers ship.

## Tests `tests/run-reparse-stored-tests.mjs`

In-memory libsql + an injected spy `ingestFn`:
- A stored `canonicals_all.csv` raw row (real header) -> `reparseStoredChunk` calls ingestFn with format-routable raw, and supersedes its unknown_stored upload row (error set).
- A stored `pagespeed_all.csv` raw row (still unknown) -> skippedUnknown, ingestFn NOT called, upload row untouched.
- Idempotency: a second pass over an already-retyped row does not double-supersede (the UPDATE `WHERE error IS NULL` no-ops) and does not error.
- A row whose ingestFn throws -> recorded in errors[], loop continues.
Assert against hand-reasoned truth. (End-to-end raw->typed-table population is validated by the prod run + a read-only check after, per local-tests-don't-validate-prod.)

## Run (after build, after Cody's go — broad prod write across all clients)
Trigger the reparse in chunks, then read-only verify: ZipKit `canonical_urls`/`directive_urls`/`page_weight_urls`/`sitemap_urls` now populated, and those files no longer show as `unknown_stored`. Report what moved out of raw storage per client.

## Out of scope
Surfacing widgets for the 4 new tables (deferred, dashboard-as-hub lens).
