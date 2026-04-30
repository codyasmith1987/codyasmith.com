# Naming Pipeline: Build Spec v3 (Astro Integration)

This spec replaces v2. v2 specced a separate Python plus FastAPI stack on a new droplet behind a Cloudflare Worker. The infrastructure audit revealed codyasmith.com is already a unified Astro 6 plus Node SSR app on DigitalOcean App Platform that includes the Listener, the portal (auth, billing, files, invoices), the marketing site, and the blog. v3 builds this tool as additional pages and API routes inside that existing app, reusing every piece of infrastructure already in production.

This file lives at `docs/naming/build_spec_v3.md` in the codyasmith.com repo on the `main` branch. The Phase 1 starter prompt at the bottom references it directly.

## Brand Decision Deferred

A prior version of this spec named the tool "DomainForge". A search of existing usage surfaced multiple active brands, including Altimetrik's enterprise AI platform at DomainForge.ai, a small-business domain setup service at DomainForge.co.uk, and several GitHub projects. The name is unusable for SEO, brand confusion, and competitive positioning reasons.

The whole purpose of this tool is to do naming work properly, with availability and conflict checks built in. Picking a brand cold while building the tool that automates this is the wrong loop. The tool will name itself after Phase 3 ships and the engine can generate ranked candidates with availability and trademark heuristic data.

Until Phase 4, the codebase uses the neutral identifier `naming` everywhere: file paths, table prefixes, environment variables, internal references. The Phase 2 preview ships at an unlinked temporary route. Phase 4 begins with a single rename commit that applies the chosen brand across routes, page filenames, marketing copy, Brevo tags, and a table-prefix migration. Roughly 30 minutes of mechanical work, all in one branch.

## What Changed From v2

| Decision | v2 | v3 |
|---|---|---|
| Stack | Python 3.11+, FastAPI, uv, Typer | TypeScript, Astro 6, Node 22.12+ (existing) |
| Hosting | New $4/mo DigitalOcean droplet | Existing DO App Platform app, no new infra |
| Routing | New Cloudflare Worker proxy | Astro page route on codyasmith.com |
| Database | New SQLite file | Existing Turso (libsql), add tables |
| Email and leads | Brevo (newly integrated) | Brevo (already integrated via existing email.ts) |
| File storage | New DO Spaces bucket | Existing Spaces via existing storage.ts |
| Auth, CSRF, rate-limit | Build from scratch | Existing middleware (auth.ts, csrf.ts, rate-limit.ts) |
| PDF generation | weasyprint (Python) | Existing pdfkit (already used by /api/report) |
| CSV generation | Python csv module | Existing papaparse |
| LLM | Gemini via google-generativeai (Python SDK) | Gemini via @google/generative-ai (Node SDK) |
| CLI surface | Typer-based personal tool | Dropped. Engine reachable from a Node REPL or test if needed. |
| Deploy pipeline | Manual SSH, git pull, systemctl restart | Existing GitHub `main` to DO App Platform auto-deploy |
| Time to first deploy | Roughly one weekend day | One git push, no infrastructure work |
| Marginal monthly cost | About $10 | $0 |
| Pricing in initial scope | Phase 2 | Deferred to Phase 6, contingent on Namecheap API research |
| Brand commit | Locked at Phase 1 | Deferred to Phase 4, tool names itself |

## Dashboard

Stack: TypeScript, Astro 6 with @astrojs/node SSR adapter, Tailwind 4, Turso (libsql). All existing in `codyasmith1987/codyasmith.com`.

New dependency: `@google/generative-ai` (Gemini SDK). Possibly `tldts` if Node's built-in URL parsing is insufficient for TLD splitting. Decide during Phase 1.

External services in initial scope: Gemini API (free tier, 1,000 RPD on Flash-Lite), RDAP (free, no auth). Namecheap deferred to Phase 6 pending API research.

URL: temporary unlinked route on codyasmith.com during build (Phase 2). Final brand URL set at Phase 4 rename.

Marginal cost: $0. No new servers, no new buckets, no new services. App Platform tier handles it.

Build time estimate: A focused weekend for the first useful version. Most of the v2 effort (provisioning, Workers, Nginx, systemd) does not exist here.

## Architecture

```
                  codyasmith.com/<brand>/*  (Phase 4+)
                            |
                            v
                  +-------------------+
                  |   Cloudflare      |
                  |  (DNS plus edge,  |
                  |   no Worker)      |
                  +---------+---------+
                            |
                            v
                  +-----------------------------+
                  |  DO App Platform            |
                  |  Astro plus Node SSR        |
                  |  (existing instance)        |
                  +-------------+---------------+
                                |
        +-----------------------+-----------------------+-------------------+
        v                       v                       v                   v
  +----------+           +-------------+         +-------------+      +-----------+
  | existing |           |  naming     |         |   /api/     |      |  shared   |
  |  pages   |           |  -preview   |         |  naming/*   |      |   libs    |
  | (/, blog,|           |  .astro     |         |  .ts        |      | (auth,    |
  |  portal, |           |  (form)     |         |             |      |  email,   |
  |  listen) |           +-------------+         +-------+-----+      |  pdf,     |
  +----------+                                           |            |  storage, |
                                                         v            |  rate-    |
                                            +-------------------+     |  limit)   |
                                            | src/lib/naming/   |     +-----+-----+
                                            | engine modules    | <---------+
                                            +---------+---------+
                                                      |
                  +-----------------------------------+-----------------------------+
                  v                                   v                             v
            +----------+                        +----------+                   +----------+
            | generator|                        | availab. |                   |  scorer  |
            | (Gemini) |                        |  (RDAP)  |                   | (Gemini) |
            +----------+                        +----------+                   +----------+
                  |
                  v
            +----------+
            |   Turso  |
            | (libsql) |
            +----------+
```

## Files Added to the codyasmith.com Repo

```
codyasmith.com/                              (existing repo, main branch)
+- docs/
|   +- naming/
|       +- build_spec_v3.md                  THIS FILE, committed before Phase 1
+- src/
|   +- pages/
|   |   +- naming-preview.astro              NEW Phase 2, temporary unlinked route
|   |   +- naming/                           These three rename at Phase 4
|   |   |   +- thanks.astro                  NEW Phase 4, post-gate page
|   |   |   +- methodology.astro             NEW Phase 5, SEO and credibility
|   |   +- api/
|   |       +- naming/
|   |           +- preview.ts                NEW Phase 2
|   |           +- report.ts                 NEW Phase 4
|   |           +- status.ts                 NEW Phase 4
|   +- lib/
|       +- naming/
|           +- generator.ts                  NEW Phase 1, Gemini call
|           +- availability.ts               NEW Phase 1, RDAP lookups
|           +- scorer.ts                     NEW Phase 3, rule plus LLM scoring
|           +- ranker.ts                     NEW Phase 1 (simple), Phase 3 (full)
|           +- pricing.ts                    NEW Phase 6, Namecheap (contingent)
|           +- trademark.ts                  NEW Phase 5, DDG search heuristic
|           +- storage.ts                    NEW Phase 1, Turso schema and queries
|           +- report.ts                     NEW Phase 4, PDF/CSV via existing pdfkit and papaparse
|           +- prompts/
|           |   +- generate.ts               NEW Phase 1, system prompt as string export
|           |   +- score.ts                  NEW Phase 3
|           +- anti-patterns.ts              NEW Phase 1, forbidden suffixes by creativity
|           +- types.ts                      NEW Phase 1, shared types
|           +- config.ts                     NEW Phase 1, defaults, scoring weights
+- migrations/
|   +- <ts>_naming.sql                       NEW Phase 1, Turso schema additions
|   +- <ts>_naming_rename_to_<brand>.sql     NEW Phase 4, table prefix rename
+- package.json                              MODIFIED Phase 1, add @google/generative-ai
+- (everything else unchanged)
```

Sixteen new TypeScript files plus three new Astro pages, one new package dependency, one initial migration in Phase 1, one rename migration at Phase 4. No infrastructure changes, no deploy script changes, no Cloudflare changes.

## Engine Module Specs

### `generator.ts`
Imports `GoogleGenerativeAI` from `@google/generative-ai`. Loads system prompt from `prompts/generate.ts`. Calls `gemini-2.5-flash-lite` by default with `responseMimeType: 'application/json'` and a `responseSchema` describing the 10 by 10 structure. Temperature mapping: creativity 1 to 0.3, creativity 5 to 0.7, creativity 10 to 1.0. Validates response with Zod (or hand-written runtime validation if Zod is not in the project). Cache layer: SHA-256 of (seed + creativity + prompt version + model) into Turso `naming_gemini_cache` table with 7-day TTL. Cache hits return immediately, no API call. Quota fallback: catches `RESOURCE_EXHAUSTED` (429), retries once on Anthropic Haiku 4.5 if `ANTHROPIC_API_KEY` is set in env, otherwise throws with a clear message visible to the API route.

### `availability.ts`
RDAP lookups against IANA's bootstrap registry, cached at module load. Concurrency via `Promise.all` chunks of 20 simultaneous fetches, throttled to roughly 10 req/sec across all RDAP servers combined. 200 means registered, 404 means available, anything else means unknown (do not mark as available). Returns `{ name, tld, available, checkedAt }` per entry.

### `scorer.ts`
Two passes. Rule pass (length, typability via consonant cluster heuristic, spelling ease) runs locally with no API call. LLM pass batches all 100 names into a single Gemini call, returns 7-axis scores per name. Combine into composite.

### `ranker.ts`
Composite is a weighted average across the 10 axes per the v1 weight defaults, configurable via `config.ts`. Tier output: S at 8.5 and above, A from 7.5 to 8.4, B from 6.5 to 7.4, C below 6.5. Available-only by default. `includeUnavailable: true` flag returns the full set.

### `pricing.ts` (Phase 6, contingent)
Single Namecheap API call: `namecheap.users.getPricing` with `ProductType=DOMAIN`, `ActionName=REGISTER`. 24-hour cache in Turso `naming_pricing_cache`. Phase 6 begins with a research step to confirm a workable auth path from App Platform's dynamic egress IPs. If no clean API path exists, Phase 6 either reduces to "no pricing in this tool for now" or substitutes a different data source. Do not ship scraped pricing.

### `trademark.ts` (Phase 5)
DuckDuckGo HTML search per top 30 names plus the term ` trademark`. Parses for uspto.gov, trademarkia.com, justia.com, exact-match brand domains. Returns `concernLevel: 'none' | 'possible' | 'likely'` plus evidence URLs. Always labeled as heuristic, not legal clearance.

### `report.ts` (Phase 4)
Imports existing `pdfkit` (already in package.json, used by `/api/report` for the Listener). Generates PDF with dashboard top (top 5 picks with reasoning), full ranked table, methodology footer. Reads existing styling and layout patterns from the Listener's PDF generator before writing this. Generates CSV via `papaparse`. Uploads both to existing DO Spaces via existing `storage.ts`. Returns `{ pdfUrl, csvUrl }`.

### `storage.ts`
Wraps existing Turso client. Schema additions, applied as the first step of Phase 1:

```sql
CREATE TABLE naming_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seed_term TEXT NOT NULL,
  creativity INTEGER NOT NULL,
  tlds TEXT NOT NULL,
  source TEXT NOT NULL,           -- 'preview' or 'report'
  lead_id INTEGER,
  created_at TEXT NOT NULL,
  config_snapshot TEXT
);

CREATE TABLE naming_names (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES naming_runs(id),
  parent_name TEXT,
  parent_rationale TEXT,
  name TEXT NOT NULL,
  variant_rationale TEXT,
  is_parent INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE naming_availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_id INTEGER NOT NULL REFERENCES naming_names(id),
  tld TEXT NOT NULL,
  available INTEGER,
  checked_at TEXT NOT NULL
);

CREATE TABLE naming_pricing_cache (
  tld TEXT PRIMARY KEY,
  first_year REAL,
  renewal REAL,
  currency TEXT,
  cached_at TEXT NOT NULL
);

CREATE TABLE naming_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_id INTEGER NOT NULL REFERENCES naming_names(id),
  axis TEXT NOT NULL,
  score REAL NOT NULL
);

CREATE TABLE naming_trademark_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_id INTEGER NOT NULL REFERENCES naming_names(id),
  concern_level TEXT,
  evidence_json TEXT,
  checked_at TEXT NOT NULL
);

CREATE TABLE naming_gemini_cache (
  cache_key TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE naming_jobs (
  id TEXT PRIMARY KEY,                -- nanoid for client-side polling
  job_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,               -- 'pending', 'running', 'done', 'failed'
  progress_step TEXT,                 -- human-readable current step
  result_json TEXT,                   -- partial results merged in as steps complete
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX idx_naming_jobs_status ON naming_jobs(status, created_at);
CREATE INDEX idx_naming_gemini_cache_expires ON naming_gemini_cache(expires_at);
```

All `naming_*` tables get renamed at Phase 4 via a second migration that applies the chosen brand prefix. Foreign keys stay intact across the rename.

Leads do not need a new table. Reuse the existing leads/contacts table the Listener already populates. Add `source = 'naming'` for now, rename to `source = '<brand>'` at Phase 4.

## API Routes

Routes live under `/api/naming/` until Phase 4. The rename commit moves them to `/api/<brand>/` along with any bookmarked URLs.

### `POST /api/naming/preview`
Body: `{ seed: string, creativity?: number }`. Creativity is optional, defaults to 5 for the public preview.

Server actions: CSRF check via existing middleware. Per-IP rate limit via existing `rate-limit.ts`: 10/hour, 50/day. Generate (cache-aware), check `.com` availability for top 5, return JSON: `{ names: [{ name, available, rationale }] }`.

Sync, roughly 3 to 5 second response time.

### `POST /api/naming/report`
Body: `{ seed, creativity, email, name?, turnstileToken }`.

Server actions: validate Turnstile via existing pattern (the Listener uses the same, reuse). Per-email rate limit: 1 per 24h. Insert lead row (reusing existing leads table, source='naming'). Push contact to Brevo via existing `email.ts` integration. Tag: `naming-lead` until Phase 4 rename. Custom attributes: seed term, creativity. Insert `naming_jobs` row with status='pending'. Return `{ jobId }`. Kick off async processing in the same Node process (see Background Processing).

### `GET /api/naming/status?id=<jobId>`
Returns `{ status, progressStep, result?, error? }`. Frontend polls every 3 to 5 seconds while status is 'pending' or 'running'. On 'done', the response includes `result.pdfUrl` and `result.csvUrl`. On 'failed', the response includes a friendly error.

## Background Processing

App Platform does not terminate Node processes on response completion the way Cloudflare Workers do. Long-running async work after the response is sent is feasible.

**Pattern: fire-and-forget after response, with intermediate state writes.** The `/report` handler returns `jobId` immediately, then the engine pipeline runs in the background as an unawaited async function. Each significant step writes its result into the job row before moving on, so a process restart leaves the row reflecting exactly what was completed.

Step-by-step writes in the job processor:

1. Update job to status='running', set `started_at`.
2. Run engine pipeline (generate, availability, scoring). On completion, merge `engineDone: true` into `result_json`.
3. Generate PDF, upload to Spaces. Merge `pdfUrl` into `result_json` immediately.
4. Generate CSV, upload to Spaces. Merge `csvUrl` into `result_json` immediately.
5. Send Brevo email. Merge `emailSentAt` and `brevoMessageId` into `result_json`.
6. Set status='done', set `completed_at`.

Recovery: a Phase 7 cron sweeps jobs in 'running' status older than 5 minutes, inspects `result_json`, and either resumes from the last completed step or marks the job 'failed' if no progress is recoverable. Manual recovery for individual stuck jobs is a one-row update because the partial state is queryable.

Trade-off accepted: if App Platform restarts the instance mid-step, the in-flight step itself dies and may produce a duplicate (a half-uploaded PDF, an extra Brevo email). Idempotency on the email side is handled by tagging each send with `jobId` and deduping in Brevo. Half-uploaded PDFs in Spaces are cleaned up by the Phase 7 cron.

If reliability concerns surface in operation despite intermediate writes, Phase 7 escalates to a separate App Platform Worker component without changing the API surface.

## Frontend (naming-preview.astro, then renamed at Phase 4)

### Page Structure

`naming-preview.astro` is a single page with three states managed via Astro islands or a small inline script:

1. State idle. Hero headline, one input (seed term), creativity slider (default 5, hidden behind Advanced toggle), submit button.
2. State preview-loaded. Top 5 names with `.com` availability indicators. Below: email form for the full report (Turnstile widget here), enabled in Phase 4.
3. State report-running. "Generating your full report" with rotating progress text reading `progressStep` from the status endpoint. Polls every 3 seconds. (Phase 4.)

When status becomes 'done', redirect to `/naming/thanks?email=<email>` (Phase 4 routes, rename to `/<brand>/thanks` at the rename commit). Email arrives in parallel with whatever the user sees on screen.

Phase 2 ships only the idle and preview-loaded states at the unlinked `/naming-preview` route. Not in nav, not on sitemap, only accessible by direct URL. Phase 4 adds the report-running state, gates the lead capture, links from main nav, and applies the brand rename.

### Interactive Pattern

Match the Listener's existing pattern, whatever it is (Astro islands with React, vanilla JS, or another approach). Read the Listener's frontend code during Phase 2 and use the same approach. Consistency over cleverness. Do not introduce HTMX or any other interactivity library if the Listener does not already use one.

### Visual Style

Existing Tailwind 4 classes, existing nav, existing footer, existing security headers. Same theme as the rest of codyasmith.com. The page slots in as one more route alongside `/listener`, `/services`, `/work`, `/blog` once Phase 4 ships and it leaves the temporary route.

Anti-AI defenses on copy: no "Unleash your brand", no "Powered by AI" badges, no fake social proof. Plain language. Phase 4 marketing copy gets written once the brand is locked.

## Funnel Mechanics

Same scope-as-gate model from v2:

| Item | Preview (free, no email) | Full Report (email-gated) |
|---|---|---|
| Names returned | 5 | 100 |
| Creativity dial | Fixed at 5 | User-selected, 1 to 10 |
| TLDs checked | .com only | All 6 (.com, .net, .co, .io, .ai, .org) |
| Pricing | Hidden, deferred to Phase 6 | Shown only after Phase 6 ships |
| Scoring | Hidden | Full 10-axis breakdown |
| Premium domain flags | Hidden | Phase 6 contingent |
| Trademark heuristic flags | Hidden | Phase 5 |
| Format | HTML on page | PDF plus CSV emailed via Brevo plus downloadable from thanks page |
| Cache | 7 days | 7 days |

A preview costs roughly 10 percent of the tokens a full report costs, so 1,000 RPD on Gemini Flash-Lite stretches to roughly 5,000 effective preview equivalents per day.

## Anti-Abuse

| Threat | Mitigation |
|---|---|
| Bot scrapers hitting /preview | Existing per-IP rate limit module, 10/hour, 50/day |
| Bot scrapers hitting /report | Cloudflare Turnstile on the form (Listener uses same pattern) |
| Single user requesting many full reports | Per-email rate limit, 1 per 24h |
| Gemini quota exhaustion | Fallback to Anthropic Haiku 4.5 if API key set, else queue with retry |
| Burst traffic | Cloudflare's existing DDoS plus edge caching absorb first hit |
| Disposable emails | Brevo's built-in disposable email list plus soft-bounce monitoring |

All but the last two are already implemented for the Listener. Read those modules before reimplementing.

## Phased Build (8 Phases)

Each phase is shippable. Phases are smaller than v2 because there is no infrastructure work.

### Phase 1: Engine modules (target: one focused session, 3 to 4 hours)
Build `lib/naming/`: generator, availability, ranker, prompts, types, config. Add Vitest unit tests with mocked Gemini and RDAP responses. Real-API integration tests sit behind an `INTEGRATION=1` env flag and a separate npm script (`npm run test:integration`), so the default test suite costs zero quota. Run the migration that adds the `naming_*` Turso tables.

Validation: `npm test` passes against mocks. `INTEGRATION=1 npm run test:integration` calls real Gemini once and returns a parsed 10 by 10 structure for "marketing strategy" creativity 7. Tables exist in Turso.

### Phase 2: Preview endpoint plus temporary preview page (target: one session, 2 to 3 hours)
Build `/api/naming/preview.ts` calling the engine. Build `naming-preview.astro` at the unlinked route, with idle and preview-loaded states matching the Listener's interactive pattern. No nav link, no sitemap entry, no gating, no full report. Just a working preview accessible by direct URL.

Validation: submit "marketing strategy" through the page (you visiting your own unlinked route directly), get 5 names with availability indicators rendered. Run a few seed terms to confirm output quality and use the results as candidate brand names for the tool itself.

### Phase 3: Full scoring (target: one session, 3 hours)
Build `scorer.ts` with rule pass plus LLM batched pass. Build full `ranker.ts` composite plus tier output. Engine returns full 100-name ranked output, used internally by Phase 4's report path. Preview does not change.

Validation: call the engine end-to-end from a test, inspect the ranked output for sensibility. **Brand decision happens here**: run the tool with naming-related seed terms ("naming pipeline", "domain finder", "brand engine", whatever feels right), pick a brand from the output, manually verify the chosen name's availability and check trademark search results before locking. Only commit the choice when satisfied.

### Phase 4: Brand rename plus report job pipeline plus Turnstile plus Brevo plus email (target: one session, 5 to 6 hours)
**First commit on this branch is the rename**: rename `naming/` directories to `<brand>/`, rename routes, rename Brevo tags, rename source field values, rename docs path, run a SQL migration to rename `naming_*` tables to `<brand>_*`. One mechanical commit, easy to review.

Then build `/api/<brand>/report.ts` and `/api/<brand>/status.ts`. Build `report.ts` library generating PDF plus CSV via existing pdfkit plus papaparse. Brevo lead push plus transactional email with linked PDF/CSV (no pricing column in this PDF; pricing is Phase 6). Background processor writes intermediate state to `result_json` after each step (PDF URL, CSV URL, email send confirmation). The Astro page gains the gate-and-status states, polls /status every 3 seconds. `thanks.astro` shows download links. Add the page to main nav.

Validation: submit a real email, watch the page poll, receive the PDF in inbox within roughly 3 minutes. Inspect the job row to confirm intermediate writes happened. Verify the rename commit didn't break any existing routes (the Listener, the portal, the blog all still work).

### Phase 5: Anti-abuse plus trademark heuristic (target: one session, 3 hours)
Per-IP and per-email rate limits via existing `rate-limit.ts`. Gemini quota fallback to Anthropic Haiku. Build `trademark.ts` heuristic via DuckDuckGo on top 30 names. Trademark flags appear in PDF and CSV. Add `methodology.astro` page (SEO and credibility surface).

Validation: rate limits hold under deliberate abuse. A known-trademarked seed term flags `concern_level: likely` in output.

### Phase 6: Namecheap integration (contingent on research)
Begin with a research spike: confirm a clean auth path from App Platform's dynamic egress IPs to Namecheap's API. Test against their sandbox first. If no clean path exists, the phase reduces to "no pricing in this tool" or substitutes a different pricing source. Do not ship scraped pricing.

If research succeeds: build `pricing.ts` with `namecheap.users.getPricing` and 24-hour cache. Add per-domain premium flag check on top 30 names. Pricing column appears in the PDF and CSV. Premium flags appear in the report.

Validation: pricing for `.com` matches public Namecheap retail within reasonable tolerance. A known premium domain flags as premium in output.

### Phase 7: Reliability hardening (only if needed)
Cron to sweep stuck jobs (status='running' for more than 5 minutes), inspect `result_json`, resume from last completed step or mark 'failed'. Optional: split background processing to a dedicated App Platform Worker component if reliability remains a real problem in operation. Skip this phase entirely if intermediate-write recovery from Phase 4 holds up.

### Phase 8: Funnel completion (not code)
Brevo nurture sequence: 3 emails over 2 weeks, ending in consulting offer plus Calendly link. Configured directly in Brevo. Methodology page expansion for SEO targeting. One short post on codyasmith.com/blog explaining the build (visibility play, doubles as launch announcement).

Validation: first lead through the funnel books a discovery call.

## Generation and Scoring Prompts

Carried verbatim from v2. Two adjustments for Gemini's Node SDK: pass `responseMimeType: 'application/json'` and `responseSchema` in `generationConfig` for reliable structured output. Strip leading and trailing markdown fences defensively even with mime type set, since Gemini occasionally adds them.

## Open Questions and Assumed Defaults

Decisions made on your behalf. Override any of them and the spec updates accordingly.

1. URL: temporary unlinked `/naming-preview` during Phase 2, final brand URL at Phase 4 rename.
2. Tool brand decided at Phase 3 by running the tool on itself plus manual verification of the chosen name. Locked at Phase 4 rename commit.
3. No paid tier on the tool itself. It is a lead-gen funnel. The product is your consulting.
4. CLI dropped. v2 had a Typer CLI as a peer surface. v3 drops it.
5. Background processing: fire-and-forget post-response with intermediate state writes. Phase 7 escalates only if needed.
6. Lead storage: reuse existing leads table with `source='naming'` until Phase 4 rename.
7. Pricing deferred to Phase 6, contingent on Namecheap API research. Phases 1 through 5 ship without pricing data in any output.
8. Codebase identifier `naming` is internal only. It does not appear in any public-facing copy, marketing, or domain. The Phase 2 unlinked route is the only public-ish surface and only people who know the URL can reach it.

## Phase 1 Starter Prompt for Claude Code

Hand to Claude Code in a fresh session inside `C:\Users\codya\projects-clean\codyasmith.com`. The spec file at `docs/naming/build_spec_v3.md` must be committed to `main` before this session opens.

```
Build Phase 1 of the naming pipeline tool per docs/naming/build_spec_v3.md.

Phase 1 scope: engine modules plus Turso schema. No API endpoints, no UI.

Note on naming: the tool's public brand is intentionally not chosen yet. The codebase uses the neutral identifier `naming` everywhere (file paths, table prefixes). The brand gets locked at Phase 4 via a single rename commit. Do not invent a brand name during Phase 1.

Before writing code, read these existing files to match patterns and reuse infrastructure:
- src/lib/turso.ts (database client)
- src/lib/email.ts (Brevo integration; for later phases, but understand it now)
- src/lib/rate-limit.ts (rate limiting; for later phases)
- src/lib/pdf.ts or wherever the existing PDF generation lives (used by /api/report)
- src/lib/storage.ts (DO Spaces uploads)
- src/middleware.ts (CSRF and security headers)
- src/pages/api/scan.ts (the closest analog to what /api/naming/report will be)
- package.json (dependency conventions, test framework)

Then create:
- src/lib/naming/types.ts: shared types for runs, names, scores
- src/lib/naming/config.ts: defaults, scoring weights, anti-pattern lists
- src/lib/naming/anti-patterns.ts: forbidden-suffix logic
- src/lib/naming/prompts/generate.ts: system prompt as exported string
- src/lib/naming/generator.ts: Gemini call via @google/generative-ai (add to package.json), with responseMimeType=application/json and a Zod schema (or runtime check) for the 10x10 output, plus 7-day cache via the existing turso client
- src/lib/naming/availability.ts: RDAP lookups via Promise.all chunks of 20, throttled to roughly 10 req/sec
- src/lib/naming/ranker.ts: Phase 1 simple ranker, sort by percent of TLDs available DESC, name length ASC
- src/lib/naming/storage.ts: typed wrappers around Turso queries for runs, names, availability, cache
- migrations/<timestamp>_naming.sql: the Turso schema additions per the spec

Add @google/generative-ai to package.json dependencies. Set GEMINI_API_KEY in .env.example.

Tests:
- Default test suite (npm test or whatever the repo uses) runs only mocked tests against mocked Gemini and mocked RDAP responses. Zero quota burn on a normal run.
- Real-API integration test sits behind INTEGRATION=1 and a separate script (npm run test:integration). When invoked, it calls real Gemini once with seed "marketing strategy" creativity 7, TLDs com,net,co, and verifies the engine returns a parsed 10x10 structure with availability data per (name, tld).
- Run the migration against the local Turso instance, then npm test, then INTEGRATION=1 npm run test:integration. Show me the output of all three.

Do NOT build pricing, scoring, trademark, the API endpoints, the Astro page, or the report generation in this phase.

Read the spec file fully before writing any code. Match existing conventions (TypeScript style, file naming, test patterns) in the codyasmith.com repo. Do not introduce new conventions.

When Phase 1 is done, commit on the phase1-naming-engine branch, push the branch, and open a PR against main. Match whatever PR convention the repo already uses (verify the existing pattern from recent merge commits before opening).
```

## What This Spec Does Not Cover

Mobile responsiveness specifics (Tailwind handles by default; details deferred to Phase 2 implementation). Analytics (whatever the rest of codyasmith.com uses applies here automatically). A/B testing (premature for Phases 1 through 7). Multi-language support (English only). Logo or branded email template design (out of scope for build). The actual nurture sequence content (Phase 8, written separately). Pricing data in any output before Phase 6 ships (the report is useful without prices; do not block Phases 4 or 5 on pricing readiness). The brand name itself (decided at Phase 3, applied at Phase 4 rename commit, not a Claude Code task).
