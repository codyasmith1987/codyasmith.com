// Per-engagement narrative snippet library.
//
// Each product carries inline default narrative for its standard
// pitch (see web-management.ts, marketing-consulting.ts, etc.). This
// file holds extension snippets indexed by named keys for cases where
// a specific client's combination of product-mix + ecosystem + variables
// calls for a more specific pitch than the defaults.
//
// Population convention: Cody adds entries here per engagement. Each
// snippet must follow the voice rules:
//   - AP style, no em or en dashes ever
//   - First person as Cody
//   - Plain language, full brand names
//   - No preambles, no sign-offs
//   - No internal exposure: no file paths, admin URLs, version markers,
//     drafter notes, source-doc citations, workflow descriptions
//
// Pattern: name a key from the combination it serves, then write the
// snippet as a function that returns a NarrativeSnippetSet. The
// composer in index.ts looks up an override by key; falls back to the
// product's default snippet generation if no override is found.

import type {
  NarrativeSnippetSet,
  ProductContext,
  ProductId,
} from './types';

// =========================================================================
// Override registry
// =========================================================================

// Key format: `${product_combo}::${ecosystem}::${variable_key}` where
// any segment may be '*' for "any value." The composer looks up the
// most-specific match first, falling back to less-specific keys.
//
// Examples:
//   'web-management::B::tactical' → WM only, Eco B, tactical urgency
//   'web-management+marketing-consulting::B::*' → WM+MC, Eco B, any urgency
//   'web-management::*::*' → WM only, any ecosystem, any urgency
//
// Add new entries below as engagements roll in. Empty registry is fine
// for v1; the product-inline defaults cover the baseline.
const SNIPPET_REGISTRY: Record<string, (ctx: ProductContext) => NarrativeSnippetSet> = {
  // Example entry kept here so the schema is visible. Comment out or
  // remove when shipping a real entry.
  //
  // 'web-management::B::tactical': (ctx) => ({
  //   intro_lines: [
  //     `Your situation is mid-size and time-sensitive. Web Management here gets you stable fast.`,
  //   ],
  //   what_i_see_paragraphs: [
  //     `<strong>Real paragraph here in Cody's voice.</strong>`,
  //   ],
  // }),
};

// =========================================================================
// Lookup helpers
// =========================================================================

export function lookupSnippetOverride(args: {
  productId: ProductId;
  otherProductIds: ProductId[];
  ecosystemId: string | null;
  urgency: string | null;
}): ((ctx: ProductContext) => NarrativeSnippetSet) | null {
  const products = [args.productId, ...args.otherProductIds].sort().join('+');
  const eco = args.ecosystemId || '*';
  const urgency = args.urgency || '*';

  // Try keys most-specific to least-specific.
  const candidates = [
    `${products}::${eco}::${urgency}`,
    `${args.productId}::${eco}::${urgency}`,
    `${products}::${eco}::*`,
    `${args.productId}::${eco}::*`,
    `${products}::*::*`,
    `${args.productId}::*::*`,
  ];

  for (const key of candidates) {
    const entry = SNIPPET_REGISTRY[key];
    if (entry) return entry;
  }
  return null;
}

// Exported for tests and for the composer to wire in lookups.
export { SNIPPET_REGISTRY };
