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
  price_label?: string;
  price_suffix?: string;
  price_subline?: string;
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
}
export interface EngagementStrategy {
  sales_angles: EngagementStrategySalesAngle[];
  clv_horizon?: 'long-term-stable' | 'medium-term' | 'churn-risk' | 'unknown' | null;
  cody_time_intensity?: 'low' | 'medium' | 'high' | null;
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
  }>;
  // Prospect's interactive selections, keyed by step id. Lets a
  // product introspect picks it doesn't own (e.g., Build reads its
  // own `build_options` step's value to decide which option's
  // pricing_delta to apply). WM and MC tier picks still resolve into
  // ctx.tierId; this is a sibling escape hatch for products that
  // emit their own non-tier steps (the Raised Bar pattern via
  // BuildOption[]).
  selections?: Record<string, string | null>;
  // Engagement-strategy synthesis from the research call, when present.
  // Optional so legacy composer calls without research still work.
  engagementStrategy?: EngagementStrategy | null;
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
export interface ProposalConfig {
  version: number;
  prepared_for: string;
  prepared_on: string;
  title: string;
  // Per-client discount, snapshotted at proposal-compose time so the
  // buyer's pricing does not silently change if the client record
  // is edited later. Decimal: 0.10 = 10% off.
  discount_rate?: number;
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
  // Optional engagement-strategy synthesis from the AI research call.
  // When present, drives the proposal's opener (The Situation) and
  // adapts per-product narrative wording. Absent for legacy/manual
  // composer calls.
  engagement_strategy?: EngagementStrategy | null;
}

// Re-export downstream types so consumers can import everything from
// this one file without reaching into contract-schedule or proposal-pricing.
export type { ScheduleA, WebManagementSection, MarketingConsultingSection, PassThroughItem };
export type { PricingResult };
