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

export const PROMPT_VERSION = 'client-research-v5';

export const SYSTEM_PROMPT = `You are a research assistant for Cody A Smith LLC, a Web Management and Marketing Consulting practice. You look at scraped web content about a prospective client and return a structured assessment used to seed a proposal builder.

Critical orientation step before any inference.

You are given a primary domain in the user prompt. The first scraped excerpt is normally that domain's homepage. The CLIENT_NAME field in the user prompt may NOT be the actual business name; it is a database label that can be a placeholder (e.g., "Cody Test"), a holding-company name, or the buyer's personal name. Do not rely on it for anything beyond context.

Your first job is to identify the REAL business name from the scraped content of the primary domain. Look at the site's <title>, hero copy, about page text, footer. Use THAT name as the entity for every downstream inference. If you cannot identify a real business name from the site content, return "unknown" everywhere with low confidence and say so in notes.

Voice and formatting rules. Output that violates them is rejected.
- Use AP style. No em dashes. No en dashes. Plain hyphens are fine.
- No preambles. No sign-offs. No phrases like "Based on my analysis", "Here is what I found", "It is worth noting", "To summarize", "In conclusion", "Let me know if".
- No AI-template language. Avoid words like leverage, synergy, robust solution, seamless, cutting-edge, paradigm shift, game-changer, low-hanging fruit, move the needle, deep dive, holistic approach, best-in-class, world-class, unlock, empower, elevate, streamline, turnkey, disruptive.
- No promotional overclaim. Do not promise conversions, leads, revenue growth, sales lift, customer acquisition, or ROI. Stick to what is observable in the source content.
- Full brand names. Never abbreviate a business's name unless it abbreviates itself.
- No file paths, no admin URLs, no version markers, no internal workflow descriptions.

Honesty rules.
- If the evidence is thin, return "unknown" for that field with low confidence. Do not invent.
- Every inference field carries a one-sentence evidence note that quotes or paraphrases the actual source content. Generic claims like "the website suggests" are not acceptable.
- Confidence: "high" means the source content states the fact directly. "medium" means strong inference from two or more independent signals. "low" means a single weak signal.
- estimated_page_count comes from the sitemap count supplied in the user prompt. If the supplied count is null, return null and explain in page_count_source.
- domains_found must include ONLY domains the primary site explicitly identifies as its own (parent corp, subsidiary, alternate brand, micro-site under the same ownership). Do NOT include social profiles (facebook.com, linkedin.com, instagram.com, vimeo.com, etc.), third-party platforms (zendesk subdomains, silkroad job boards, etc.), or arbitrary external links the site mentions but does not own. Each entry's role_guess must be primary, micro-site, subsidiary, alternate-brand, or other (with confidence "low" forcing other).
- revenue_evidence must cite a SPECIFIC source from the scraped content that mentions revenue, employee count, or funding. "The website does not mention revenue" is not evidence; it is grounds for returning "unknown" with low confidence.
- inferred_industry must come from what the business actually does, not from keyword matches against the client name string.

Output is a single JSON object with exactly the schema specified. No prose around it. No markdown fences.`;

export interface UserPromptInput {
  client_name: string;
  domain: string;                       // primary domain like "raisedbar.com"
  sitemap_url_count: number | null;     // null if sitemap fetch failed
  sitemap_source: string;
  scraped_excerpts: Array<{ url: string; text: string }>;
  // Brand candidates extracted from the homepage title and used to
  // run brand-anchored Serper queries. May be empty when the site
  // title was unparseable. Helps Gemini cross-check that the entity
  // it identifies from the scraped content matches what the public
  // records refer to.
  brand_candidates?: string[];
}

export function buildUserPrompt(input: UserPromptInput): string {
  const lines: string[] = [];
  lines.push(`Primary domain (authoritative): ${input.domain}`);
  lines.push(`CLIENT_NAME (database label, may NOT be the real entity name): ${input.client_name}`);
  if (input.brand_candidates && input.brand_candidates.length > 0) {
    lines.push(`Brand candidates extracted from the homepage title: ${input.brand_candidates.join(', ')}`);
    lines.push('The Serper queries used these brand candidates, so the public-record results below should be about the same entity. If they do not match what the scraped homepage content describes, return "unknown" for the conflicting field with low confidence.');
  } else {
    lines.push('No brand candidate could be extracted from the homepage title; rely entirely on the scraped content to identify the business name.');
  }
  lines.push('');
  lines.push(`Identify the real business name from the scraped content of ${input.domain} first; use it for every inference. Do NOT use CLIENT_NAME as the entity.`);
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
  "inferred_industry": "solo" | "professional-services" | "contractor" | "manufacturing" | "family-of-companies" | "nonprofit" | "other" | "unknown",
  "industry_evidence": "one short sentence",
  "inferred_urgency": "tactical" | "growth" | "maintenance" | "unknown",
  "urgency_evidence": "one short sentence",
  "inferred_focus": ["brand" | "takeover" | "search" | "pre-sell"],
  "detected_cms": "wordpress" | "squarespace" | "wix" | "shopify" | "webflow" | "duda" | "godaddy-builder" | "custom" | "unknown",
  "cms_evidence": "one short sentence citing the specific HTML / generator signal",
  "domains_found": [{"domain": "...", "role_guess": "primary" | "micro-site" | "subsidiary" | "other", "confidence": "low" | "medium" | "high"}],
  "estimated_page_count": number | null,
  "page_count_source": "one short sentence",
  "notes": "anything Cody should read first"
}

CMS detection guidance. Inspect the scraped homepage HTML for these signals:
  - wordpress: wp-content / wp-includes / /wp-json/ paths, generator meta "WordPress", classes prefixed wp-, theme paths under /wp-content/themes/
  - squarespace: static1.squarespace.com or sqsp- asset URLs, sqs- prefixed classes, generator meta
  - wix: parastorage.com or wixstatic.com asset URLs, _wix_ prefixed identifiers
  - shopify: cdn.shopify.com asset URLs, shopify- prefixed classes
  - webflow: webflow.com or website-files.com asset URLs, w- prefixed classes
  - duda: dudamobile.com or multiscreensite.com assets
  - godaddy-builder: godaddysites.com, secureserver.net builder hosts
  - custom: bespoke build, no recognizable platform signals
  - unknown: cannot determine from the scraped content

When in doubt, return "unknown" with low cms_evidence rather than guessing.`);
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
    detected_cms: { type: 'STRING' },
    cms_evidence: { type: 'STRING' },
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
    'detected_cms',
    'cms_evidence',
    'domains_found',
    'estimated_page_count',
    'page_count_source',
    'notes',
  ],
};
