// Strict JSON prompt for the client research feature.
//
// Voice anchors and guardrails come straight from Cody's feedback
// memories. The system prompt enumerates them; the user prompt
// supplies the scraped text for synthesis. Gemini returns JSON matching
// the responseSchema; an additional structural validation runs on the
// parsed object before it's cached or sent to the wizard.
//
// Output is purely advisory: every suggestion is reviewed by Cody and
// applied per-field with a click. The prompt tells Gemini to be
// honest about uncertainty (confidence flags, "unknown" fallback).

export const PROMPT_VERSION = 'client-research-v1';

export const SYSTEM_PROMPT = `You are a research assistant for Cody A Smith LLC, a Web Management and Marketing Consulting practice. Cody asks you to look at scraped web content about a prospective client and return a structured assessment used to seed a proposal builder.

Voice and formatting rules. These are hard rules. Output that violates them is rejected and you are asked to redo it.
- Use AP style. No em dashes. No en dashes. Plain hyphens are fine.
- No preambles. No sign-offs. No phrases like "Based on my analysis", "Here is what I found", "It is worth noting", "To summarize", "In conclusion", "Let me know if".
- No AI-template language. Avoid words like leverage, synergy, robust solution, seamless, cutting-edge, paradigm shift, game-changer, low-hanging fruit, move the needle, deep dive, holistic approach, best-in-class, world-class, unlock, empower, elevate, streamline, turnkey, disruptive.
- No promotional overclaim. Do not promise conversions, leads, revenue growth, sales lift, customer acquisition, or ROI. Stick to what is observable in the source content.
- Full brand names. Never abbreviate a client's company name unless they themselves do.
- No file paths, no admin URLs, no version markers, no internal workflow descriptions.

Honesty rules. These shape how you fill the output.
- If the evidence is thin, return "unknown" for that field. Do not invent.
- Every inference field carries a one-sentence evidence note. Cite the source content; do not generalize about the industry.
- Confidence levels: "high" means the source content states the fact directly. "medium" means strong inference from two or more independent signals. "low" means a single weak signal.
- The estimated_page_count field comes from a sitemap count if one is supplied in the user prompt. Otherwise return null and explain why in page_count_source.

Output is a single JSON object with exactly the schema specified. No prose around it. No markdown fences.`;

export interface UserPromptInput {
  client_name: string;
  domain: string;                       // primary domain like "raisedbar.com"
  sitemap_url_count: number | null;     // null if sitemap fetch failed
  sitemap_source: string;
  scraped_excerpts: Array<{ url: string; text: string }>;
}

export function buildUserPrompt(input: UserPromptInput): string {
  const lines: string[] = [];
  lines.push(`Client name: ${input.client_name}`);
  lines.push(`Primary domain: ${input.domain}`);
  if (input.sitemap_url_count !== null) {
    lines.push(`Sitemap URL count: ${input.sitemap_url_count} (from ${input.sitemap_source})`);
  } else {
    lines.push(`Sitemap URL count: not available (${input.sitemap_source})`);
  }
  lines.push('');
  lines.push('Scraped excerpts follow. Each block is text pulled from a public page about this client.');
  lines.push('');
  for (const excerpt of input.scraped_excerpts) {
    lines.push(`--- source: ${excerpt.url} ---`);
    // Trim each excerpt to a sensible length so the token budget stays
    // reasonable. 2500 chars per excerpt is enough context for the model
    // to glean revenue band signals, industry, and focus while staying
    // well under the model's input window.
    lines.push(excerpt.text.slice(0, 2500));
    lines.push('');
  }

  lines.push('Return a JSON object with this exact shape:');
  lines.push(`{
  "estimated_revenue_band": "under-1m" | "1m-to-10m" | "over-10m" | "unknown",
  "revenue_evidence": "one short sentence citing the source",
  "revenue_confidence": "low" | "medium" | "high",
  "inferred_industry": "solo" | "professional-services" | "contractor" | "ecommerce" | "family-of-companies" | "nonprofit" | "other" | "unknown",
  "industry_evidence": "one short sentence",
  "inferred_urgency": "tactical" | "growth" | "maintenance" | "unknown",
  "urgency_evidence": "one short sentence",
  "inferred_focus": ["revenue" | "brand" | "takeover" | "search" | "pre-sell" | "hiring"],
  "domains_found": [{"domain": "...", "role_guess": "primary" | "micro-site" | "subsidiary" | "other", "confidence": "low" | "medium" | "high"}],
  "estimated_page_count": number | null,
  "page_count_source": "one short sentence",
  "notes": "anything Cody should read first"
}`);
  return lines.join('\n');
}

// Optional Gemini responseSchema. Strict typing for the model's JSON
// output. The model honors this when generationConfig sets
// responseSchema with responseMimeType: 'application/json'.
export const RESPONSE_SCHEMA: any = {
  type: 'OBJECT',
  properties: {
    estimated_revenue_band: { type: 'STRING' },
    revenue_evidence: { type: 'STRING' },
    revenue_confidence: { type: 'STRING' },
    inferred_industry: { type: 'STRING' },
    industry_evidence: { type: 'STRING' },
    inferred_urgency: { type: 'STRING' },
    urgency_evidence: { type: 'STRING' },
    inferred_focus: { type: 'ARRAY', items: { type: 'STRING' } },
    domains_found: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          domain: { type: 'STRING' },
          role_guess: { type: 'STRING' },
          confidence: { type: 'STRING' },
        },
        required: ['domain', 'role_guess', 'confidence'],
      },
    },
    estimated_page_count: { type: 'NUMBER', nullable: true },
    page_count_source: { type: 'STRING' },
    notes: { type: 'STRING' },
  },
  required: [
    'estimated_revenue_band',
    'revenue_evidence',
    'revenue_confidence',
    'inferred_industry',
    'industry_evidence',
    'inferred_urgency',
    'urgency_evidence',
    'inferred_focus',
    'domains_found',
    'estimated_page_count',
    'page_count_source',
    'notes',
  ],
};
