// Voice lint for AI-generated proposal copy.
//
// Patterns are drawn directly from the feedback memories:
//   - feedback_voice_and_formatting (no em/en dashes, no preambles, no sign-offs)
//   - feedback_no_internal_exposure (no file paths, admin URLs, version markers)
//   - feedback_no_overclaim_sun (no conversions/leads/revenue promises)
//   - feedback_no_template_defaults_as_distinctive (no AI-template clichés)
//   - feedback_no_drop_caps (no drop-cap structures)
//   - feedback_no_dangling_tier_references (no client-facing tier refs)
//
// Each violation is returned with the matched substring so the caller
// can surface it to Cody. The function does not modify the input.
//
// Severity model: every match is a hard fail. The drafter must re-run
// or Cody edits manually. There is no "warning, ship anyway" path.

import type { VoiceLintResult } from './types';

interface RulePattern {
  rule: string;
  pattern: RegExp;
  // 'global' = matches across whole string; 'anchored' = matches at start of any line.
  scope: 'global' | 'anchored';
  // If specified, restricts the rule to specific product categories. Used
  // to allow MC snippets to talk prescriptively about revenue/growth.
  productScope?: 'wm-only' | 'all';
}

const RULES: RulePattern[] = [
  // ---- Em / en dashes ----
  {
    rule: 'em-or-en-dash',
    pattern: /[–—]/g,
    scope: 'global',
  },

  // ---- Banned preambles and sign-offs ----
  {
    rule: 'banned-preamble',
    pattern: /^\s*(Here['']s what I['']d suggest|Based on (my )?analysis|To start|First and foremost|It['']s worth noting|It['']s important to note|In conclusion|To summarize|All in all|At the end of the day|Looking forward|Let me know if)/im,
    scope: 'anchored',
  },

  // ---- AI-template / corporate clichés ----
  {
    rule: 'ai-template-language',
    pattern: /\b(leverage|leveraging|leverages|synergy|synergies|robust solution|drive results|drive growth|seamless|seamlessly|cutting[- ]edge|paradigm shift|game[- ]changer|low[- ]hanging fruit|move the needle|circle back|deep dive|holistic approach|best[- ]in[- ]class|world[- ]class|unlock|empower|empowering|empowers|elevate|elevating|elevates|streamlin\w*|next[- ]level|turnkey|disruptive)\b/gi,
    scope: 'global',
  },

  // ---- Promotion overclaim (WM stays descriptive) ----
  {
    rule: 'wm-overclaim',
    pattern: /\b(conversions?|leads?|revenue growth|sales lift|customer acquisition|ROI|return on investment)\b/gi,
    scope: 'global',
    productScope: 'wm-only',
  },

  // ---- Drop cap structures ----
  {
    rule: 'drop-cap-structure',
    pattern: /^([A-Z])\s*\n\s*\1\w/m,
    scope: 'anchored',
  },

  // ---- Internal exposure ----
  {
    rule: 'internal-exposure-path',
    pattern: /([A-Z]:\\|\bsrc\/|\b\/portal\/admin|\bproposal-ai\/|\.astro\b|\.ts\b|migration \d+|v\d+\.\d+\.\d+)/g,
    scope: 'global',
  },
  {
    rule: 'internal-exposure-workflow',
    pattern: /\b(SOP|drafter note|QA note|admin only|behind the scenes|internal note|tool\/vendor stack)\b/gi,
    scope: 'global',
  },

  // ---- Dangling tier references in client-facing copy ----
  // Catches phrases like "your tier", "calibrated to your engagement",
  // "based on your level". The proposal already names tiers in the
  // step picker; narrative paragraphs should not pre-reference them.
  {
    rule: 'dangling-tier-reference',
    pattern: /\b(your tier|your level|calibrated to your (engagement|tier|level)|based on your (tier|level)|appropriate to your (tier|level))\b/gi,
    scope: 'global',
  },
];

export function lintSnippet(
  text: string,
  opts: { productScope?: 'wm-only' | 'mc-only' | 'all' } = {},
): VoiceLintResult {
  const productScope = opts.productScope || 'all';
  const violations: VoiceLintResult['violations'] = [];

  for (const rule of RULES) {
    if (rule.productScope === 'wm-only' && productScope !== 'wm-only') continue;

    // Use the right match path based on the rule's flags. Global flags
    // get matchAll for clean iteration; non-global use exec for a
    // single anchored match. One violation per rule is enough; we don't
    // need every occurrence on a long string.
    if (rule.pattern.flags.includes('g')) {
      const matches = Array.from(text.matchAll(rule.pattern));
      if (matches.length > 0) {
        violations.push({ rule: rule.rule, matched: matches[0][0] });
      }
    } else {
      const single = rule.pattern.exec(text);
      if (single) {
        violations.push({ rule: rule.rule, matched: single[0] });
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

// Used to surface the list of rules in admin UI / docs without having
// to re-derive them.
export function listVoiceRules(): string[] {
  return RULES.map(r => r.rule);
}
