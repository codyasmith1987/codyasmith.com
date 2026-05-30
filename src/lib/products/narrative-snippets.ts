// Per-engagement narrative snippet library.
//
// Each product carries inline default narrative for its standard
// pitch (see web-management.ts, marketing-consulting.ts, etc.). This
// file holds extension snippets indexed by named keys for cases where
// a specific client's combination of product-mix + ecosystem + variables
// calls for a more specific pitch than the defaults.
//
// Population convention: each entry is hand-authored Cody-voice prose.
// Voice rules enforced by the entries themselves:
//   - AP style, no em or en dashes ever
//   - First person as Cody
//   - Plain language, full brand names
//   - No preambles, no sign-offs
//   - No internal exposure: no file paths, admin URLs, version markers,
//     drafter notes, source-doc citations, workflow descriptions
//   - No tier names in client copy
//   - No outcome promises (revenue, conversions, leads)
//
// Pattern: name a key from the combination it serves, then write the
// snippet as a function that returns a NarrativeSnippetSet. The
// composer in index.ts looks up the registry by combo + ecosystem +
// urgency. When a snippet fires, its non-empty buckets REPLACE the
// per-product inline defaults; empty buckets in the snippet fall back
// to the concatenated inline contributions. That gives the snippet
// author control: override what you want to override, leave the rest
// to the product modules.

import type {
  NarrativeSnippetSet,
  ProductContext,
  ProductId,
} from './types';

// =========================================================================
// Override registry
// =========================================================================
//
// Key format: `${product_combo}::${ecosystem}::${urgency}` where
// any segment may be '*' for "any value." The composer looks up the
// most-specific match first, falling back to less-specific keys.
//
// product_combo: alphabetized, '+' joined. Examples:
//   'web-management'
//   'marketing-consulting+web-management'
//   'build+web-management'
//
// ecosystem: 'A' | 'B' | 'C' | '*'. For multi-product combos, refers
// to Web Management's ecosystem when WM is in the mix, otherwise the
// first product's ecosystem.
//
// urgency: 'tactical' | 'growth' | 'maintenance' | '*'.

const SNIPPET_REGISTRY: Record<string, (ctx: ProductContext) => NarrativeSnippetSet> = {

  // =======================================================================
  // 1. Single-site, mid-footprint, time-sensitive
  // =======================================================================
  // WM only, Ecosystem B (30-150 pages), tactical urgency. The most
  // common shape: a working mid-size site needing to be handed off
  // to someone who will own it.
  'web-management::B::tactical': (ctx) => {
    const clientName = clientNameFromCtx(ctx);
    const angle = firstSalesAngleFromCtx(ctx);
    return {
      intro_lines: [
        `You have a real site. A specific problem you want fixed. The right answer is steady ownership from here.`,
      ],
      what_i_see_paragraphs: [
        `${clientName}'s site is a real, working site. A plugin going stale. A form that started misfiring. A piece of content that no longer says the right thing. None of it is dramatic on any given day. It adds up across months, and it adds up faster when nobody owns it.`,
        `What I see you buying out of is the unevenness. The site goes well when you can get to it. It goes quiet when you cannot. Per-task work means a new estimate, a new invoice, a new wait every time something small comes up, and the smallest items end up taking the longest to get done. There is no one whose week the site sits inside. That gap is what the engagement closes.`,
      ],
      what_i_recommend_paragraphs: [
        `I recommend <strong>Web Management</strong> on a monthly basis for the ${clientName} site. The monthly fee covers hosting, daily backups, security and uptime monitoring, and software updates on the contracted cadence. A pool of hands-on hours sits ready every month for active work: edits, page builds, small fixes, content updates, the running list of things the site actually needs. I am the one whose week it sits inside.`,
        `The trade is worth naming plainly. The monthly is predictable. The hours are use-it-or-lose-it. A month with light work does not roll its hours into a heavier month later. That is how the math holds. You get a known number every month, a known cadence of work, a known response window. I get a steady relationship instead of a string of one-off estimates. Predictability is the trade.`,
      ],
      closer_tie_back: angle
        ? `Your own pitch leads with this: ${angle} Steady ownership is what keeps a promise like that from quietly going stale across the months. Predictability for you is what predictability lets me deliver.`
        : '',
    };
  },

  // =======================================================================
  // 2. WM + MC, growth-mode mid-market
  // =======================================================================
  // Both products in scope, both at Ecosystem B (30-150 pages for WM,
  // $1M-$10M revenue for MC), urgency growth. The flagship combo for
  // a business actively pushing on both site and decisions.
  'marketing-consulting+web-management::B::growth': (ctx) => {
    const clientName = clientNameFromCtx(ctx);
    const industry = industryFromCtx(ctx);
    const angle = firstSalesAngleFromCtx(ctx);
    return {
      intro_lines: [
        `You are not asking for one thing.`,
        `You are asking for the site managed and the bigger questions thought through, and those are two separate jobs.`,
      ],
      what_i_see_paragraphs: [
        `${clientName} is in active growth, which puts pressure in two directions at once. The site has more to carry: more pages, more updates, more surface area where things can quietly break. At the same time, the room is making decisions that were not on the table last year. Which markets to push into. How to position against competitors who are also moving. Where the next role should sit. The site work and the decision work are two different jobs. Treating them as one engagement is how both end up half-served.`,
        `The ${industry} businesses I see at this stage are usually a step ahead of their own systems. You can feel the next stage of the business before the website, the content, or the in-room thinking has caught up to it. That gap is not a problem so long as it is named. The operator who built the business is the same operator carrying the next set of choices. The day there is no outside thinker in the conversation is the day those choices start running on instinct alone.`,
      ],
      what_i_recommend_paragraphs: [
        `I recommend <strong>Web Management</strong> as the execution layer for the ${clientName} site. The monthly fee covers hosting, daily backups, security and uptime monitoring, and software updates on the contracted cadence. A monthly pool of hands-on hours covers active work: edits, page builds, small fixes, content updates, the running list a working site accumulates. The cadence is known. The number is known. The site stops being a thing you have to remember to think about.`,
        `I recommend <strong>Marketing Consulting</strong> as the strategic layer applied to the whole business, not just the site. Scope is marketing, search and content strategy, brand positioning, plus adjacent advisory like operations or hiring guidance for marketing or web roles when you want outside thinking on the questions that fall outside the day-to-day. The engagement opens with a research-grade audit and runs on an ongoing cadence of strategy work after that. Sold once for the whole business. Never multiplied across sites or entities.`,
        `<strong>Marketing Consulting</strong> is advice. That is the format and it is what makes it work. The fee buys attention and research, not unlimited production. When consulting work needs to be executed on the site, those hours come out of the <strong>Web Management</strong> pool. When it needs to be executed off the site, it gets a separate statement of work. Strategy is named in one place. Executed somewhere else. The boundary is what keeps either one from getting watered down.`,
      ],
      closer_tie_back: angle
        ? `Your own pitch leads with this: ${angle} The engagement runs in two layers because a promise like that gets executed in two places: in the site customers see, and in the decisions that shape what they see next.`
        : '',
    };
  },

  // =======================================================================
  // 3. WM only, mid-footprint, fallback for non-tactical urgencies
  // =======================================================================
  // WM only, Ecosystem B, any urgency other than tactical. The calmer
  // version of snippet 1: the site is not on fire and the goal is
  // keeping it that way.
  'web-management::B::*': (ctx) => {
    const clientName = clientNameFromCtx(ctx);
    const angle = firstSalesAngleFromCtx(ctx);
    return {
      intro_lines: [
        `This is the version where nothing is on fire. The goal is keeping it that way.`,
      ],
      what_i_see_paragraphs: [
        `${clientName}'s site is established and working. It carries the company's story and holds the pages a customer or a search engine expects to find. A site like this does not need rescuing. It needs ongoing attention. Software ages. Security surface area widens with every plugin. Content drifts out of date a paragraph at a time. The risk is slow erosion.`,
      ],
      what_i_recommend_paragraphs: [
        `I recommend <strong>Web Management</strong> on a monthly basis for the ${clientName} site. The monthly fee covers hosting, daily backups, security and uptime monitoring, and software updates on the contracted cadence. Those four lines run in the background every day. They are how a site this size stays running while nobody is looking at it, and they are also how it stays out of the moments where one missed update turns into a recovery weekend.`,
        `A pool of hands-on hours sits ready every month for active work. A monthly health report comes with it, so you can see what was touched, what was found, and what is coming. A known cadence. A known number. A known place to send things when they come up. Nothing about this is reactive. It is the version of the relationship where the site stops being a thing you have to remember to think about.`,
      ],
      closer_tie_back: angle
        ? `Your own pitch leads with this: ${angle} Slow erosion is what undoes a claim like that. Ongoing attention is what keeps it true.`
        : '',
    };
  },

  // =======================================================================
  // 4. WM + MC, ecosystem-agnostic catch-all
  // =======================================================================
  // Both products in scope, any ecosystem, any urgency. Fallback when
  // no more specific WM+MC snippet matches. Fills what_i_recommend only;
  // what_i_see falls back to per-product inline defaults.
  'marketing-consulting+web-management::*::*': (ctx) => {
    const clientName = clientNameFromCtx(ctx);
    const angle = firstSalesAngleFromCtx(ctx);
    return {
      what_i_recommend_paragraphs: [
        `I recommend <strong>Web Management</strong> as the execution layer for the ${clientName} site. The monthly fee covers hosting, daily backups, security and uptime monitoring, and software updates on the contracted cadence. A monthly pool of hands-on hours covers active site work. The site runs and improves every month on a known cadence, not as a string of one-off estimates.`,
        `I recommend <strong>Marketing Consulting</strong> as the strategic layer for the business as a whole. Scope is marketing, search and content strategy, brand positioning, plus adjacent advisory when you want outside thinking on operations, hiring, or vendor selection. The format is what makes it work. <strong>Marketing Consulting</strong> is advice. Execution on the site comes out of <strong>Web Management</strong> hours. Execution off the site gets its own statement of work.`,
      ],
      closer_tie_back: angle
        ? `Your own pitch leads with this: ${angle} The engagement protects a promise like that in two places: the site that shows it, and the strategy that keeps deciding what to show.`
        : '',
    };
  },

  // =======================================================================
  // 5. Build + WM, new site that lands on management at launch
  // =======================================================================
  // A new site being built, then moving onto management. Any ecosystem.
  // Includes rollout_phases for the build/launch/ongoing arc.
  'build+web-management::*::*': (ctx) => {
    const clientName = clientNameFromCtx(ctx);
    const industry = industryFromCtx(ctx);
    const urgency = urgencyFromCtx(ctx);
    const angle = firstSalesAngleFromCtx(ctx);
    return {
      intro_lines: [
        `This engagement starts with a one-time build and ends in an ongoing relationship.`,
        `The ${urgency} side of ${clientName}'s situation shapes the order. The handoff between the build and what catches it is what makes the engagement work.`,
      ],
      what_i_see_paragraphs: [
        `${clientName} needs a site built. The shape of that need can be a ${industry} business standing up its first real marketing site. A parent company spinning up a sub-brand on its own URL. An existing site whose current setup has outgrown the work the business now wants it to do. The first decision is the build. The second decision, the one most builds skip, is what catches the site after launch.`,
      ],
      what_i_recommend_paragraphs: [
        `I recommend the <strong>Build</strong> as a fixed-fee project, separately scoped from <strong>Web Management</strong> with its own statement of work, milestones, and deliverables. The fee buys the site itself: information architecture, design, page production, the search-engine foundation, forms, and launch. The work is deliberately not a catch-all for any web project a business might want done. Ecommerce platforms, custom web applications, and from-scratch plugin or theme development are out of scope and need a different vendor. The scope is clean because the scope is named.`,
        `The site lands on <strong>Web Management</strong> at launch. The day the build goes live, two things start: the monthly fee, and the hours pool. Hosting, daily backups, security and uptime monitoring, and software updates on the contracted cadence cover the running of the site. Hands-on hours every month cover the active work: edits, content updates, small fixes, the things every working site needs from week one. The build is the entry. <strong>Web Management</strong> is the relationship.`,
        `The reason to name the launch handoff in writing is the most common failure mode of a new site. The site is built. The project closes. A few months later nobody owns the upkeep. That is not this engagement. From the day the site goes live, the upkeep is mine, billed monthly, on a known number and a known cadence. Any additional builds inside the same engagement come at 20 percent off the first.`,
      ],
      rollout_phases: [
        {
          phase_num: 'Phase 1',
          h3: 'Scoping, design, and build',
          html: `I scope the build with you against an agreed page list and feature set, then design and produce the site against that scope. Anything past the scope becomes a change order, quoted separately and approved before it begins. The build fee is paid in full at signing, and work begins once it clears.`,
        },
        {
          phase_num: 'Phase 2',
          h3: 'Launch and handoff to management',
          html: `I take the site live, point the domain, and run the launch checklist: search-engine submission, redirect map if there was an older site, analytics in place, forms tested. The day the site goes live, the <strong>Web Management</strong> monthly fee starts. The included hours pool opens. The build closes. The management relationship begins.`,
        },
        {
          phase_num: 'Phase 3',
          h3: 'Ongoing site management',
          html: `From launch forward, the site sits inside the standard <strong>Web Management</strong> cadence: hosting, daily backups, security and uptime monitoring, and software updates on the contracted cadence. A pool of hands-on hours every month covers active work. Edits, page additions, content updates, small fixes all draw from that pool. There is no second onboarding.`,
        },
      ],
      closer_tie_back: angle
        ? `Your own pitch leads with this: ${angle} The site I build is what makes that promise visible online. The management I run after launch is what keeps it visible.`
        : '',
    };
  },

  // =======================================================================
  // 6. MC only, mid-revenue
  // =======================================================================
  // Marketing Consulting standalone, Ecosystem B ($1M-$10M revenue),
  // any urgency. The thinking-partner subscription shape.
  'marketing-consulting::B::*': (ctx) => {
    const clientName = clientNameFromCtx(ctx);
    const angle = firstSalesAngleFromCtx(ctx);
    return {
      intro_lines: [
        `You are looking for someone to think with you on the questions that sit above the day-to-day.`,
      ],
      what_i_see_paragraphs: [
        `A business at your stage runs into a particular set of decisions every quarter. How to position against competitors moving on the same customers. Which content strategy maps to where the search audience is going. Whether the brand is still saying what the business now sells. Whether the marketing role you have is the right one. Whether the vendors around it still are. None of these have a right answer in a book. They have a right answer for ${clientName}, in this market, this year.`,
      ],
      what_i_recommend_paragraphs: [
        `I recommend <strong>Marketing Consulting</strong> as a thinking-partner subscription for the business. The engagement opens with a research-grade audit: competitors, search and keyword landscape, content gaps, brand positioning, the state of the in-room strategy as it actually exists today. After the audit, the engagement runs on an ongoing cadence of strategy work, with the rhythm and depth set in the agreement. Sold once for the whole business. Not per site. Not per entity.`,
        `<strong>Marketing Consulting</strong> is advice. That is the format. It is also the value. The fee buys attention and research, not unlimited production. When a recommendation needs to be implemented, the implementation routes through a separate statement of work. Not through the consulting fee. You are paying for a thinker who is in the work with you. Not a vendor who will quietly absorb scope until the engagement loses its shape.`,
      ],
      closer_tie_back: angle
        ? `Your own pitch leads with this: ${angle} Thinking-partner work is how a promise like that stays sharp as the market keeps moving.`
        : '',
    };
  },

  // =======================================================================
  // 7. WM only, large footprint
  // =======================================================================
  // WM only, Ecosystem C (150+ pages), any urgency. Larger orgs with
  // deeper sites; the engagement is sized to the footprint.
  'web-management::C::*': (ctx) => {
    const clientName = clientNameFromCtx(ctx);
    const pageCount = pageCountFromCtx(ctx);
    const angle = firstSalesAngleFromCtx(ctx);
    return {
      intro_lines: [
        `A site of this depth is operating infrastructure. The engagement should be sized to that reality.`,
      ],
      what_i_see_paragraphs: [
        `The ${clientName} site carries ${pageCount} pages. That is a real, deep site, not a brochure site, and the math changes at this size. More pages means more places a link can break. More content means more drift between what a page says and what the business does today. More plugins and integrations means more security surface area. The work to keep all of it running is steady and ongoing, not a quarterly cleanup.`,
      ],
      what_i_recommend_paragraphs: [
        `I recommend <strong>Web Management</strong> on a monthly basis for the ${clientName} site, at the higher hours pool a larger footprint requires. The monthly fee covers hosting, daily backups, security and uptime monitoring, and software updates on the contracted cadence. The hours pool is sized to the site itself. More updates to vet before they ship. More pages to keep current. More places to check when something upstream has shifted. The hours match the site, not the average.`,
        `The monthly health report and the maintenance cadence run as an operational rhythm, not a reactive one. You see what was touched. What was found. What is queued for the next cycle. What is being watched. What is being deferred, and why. A site this size goes off the rails when nobody is paying attention. It stays running when someone is paying attention every week. The shape of the engagement is what holds that posture in place.`,
      ],
      closer_tie_back: angle
        ? `Your own pitch leads with this: ${angle} A site this size goes quiet about a promise like that the moment nobody is paying attention to it. The engagement is how someone keeps paying attention.`
        : '',
    };
  },

  // =======================================================================
  // 8. WM only, small footprint
  // =======================================================================
  // WM only, Ecosystem A (under 30 pages), any urgency. Solo or small
  // business with a focused light site.
  'web-management::A::*': (ctx) => {
    const clientName = clientNameFromCtx(ctx);
    const pageCount = pageCountFromCtx(ctx);
    const angle = firstSalesAngleFromCtx(ctx);
    return {
      intro_lines: [
        `A small site is the right shape for what the business needs. The engagement should match it, not pad it out.`,
      ],
      what_i_see_paragraphs: [
        `The ${clientName} site is small by design. ${pageCount} pages doing one or two things well is a clean shape for a focused business. Sites at this scale do not benefit from being managed as if they were bigger. They benefit from being managed honestly. The things a small site needs. On a steady cadence. Nothing on top of that.`,
      ],
      what_i_recommend_paragraphs: [
        `I recommend <strong>Web Management</strong> on a monthly basis for the ${clientName} site, sized to the site itself. The monthly fee covers hosting, daily backups, security and uptime monitoring, and monthly software updates. A small but real pool of hands-on hours covers active work: edits, small fixes, content updates, the things a working site picks up across a month. The shape of the engagement matches the shape of the site. Nothing about that is a compromise.`,
      ],
      closer_tie_back: angle
        ? `Your own pitch leads with this: ${angle} A small site managed honestly is the shape that promise takes online without padding around it.`
        : '',
    };
  },

};

// =========================================================================
// Variable extraction helpers
// =========================================================================
//
// Each snippet uses these to pull dynamic values from the context.
// The fallbacks here are intentionally generic, so a snippet that runs
// with thin context still produces clean copy.

function clientNameFromCtx(ctx: ProductContext): string {
  // The composer threads the client name down through variables when
  // it's set; otherwise we fall back to a neutral placeholder. The
  // composer in index.ts is responsible for passing client_name in.
  const v = ctx.variables['client_name'];
  if (typeof v === 'string' && v.trim()) return v.trim();
  return 'the business';
}

function pageCountFromCtx(ctx: ProductContext): string {
  const v = ctx.variables['page_count'];
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    return String(Math.round(v));
  }
  if (typeof v === 'string' && v.trim()) return v.trim();
  return 'A working';
}

function industryFromCtx(ctx: ProductContext): string {
  const v = ctx.variables['industry'];
  if (typeof v === 'string' && v.trim() && v !== 'unknown' && v !== 'other') {
    // Normalize bucket strings into prose ("family-of-companies" -> "family of companies").
    return v.replace(/-/g, ' ');
  }
  return 'mid-market';
}

function urgencyFromCtx(ctx: ProductContext): string {
  const v = ctx.variables['urgency'];
  if (typeof v === 'string' && v.trim()) return v.trim();
  return 'time-sensitive';
}

// Pulls the first sales angle from the engagement strategy synthesis
// and normalizes it for inline use in a closer_tie_back paragraph.
// Returns an empty string when no angle is present so the snippet's
// tie-back gracefully no-ops.
function firstSalesAngleFromCtx(ctx: ProductContext): string {
  const strategy = ctx.engagementStrategy;
  if (!strategy) return '';
  const angles = strategy.sales_angles;
  if (!Array.isArray(angles) || angles.length === 0) return '';
  const first = angles[0];
  if (!first || typeof first.angle !== 'string') return '';
  const trimmed = first.angle.trim();
  if (!trimmed) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : trimmed + '.';
}

// =========================================================================
// Lookup helpers
// =========================================================================

export interface SnippetLookupArgs {
  productId: ProductId;
  otherProductIds: ProductId[];
  ecosystemId: string | null;
  urgency: string | null;
  // Per audit move 4: optional fourth segment of the snippet key.
  // When the wizard's narrative_variables.focus[] is populated, the
  // first focus tag is passed here so snippet authors can write
  // focus-specific variants (e.g., web-management::B::tactical::takeover
  // reads differently from web-management::B::tactical::pre-sell).
  // 4-segment keys are tried first; 3-segment keys (existing snippets)
  // still match as the fallback.
  focusPrimary?: string | null;
  // Per audit move 7: when the proposal is being composed for a
  // specific client, snippet overrides stored at (key, client_id)
  // win over global overrides at (key, '*'). When omitted or
  // undefined, only global overrides match (legacy behavior).
  clientId?: string | null;
}

// Build the ordered candidate-key list for a lookup. Exposed so tests
// (and the snippet matrix editor) can verify the ladder without going
// through the full lookup. Order: most-specific to least-specific.
// Combo keys beat single-product keys at every specificity level
// (combo content describes the actual sale better than single-product
// content does when multiple products are in scope). 4-segment keys
// (focus-specific) beat 3-segment keys (no focus) at each level.
export function getSnippetCandidateKeys(args: SnippetLookupArgs): string[] {
  const products = [args.productId, ...args.otherProductIds].sort().join('+');
  const eco = args.ecosystemId || '*';
  const urgency = args.urgency || '*';
  const focus = (args.focusPrimary && args.focusPrimary.trim()) || null;

  const candidates: string[] = [];

  // Combo, 4-segment focus-specific (highest specificity).
  if (focus) {
    candidates.push(
      `${products}::${eco}::${urgency}::${focus}`,
      `${products}::${eco}::*::${focus}`,
      `${products}::*::*::${focus}`,
    );
  }
  // Combo, 3-segment (existing convention).
  candidates.push(
    `${products}::${eco}::${urgency}`,
    `${products}::${eco}::*`,
    `${products}::*::*`,
  );
  // Single-product, 4-segment focus-specific.
  if (focus) {
    candidates.push(
      `${args.productId}::${eco}::${urgency}::${focus}`,
      `${args.productId}::${eco}::*::${focus}`,
      `${args.productId}::*::*::${focus}`,
    );
  }
  // Single-product, 3-segment (existing convention).
  candidates.push(
    `${args.productId}::${eco}::${urgency}`,
    `${args.productId}::${eco}::*`,
    `${args.productId}::*::*`,
  );

  return candidates;
}

// Like lookupSnippetOverride, but returns the matched key alongside the
// snippet so the composer knows WHICH products the snippet speaks for (the
// key's product segment). A single-product snippet that matched in a
// multi-product proposal must not silently drop the other products.
export function lookupSnippetOverrideWithKey(
  args: SnippetLookupArgs,
): { snippet: (ctx: ProductContext) => NarrativeSnippetSet; key: string } | null {
  const clientId = (args.clientId && args.clientId.trim()) || null;
  for (const key of getSnippetCandidateKeys(args)) {
    // Per audit move 7: client-scoped DB override wins first, then
    // global DB override, then file registry. The scope ladder runs
    // INSIDE each key (so a client-scoped 3-seg key still beats a
    // global 4-seg key, because the loop goes most-specific key first
    // and within that key tries client-scoped before global).
    if (clientId) {
      const clientScoped = lookupDbOverride(key, clientId);
      if (clientScoped) return { snippet: clientScoped, key };
    }
    const dbGlobal = lookupDbOverride(key, null);
    if (dbGlobal) return { snippet: dbGlobal, key };
    const entry = SNIPPET_REGISTRY[key];
    if (entry) return { snippet: entry, key };
  }
  return null;
}

export function lookupSnippetOverride(args: SnippetLookupArgs): ((ctx: ProductContext) => NarrativeSnippetSet) | null {
  return lookupSnippetOverrideWithKey(args)?.snippet || null;
}

// -----------------------------------------------------------------
// DB overrides — populated by the admin snippet matrix editor.
// The cache is loaded by primeSnippetOverrides() and refreshed
// every 60 seconds so edits in the editor surface on the next
// request without a redeploy.
// -----------------------------------------------------------------

type DbOverride = { key: string; clientId: string; snippet: (ctx: ProductContext) => NarrativeSnippetSet };
// Outer key: snippet key. Inner key: client_id ('*' = global; any
// other string = client-specific). Per audit move 7.
let dbOverrideCache: Map<string, Map<string, DbOverride>> | null = null;
let dbOverrideCacheExpiresAt = 0;
const DB_CACHE_TTL_MS = 60_000;

// lookupDbOverride takes the snippet key plus an optional client_id.
// When clientId is non-null, returns the client-scoped snippet for
// that key (does NOT fall back to global — the global fallback is
// the caller's responsibility in lookupSnippetOverride). When
// clientId is null, returns the global snippet for that key, or
// null if none.
function lookupDbOverride(key: string, clientId: string | null): ((ctx: ProductContext) => NarrativeSnippetSet) | null {
  if (!dbOverrideCache) return null;
  if (Date.now() > dbOverrideCacheExpiresAt) {
    dbOverrideCache = null;
    return null;
  }
  const byClient = dbOverrideCache.get(key);
  if (!byClient) return null;
  const scopeKey = clientId || '*';
  const hit = byClient.get(scopeKey);
  return hit ? hit.snippet : null;
}

// Called by the composer at the start of each compose. Refreshes the
// DB override cache when stale.
export async function primeSnippetOverrides(): Promise<void> {
  if (dbOverrideCache && Date.now() <= dbOverrideCacheExpiresAt) return;
  try {
    const { default: turso } = await import('../turso');
    const res = await turso.execute({
      sql: `SELECT key, client_id, intro_lines, what_i_see_paragraphs, what_i_recommend_paragraphs FROM snippet_overrides`,
    });
    const next = new Map<string, Map<string, DbOverride>>();
    for (const row of res.rows as any[]) {
      const key = String(row[0]);
      const clientId = row[1] ? String(row[1]) : '*';
      const intro = parseJsonArrayOrNull(row[2]);
      const whatISee = parseJsonArrayOrNull(row[3]);
      const whatIRecommend = parseJsonArrayOrNull(row[4]);
      if (!next.has(key)) next.set(key, new Map());
      next.get(key)!.set(clientId, {
        key,
        clientId,
        snippet: () => ({
          intro_lines: intro || [],
          what_i_see_paragraphs: whatISee || [],
          what_i_recommend_paragraphs: whatIRecommend || [],
        }),
      });
    }
    dbOverrideCache = next;
    dbOverrideCacheExpiresAt = Date.now() + DB_CACHE_TTL_MS;
  } catch {
    // Failing to load DB overrides should never break compose. Fall
    // back to the file registry silently.
    dbOverrideCache = new Map();
    dbOverrideCacheExpiresAt = Date.now() + 5_000;
  }
}

// Manually invalidate the cache. Called by the save endpoint so the
// new snippet takes effect immediately instead of waiting for the TTL.
export function invalidateSnippetOverrideCache(): void {
  dbOverrideCache = null;
  dbOverrideCacheExpiresAt = 0;
}

function parseJsonArrayOrNull(raw: any): string[] | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (Array.isArray(parsed)) {
      return parsed.map(s => String(s)).filter(s => s.length > 0);
    }
  } catch {
    // ignore parse error
  }
  return null;
}

// Exported for tests and for the composer to wire in lookups.
export { SNIPPET_REGISTRY };
