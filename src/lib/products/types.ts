// Canonical types for the product-driven proposal builder.
//
// Every product module (web-management, marketing-consulting, build,
// training, other-sow) implements a ProductDefinition. The wizard
// composes a proposal config from a set of in-scope ProductDefinitions
// plus per-product variables the admin (or auto-routing) supplies.
//
// These types intentionally mirror existing shapes already used by:
//   - the proposal renderer in src/pages/portal/proposals/[slug].astro
//   - the pricing dispatcher in src/lib/proposal-pricing.ts
//   - the Schedule A builder in src/lib/contract-schedule.ts
//
// so the composed config plugs into the unchanged downstream without
// schema migration. New products add a file + a registry line; the
// rest of the pipeline does not move.

import type { ScheduleA, WebManagementSection, MarketingConsultingSection, PassThroughItem } from '../contract-schedule';
import type { PricingResult } from '../proposal-pricing';

// =========================================================================
// IDs and enums
// =========================================================================

export type ProductId =
  | 'web-management'
  | 'marketing-consulting'
  | 'build'
  | 'training'
  | 'other-sow';

// Each product owns its own ecosystem space; the routing variable
// differs (page count for WM, revenue for MC, build size for Build).
// EcosystemId is a per-product string union expressed as 'A' | 'B' | 'C'
// for the three-band products; sub-products may use other values.
export type EcosystemId = string;

export type TierId = 'good' | 'better' | 'best' | 'custom';

// =========================================================================
// Ecosystem and tier definitions
// =========================================================================

export interface TierDefaults {
  id: TierId;
  name: string;                          // "Good" | "Better" | "Best"
  recommended?: boolean;                 // surfaces as the "Recommended" card
  tagline?: string;                      // short subtitle on the card
  features?: string[];                   // bullet list of inclusions
  // Pricing primitives. Not every product uses every field.
  monthly?: number;                      // recurring fee for the tier
  onb?: number;                          // one-time onboarding fee
  audit?: number;                        // one-time audit fee (consulting)
  // Engagement parameters that flow to Schedule A.
  hours?: number;                        // pooled hours per cycle for the base unit
  update_cadence?: string;               // 'monthly' | 'bi-weekly' | 'weekly' | etc.
  response_time?: string;                // free-text description per tier
  training_sessions?: number | null;     // quarterly training sessions included
  call_frequency?: string;               // consulting call cadence
  advisories?: string;                   // deep-advisory cadence per cycle
  reporting?: string;                    // reporting cadence
  hiring_guidance?: boolean;             // consulting hiring guidance included
}

export interface Ecosystem<E extends EcosystemId = EcosystemId> {
  id: E;
  label: string;                         // customer-facing label
  band?: string;                         // routing band description (e.g., "<30 pages")
  tiers: Record<TierId, TierDefaults>;   // good/better/best (custom is optional)
  // Per-product extras. Optional so other products can extend.
  multi_unit_monthly_discount?: number;  // 0.80 for WM's 80% multi-site
  multi_unit_onb_discount?: number;      // 1.0 = no discount (per 05 §4 takeover rule)
}

// =========================================================================
// Variables: what the wizard collects per product
// =========================================================================

// A multi-option deployment shape for the Build product (per the
// Raised Bar pattern; see docs/audits/proposal-chain-audit-2026-05-24.md
// finding 7). Each option is one way the same Build could ship: a
// unified-vs-split site setup, a sub-brand-vs-microsite split, etc.
// When a Build has 2+ options, the proposal page renders them as
// interactive cards via the binary_picker step; the prospect picks
// one; the rollout phases swap based on the pick; the Schedule A
// reflects the pick.
//
// Authored in the wizard (Phase 4 UI). Composer reads them and emits
// the corresponding step + rollout scenarios. computePricing applies
// the option's pricing_delta to the build fee when an option is picked.
export interface BuildOption {
  id: string;                   // 'o1', 'o2', etc. Must be unique within the Build.
  name: string;                 // "Option 1: Single unified site"
  pitch: string;                // HTML body shown on the option card on the proposal page.
  pricing_delta?: number;       // Added to the one-time build total when this option is picked (negative for discount).
  rollout_phases?: NarrativePhase[]; // Phases shown under "How it rolls out" when picked.
  rollout_intro_html?: string;  // Shown above the phases.
  rollout_outro_html?: string;  // Shown below the phases.
  schedule_a_note?: string;     // Free-text note added to Schedule A's build_sow_ref when picked.

  // Cross-product effects on Web Management. These are structural,
  // not pre-priced: the buyer picks the WM tier on the proposal page,
  // then WM computes the selected option's added/modified sites at
  // that tier using the canonical per-site formula. Legacy proposals
  // may still carry wm_*_delta fields; new wizard output should not.
  wm_monthly_delta?: number;    // Legacy static delta only.
  wm_onboarding_delta?: number; // Legacy static delta only.
  wm_sites_added?: Array<{
    domain: string;             // Actual domain if known; blank allowed until signing.
    label: string;              // Display label for the site row.
    page_count_estimate?: number; // Routes ecosystem and build fee by formula.
  }>;
  // Modifications to existing managed sites when this option is picked.
  // Lets an option express "the existing site grows to N pages" which
  // re-routes its ecosystem and changes its tier pricing. The composer
  // applies modifications BEFORE pricing the site rows, so Schedule A
  // reflects the post-option ecosystem. Auto-calc on the wizard reads
  // the site's current page count from managedSites to compute the
  // delta accurately.
  wm_site_modifications?: Array<{
    site_domain: string;        // Existing managed domain to modify (must match an existing client_sites.domain).
    new_page_count: number;     // Page count after this option is picked.
    note?: string;              // Admin-visible reason (e.g., "adds 10 pages of new content").
  }>;
}

// Each product declares its variable schema; the wizard renders inputs
// for it and the routing function returns the matching ecosystem.
// Values are primitives OR structured arrays for products that need
// multi-row inputs (Build's `build_options` is the only current case).
export interface ProductVariables {
  [key: string]: string | number | boolean | null | BuildOption[];
}

export interface VariableSchemaField {
  id: string;
  label: string;
  type: 'number' | 'text' | 'select' | 'boolean';
  options?: Array<{ id: string; label: string }>;
  default?: string | number | boolean | null;
  help?: string;
}

// =========================================================================
// Proposal step shapes (match the renderer's existing contract)
// =========================================================================

export interface ProposalStepOption {
  id: string;
  name: string;
  tagline?: string;
  html?: string;
  recommended?: boolean;
  // Per audit move 5: when the AI's per-prospect tier recommendation
  // is the reason this option is flagged recommended (not the
  // product's static default), the rationale string from the
  // synthesis surfaces here. Renderer shows it as a small sub-line
  // under the Recommended pill so the buyer reads "why this one fits"
  // instead of an unexplained label.
  recommended_rationale?: string;
  price_label?: string;
  price_suffix?: string;
  price_subline?: string;
  // Included monthly pooled hours for this tier, surfaced as a dedicated
  // card element (not buried in feature prose) so a rebuild cannot drop
  // it. Per the tier-cards-show-included-hours requirement. WM sets it;
  // MC is advisory cadence and leaves it undefined.
  included_hours?: number;
  features?: string[];
  price_dynamic?: string;
  price_detail_html?: string;
}

export interface ProposalStep {
  id: string;
  type: 'tier_picker' | 'binary_picker';
  h2: string;
  prompt: string;
  options: ProposalStepOption[];
  depends_on?: string;
  show_when?: Record<string, string>;
}

// =========================================================================
// Narrative composition
// =========================================================================

export interface NarrativePhase {
  phase_num: string;
  h3: string;
  html: string;
}

export interface NarrativeScenario {
  intro_html?: string;
  phases?: NarrativePhase[];
  outro_html?: string;
}

export interface NarrativeSection {
  h2: string;
  paragraphs: string[];
}

export interface NarrativeSnippetSet {
  // A product's contribution to the composed narrative. The composer
  // in src/lib/products/index.ts merges contributions from every
  // in-scope product, deduping headings and concatenating paragraphs
  // in product order.
  intro_lines?: string[];                // sentences appended to the master intro
  what_i_see_paragraphs?: string[];      // paragraphs under the "what I see in your business" h2
  what_i_recommend_paragraphs?: string[];// paragraphs under "what I recommend"
  rollout_scenarios?: Record<string, NarrativeScenario>; // keyed by scenario step value
  rollout_scenario_step?: string;        // which step drives scenario picking
  rollout_phases?: NarrativePhase[];     // single-scenario rollout (no scenario_step)
  // Optional final paragraph appended to the "How this works in
  // practice" closer that ties the engagement to the prospect's
  // first stated value prop (sales_angles[0]). Per audit finding 4
  // (docs/audits/proposal-chain-audit-2026-05-24.md). Snippet authors
  // write the tie-back in Cody voice per-snippet; the composer
  // appends it after the boundary-setting paragraphs.
  closer_tie_back?: string;
}

// =========================================================================
// Pricing contribution from a single product
// =========================================================================

export interface PricingBreakdownLine {
  label: string;
  amount: number;
}

export interface ProductPricingContribution {
  monthly: number;                       // adds to total monthly
  oneTime: number;                       // adds to total one-time
  breakdown: PricingBreakdownLine[];     // itemized lines for the one-time table
  // Per-product display strings the email + page summaries reuse.
  displaySummary?: Record<string, string>;
}

// =========================================================================
// Schedule A contribution from a single product
// =========================================================================

// Each product fills its slot of the Schedule A. The composer in
// src/lib/contract-schedule.ts (the product_driven_v1 branch) collects
// these and produces a complete ScheduleA. Shape mirrors
// `ScheduleA`'s sub-sections from contract-schedule.ts so the same
// renderer reads it without changes.
export interface ProductScheduleAContribution {
  products_purchased?: Partial<ScheduleA['products_purchased']>;
  web_management?: WebManagementSection;
  marketing_consulting?: MarketingConsultingSection;
  build_sow_ref?: string;
  other_sow_ref?: string;
  pass_through_items?: PassThroughItem[];
  // Hours/rates contribution: only WM contributes the includedHours.
  hours_addendum?: { included_hours?: number | null };
  // Day-one access additions if a product implies specific access needs.
  day_one_access_items?: Array<{ system: string; provider: string }>;
}

// =========================================================================
// The product definition itself
// =========================================================================

// Engagement-strategy synthesis subset that flows from the AI research
// call to the narrative composer. Mirrors a subset of
// `ClientResearchResult` in src/lib/proposal-ai/types.ts but is defined
// locally to keep products/ independent of proposal-ai/. The wizard
// adapts research_result -> EngagementStrategy before calling the
// composer; both shapes share field names verbatim for that reason.
//
// Used by:
//   - composer (opener composition from sales_angles)
//   - per-product narrative generators (light copy adaptation)
//
// The synthesis is NEVER named directly in client-facing copy
// (no-dangling-tier-references rule). It steers wording; it does not
// appear as a label.
export interface EngagementStrategySalesAngle {
  angle: string;
  supporting_evidence: string;
  // Per audit move 9: which of Cody's products amplifies or supports
  // this prospect-stated value prop. Composer reads this to thread
  // the prospect's own pitch into each in-scope product's section
  // ("Web Management carries forward what you said about quality").
  product_implication?: EngagementStrategySynthProductId | 'none';
}
// AI's per-prospect tier recommendation per product. Keys are the
// synthesis product ids (underscored: web_management,
// marketing_consulting, build, training); each entry carries the
// recommended tier + rationale string. When present, overrides the
// product definition's default `recommended: true` on the matching
// tier card so the prospect sees the AI-driven recommendation, not
// the static default. Per finding 3 in
// docs/audits/proposal-chain-audit-2026-05-24.md.
export type EngagementStrategySynthProductId =
  | 'web_management' | 'marketing_consulting' | 'build' | 'training';
export interface EngagementStrategyTierRec {
  tier: 'good' | 'better' | 'best';
  rationale?: string;
}

// Concrete things that are broken or under-served on the prospect's
// current site. Distinct from sales_angles (their pitch to customers);
// this is what the data reveals they haven't said out loud. Drives the
// "Where the work is" section on the proposal page so the buyer reads
// their own problems in Cody's framing, not just his pitch.
export type EngagementStrategyInternalGapSeverity = 'low' | 'medium' | 'high';
export interface EngagementStrategyInternalGap {
  gap: string;
  evidence?: string;
  severity: EngagementStrategyInternalGapSeverity;
  product_implication?: EngagementStrategySynthProductId | 'none';
}

// Personalization quiz axes for a prospect (or signer) who took the
// quiz at /quiz. Joined from the lead_personas table by signer email
// at composeProposal time. Per audit move 3 — closes the loop from
// quiz-personalization-of-site to quiz-personalization-of-proposal.
// Snippets and future narrative branches can read these to shape
// voice (mountain = denser hierarchy, clouds = shorter sentences,
// sun = brighter framing, etc.).
export interface EngagementStrategyPersonaAxes {
  email?: string;
  name?: string | null;
  sun_moon?: 'sun' | 'moon' | null;
  beach_mountain?: 'beach' | 'mountain' | null;
  spring_fall?: 'spring' | 'fall' | null;
  stars_clouds?: 'stars' | 'clouds' | null;
}

// AI's per-product recommendation with rationale. Per audit move 8:
// the rationale flows to the buyer-facing proposal as a "Why I'm
// recommending each piece" paragraph at the bottom of "What I
// recommend." Confidence is kept admin-side (telling a buyer "I'm
// not sure about this" undercuts the pitch).
export interface EngagementStrategyProductMixRec {
  recommended: boolean;
  rationale?: string;
  confidence?: 'low' | 'medium' | 'high';
}

export interface EngagementStrategy {
  sales_angles: EngagementStrategySalesAngle[];
  clv_horizon?: 'long-term-stable' | 'medium-term' | 'churn-risk' | 'unknown' | null;
  cody_time_intensity?: 'low' | 'medium' | 'high' | null;
  recommended_tier_per_product?: Partial<Record<EngagementStrategySynthProductId, EngagementStrategyTierRec>>;
  recommended_product_mix?: Partial<Record<EngagementStrategySynthProductId, EngagementStrategyProductMixRec>>;
  internal_gaps?: EngagementStrategyInternalGap[];
  persona_axes?: EngagementStrategyPersonaAxes | null;
}

export interface ProductContext {
  // Everything a product needs to do its work. Passed in by the
  // composer; products do not reach for global state.
  ecosystemId: EcosystemId | null;
  tierId: TierId | null;                 // null when the prospect has not picked yet
  variables: ProductVariables;           // page_count, site_count, revenue, build_size, etc.
  // Cross-product context: other in-scope products and their tier
  // picks (used for narrative composition and for training-mode
  // auto-routing when WM/MC is at Best).
  otherProducts: Array<{ id: ProductId; tierId: TierId | null }>;
  // Managed sites for the client (from client_sites where is_managed
  // = 1). WM's buildScheduleAContribution renders real domain rows
  // from this list when present. Empty / undefined falls back to
  // placeholder rows derived from variables.site_count.
  //
  // page_count routes each site to its OWN ecosystem in the multi-site
  // pricing pipeline (2026-05-24 locked formula per
  // docs/audits/proposal-chain-audit-2026-05-24.md finding 1). Null
  // means "no data yet" -- the pricing pipeline falls back to the
  // primary site's ecosystem for that site.
  managedSites?: Array<{
    domain: string;
    label?: string | null;
    is_primary?: boolean;
    page_count?: number | null;
    // Per-site overrides. NULL = use formula. Non-null (including 0)
    // = use this exact amount; multi-site 0.80 multiplier is skipped
    // for this site because the override IS the price. Pro-bono and
    // grandfathered carve-outs.
    monthly_override?: number | null;
    onboarding_override?: number | null;
  }>;
  // Prospect's interactive selections, keyed by step id. Lets a
  // product introspect picks it doesn't own (e.g., Build reads its
  // own `build_options` step's value to decide which option's
  // pricing_delta to apply). WM and MC tier picks still resolve into
  // ctx.tierId; this is a sibling escape hatch for products that
  // emit their own non-tier steps (the Raised Bar pattern via
  // BuildOption[]).
  selections?: Record<string, string | null>;
  // All in-scope products' variables, indexed by product id. Used by
  // products that need cross-product introspection — e.g., WM reads
  // build.build_options[picked].wm_sites_added when applying the
  // Raised Bar cross-product effect on Schedule A. Optional so legacy
  // callers without cross-product needs still work.
  allProductVars?: Partial<Record<ProductId, ProductVariables>>;
  // Engagement-strategy synthesis from the research call, when present.
  // Optional so legacy composer calls without research still work.
  engagementStrategy?: EngagementStrategy | null;
  // Reissue / already-onboarded waiver. When true, products zero their
  // one-time setup fee (WM onboarding, MC initial audit) because the
  // client already paid it on a prior engagement. Set from the proposal
  // config's waive_onboarding flag. Pro-bono uses the client discount
  // instead; this is specifically for re-issuing to an existing client.
  waiveOnboarding?: boolean;
}

export interface ProductDefinition {
  id: ProductId;
  name: string;                          // customer-facing label
  short_name: string;                    // for sentence composition (e.g., "Web Management")

  // The variables this product needs the admin (or auto-routing) to
  // supply before its ecosystem and pricing can be computed.
  variableSchema: VariableSchemaField[];

  // Ecosystems and their tiers. Single source for both pricing and
  // Schedule A. The legacy RB_* constants in proposal-pricing.ts and
  // contract-schedule.ts are duplicates of this for the live Raised
  // Bar proposal; v2 retires those duplicates.
  ecosystems: Record<EcosystemId, Ecosystem>;

  // Ecosystem routing from the supplied variables. Returns null if
  // the variables are not yet enough to route (wizard surfaces this
  // as a follow-up question).
  routeEcosystem(variables: ProductVariables): EcosystemId | null;

  // Generates the interactive step(s) the prospect sees on the
  // proposal page for this product. May return an empty array (build
  // with no buyer choice; training when bundled).
  generateSteps(ctx: ProductContext): ProposalStep[];

  // Generates this product's contribution to the composed narrative.
  generateNarrativeSnippets(ctx: ProductContext): NarrativeSnippetSet;

  // Computes this product's pricing contribution.
  computePricing(ctx: ProductContext): ProductPricingContribution;

  // Builds this product's contribution to the Schedule A.
  buildScheduleAContribution(ctx: ProductContext, pricing: ProductPricingContribution): ProductScheduleAContribution;
}

// =========================================================================
// Composer output: what the wizard produces and the renderer consumes
// =========================================================================

// The full config blob a finished proposal carries in the proposals
// table. Matches the shape the renderer at /portal/proposals/[slug]
// already consumes. New fields (`products`, `product_vars`,
// `narrative_variables`, `overrides`) live alongside the legacy fields
// so the same config can be both renderer-compatible and
// composer-traceable.
// Bundled-tier configuration (see ProposalConfig.bundle). The bundle is a
// presentation + buyer-decision layer only; it stores NO dollar figures.
// Each GBB level names the per-product tiers it expands to (default
// symmetric: good->good, better->better, best->best, but the wm/mc tiers
// can differ if a level intentionally mixes them). The optional add-on maps
// to two build_options ids (the "add" build vs the "skip" baseline). All
// money is derived from the product registry via expandBundleSelections.
export interface BundleConfig {
  tiers: Record<'good' | 'better' | 'best', { wm: TierId; mc: TierId }>;
  addon?: { build_option_id: string; skip_option_id: string; label: string };
}

export interface ProposalConfig {
  version: number;
  prepared_for: string;
  prepared_on: string;
  title: string;
  // ── Price-reduction mechanisms (three independent handles; can compose) ──
  // Reach for the right one; they all lower what the buyer sees but mean
  // different things and apply at different layers:
  //   (A) waive_onboarding  → zeros ONLY the one-time setup fees (WM
  //       onboarding + MC audit) uniformly. Use for an existing-client
  //       REISSUE where setup was already paid. Recurring is untouched.
  //   (B) discount_rate     → scales ALL fees (one-time + recurring)
  //       proportionally. Use for PRO-BONO / negotiated discounts.
  //   (C) client_sites.onboarding_override (per-site, migration 047) →
  //       sets one site's onboarding to an exact amount (incl. 0). Use for
  //       GRANULAR carve-outs: build-produced sites (auto 0) or a single
  //       grandfathered/already-onboarded site in a mixed pool.
  // The wizard surfaces (A) today; (B) comes from the client record; (C)
  // is set on client_sites. They compose (e.g. discount + waiver together).
  // Per-client discount, snapshotted at proposal-compose time so the
  // buyer's pricing does not silently change if the client record
  // is edited later. Decimal: 0.10 = 10% off.
  discount_rate?: number;
  // Reissue / already-onboarded waiver. When true, the one-time setup
  // fees (WM onboarding and MC initial audit) are zeroed because the
  // client already paid them on a prior engagement (e.g. re-issuing a
  // contract to an existing client like ZipKit Homes). Recurring fees
  // and the first-month-at-signing are unaffected. Pro-bono uses
  // discount_rate instead.
  waive_onboarding?: boolean;
  // Bundled-tier mode: one buyer-facing Good/Better/Best card fusing
  // Web Management + Marketing Consulting into a single monthly + to-start,
  // with an optional add-on below (the Raised Bar / Jason 5/22 shape). When
  // present, the proposal page shows the single GBB card instead of separate
  // WM/MC pickers; expandBundleSelections fans the pick out to the canonical
  // per-product keys so pricing + Schedule A stay registry-derived (the
  // anti-#195 guarantee). Absent = standard multi-product composer.
  bundle?: BundleConfig;
  narrative: {
    intro: string;
    sections: NarrativeSection[];
    rollout?: {
      h2: string;
      intro_html?: string;
      phases?: NarrativePhase[];
      outro_html?: string;
      scenarios?: Record<string, NarrativeScenario>;
      scenario_step?: string;
    };
  };
  steps: ProposalStep[];
  signers: Array<{ id: string; email: string; name: string }>;
  pricing_formula: string;

  // Product-driven composer fields (only present when
  // pricing_formula === 'product_driven_v1'). Legacy proposals
  // (raised_bar_v1) leave these undefined.
  products?: ProductId[];
  product_vars?: Record<ProductId, ProductVariables>;
  narrative_variables?: NarrativeVariables;
  overrides?: ProposalOverrides;
  // Per audit move 3: persist the engagement strategy alongside the
  // composed config so downstream readers (proposal page renderer,
  // persona-aware variants, admin re-render) can access the
  // structured per-prospect signals that drove this proposal.
  engagement_strategy?: EngagementStrategy | null;
  // Per ClickUp 86ba3ww35 fix: snapshot managedSites at compose time
  // so composePricing (the proposal-page price path) routes each site
  // to its own ecosystem the same way Schedule A does. Without this
  // snapshot, the proposal-page WM total fell back to single-eco for
  // multi-site clients and disagreed with the contract's Schedule A.
  managed_sites?: Array<{
    domain: string;
    label?: string | null;
    is_primary?: boolean;
    page_count?: number | null;
    monthly_override?: number | null;
    onboarding_override?: number | null;
  }>;
}

export interface NarrativeVariables {
  industry?: string;                     // 'solo' | 'professional-services' | 'contractor' | 'family-of-companies' | etc.
  urgency?: string;                      // 'tactical' | 'growth' | 'maintenance'
  focus?: string[];                      // ['revenue', 'brand', 'takeover', 'search', 'pre-sell', ...]
}

// Admin overrides on the composed output. Free-form raw text wins
// over the composed text on every rebuild. Use sparingly; the point
// of the rebuild is to make overrides rare.
export interface ProposalOverrides {
  title?: string;
  slug?: string;
  prepared_for?: string;
  prepared_on?: string;
  intro?: string;
  sections?: NarrativeSection[];
  rollout?: ProposalConfig['narrative']['rollout'];
  steps?: ProposalStep[];                // step-level overrides; replaces a step by id
  step_options?: Record<string, Record<string, Partial<ProposalStepOption>>>;
  // {stepId: {optionId: {price_label: '...', ...}}}
}

// =========================================================================
// Composer input from the wizard
// =========================================================================

export interface ComposeArgs {
  client: {
    id: string;
    name: string;
    slug: string;
    discount_rate?: number;
  };
  signers: Array<{ id: string; email: string; name: string }>;
  products: ProductId[];                 // which products are in scope
  product_vars: Record<ProductId, ProductVariables>;
  narrative_variables?: NarrativeVariables;
  overrides?: ProposalOverrides;
  // Optional explicit pricing_formula (defaults to 'product_driven_v1').
  pricing_formula?: string;
  // Reissue / already-onboarded waiver. When true, the composed config
  // carries waive_onboarding so the one-time setup fees (WM onboarding,
  // MC initial audit) are zeroed. For re-issuing to an existing client
  // (e.g. ZipKit Homes); pro-bono uses the client discount instead.
  waive_onboarding?: boolean;
  // Optional engagement-strategy synthesis from the AI research call.
  // When present, drives the proposal's opener (The Situation) and
  // adapts per-product narrative wording. Absent for legacy/manual
  // composer calls.
  engagement_strategy?: EngagementStrategy | null;
  // Per-product admin overrides for which tier is marked recommended
  // on the published proposal. Audit Finding 3 UI piece — PR #101 made
  // composeProposal honor the AI's recommended_tier_per_product
  // automatically; this lets admin override that with an explicit pick.
  // Override beats AI. Missing entry = use AI rec, falling back to
  // each product's static `recommended` tier flag.
  tier_overrides?: Partial<Record<ProductId, TierId>>;
  // Managed sites with per-site page_count. Drives per-site ecosystem
  // routing in the multi-site pricing pipeline (2026-05-24 locked
  // formula). Empty / undefined falls back to single-ecosystem
  // pricing using the primary's ecosystem for all sites.
  managedSites?: Array<{
    domain: string;
    label?: string | null;
    is_primary?: boolean;
    page_count?: number | null;
    // Per-site overrides. NULL = use formula. Non-null (including 0)
    // = use this exact amount; multi-site 0.80 multiplier is skipped
    // for this site because the override IS the price. Pro-bono and
    // grandfathered carve-outs.
    monthly_override?: number | null;
    onboarding_override?: number | null;
  }>;
}

// Re-export downstream types so consumers can import everything from
// this one file without reaching into contract-schedule or proposal-pricing.
export type { ScheduleA, WebManagementSection, MarketingConsultingSection, PassThroughItem };
export type { PricingResult };
