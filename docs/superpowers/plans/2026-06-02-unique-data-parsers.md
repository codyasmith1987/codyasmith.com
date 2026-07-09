# Parsers for the unique-data Screaming Frog exports

Goal: stop these four SF exports landing in `unknown_stored`. Each carries data not in any existing table. Mirror the established per-URL Class-A parser pattern (content-urls.ts / security-urls.ts): pure `build*Statements` + thin `parse()`, detector signature, new table, FORMAT_SOURCES + CLASS_A_BUILDERS wiring, coverage-signals (file-present), parity test.

Skipped on purpose (empty or redundant for ZKH free SF, per the accessibility lesson — don't build a parser for a structurally-empty export): pagespeed_all/mobile_all (PSI Request Status blank), search_console_all/analytics_all (URL+title only, real data comes from the gsc_* exports), hreflang_all (blank — single-language site), custom_extraction/link_metrics/ai_all/url_all/external_all (empty or redundant with internal_all).

## The four formats

Real headers captured from the ZKH June scrape (use these to build accurate inline test fixtures — do NOT depend on the OneDrive folder).

### 1. canonicals  (file: canonicals_all.csv, 62 data rows)
Header: `Address, Occurrences, Indexability, Indexability Status, Canonical Link Element 1, HTTP Canonical, Meta Robots 1, X-Robots-Tag 1, rel="next" 1, rel="prev" 1, HTTP rel="next" 1, HTTP rel="prev" 1`
- Detection: header SIGNATURE `['address','occurrences','canonical link element 1','rel="next" 1']` (rel=next is the unique tell; directives has occurrences+canonical but no rel=next).
- Table `canonical_urls`: id, client_id, csv_upload_id, month, url, hostname, occurrences INT, indexability, indexability_status, canonical_link_element, http_canonical, meta_robots, x_robots_tag, rel_next, rel_prev, http_rel_next, http_rel_prev, raw_json, created_at.

### 2. directives  (file: directives_all.csv, 473 data rows)
Header: `Address, Occurrences, Meta Robots 1, X-Robots-Tag 1, Meta Refresh 1, Canonical Link Element 1, HTTP Canonical, Indexability, Indexability Status`
- Detection: header SIGNATURE `['address','occurrences','meta robots 1','x-robots-tag 1','meta refresh 1']` (meta refresh 1 is the unique tell; security_all has meta robots/x-robots but no meta refresh and is matched earlier by its own http-version signature).
- Table `directive_urls`: id, client_id, csv_upload_id, month, url, hostname, occurrences INT, meta_robots, x_robots_tag, meta_refresh, canonical_link_element, http_canonical, indexability, indexability_status, raw_json, created_at.

### 3. page_weight  (file: validation_all.csv, 477 data rows)
Header: `Address, Content Type, Status Code, Status, Indexability, Indexability Status, Size (Bytes), Transferred (Bytes), Total Transferred (Bytes), CO2 (mg), Carbon Rating`
- Format name is `page_weight` (the data is page size + carbon, NOT html/schema validation — name by content).
- Detection: header SIGNATURE `['address','co2 (mg)','carbon rating']` (carbon is unique across all SF exports; size alone would collide with images, which also requires img inlinks+dimensions).
- Table `page_weight_urls`: id, client_id, csv_upload_id, month, url, hostname, content_type, status_code INT, indexability, size_bytes INT, transferred_bytes INT, total_transferred_bytes INT, co2_mg REAL, carbon_rating, raw_json, created_at.

### 4. sitemap_urls  (file: sitemaps_all.csv, 66 data rows)
Header: `Address, Content Type, Status Code, Status, Indexability, Indexability Status` (GENERIC — identical to response_codes_* etc.; cannot detect by header).
- Detection: FILENAME rule. In detectFormat, alongside the other filename rules (before the SIGNATURE loop), add `if (normalizedName === 'sitemaps_all.csv') return { format: 'sitemap_urls', headers: [] }`.
- Table `sitemap_urls`: id, client_id, csv_upload_id, month, url, hostname, content_type, status_code INT, status, indexability, indexability_status, raw_json, created_at.

## Wiring (all four are Class-A, supersede-class, per-URL)

- `detector.ts`: add the 4 format strings to the `CsvFormat` union; add the 3 header signatures to `SIGNATURES`; add the sitemaps filename rule. The 3 signatures must be placed so they neither pre-empt nor are pre-empted by existing signatures (each requires a unique tell the others lack — verified). Keep crawl_internal's filename guard intact.
- New parsers `src/lib/csv/parsers/{canonical-urls,directive-urls,page-weight-urls,sitemap-urls}.ts`: each exports `build<Name>Statements(raw, clientId, month, uploadId) => {sql,args}[]` + thin `parse()` that batches at 450 (match the rest of the write path). Reuse `_url-parser-helpers` (parseCsvHeaderAndRows, findIdx, findIdxContains, safeText, safeInt, safeFloat, extractHostname, rowToJson). Dedup by lowercased url within the upload, skip rows with no url/hostname — exactly like content-urls.ts.
- `index.ts`: add all 4 to `CLASS_A_BUILDERS` (imported build*Statements). They route through the atomic per-file transaction automatically.
- `FORMAT_SOURCES`: add 4 entries `{ tables: ['<table>'], source: '<format>' }` so supersession clears the prior upload's rows for the same key.
- `coverage-signals.ts`: add to `FORMAT_TO_CATEGORY` (canonicals->'canonicals', directives->'directives', page_weight->'page_weight', sitemap_urls->'sitemaps') and `COVERAGE_CATEGORIES` (4 entries, kind `'file-present'`, table = the new table). These are file-present (the columns always populate when the export is provided; no optional-scan empty-column problem like accessibility).
- Migration `059-extra-per-url-tables.ts`: CREATE TABLE IF NOT EXISTS for the 4 tables + an index on (client_id, month) each. Mirror migration 034/055 shape.

## Tests (assert against the real headers, inline fixtures — never old-code output)

- Extend `tests/run-csv-detector-tests.mjs`: the 4 sample headers route to the 4 new formats; AND a regression block proving the new signatures do NOT mis-route existing exports — security_all header stays `security_urls` (has meta robots/x-robots but no meta refresh), response_codes_* generic header stays `site_audit`/`unknown` not `sitemap_urls` (filename differs), images_all stays `images` (has size but also img inlinks), internal_all stays `crawl_internal`. Run the full existing detector suite — must stay green.
- Per-parser parity test (4 new files `tests/run-<name>-parity-tests.mjs`): feed an inline CSV built from the real header above, assert row count, column coercions (occurrences/size as int, co2 as float), url+hostname extraction, dedup, and that a blank cell becomes null (not 0). Append each to the package.json `test` chain.
- `npm test` fully green; `npm run build` clean.

## Out of scope (flag as follow-on)

Surfacing widgets on the health page (url-insights blocks + cards) for these four. This build lands the data in queryable tables + coverage. Widgets are the next step under the dashboard-as-hub lens.
