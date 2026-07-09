# F3 / Raised Bar ingest format-collision — findings

Date: 2026-06-01
Status: investigation complete, NO code changed yet (per Cody: findings before code)

## TL;DR

Raised Bar's per-URL tables (`crawl_urls`, `accessibility_urls`, `content_urls`, `structured_data_urls`) are empty or wrong because the F3 Screaming Frog bundle contains many CSVs that the detector classifies as the *same* format, and the ingest's `clearPreviousData()` makes each upload of a format wipe the prior one's rows. The files process alphabetically, so a small/filtered/header-only sibling usually processes last and wins, leaving the authoritative `*_all.csv` data deleted. This is the same bug class the codebase already fixed for `crawl_internal` (filename guard) and `issue_urls`/`links` (omit from FORMAT_SOURCES) — three later per-URL formats just never got the guard.

This is NOT the date/widget fix shipped in PR #251 (that made parsed-but-clean data visible). This is the deeper reason Raised Bar specifically shows nothing.

## Proven root cause

1. **Format collision.** Per-issue and filtered SF exports carry the same column signatures as the per-URL `*_all.csv` files, so `detectFormat` classifies them identically. Verified by replaying the real detector over the real bundle (`src/data/raised-bar-f3-csvs/`):
   - `accessibility`: 61 files. `accessibility_all.csv` = 5 data rows; 60 per-issue siblings = 0 data rows (header-only).
   - `content_urls`: 13 files. `content_all.csv` = 12 rows; `internal_images.csv` (a filtered internal export) = 52 rows, also matches the content signature.
   - `structured_data_urls`: 12 files. `structured_data_all.csv` is the real one; 11 siblings.
   - `crawl_internal`: 2 files. `internal_all.csv` = 94 rows (full crawl), `internal_html.csv` = 13 rows (HTML-only subset). Both pass the existing `isAuthoritativeCrawlInternalFilename` guard.
   - (Also seen: `site_audit` 52, `redirects` 3 — adjacent collisions.)

2. **`clearPreviousData` wipes the prior upload of the same format** (`src/lib/csv/index.ts:78-110`). It deletes rows belonging to the most-recent prior upload of that `client+month+format`, then the current file inserts its own. Across N same-format files, the table ends holding only the **last-processed** file's rows.

3. **Processing order is alphabetical** (`raised-bar-f3-ingest.ts:59`, `.sort(([a],[b]) => a.localeCompare(b))`). So the alphabetically-last file of each colliding format wins.

4. **Fingerprint confirmation (crawl):** `internal_all.csv` sorts before `internal_html.csv` (`a` < `h`), so `internal_html.csv` (13 rows) processes last and wins. The prod diagnostic showed Raised Bar `crawl_urls_total = 13` — an exact match. For accessibility, the alphabetically-last file is a 0-row per-issue sibling → table ends empty → `has_accessibility_data = false` → widget hidden. Matches observation.

**Correction to the workflow synthesis:** its `blast_radius` paragraph claimed accessibility/content/structured "have no per-issue filename siblings in the bundle." That contradicts its own detector-replay trace (61/13/12 files) and is wrong. The replay evidence governs.

## Blast radius

- **Affected client:** `raised-bar-group` only. The F3 bundle ingest is hard-scoped to `RAISED_BAR_F3_CLIENT_SLUG` (`raised-bar-f3-ingest.ts:14,52`). ZipKit/KelseyVerse upload single `*_all.csv` files with no siblings, so they don't collide (consistent with their tables being populated).
- **Affected month:** `2026-05` (`RAISED_BAR_F3_MONTH`).
- **Affected tables:** `crawl_urls` (has wrong/partial data — 13 instead of ~94), `accessibility_urls` / `content_urls` / `structured_data_urls` (empty or wrong-subset).
- **Not a data-loss-from-source event:** the source CSVs are all in the repo bundle and re-ingestable. Nothing is permanently lost.

## Recommended fix (NOT yet applied)

Mirror the existing `crawl_internal` authoritative-filename guard for the three later per-URL formats, in `src/lib/csv/detector.ts`:
- Route to `accessibility` only when basename is `accessibility_all.csv`; to `content_urls` only `content_all.csv`; to `structured_data_urls` only `structured_data_all.csv`. Non-authoritative siblings fall through to `unknown_stored` (safe raw storage, per-filename dedup) instead of fighting.
- **`crawl_internal` decision needed:** tighten the guard from allowing BOTH `internal_html.csv` and `internal_all.csv` to **`internal_all.csv` only** (the full crawl). This is a judgment call — see open questions.
- No `FORMAT_SOURCES` change required; the guards stop the wrong files from reaching the clearing/parsing path.

This is small and matches a proven in-repo pattern, but it touches the live ingest pipeline, so it warrants the full spec + review treatment, not a fast-path.

## Re-ingest — open risk, needs a decision

After the detector fix, Raised Bar's tables must be repopulated. The naive plan (manually `DELETE FROM csv_uploads ...` then re-ingest) has two problems I will NOT do without an explicit decision:

1. **Manual prod DB writes are forbidden** by the production-safety SOP. A hand-run DELETE against the live DB is exactly what the SOP prohibits. The clean path is through code: the existing `force=true` re-ingest, and/or the existing admin clear endpoints (`clear-superseded`, `delete-upload`, `clear-all-for-client`) — not raw SQL.
2. **The re-ingest plan assumes a CASCADE constraint** (`crawl_urls.csv_upload_id` → `csv_uploads.id`) that the investigation did **not** verify. If there's no cascade, deleting upload records orphans rows. Must confirm the schema before relying on it.
3. Even with `force=true`, the **old mis-detected upload records** (60+ siblings tagged `detected_format='accessibility'`, etc.) still exist and complicate `clearPreviousData`'s "most-recent-prior" logic. The re-ingest mechanism likely needs a clean "reset this client+month and re-ingest" path, designed deliberately.

So re-ingest is its own small design problem, not a one-liner.

## Open questions for Cody

1. **`crawl_internal` guard strictness:** OK to make `internal_all.csv` the only authoritative crawl file and route `internal_html.csv` to raw storage? (internal_all is the superset; internal_html is the filtered subset that's currently winning and giving you 13 rows instead of ~94.)
2. **Re-ingest mechanism:** build a proper admin "re-ingest this client/month cleanly" path (no manual SQL), or is there an existing flow you prefer? This is required to actually repopulate Raised Bar after the detector fix.
3. **Scope:** fix all colliding per-URL formats (accessibility/content/structured + crawl_internal + redirects) in one PR, or just the three widget formats first?

## Portal-wide root (second investigation, 2026-06-01)

**Deepest root cause (proven):** `clearPreviousData` (`src/lib/csv/index.ts:78-110`) supersedes prior uploads keyed on `(client_id, month, detected_format)`. That key is too coarse: the detector legitimately maps many distinct physical files to one `detected_format`, so when a folder of CSVs is uploaded (which the UI explicitly invites), sibling files of the same format delete each other's rows before inserting — the alphabetically-last-processed file wins. The codebase already worked around this twice (the `crawl_internal` filename guard; omitting `issue_urls`/`links`/`unknown_stored` from `FORMAT_SOURCES` so their parsers self-dedup on a finer key). Three per-URL formats (accessibility, content_urls, structured_data_urls) plus redirects/images/site_audit got neither, and the `crawl_internal` guard is itself incomplete (admits both `internal_all.csv` and `internal_html.csv`).

**The two complementary fixes:**
- **A — authoritative-filename guards in the detector** (precision): only the canonical `*_all.csv` routes to each per-URL parser; non-authoritative siblings fall to `unknown_stored` (safe raw storage). Mirrors `isAuthoritativeCrawlInternalFilename`.
- **B — add `original_name` to the supersession key** in `clearPreviousData` (correctness): a re-upload clears only the prior upload of the *same filename*, not every file of that format. Mirrors the proven `issue_urls` (dedup by `issue_name`) and `links` (by `source_file`) patterns, generalized. Backward-compatible (old NULL `original_name` simply won't match).

A alone fixes sibling collision but not re-upload correctness; B alone fixes supersession but would leave duplicate rows for crawl (internal_html is a subset of internal_all). They are complementary — ship both.

## Correction to the second synthesis (overclaim rejected)

The workflow synthesis claimed "Raised Bar 86% / KelseyVerse 66% / ZipKit 95% crawl data loss." **I am NOT relaying that as fact — it is an inference presented as proof, and it is wrong:**
- It compared `crawl_urls` (per-URL HTML rows) against the `total_urls` metric (ALL crawled URLs incl. assets). Those differ by design; a gap is not loss.
- **KelseyVerse has only 1 `crawl_internal` upload** (per the prod diagnostic earlier this session) — it cannot have the two-file collision at all. Its "66% loss" is spurious.

**What IS proven damaged:** Raised Bar's `accessibility_urls`/`content_urls`/`structured_data_urls` are empty when their `*_all.csv` files carry real rows (true loss; this is why the three new widgets show nothing for Raised Bar). The crawl `13 vs ~94` for Raised Bar is a real collision, but whether 13 (HTML pages) or 94 (all URLs) is the *correct* contents of `crawl_urls` is a product decision, not established loss. Per-client crawl damage must be verified by checking whether each client actually uploaded the colliding pair — not inferred from a row-count gap.

## Open product decision (only Cody)

For `crawl_internal`: should `crawl_urls` hold the **full crawl** (`internal_all.csv`, ~94 rows incl. assets) or **HTML pages only** (`internal_html.csv`, ~13)? The per-URL widgets and `page_count` routing depend on this. The fix's guard picks one authoritative file; which one is your call.

## Verification trail
- Detector replay over the real bundle: 61 accessibility / 13 content / 12 structured / 2 crawl_internal files, with row counts (proven).
- `clearPreviousData` semantics quoted from `src/lib/csv/index.ts:78-110` (proven).
- Alphabetical processing order from `raised-bar-f3-ingest.ts:59` (proven).
- `crawl_urls_total = 13` from prod `schema-diagnostic` matches `internal_html.csv` row count (strong corroboration).
</content>
