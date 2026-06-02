# Portal Audit Engine: design guidance from the portal/ingest team

Purpose: hand this to the "Build Screaming Frog replacement" chat. It is not a spec. It is the portal-side ground truth and the hard constraints that chat cannot see from where it sits, plus the sharper questions to answer before building. The chat already made the right core pivot (evidence to observation to finding to portal, strongest collector per evidence type, no artificial report ceiling, preserve raw evidence). This corrects the gaps.

Source of authority: this comes out of a long portal session that just root-caused and fixed the CSV ingest + multi-site page-count pipeline. Cross-references: `docs/audits/ingest-and-pagecount-root-findings-2026-06-01.md`, `docs/audits/f3-ingest-format-collision-findings-2026-06-01.md`.

---

## 1. The thing that changes everything: this engine feeds PRICING, not just dashboards

The chat is treating the audit engine as a data producer for health dashboards and reports. That is true but incomplete. The crawl output drives a money chain:

`crawl data -> client_sites.page_count -> routeWebManagementEcosystem (band thresholds <30 / <=150 / >150) -> per-site monthly + onboarding -> proposal -> contract -> invoice`

A wrong page count puts a client in the wrong ecosystem band and mis-prices a signed contract. So the engine's page-count output is a money-critical value, not a vanity metric. That raises the bar: the page count must be deterministic, reconcilable against an independent source, and validated against known benchmarks before it is trusted for pricing.

Implication for design: the engine must not just "capture URLs." It must produce a defensible **real-user-page count** as a first-class, audited output.

## 2. There are THREE distinct page concepts. Do not collapse them.

This is the single most important modeling point, learned the hard way this session:

1. **All URLs** (everything crawled: HTML, CSS, JS, images, PDFs, fonts, feeds, taxonomy). Needed for link graph, redirects, response-code health, asset analysis. Capture all of it.
2. **HTML pages** (the `text/html` subset). An intermediate filter, NOT "pages."
3. **Real user pages** (published destinations a human navigates to: WordPress `page` + `post` content types, EXCLUDING taxonomy/archives like category/tag/author/date, utility/system like `/wp-*` `/feed` pagination `/page/N`, and noindexed pages). THIS is what "page" means in the portal and what pricing uses.

Benchmarks (independently verified this session, these are your acceptance tests):
- f3properties.com = **5** real user pages (home, /projects/, /contact/, /history/, /about/), from a 94-URL crawl. Confirmed three ways: raw crawl hand-count, the site's own sitemap, and the portal filter. Note the site also has 7 indexable PDFs that are deliberately NOT real user pages.
- zipkithomes.com (June 2026 scrape) = **62** real user pages, from 477 crawled URLs.

The cleanest independent source for real-user-pages on a WordPress site is the **Yoast sitemap** (`page-sitemap.xml` + `post-sitemap.xml` loc counts, excluding category/author sitemaps). The crawl-derived count must reconcile to it; if they diverge, the crawl missed orphans or the filter is wrong. Build this reconciliation in, do not pick one source blindly.

The current portal definition lives in `src/lib/csv/page-count-sql.ts` (`realUserPageRowFilters` + `realUserPageUrlExclusions`). Reuse that exact definition so the engine, the dashboard, the report, and pricing never drift. We just spent real effort collapsing THREE divergent copies of this filter into one shared module; do not create a fourth.

## 3. The client sites actively block automated crawlers

ZKH and MVP run Cloudflare WAF; MVP also runs Wordfence. Both block automated requests. This is in portal memory as a standing fact: a failed or odd fetch against these sites is usually the firewall, not breakage. Screaming Frog itself only gets through with a Chrome user-agent, or via Ubersuggest's crawler, or by being run from an allowlisted context.

A from-scratch crawler will be blocked the same way unless it: presents a real browser fingerprint, is explicitly allowlisted at the WAF (we manage these sites, so we can allowlist our own crawler IP), and respects politeness so it does not trip rate limiting. Design the HTTP collector to assume hostile-to-bots targets, not open ones. This is non-optional for the actual client base.

## 4. Infrastructure reality on DigitalOcean App Platform

The portal runs on DO App Platform behind Cloudflare. The web process answers HTTP requests inside Cloudflare's ~100s origin timeout window. You cannot run a full-site crawl + Playwright render + Lighthouse + axe inside a request handler. We already hit this: the CSV batch upload had to go parallel specifically to stay under the CF 524 timeout, and even that is now showing strain.

So the engine needs an **async job/worker model** separate from the web process: a queue, a worker that runs crawls/renders over minutes, and status polling. `audit_runs` with status (`queued`/`running`/`done`/`failed`), progress counts, and a worker that updates it. The web UI kicks off a run and polls; it does not run the crawl synchronously. Plan this from the start. Playwright (headless Chromium) and Lighthouse are heavy: real memory, real time per URL. Budget for it; do not assume per-URL render at full-site scale is free.

## 5. PageSpeed / Core Web Vitals: field data will not exist for these clients

Most portal clients are small, low-traffic sites (F3 has 5 pages). Google CrUX field data only exists for sites with enough real-user traffic. So the PageSpeed Insights API will return **lab data only** (Lighthouse) for most clients, no field CrWV. Design the performance collector to run Lighthouse locally for broad coverage and treat field data as a sometimes-available bonus, not the primary signal. Do not build a CWV dashboard that is empty for 90% of clients.

## 6. Idempotency: re-runs must REPLACE, not accumulate

Hard lesson from this session's repopulation work. The CSV ingest superseded prior data per `(client, month, format, original_name)` but re-running a `force` ingest left accumulating superseded rows and required multiple passes due to a concurrency collision. The new engine must be idempotent by construction:

- A re-run for the same `(client, site, month)` cleanly supersedes or replaces the prior run's data, with no row accumulation and no partial-completion gaps.
- Identity is `(run_id, url, observation_type)`, NEVER a filename. The entire collision class we have been fighting in CSV ingest exists because data was keyed by CSV basename, and Screaming Frog ships genuinely-different files under the same basename in different subfolders (confirmed: in the ZKH June scrape, 5 same-named file pairs had different content). Producing data directly is the chance to delete this whole problem. Do not reintroduce a name-based identity key.
- Keep raw evidence keyed to the run so a re-parse never needs a re-crawl.

## 7. Write into the EXISTING portal tables; do not fork the data model

The portal already has normalized per-URL tables the dashboard, reports, scoring, and pricing read from: `crawl_urls`, `link_graph`, `redirect_chains`, `image_urls`, `content_urls`, `security_urls`, `structured_data_urls`, `accessibility_urls`, `site_issues`, `site_issue_urls`, `keyword_rankings`, `metrics`, `ga4_*`, `gsc_*`. The engine should populate these (or cleanly superseding versions of them) so the current portal keeps working while the engine is built. A new `audit_runs` + `audit_artifacts` (raw evidence) + `audit_observations` + `audit_findings` layer ON TOP is the right shape, but the bottom must still fill the tables consumers already read. Do not build a parallel data world the portal cannot see.

Note the deliberate dedup patterns already in the portal you should mirror, not fight: `site_issue_urls` dedups by `issue_name`, `link_graph` by source file, and some formats are intentionally kept out of the format-level clearing sweep precisely so sibling data coexists. The engine's writers should honor the same "coexist distinct data" intent.

## 8. The portal's job is business intelligence, not SEO-tool parity

The chat correctly said "build the thing Screaming Frog cannot be for you." Sharpen it: every finding should connect to a portal surface or business rule that already exists, because that is the portal's actual value:

- **Health score** (`/portal/api/dashboard/score`): today it uses only `site_issues` high/medium/low counts for the Technical Health component. It ignores the rich per-URL tables. The engine's findings should feed a richer score (per-URL violation ratios, performance, accessibility, structured-data eligibility). Scoring is a standing improvement lens for the portal ("dashboard is the hub").
- **WM vs MC product lines**: Web Management is descriptive (what happened, what was done). Marketing Consulting is prescriptive (what to do). Audit findings that are advisory/recommendations belong to MC; routine technical execution belongs to WM. Do not route an audit recommendation into WM task creation unless the site is managed and execution is authorized. (Portal rule: advisory output is not WM routing.)
- **Proposal research**: the same crawl drives proposal page-count, ecosystem routing, and the AI client-research grounding. One run, many business consumers.

## 9. Acceptance benchmarks (use these as tests, do not tune the code to a guessed number)

Validate against independent oracles, not against test data you wrote (a lesson from this session: a test you author to match your own implementation proves nothing):
- f3properties.com real user pages == 5 (reconcile crawl vs sitemap).
- zipkithomes.com (June scrape) real user pages == 62.
- All-URL capture for F3 ~= 94, ZKH June = 477 (these are the full inventories; they are NOT the page count).
- Link graph, redirect chains, per-URL accessibility/structured/content tables populate non-empty for a site that has those issues.
- A re-run of the same site/month produces the same counts and does not multiply rows.

## 10. Open questions the chat should answer before building

1. Sitemap-first or crawl-first for the real-user-page count, and how do they reconcile when they disagree (orphans, noindex, recently changed site)?
2. Worker/queue choice on DO: separate service, scheduled job, or external runner? What holds run state and serves progress?
3. Render policy: render every URL, only HTML pages, or only pages where raw vs rendered differ? (Cost vs coverage.)
4. WAF allowlisting: how does our crawler authenticate as "ours" to the clients' Cloudflare/Wordfence so it is not blocked?
5. Migration: does the engine replace CSV upload immediately, or run alongside it writing the same tables until proven? (Recommend alongside; keep CSV upload working.)
6. Where do findings become client-facing wording vs internal evidence, and who gates that (the descriptive/prescriptive and no-internal-exposure rules apply).

---

Bottom line: the chat's architecture instinct is right. The corrections are: it is pricing-critical (so the page model and validation matter more than they realized), the real client sites block bots and the platform cannot crawl synchronously (so plan async + allowlisting + browser fingerprint from day one), identity must be run/url/type and never filename (to kill the collision class for good), and it must fill the portal's existing tables and connect findings to existing business surfaces rather than build a parallel SEO tool.
