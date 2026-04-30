# Listener: AFINN to Gemini Sentiment Migration v1

## Dashboard

The Listener tool currently scores web mention sentiment using the AFINN-165 lexicon (`src/lib/sentiment.ts`). This spec migrates per-mention scoring to Gemini-backed LLM analysis with AFINN as a deterministic fallback.

**What changes**: per-mention scoring is rewritten to call Gemini first, fall back to AFINN on any Gemini failure, and cache successful Gemini results in a new `listener_sentiment_cache` Turso table.

**What stays the same**: the `/api/scan` SSE response contract, the existing `generateReport` aggregation (rolled-up score, source breakdown, top phrases, summary, sample mentions, teaser lines), the recommendation engine, the rate-limit posture, the frontend rendering in `listener.astro`, and AFINN itself (which becomes the fallback path, still living at `src/lib/sentiment.ts`).

**Cascade strategy**: cache hit returns cached Gemini result; cache miss calls Gemini; any Gemini failure falls back to AFINN scoring of the same text. Lexicon results are not cached. Scans always complete because the lexicon path is deterministic and never throws.

**SSE preservation**: the `/api/scan` event stream is invariant. Step progression, event shape, and the `complete` payload all stay byte-compatible with what `listener.astro`'s script block reads today.

This spec lives at `docs/listener/gemini_migration_v1.md` on the `main` branch. Implementation lands as one or more code PRs after this spec is merged.

## Why this exists

The Listener is a lead-gen funnel. The free Tier 1 preview decides whether a prospect emails for the gated Tier 2 report. AFINN-165 sentiment scoring works mechanically (it produces a score, a label, and a list of words), but it reads like a template at the user-visible layer: per-mention key phrases are bare lexicon words ("good", "bad", "slow"), summaries lean on generic adjective patterns, and the overall score-to-label mapping does not surface the kinds of specific themes that make a marketing director feel the report was hand-built.

LLM-backed sentiment trades the lexicon's mechanical reliability for the differentiating quality of a brand monitoring analyst's read. Same engine inputs, same engine outputs (the contract holds), better differentiation at the margin where conversion lives.

This decision was made conversationally during the naming pipeline architecture work but never executed. This spec captures the decision, the architecture, and the implementation phasing in one place.

## Current state

Discovery findings from the prior session, summarized for implementation reference:

- **Sentiment in**: a plain text string (`text: string`) goes into `analyzer.analyze(text)` at `src/lib/sentiment.ts:32`. The string is `scrapedMentions[i].full_text`, produced by `scraper.ts` from each web URL, capped at 3000 characters per mention. Failed scrapes fall back to the Serper search snippet, gated on `length > 20`.
- **Sentiment out**: `analyzer.analyze` returns the native `sentiment` package shape (used: `comparative`, `positive`, `negative`). The wrapped `analyzeSingleMention` returns `{ score: number in [-1, 1], label: 'positive' | 'negative' | 'neutral', positive: string[], negative: string[] }`. `generateReport` returns the full `ScanReport` interface defined at `src/lib/sentiment.ts:17-29`.
- **Direct importers of sentiment.ts**: only `src/pages/api/scan.ts:7`. `unlock.ts` and `report.ts` read the persisted shape from the DB; `recommend.ts` takes only `(overallScore, mentionCount)`.
- **`/api/scan` is an SSE stream**, not a JSON response. Events: `{ step, status, detail, data? }`. Steps: `'search' | 'scrape' | 'analyze' | 'report' | 'complete' | 'error'`. The frontend captures `event.data` on `step === 'complete'` and renders Tier 1 from there.
- **No PDF anywhere in the Listener**. `/api/unlock` sends a Brevo HTML email with a link back to `/listener?report=<id>`. `/api/report.ts` returns JSON. `src/lib/pdf.ts` is invoice-only for the portal.
- **No existing test coverage of sentiment.ts**. No `.mjs` runner imports it. No mocks. The migration adds the first test surface.
- **No existing cache for the Listener**. The only caches in the schema are `naming_pricing_cache` and `naming_gemini_cache`, both added by naming Phase 1 migration `012-naming.ts`.

## Architecture: cascade with cache

Per-mention scoring follows this exact path:

1. **Compute cache key** as SHA-256 of `(prompt_version + '|' + model + '|' + full_text)`. The brand name is intentionally not in the key: the same mention text scored against different brand names is a rare enough edge case to skip caching disambiguation; if it surfaces in operation, version the prompt.
2. **Check `listener_sentiment_cache`** for the key.
   - On hit (where `expires_at > now`): return cached result with `scored_by: 'gemini'`. Do not call Gemini.
   - On miss: proceed to step 3.
3. **Call Gemini** with the system prompt and the per-mention user prompt (see Prompt Design).
   - On success: parse and validate the response, write to cache with `expires_at = now + 7 days`, return with `scored_by: 'gemini'`.
   - On any failure (quota, network, timeout, validation): proceed to step 4. Do not write to cache on failure.
4. **AFINN fallback**: run the existing `analyzeSingleMention(text)`, return with `scored_by: 'lexicon'`. The lexicon path is deterministic and never throws. Do not write lexicon results to cache.

Why per-mention rather than batched: failure isolation. One bad mention text or one transient Gemini hiccup must not poison a 50-mention scan. The cascade per mention guarantees every mention gets a score (Gemini or AFINN) and the scan completes. Worst-case latency is dominated by the slowest Gemini call, not by retries against a batched payload.

Why the rate-limit posture is unchanged: the cascade guarantees the scan completes. The current "increment rate-limit before work" pattern at `scan.ts:66` stays. No refund logic. Quota exhaustion drops gracefully to AFINN; the user gets a complete report; the lexicon-rate metric (visible in monitoring, see Test plan and Rollback) signals that Gemini service is degraded.

## Schema additions

One new migration: `src/lib/migrations/013-listener-sentiment-cache.ts`, in the existing TypeScript Migration module format (default export of `{ id, up }`), matching `src/lib/migrations/012-naming.ts`.

Schema:

```sql
CREATE TABLE IF NOT EXISTS listener_sentiment_cache (
  cache_key TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_listener_sentiment_cache_expires
  ON listener_sentiment_cache(expires_at);
```

The shape mirrors `naming_gemini_cache` exactly. A separate table (rather than reusing `naming_gemini_cache` with namespaced keys) keeps the two pipelines decoupled and survives the naming pipeline's Phase 4 brand rename without coupling.

**Type updates** in `src/lib/sentiment.ts`:

```ts
export type ScoredBy = 'gemini' | 'lexicon';

export interface MentionSentiment {
  url: string;
  source_name: string;
  source_type: string;
  snippet: string;
  sentiment_score: number;
  sentiment_label: string;
  key_phrases: string[];
  query_type: string;
  scored_by: ScoredBy;     // NEW in v1
}
```

The `mentions` DB table does not get a new column in v1. The `scored_by` field flows through the `MentionSentiment` object, the SSE `complete` payload, and the `/api/unlock` and `/api/report` JSON responses. It is used for monitoring (lexicon-fallback rate) and is available to the frontend for diagnostic display, but the frontend does not render it in v1.

If per-mention attribution in the persisted scan record turns out to matter (for retroactive analysis or for showing "scored by AI" badges), that is a follow-up migration: add `scored_by TEXT` to the `mentions` table and update `insertMention` accordingly. v1 keeps the persisted schema unchanged.

## Gemini integration

- **SDK**: `@google/generative-ai`, already a direct dependency from naming Phase 1.
- **Model**: `gemini-2.5-flash-lite`, matching the naming pipeline default.
- **Generation config**: `responseMimeType: 'application/json'`, `temperature: 0.2` (low, because sentiment scoring is not a creative task).
- **Response schema**: enforced via the prompt's hand-rolled validation. Zod is not a direct dependency. The validator must reject responses that fail any of: missing required fields, score outside [-1, 1], label outside the four-value enum, themes or key_phrases not arrays of strings.
- **Per-mention call**: one Gemini call per mention. No batching. Per-mention failure isolation is the whole point of the cascade.
- **Quota fallback**: the cascade itself is the quota fallback. Gemini's `RESOURCE_EXHAUSTED` (HTTP 429) is treated like any other Gemini failure: catch the exception, log it for monitoring, fall back to AFINN. **Anthropic Haiku is not wired in v1**. If Gemini quota becomes a sustained pain point, adding Anthropic as a middle layer in the cascade is a v2 change.
- **Markdown fence stripping**: defensive, mirroring `src/lib/naming/generator.ts`. Strip leading and trailing ```json``` fences before `JSON.parse` even though `responseMimeType=application/json` should prevent them.

## Prompt design

The prompt is the IP of this migration. Future iterations are a separate work item; v1 ships with the prompt below.

### System prompt

```
You are a brand monitoring analyst. Your job is to read a single web mention of a specific named brand and produce a structured sentiment assessment that a marketing director could act on.

Read the mention as if you were briefing the director: was the writer's stance toward this brand positive, negative, mixed, or neutral? What specific themes drove that stance? Be precise. Avoid generic adjectives and template phrasing.

Return a JSON object with this exact shape:
{
  "score": number,
  "label": "positive" | "negative" | "neutral" | "mixed",
  "positive_themes": string[],
  "negative_themes": string[],
  "key_phrases": string[]
}

Field rules:
- score: a number in [-1.0, 1.0] with one decimal place. -1.0 is overwhelmingly hostile, 0.0 is neutral or balanced, 1.0 is enthusiastic endorsement.
- label: maps roughly to score. Use "negative" for score at or below -0.3. Use "positive" for score at or above 0.3. Use "neutral" for scores between -0.3 and 0.3 with no strong opposing signals. Use "mixed" only when there are strong positive AND strong negative signals that average out near zero but neither cancels the other.
- positive_themes: 0 to 5 short phrases, 1 to 4 words each, naming positive elements of the mention. "reliable shipping" not "reliable". "responsive support" not "good".
- negative_themes: 0 to 5 short phrases naming negative elements. Same length rule.
- key_phrases: 2 to 5 phrases that most drove your assessment. Multi-word allowed. May overlap with positive_themes or negative_themes.

Edge cases:
- Empty, garbage, or non-English text: return score=0.0, label="neutral", and empty arrays for the three string lists.
- The named brand is mentioned only incidentally and the text is about something else: return label="neutral", score=0.0.
- Off-topic content (spam, boilerplate, link farms): return label="neutral", score=0.0.

Do not include preamble, sign-off, or any text outside the JSON object. Do not wrap the response in markdown fences.
```

### User prompt template

```
Brand: {brand}
Source: {source_type} ({source_name})
URL: {url}

Mention text:
{full_text}

Score this mention's sentiment toward the brand named above.
```

The `{brand}` value is currently held by `scan.ts` and not passed to `sentiment.ts`. The migration adds a brand parameter to the scorer signature, threaded from `scan.ts` through the new scoring path. AFINN's existing function does not need the brand (it operates on text alone), so the lexicon fallback ignores the parameter.

### Mapping LLM output back to MentionSentiment

The LLM returns `score, label, positive_themes, negative_themes, key_phrases`. The migration maps that to the existing `MentionSentiment` shape:

- `sentiment_score` <- `score` (already in [-1, 1], one decimal precision retained or rounded as needed for storage)
- `sentiment_label` <- `label` (already lowercase, four-value enum compatible with existing three-value plus the new 'mixed')
- `key_phrases` <- `key_phrases` (string array, the migration may concatenate `positive_themes[:2]` and `negative_themes[:2]` into `key_phrases` if the model under-fills the latter; precise composition is a Phase 2 implementation choice and should not be premature in this spec)
- `scored_by` <- `'gemini'`

The `positive_themes` and `negative_themes` fields are not stored in v1. They feed `top_positive_phrases` and `top_negative_phrases` aggregation in `generateReport`, which already sorts by frequency across mentions. Implementation: collect per-mention themes during the scoring pass, aggregate frequencies in the existing aggregation step (see Aggregation logic), and surface the top 8 of each.

## SSE preservation

The `/api/scan` SSE contract is invariant. Migration must preserve:

- **Event shape**: `{ step: string, status: string, detail: string, data?: any }`. JSON-encoded, prefixed with `data: ` and terminated by `\n\n`, per Server-Sent Events convention.
- **Step progression**: `'search' | 'scrape' | 'analyze' | 'report' | 'complete' | 'error'`. No new step values in v1.
- **Analyze-step latency**: with AFINN, the `analyze` step finishes in milliseconds. With Gemini, it takes seconds (the slowest call dominates a parallelized run; a serialized run is bounded by sum of latencies). To keep the frontend from appearing hung, emit progress sub-events within the analyze step when a scan has more than 10 mentions. Sub-events use the same `step: 'analyze'` value with `status: 'active'` and a varying `detail` string (for example, `"Analyzing mention 7 of 23"`). Frontend renders these in the existing loading row without code changes; the existing `setStep('analyze', 'active')` plus `loading-text` update handles them.
- **`complete` event payload**: must contain the same fields the frontend reads today: `scan_id, brand, domain, overall_score, overall_label, mention_count, summary, sample_mentions, source_breakdown, teaser_lines, recommendation`. The migration adds `scored_by` per mention (inside `sample_mentions[*]` and, on Tier 2, inside `mentions[*]`), but the payload must remain backward-compatible.
- **Empty-result path**: `scan.ts` lines 86-99 emit a `complete` event with `mention_count: 0, sample_mentions: [], source_breakdown: {}, teaser_lines: []` when no search results land. Migration must keep this path working without calling Gemini.

## Two-casing label preservation

The frontend's `badgeClasses` function (`listener.astro` lines 458-463) accepts both casings:

- Per-mention `sentiment_label`: lowercase. `'positive' | 'negative' | 'neutral' | 'mixed'`.
- Overall `overall_label`: capitalized. `'Strong' | 'Positive' | 'Mixed' | 'Poor'`.

Migration must not collapse these into a single casing. The Gemini scorer returns lowercase per-mention labels. The existing `scoreToLabel` function in `sentiment.ts:44` produces capitalized overall labels and stays unchanged. The frontend's casing-tolerant `badgeClasses` continues to work as-is.

## key_phrases handling

The `key_phrases: string[]` format is preserved.

- AFINN returns single-word lexicon matches ("good", "fast", "slow").
- Gemini returns multi-word themes ("reliable shipping", "slow customer support", "great onboarding").
- The frontend `mentionCard` renders `key_phrases` as small pill chips with no length cap. Both word-shaped and phrase-shaped values render acceptably in v1.
- The DB column stores `key_phrases` as JSON-stringified text (per `scan.ts:122`). The frontend defensively parses (try/catch around `JSON.parse`). Both the new and old shapes round-trip through this layer without changes.
- If multi-word themes start breaking the pill layout in production (likely fine; chip layout is grid-based and wraps), v2 can cap themes at a character length on the frontend. Not a v1 concern.

## Aggregation logic

The aggregation in `generateReport` (`src/lib/sentiment.ts` lines 70-152) is invariant to the source of per-mention scores:

- `overall_score` normalization to [0, 100] is `((avgScore + 1) / 2) * 100`, rounded. This works on any per-mention score in [-1, 1].
- `overall_label` thresholds (`scoreToLabel`, lines 44-49) operate on `overall_score`.
- `source_breakdown[type].avg_score` averages per-mention `sentiment_score` per source type. Works the same.
- `top_positive_phrases` and `top_negative_phrases` are frequency-sorted across all mentions. With AFINN, the inputs are `analyzer.positive` and `analyzer.negative` per mention. With Gemini, the inputs are `positive_themes` and `negative_themes` per mention. The sort-and-slice logic is identical.
- `summary` is built from counts and the top phrases. Logic stays the same.
- `sample_mentions` and `teaser_lines` are derived from the per-mention array. Logic stays the same.

**Implementation note**: do not rewrite the aggregation. Wire the new per-mention scoring into the existing `mentions: MentionSentiment[]` array, and let the rest of `generateReport` run unchanged. The temptation to "refactor while we're in there" is what breaks working code in migrations like this. Resist it for v1.

The single point of integration is `analyzeSingleMention`. The rest of `generateReport` reads the per-mention shape and aggregates. Replace the body of `analyzeSingleMention` (or wrap it in a new `scoreMention` that handles the cascade), preserve the return shape, ship.

## Test plan

Two new test runners in `tests/`, hand-rolled in the `.mjs` style of `tests/run-naming-unit-tests.mjs`. Run via tsx because the runners import `.ts` engine modules.

### tests/run-listener-sentiment-unit-tests.mjs

Mocked Gemini, mocked Turso, in-memory libsql for the cache table, no network.

Coverage:
- Mocked Gemini happy path: cache miss, Gemini returns valid JSON, result is parsed, cached, returned with `scored_by: 'gemini'`.
- Cache hit path: pre-populate the cache table, scoring returns cached result without calling Gemini.
- Mocked Gemini failure paths: thrown error, returned malformed JSON, score outside [-1, 1], label outside the four-value enum, missing required fields. Each path triggers AFINN fallback. Result has `scored_by: 'lexicon'`.
- Empty-text fixture: returns `score=0, label='neutral', empty arrays, scored_by='lexicon'` (or `'gemini'` if the prompt gracefully handles it; both are acceptable).
- Two-casing label round-trip: per-mention labels stay lowercase, `scoreToLabel` produces capitalized overall labels.
- Aggregation with mixed `scored_by`: a 10-mention scan where 7 are 'gemini' and 3 are 'lexicon' produces an `overall_score` and `source_breakdown` consistent with the per-mention scores, regardless of source.
- Cache key stability: same `(text, prompt_version, model)` produces the same SHA-256 key across calls.
- Cache TTL respect: a cache entry with `expires_at < now` is treated as a miss.

### tests/run-listener-sentiment-integration-tests.mjs

Real Gemini, real Turso (file://), gated by `GEMINI_API_KEY` validity (start with "AIza", length 39).

Coverage:
- One real Gemini call against a fixture text: a known-positive paragraph (for example, a synthetic "I love this product, the customer service is amazing" string).
- Verify the response shape matches the schema exactly: `score in [-1, 1]`, `label` is one of the four enum values, `positive_themes` and `negative_themes` are arrays of strings, `key_phrases` length is between 2 and 5.
- Verify cache write happened: query `listener_sentiment_cache` for the expected key after the call.
- Skip with a clear stdout message if `GEMINI_API_KEY` is missing or starts with anything other than `AIza`. Exit code 0 on skip (so CI does not fail when the secret is intentionally omitted).

### npm scripts

`npm test` currently invokes only the naming pipeline runner. Two options:

**Option A (preferred for v1)**: chain both runners with `&&` in the `test` script:
```json
"test": "tsx tests/run-naming-unit-tests.mjs && tsx tests/run-listener-sentiment-unit-tests.mjs"
```

Same chain for `test:integration`.

**Option B**: a new `tests/run-all-unit-tests.mjs` that imports and invokes both runners. Use this if the test count grows beyond the chain pattern's readability (likely v2 or v3).

Phase 1 of this migration ships Option A. Migration to Option B is a follow-up if needed.

## Phased build

Each phase is shippable. Same convention as the naming pipeline: feature branch, PR against main, merge-commit convention.

### Phase 1: Schema, types, validation, test scaffolding

- New migration `src/lib/migrations/013-listener-sentiment-cache.ts` creating the cache table.
- Update `MentionSentiment` in `src/lib/sentiment.ts` to add the `scored_by: ScoredBy` field. Existing call sites in `scan.ts` get default `scored_by: 'lexicon'` for now (since AFINN is still the only path).
- Hand-rolled validation helpers for the LLM response schema (in a new file or inside the scorer module; Phase 2 decides).
- Test runner scaffolding: empty `tests/run-listener-sentiment-unit-tests.mjs` and `tests/run-listener-sentiment-integration-tests.mjs` with the runner-of-runners chain in `package.json`.
- Existing `npm test` keeps passing (now also runs the empty Listener unit runner). Existing scan flow keeps passing (AFINN unchanged).

**Validation**: `npm run migrate:naming` is unchanged; add a `npm run migrate:listener` script invoking `tsx scripts/migrate-listener.ts` (mirror of `scripts/migrate-naming.ts`, applies the listener cache schema). Confirm the cache table exists in `data/dev2.db`. `npm test` passes (zero quota burn).

### Phase 2: Gemini scorer module

- New module (controller decides naming during build; candidates: `src/lib/listener-gemini-scorer.ts`, `src/lib/listener/scorer.ts`, or merging into a new `src/lib/listener/` directory parallel to `src/lib/naming/`). For this spec, use `src/lib/listener/scorer.ts`.
- Implements: cache get, Gemini call with the prompt above, response validation, cache set, failure-fallback to AFINN.
- Reuses `src/lib/naming/generator.ts` patterns for SDK init, response parsing, fence stripping, and the SHA-256 cache key helper. Resist sharing too much code: the two pipelines have different output shapes and prompt designs. Copy what helps, factor out only if a third use case appears.
- Cache get/set typed wrappers, similar to `src/lib/naming/storage.ts`'s pattern.

**Validation**: unit tests cover all cascade paths. Integration test passes one real Gemini call. `npm test` and `npm run test:integration` both green.

### Phase 3: Wire into existing sentiment.ts

- The existing `analyzeSingleMention(text)` becomes the AFINN-only fallback. Rename internally (or keep name; controller decides).
- A new function (proposed name `scoreMention(brand, mention, deps?)`) wraps the cascade and returns the same shape that `analyzeSingleMention` currently returns, plus `scored_by`.
- `generateReport(scrapedMentions, brand)` adds the `brand` parameter. Each mention is scored via `scoreMention`. The rest of `generateReport` runs unchanged.
- `scan.ts` passes `brand` to `generateReport`. Already in scope at the call site (`brand` is parsed at line 63 of `scan.ts`).
- Emit progress sub-events from the analyze step when `scrapedMentions.length > 10`.

**Validation**: full unit and integration test runs pass. Aggregation tests confirm `overall_score`, `overall_label`, `source_breakdown`, `top_positive_phrases`, `top_negative_phrases`, and `summary` produce the same shapes as before for a fixture scan.

### Phase 4: End-to-end manual verification

- Run `npm run dev` locally. Submit a real brand to the Listener at `http://localhost:4321/listener` (or whatever the dev port is). Watch the SSE flow; confirm progress sub-events render in the loading row. Confirm Tier 1 renders. Confirm gated unlock flow still works.
- Compare the report shape against a pre-migration snapshot: same fields, plausible values, no broken pill chips, no 500s in the network tab.
- Confirm the lexicon-fallback rate by inspecting log output: most or all mentions should report `scored_by: 'gemini'` on a stable Gemini service.

**Validation**: a real scan against a real brand produces a coherent Tier 1 report indistinguishable in shape from the AFINN era, with substantively different (more specific, less template-y) per-mention key_phrases and themes.

### Phase 5: PR opens, post-merge soak

- PR opens against main with merge-commit convention.
- After merge, monitor the first 24 hours of real `/api/scan` traffic. Track the lexicon-fallback rate (proportion of mentions with `scored_by: 'lexicon'` versus `'gemini'`). On stable Gemini service, this should be near zero. A sustained non-zero rate signals that Gemini is degraded or that the prompt is being rejected (validation failures triggering fallback).
- If the lexicon-fallback rate exceeds 5% over a 24-hour window, surface it for manual review. Likely fix: prompt tightening, validation loosening, or a Gemini incident waiting itself out. None of these require a rollback to pre-migration code.

**Validation**: 24 hours of clean Gemini-served scans, no funnel regression, no user-visible issues in the email-gated flow.

## Rollback strategy

The cascade IS the rollback. By design, any Gemini failure already routes to AFINN. There is no scenario where a Gemini outage breaks the Listener funnel because the lexicon path is deterministic, local, and never throws.

For an emergency forced rollback (Gemini stays up but is producing bad output, or quota costs blow up unexpectedly), v2 can ship a `LISTENER_USE_LEXICON=true` env var that short-circuits the cascade to AFINN unconditionally. v1 does not ship the flag. The cascade architecture is built so that adding the flag is a one-line change at the top of `scoreMention`:

```ts
if ((import.meta.env.LISTENER_USE_LEXICON || '').trim() === 'true') {
  return analyzeSingleMention(mention.full_text); // with scored_by: 'lexicon'
}
```

Position the change at the top of the function so it bypasses cache lookup, Gemini call, and validation in one branch.

## What this spec does not cover

- **Per-mention `scored_by` persistence**: the `mentions` DB table does not get a new column in v1. Add later if attribution-in-history becomes load-bearing.
- **Anthropic Haiku as a third cascade layer**: deferred. Wire if Gemini quota or quality becomes a sustained problem.
- **Multi-language support**: out of scope. The prompt assumes English. Non-English mentions will likely score as `neutral` with empty themes.
- **UI changes for richer themes**: deferred to v2 polish. The pill-chip layout absorbs multi-word themes acceptably in v1.
- **Migration of any other Listener component**: only sentiment changes. Scraping, search, recommendation, rate-limiting, email, and saved-report flow all stay untouched.
- **Cost ceiling instrumentation**: v1 relies on Gemini's free-tier limits and the existing `getMonthlySearchCount` budget gate. If LLM cost becomes a real concern, instrument it in v2.
- **A/B test of LLM versus lexicon scoring on funnel conversion**: deferred. The decision to migrate is on conviction, not measurement. Post-migration monitoring is for failure detection, not for a formal A/B comparison.
