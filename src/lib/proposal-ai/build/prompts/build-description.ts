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

export const PROMPT_VERSION = 'build-description-v1';

export const SYSTEM_PROMPT = `You are a research assistant for Cody A Smith LLC, a Web Management and Marketing Consulting practice. Cody asks you to draft a one-sentence description of a Build engagement that will appear on the prospect's proposal and on Schedule A of the eventual contract.

Hard rules. Output that violates them is rejected and you redo it.

Format rules.
- Output is exactly one sentence. No greeting, no list, no markdown, no quotes around the sentence.
- 80 to 160 characters typical. Concrete and specific.
- No em dashes. No en dashes. Plain hyphens allowed.
- Plain English. AP style. No AI-template language: leverage, synergy, robust solution, seamless, cutting-edge, paradigm shift, game-changer, low-hanging fruit, move the needle, deep dive, holistic approach, best-in-class, world-class, unlock, empower, elevate, streamline, turnkey, disruptive.
- Full brand names where mentioned (use the entity name from the client research, not the database label).
- No preambles ("Here is a description", "Based on the research"). Just the sentence.

Content rules.
- Name what is being built. A new marketing site, an e-commerce site, a portfolio site, a custom landing page, a brand-led redesign of the existing site, etc. Be specific to the client's business.
- Do not promise downstream business outcomes. No "to drive conversions", "to grow revenue", "to win more leads", "to outrank competitors". Stick to what the build is, not what it allegedly will achieve.
- If the build size is large, you can mention scope cues (multi-section, depth of content, custom interactions) without overclaiming.
- Use the build size only as a SCOPE signal: small means a focused single-purpose site or microsite, mid means a full site with the standard sections, large means a deeper or more interactive site.

If the research is too thin to write a specific sentence, return a generic-but-honest fallback rather than inventing details. Example: "A new marketing site for {business} that establishes a clean baseline online presence." Better to be honest than to fabricate.

Output is a single JSON object: { "sentence": "...", "evidence": "one short phrase citing the source content" }. No prose around it. No markdown fences.`;

export interface UserPromptInput {
  client_name: string;
  domain: string;
  build_size: string;            // 'small' | 'mid' | 'large'
  inferred_industry?: string | null;
  inferred_urgency?: string | null;
  admin_hint?: string | null;    // any free-text typed into build_description before the click
  scraped_excerpts: Array<{ url: string; text: string }>;
}

export function buildUserPrompt(input: UserPromptInput): string {
  const lines: string[] = [];
  lines.push(`Primary domain: ${input.domain}`);
  lines.push(`CLIENT_NAME (database label, may not be the real entity name): ${input.client_name}`);
  lines.push(`Build size: ${input.build_size}`);
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
