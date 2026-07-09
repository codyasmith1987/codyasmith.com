# Accessibility (WCAG) Health Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the already-ingested `accessibility_urls` per-URL WCAG data as a client-facing widget on `/portal/health`, matching the existing per-URL widgets.

**Architecture:** Extend the existing `GET /portal/api/dashboard/url-insights` endpoint with an `accessibility` aggregate block (mirroring the crawl/image/redirect blocks already there), then render one `widgetCard` on `health.astro` gated on the new `has_accessibility_data` flag. The only logic complex enough to unit-test (WCAG bucket labeling + NULL coalescing) is extracted into a pure helper and tested in isolation; the rest is verified by build + read-only prod check, because the endpoint's SQL is embedded in the route handler and the repo has no DB-backed endpoint test harness.

**Tech Stack:** Astro SSR endpoint (TypeScript), Turso/libSQL (`turso.execute`), vanilla-JS client render in `health.astro`, tsx test runner (`.mjs` test files, node:assert).

---

## File Structure

- **Create:** `src/lib/dashboard/accessibility-insights.ts` — pure helpers: `WCAG_BUCKETS` (column→label map) and `buildAccessibilityByLevel(rows)` + `emptyAccessibility()`. Isolated so it is unit-testable without a DB.
- **Create:** `tests/run-accessibility-insights-tests.mjs` — unit tests for the pure helpers.
- **Modify:** `src/pages/portal/api/dashboard/url-insights.ts` — add `has_accessibility_data` + `accessibility` to the response type, the zeroed default, and the populated block; import the pure helpers.
- **Modify:** `src/pages/portal/health.astro` — add `has_accessibility_data` to the section gate (line ~649) and push one accessibility `widgetCard` (before the `if (cards.length > 0)` block, line ~844).
- **Modify:** `package.json` — add the new test file to the `test` script chain.

---

## Task 1: Pure helpers for WCAG bucket labeling

**Files:**
- Create: `src/lib/dashboard/accessibility-insights.ts`
- Test: `tests/run-accessibility-insights-tests.mjs`

- [ ] **Step 1: Write the pure helper module**

Create `src/lib/dashboard/accessibility-insights.ts`:

```typescript
// Pure helpers for the accessibility (WCAG) URL-insights aggregate.
// Extracted from the url-insights endpoint so the bucket-labeling and
// NULL-coalescing logic is unit-testable without a database.

// The seven per-URL WCAG count columns on accessibility_urls, mapped to
// the human labels shown in the client widget. Order = display order.
export const WCAG_BUCKETS: Array<{ column: string; label: string }> = [
  { column: 'wcag_20a_violations', label: 'WCAG 2.0 A' },
  { column: 'wcag_20aa_violations', label: 'WCAG 2.0 AA' },
  { column: 'wcag_20aaa_violations', label: 'WCAG 2.0 AAA' },
  { column: 'wcag_21a_violations', label: 'WCAG 2.1 A' },
  { column: 'wcag_21aa_violations', label: 'WCAG 2.1 AA' },
  { column: 'wcag_22a_violations', label: 'WCAG 2.2 A' },
  { column: 'wcag_22aa_violations', label: 'WCAG 2.2 AA' },
];

export interface AccessibilitySample {
  url: string;
  all_violations: number;
  status_code: number | null;
}

export interface AccessibilityInsights {
  pages_with_violations: number;
  total_violations: number;
  by_level: Record<string, number>;
  samples: AccessibilitySample[];
}

export function emptyAccessibility(): AccessibilityInsights {
  return { pages_with_violations: 0, total_violations: 0, by_level: {}, samples: [] };
}

// Given a map of { bucketColumn: pageCount }, return an ordered
// { label: count } object containing only buckets with a positive count.
// NULL / undefined / non-numeric counts coalesce to 0 and are dropped.
export function buildAccessibilityByLevel(
  counts: Record<string, number | null | undefined>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { column, label } of WCAG_BUCKETS) {
    const raw = counts[column];
    const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    if (n > 0) out[label] = n;
  }
  return out;
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/run-accessibility-insights-tests.mjs`:

```javascript
import assert from 'node:assert';
import {
  WCAG_BUCKETS,
  emptyAccessibility,
  buildAccessibilityByLevel,
} from '../src/lib/dashboard/accessibility-insights.ts';

let passed = 0;
function test(name, fn) { fn(); console.log(`[PASS] ${name}`); passed++; }

test('WCAG_BUCKETS has the seven per-URL columns', () => {
  assert.strictEqual(WCAG_BUCKETS.length, 7);
  assert.deepStrictEqual(
    WCAG_BUCKETS.map(b => b.column),
    ['wcag_20a_violations','wcag_20aa_violations','wcag_20aaa_violations',
     'wcag_21a_violations','wcag_21aa_violations','wcag_22a_violations','wcag_22aa_violations'],
  );
});

test('emptyAccessibility is fully zeroed', () => {
  assert.deepStrictEqual(emptyAccessibility(), {
    pages_with_violations: 0, total_violations: 0, by_level: {}, samples: [],
  });
});

test('buildAccessibilityByLevel keeps only positive buckets, in order', () => {
  const out = buildAccessibilityByLevel({
    wcag_20a_violations: 3,
    wcag_20aa_violations: 0,
    wcag_21aa_violations: 5,
  });
  assert.deepStrictEqual(out, { 'WCAG 2.0 A': 3, 'WCAG 2.1 AA': 5 });
  // insertion order follows WCAG_BUCKETS order
  assert.deepStrictEqual(Object.keys(out), ['WCAG 2.0 A', 'WCAG 2.1 AA']);
});

test('buildAccessibilityByLevel coalesces NULL/undefined/NaN to 0 and drops them', () => {
  const out = buildAccessibilityByLevel({
    wcag_20a_violations: null,
    wcag_20aa_violations: undefined,
    wcag_20aaa_violations: NaN,
    wcag_21a_violations: 2,
  });
  assert.deepStrictEqual(out, { 'WCAG 2.1 A': 2 });
});

test('buildAccessibilityByLevel returns {} for all-zero input', () => {
  assert.deepStrictEqual(buildAccessibilityByLevel({ wcag_20a_violations: 0 }), {});
});

console.log(`\n${passed}/${passed} passed`);
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx tsx tests/run-accessibility-insights-tests.mjs`
Expected: `5/5 passed` (the module from Step 1 satisfies these; this is a write-module-then-test slice since the helper is trivial and the test is the spec).

- [ ] **Step 4: Wire the test into the suite**

Modify `package.json` `test` script: append ` && tsx tests/run-accessibility-insights-tests.mjs` to the end of the existing `test` chain (immediately after `run-no-em-dash-lint.mjs`).

- [ ] **Step 5: Run the full suite to confirm nothing broke**

Run: `npm test`
Expected: all suites pass, ending with `5/5 passed` from the new file.

- [ ] **Step 6: Commit**

```bash
git add src/lib/dashboard/accessibility-insights.ts tests/run-accessibility-insights-tests.mjs package.json
git commit -m "feat: pure helpers for accessibility WCAG url-insights aggregate"
```

---

## Task 2: Add the accessibility block to the url-insights endpoint

**Files:**
- Modify: `src/pages/portal/api/dashboard/url-insights.ts`

- [ ] **Step 1: Import the pure helpers**

At the top of `url-insights.ts`, after the existing imports (`turso`, `logger`), add:

```typescript
import {
  WCAG_BUCKETS,
  emptyAccessibility,
  buildAccessibilityByLevel,
  type AccessibilityInsights,
} from '../../../../lib/dashboard/accessibility-insights';
```

- [ ] **Step 2: Add fields to the `UrlInsightsResponse` interface**

In the `interface UrlInsightsResponse { ... }`, add a `has_accessibility_data` flag next to the other `has_*` flags, and an `accessibility` member typed as the imported interface:

```typescript
  has_accessibility_data: boolean;
```

and, alongside the other category members (e.g. after `inbound_broken_links`):

```typescript
  accessibility: AccessibilityInsights;
```

- [ ] **Step 3: Resolve the latest accessibility month**

In the handler, alongside the other `MAX(month)` resolutions (after the `linkMonth` block), add:

```typescript
    const accessibilityMonthRow = await turso.execute({
      sql: 'SELECT MAX(month) FROM accessibility_urls WHERE client_id = ?',
      args: [clientId],
    });
    const accessibilityMonth = (accessibilityMonthRow.rows[0]?.[0] as string | null) ?? null;
```

- [ ] **Step 4: Set the flag and zeroed default in the response literal**

In the `const response: UrlInsightsResponse = { ... }` literal, add to the `has_*` group:

```typescript
      has_accessibility_data: !!accessibilityMonth,
```

and add to the category members (after `inbound_broken_links: {...},`):

```typescript
      accessibility: emptyAccessibility(),
```

- [ ] **Step 5: Populate the accessibility block when data exists**

After the `if (linkMonth) { ... }` block and before `return json(response);`, add:

```typescript
    // Accessibility (WCAG) widget. Per-URL violation counts from
    // accessibility_urls. by_level coalesces NULL buckets to 0 via the
    // pure helper so a partial export cannot miscount or throw.
    if (accessibilityMonth) {
      const aCounts = await turso.execute({
        sql: `SELECT
                SUM(CASE WHEN all_violations > 0 THEN 1 ELSE 0 END) AS pages_with,
                COALESCE(SUM(all_violations), 0) AS total
              FROM accessibility_urls
              WHERE client_id = ? AND month = ?`,
        args: [clientId, accessibilityMonth],
      });
      const ac = aCounts.rows[0] as any;
      response.accessibility.pages_with_violations = Number(ac?.[0] || 0);
      response.accessibility.total_violations = Number(ac?.[1] || 0);

      // Per-bucket page counts: one SUM(CASE...) per WCAG column.
      const levelSelects = WCAG_BUCKETS
        .map(b => `SUM(CASE WHEN ${b.column} > 0 THEN 1 ELSE 0 END) AS ${b.column}`)
        .join(',\n                ');
      const levelRow = await turso.execute({
        sql: `SELECT
                ${levelSelects}
              FROM accessibility_urls
              WHERE client_id = ? AND month = ?`,
        args: [clientId, accessibilityMonth],
      });
      const lr = levelRow.rows[0] as any;
      const countsByColumn: Record<string, number> = {};
      WCAG_BUCKETS.forEach((b, i) => { countsByColumn[b.column] = Number(lr?.[i] || 0); });
      response.accessibility.by_level = buildAccessibilityByLevel(countsByColumn);

      const aSamples = await turso.execute({
        sql: `SELECT url, all_violations, status_code FROM accessibility_urls
              WHERE client_id = ? AND month = ?
                AND all_violations > 0
              ORDER BY all_violations DESC, url LIMIT ?`,
        args: [clientId, accessibilityMonth, SAMPLE_LIMIT],
      });
      response.accessibility.samples = (aSamples.rows as any[]).map(r => ({
        url: String(r[0]),
        all_violations: Number(r[1] || 0),
        status_code: r[2] != null ? Number(r[2]) : null,
      }));
    }
```

Note: `WCAG_BUCKETS[i].column` values are hardcoded constants (no user input), so interpolating them into the SQL is safe; `clientId` and `month` stay parameterized.

- [ ] **Step 6: Build to verify the endpoint compiles**

Run: `npm run build`
Expected: build completes, server built, `postbuild-assert-sitemap` passes. No TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/pages/portal/api/dashboard/url-insights.ts
git commit -m "feat: accessibility WCAG aggregate in url-insights endpoint"
```

---

## Task 3: Render the accessibility widget on the health page

**Files:**
- Modify: `src/pages/portal/health.astro`

- [ ] **Step 1: Add the flag to the section gate**

Find (around line 649):

```javascript
      if (!data.has_crawl_data && !data.has_image_data && !data.has_redirect_data) return;
```

Replace with (so a client with ONLY accessibility data still renders the section):

```javascript
      if (!data.has_crawl_data && !data.has_image_data && !data.has_redirect_data && !data.has_link_data && !data.has_accessibility_data) return;
```

- [ ] **Step 2: Push the accessibility widget**

Immediately before the `if (cards.length > 0) {` block (around line 844), add:

```javascript
      // ----- Accessibility (WCAG) -----
      if (data.has_accessibility_data && data.accessibility.pages_with_violations > 0) {
        const ac = data.accessibility;
        const byLevelItems = Object.entries(ac.by_level)
          .map(([k, v]) => `<li>${escapeHtml(k)} <span class="text-neutral-400">${v} page${v !== 1 ? 's' : ''}</span></li>`)
          .join('');
        const byLevelHtml = byLevelItems
          ? `<p class="text-[10px] font-mono text-neutral-500 mt-3 uppercase tracking-wide">By standard</p>
             <ul class="mt-2 space-y-1.5 text-[11px] font-mono text-neutral-400">${byLevelItems}</ul>`
          : '';
        cards.push(widgetCard({
          id: 'widget-accessibility',
          title: 'Accessibility',
          description: 'Pages with accessibility issues that can affect visitors who use assistive technology such as screen readers. Each count is the number of issues the audit flagged on that page.',
          stat_lines: [
            { count: ac.pages_with_violations, label: 'pages with issues', severity: 'medium' },
            { count: ac.total_violations, label: 'total issues found', severity: ac.total_violations > 0 ? 'medium' : 'ok' },
          ],
          sample_html: byLevelHtml + renderUrlList(ac.samples,
            x => `<li>${urlLink(x.url)} <span class="text-neutral-400">${x.all_violations} issue${x.all_violations !== 1 ? 's' : ''}</span></li>`),
        }));
      }
```

- [ ] **Step 3: Build to verify the page compiles**

Run: `npm run build`
Expected: build completes clean, sitemap assert passes.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all suites pass (this change is client-render JS inside `.astro`, not exercised by the unit suites; the run confirms nothing regressed).

- [ ] **Step 5: Commit**

```bash
git add src/pages/portal/health.astro
git commit -m "feat: accessibility WCAG widget on the health page"
```

---

## Task 4: Ship and verify

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/accessibility-health-widget
```

- [ ] **Step 2: Open the PR** (no Claude attribution in title or body)

```bash
gh pr create --repo codyasmith1987/codyasmith.com --base main --head feat/accessibility-health-widget \
  --title "Accessibility (WCAG) health widget" \
  --body "<summary: surfaces existing accessibility_urls per-URL WCAG data as a gated widget on /portal/health, matching the existing per-URL widgets. New: url-insights accessibility aggregate + pure helper + unit test. No new tables/migration/parser. Verified: npm test, npm run build.>"
```

- [ ] **Step 3: Merge** (ff to main, push triggers DO deploy) — only after Cody's go per convention.

- [ ] **Step 4: Read-only prod verification against Cody Test ONLY**

After the DO deploy reaches ACTIVE: log in as the Cody Test client (or admin scoped to a client that has accessibility data), GET `/portal/health`, and confirm the accessibility widget renders when `accessibility_urls` has data and is absent when it does not. Read-only; no real client touched; no test data created against a real client. Per the "local tests don't validate prod" rule, this closes the loop — a green build alone does not.

---

## Notes / guardrails carried from session rules

- No prod writes during development.
- No Claude/AI attribution on any commit or PR.
- Nothing touches the Raised Bar proposal or any `raised_bar` file.
- Single-client, latest-month scope only — no multi-site picker, no detail page, no per-violation-rule drilldown (YAGNI; those are not this slice).
