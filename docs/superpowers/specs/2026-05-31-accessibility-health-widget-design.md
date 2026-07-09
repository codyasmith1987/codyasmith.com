# Accessibility (WCAG) health widget — design

Date: 2026-05-31
Status: approved, pre-implementation

## Problem

`accessibility_urls` is fully ingested (parser `src/lib/csv/parsers/accessibility-urls.ts` writes per-URL WCAG violation counts), but nothing shows it to the client. It is one of three "ingested-but-unsurfaced" data categories found by the 2026-05-31 data-surfacing ground-truth map (the other two, structured data and deeper content quality, are explicit follow-ons, not this slice).

This is the first slice of the data-surfacing vein. It surfaces existing data using the exact pattern already proven by the 9 live per-URL widgets on `/portal/health`. No new tables, no migration, no parser change.

## Data source (verified against the parser, not the migration)

Table `accessibility_urls`, one row per crawled URL, populated by `accessibility-urls.ts`:

- `url`, `hostname`, `status_code`, `content_type`, `indexability`
- `all_violations` — total accessibility violations on the page
- `best_practice_violations`
- Seven WCAG buckets: `wcag_20a_violations`, `wcag_20aa_violations`, `wcag_20aaa_violations`, `wcag_21a_violations`, `wcag_21aa_violations`, `wcag_22a_violations`, `wcag_22aa_violations`
- `client_id`, `csv_upload_id`, `month`, `raw_json`

Any bucket can be NULL if the source export omitted that column (parser writes NULL when the header is absent). Aggregations must treat NULL as 0.

## Component 1 — endpoint: `src/pages/portal/api/dashboard/url-insights.ts`

Mirror the existing per-table blocks (crawl/image/redirect/link). Additions:

1. New response field `has_accessibility_data: boolean`.
2. Resolve latest month: `SELECT MAX(month) FROM accessibility_urls WHERE client_id = ?` (same per-table month-resolution pattern already in the file). `has_accessibility_data = !!accessibilityMonth`.
3. New response object `accessibility`:
   - `pages_with_violations: number` — `COUNT(*) WHERE all_violations > 0`
   - `total_violations: number` — `SUM(all_violations)` (COALESCE NULL to 0)
   - `by_level: Record<string, number>` — for each of the seven WCAG buckets, the count of pages where that bucket `> 0`. Only include buckets with a nonzero page count. Keys are human labels: `WCAG 2.0 A`, `WCAG 2.0 AA`, `WCAG 2.0 AAA`, `WCAG 2.1 A`, `WCAG 2.1 AA`, `WCAG 2.2 A`, `WCAG 2.2 AA`.
   - `samples: Array<{ url: string; all_violations: number; status_code: number | null }>` — top 25 (`SAMPLE_LIMIT`) pages by `all_violations DESC`, only rows with `all_violations > 0`.
4. Default-zeroed `accessibility` object in the initial response literal (like every other widget), populated only when `accessibilityMonth` is set.
5. Scoped by `client_id` (admin may pass `client_id`; client scoped to own) — identical to existing auth handling at the top of the handler. No change to auth.

Bounded payload: `by_level` is at most 7 keys, `samples` capped at 25. Same envelope size discipline as siblings.

## Component 2 — widget: `src/pages/portal/health.astro`

One `widgetCard`, gated like the others:

```
if (data.has_accessibility_data && data.accessibility.pages_with_violations > 0) {
  const a = data.accessibility;
  // by_level -> a small <ul> of "WCAG 2.1 AA: N pages" lines (reuse the indexability by_status rendering shape)
  // samples -> renderUrlList(a.samples, x => `<li>${urlLink(x.url)} <span ...>${x.all_violations} violation(s)</span></li>`)
  cards.push(widgetCard({
    title: 'Accessibility',
    description: '<plain-language, no dev jargon>',
    stats: [ {label, value} for pages_with_violations and total_violations ],
    sample_html: <by_level list> + <samples list>,
  }));
}
```

- Placed among the technical widgets (natural spot: after the security/structured technical group; exact position is cosmetic, match surrounding ordering).
- Reuses existing helpers verbatim: `widgetCard`, `renderUrlList`, `urlLink`, `escapeHtml`, `shorten`. No new client utilities.
- Description in plain language per the "no developer jargon in UI" rule. Draft: "Pages with accessibility issues that can affect visitors who use assistive technology such as screen readers. Each count is the number of issues the audit flagged on that page." No legal/ADA claim asserted as fact (advisory framing; do not promise compliance).

## Scope and non-goals (YAGNI)

- Single client, latest month — identical to every sibling widget.
- NO dedicated accessibility detail page.
- NO per-violation-type drilldown (we show counts + dominant levels, not individual rule names; `raw_json` is not parsed further this slice).
- NO multi-site picker (no sibling widget has one; out of scope).
- NO change to the parser, table, or any migration.
- Structured-data and content-quality widgets are separate future slices.

## Error handling

- Endpoint: inherits the existing `try/catch` returning `500 { error }`. The accessibility block runs only when `accessibilityMonth` is set; an empty table yields `has_accessibility_data: false` and a zeroed object.
- Page: if `has_accessibility_data` is false or `pages_with_violations === 0`, the widget does not render — same gating as crawl/image/redirect widgets. No empty card.
- NULL WCAG buckets are coalesced to 0 in SQL so a partial export cannot throw or miscount.

## Testing

1. `npm test` — full suite must stay green. This change touches neither contract nor pricing code; the relevant existing suites (contract-render, products, etc.) should be unaffected. Confirm, do not assume.
2. Endpoint shape: locate any existing `url-insights` / dashboard endpoint test. If one exists, extend it to assert the new `has_accessibility_data` + `accessibility` fields and that NULL buckets coalesce. If none exists, add a minimal assertion test for the new response shape (pure-function-level if the query logic can be isolated; otherwise document that coverage is via the prod read-only check below).
3. `npm run build` — must complete clean (server build + postbuild sitemap assert).
4. Post-deploy, read-only prod verification against the Cody Test client only (open `/portal/health` as Cody Test, confirm the widget renders when accessibility data exists and is absent when it does not). No real client touched. Per the "local tests don't validate prod" rule, this is what closes the loop, not the green build alone.

## Delivery

Feature branch `feat/accessibility-health-widget` -> PR to `main` -> merge -> verify. No prod writes during development. No Claude attribution on commit or PR (per standing rule).

## Follow-ons (not this slice)

- Structured-data / schema-markup widget (`structured_data_urls`) — same pattern, needs new endpoint block + widget.
- Deeper content-quality widget (`content_urls`: readability grade, near-duplicate, semantic similarity, spelling/grammar) — same pattern; most editorial-judgment-heavy, sequence last.
