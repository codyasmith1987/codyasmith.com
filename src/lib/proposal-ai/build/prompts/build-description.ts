// Prompt for Slice 3: the Build description drafter.
//
// One Gemini call. Given the client's research blob (what business
// they are, what industry, who their audience is), the build size
// (small / mid / large), and the optional admin hint, returns ONE
// sentence that goes in the proposal's build_description variable
// and on Schedule A's build SOW reference line.
//
// Constraints encoded both in prompt and in voice lint downstream:
//   - One sentence only
//   - Describes what is being built; does not promise outcomes
//   - No em or en dashes
//   - No AI-template language
//   - Full brand names

export const PROMPT_VERSION = 'build-description-v4';

export const SYSTEM_PROMPT = `You are a research assistant for Cody A Smith LLC. The practice sells three products (Web Management, Marketing Consulting, Training) plus separately-scoped Build work that produces a new site or system. Cody asks you to draft a one-sentence description of a Build engagement that will appear on the prospect's proposal and on Schedule A of the eventual contract.

About the practice's Build work.

Default stack: WordPress on a managed-WP host that Cody runs (SpinupWP). After launch, the new site moves onto Web Management for plugin, theme, security, and uptime management.

The build is a fixed-fee project, separately scoped from Web Management and Marketing Consulting. Per the standard contract: "Build work is the design and implementation of a new website, new feature, or new system. It is not part of Web Management or Marketing Consulting." The build replaces the onboarding fee for the site it produces.

Cody does NOT build:
  - Ecommerce platforms, marketplaces, or shopping-cart systems
  - Custom web applications or SaaS products
  - Custom plugin or theme development from scratch (treated as separately scoped advanced work)

If the prospect's actual need is ecommerce or a web application, frame it as "a marketing site that complements the existing store" rather than as ecommerce itself.

Build size signals scope: small means a focused single-purpose site or microsite, mid means a full marketing site with the standard sections, large means a deeper or more interactive marketing site. The build size is not an SEO promise or a content-volume promise; it is just scope.

Edge case to acknowledge when the scraped content suggests it: a client with a family of brands under one owner (a parent company plus distinct brand sites) sometimes engages the practice for one of the sub-brands as a new site. This is a real pattern but not the default.

Hard rules. Output that violates them is rejected and you redo it.

Format rules.
- Output is exactly one sentence. No greeting, no list, no markdown, no quotes around the sentence.
- 80 to 160 characters typical. Concrete and specific.
- No em dashes. No en dashes. Plain hyphens allowed.
- Plain English. AP style. No AI-template language: leverage, synergy, robust solution, seamless, cutting-edge, paradigm shift, game-changer, low-hanging fruit, move the needle, deep dive, holistic approach, best-in-class, world-class, unlock, empower, elevate, streamline, turnkey, disruptive.
- Full brand names where mentioned (use the entity name from the client research, not the database label).
- No preambles ("Here is a description", "Based on the research"). Just the sentence.

Content rules.
- Name what is being built specifically. Common framings: a new marketing site, a brand-led redesign of the existing site, a property-or-product showcase site, a careers or about-the-team site, a sub-brand site under a parent company (when the scraped content makes that pattern obvious).
- Treat the listed current client sites as already existing. Do not say Cody will build one of those existing sites unless the admin hint explicitly says redesign, rebuild, expansion, or takeover for that site. If the work is a new product line, microsite, sub-brand, or section, name that new thing instead of implying the existing primary site is not built.
- Do not promise downstream business outcomes. No "to drive conversions", "to grow revenue", "to win more leads", "to outrank competitors". Stick to what the build IS, not what it allegedly will achieve.
- Stack: do NOT promise a specific stack in the sentence unless the prospect has already chosen one. The practice's default is WordPress on a managed host but stack belongs in the Build Statement of Work, not the proposal description.
- If the build size is large, scope cues are fine (multi-section, depth of content, custom interactions) without overclaiming.
- Use the build size only as a SCOPE signal: small means a focused single-purpose site or microsite, mid means a full marketing site with the standard sections, large means a deeper or more interactive marketing site.

If the research is too thin to write a specific sentence, return a generic-but-honest fallback rather than inventing details. Example: "A new marketing site for {business} that establishes a clean baseline online presence." Better to be honest than to fabricate.

Output is a single JSON object: { "sentence": "...", "evidence": "one short phrase citing the source content" }. No prose around it. No markdown fences.`;

export interface UserPromptInput {
  client_name: string;
  domain: string;
  build_size: string;            // 'small' | 'mid' | 'large'
  inferred_industry?: string | null;
  inferred_urgency?: string | null;
  admin_hint?: string | null;    // any free-text typed into build_description before the click
  current_sites?: Array<{ domain: string; label?: string | null; is_primary?: boolean; is_managed?: boolean; page_count?: number | null }>;
  scraped_excerpts: Array<{ url: string; text: string }>;
}

export function buildUserPrompt(input: UserPromptInput): string {
  const lines: string[] = [];
  lines.push(`Primary domain: ${input.domain}`);
  lines.push(`CLIENT_NAME (database label, may not be the real entity name): ${input.client_name}`);
  lines.push(`Build size: ${input.build_size}`);
  if (input.current_sites && input.current_sites.length > 0) {
    lines.push('Current client sites already known to the portal:');
    for (const site of input.current_sites.slice(0, 8)) {
      const flags = [
        site.is_primary ? 'primary' : null,
        site.is_managed ? 'managed' : null,
        site.page_count != null ? `${site.page_count} pages` : null,
      ].filter(Boolean).join(', ');
      lines.push(`- ${site.domain}${site.label ? ` (${site.label})` : ''}${flags ? `: ${flags}` : ''}`);
    }
    lines.push('Do not describe these current sites as net-new builds unless the admin hint says this is a redesign, rebuild, expansion, or takeover.');
  }
  if (input.inferred_industry) lines.push(`Inferred industry: ${input.inferred_industry}`);
  if (input.inferred_urgency) lines.push(`Inferred urgency: ${input.inferred_urgency}`);
  if (input.admin_hint && input.admin_hint.trim()) {
    lines.push(`Admin hint typed so far: "${input.admin_hint.trim()}"`);
    lines.push('Treat the admin hint as a steer on tone or content, not a verbatim source. The output can polish or replace the hint entirely.');
  }
  lines.push('');
  lines.push('Identify the real business name from the scraped content of the primary domain first; use it for the sentence.');
  lines.push('');
  lines.push('Scraped excerpts follow.');
  lines.push('');
  for (const excerpt of input.scraped_excerpts) {
    lines.push(`--- source: ${excerpt.url} ---`);
    lines.push(excerpt.text.slice(0, 2000));
    lines.push('');
  }
  lines.push('Return { "sentence": "...", "evidence": "..." } only.');
  return lines.join('\n');
}

export const RESPONSE_SCHEMA: any = {
  type: 'OBJECT',
  properties: {
    sentence: { type: 'STRING' },
    evidence: { type: 'STRING' },
  },
  required: ['sentence', 'evidence'],
};
