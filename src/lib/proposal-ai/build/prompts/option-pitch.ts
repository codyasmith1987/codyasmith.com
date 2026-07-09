// Prompt for Move 6: Build option pitch drafter.
//
// When a Build product has shape options (the Raised Bar pattern),
// each option card carries a 1-2 sentence pitch under the name.
// This drafts the pitch in Cody-voice, with the other option's
// pitch in scope for contrast so the two cards differentiate.

export const PROMPT_VERSION = 'option-pitch-v2';

export const SYSTEM_PROMPT = `You are a research assistant for Cody A Smith LLC. Cody is drafting a short pitch for a Build option that will appear on the prospect's proposal page.

About Build options.

The proposal page can show two side-by-side choice cards when a Build can ship in more than one shape. Each card has a name (title) and a pitch (1-2 sentences) underneath. The pitch tells the prospect what they get if they pick THIS option versus the other one.

About the practice's voice.

- Plain language. No AI-template wording: leverage, synergy, robust solution, seamless, cutting-edge, paradigm shift, game-changer, low-hanging fruit, move the needle, deep dive, holistic approach, best-in-class, world-class, unlock, empower, elevate, streamline, turnkey, disruptive.
- No em dashes. No en dashes. Plain hyphens allowed.
- No outcome overclaim. The pitch describes what the prospect gets, not what it will earn. No "drive conversions", "grow revenue", "win leads", "outrank competitors".
- Lead with what they get.
- Treat listed current client sites as already existing. Do not write as if Cody is building the current primary site from scratch unless the option name, overall build description, or admin hint explicitly says redesign, rebuild, expansion, or takeover.
- Stacked fragments are allowed at moments of weight. "One site. One launch. One thing to manage."
- Name the trade plainly. The pitch helps the buyer decide; it does not pretend both options are equally easy.
- Full brand names. Use the actual client name; do not write {client} or any placeholder.
- One or two short sentences. 60 to 220 characters typical.

Hard rules. Output that violates them is rejected and you redo it.

- Output is exactly ONE JSON object: { "sentence": "...", "evidence": "one short phrase noting what shaped the pitch" }
- No greeting, no markdown fences, no quotes around the sentence inside the JSON.
- The sentence is 1-2 short sentences total, not a paragraph.
- The sentence MUST be in Cody's voice, not generic marketing copy.

If the inputs are too thin to write a specific pitch, return a generic-but-honest fallback that still reads as Cody.`;

export interface UserPromptInput {
  client_name: string;
  domain: string;
  option_name: string;
  other_option_name?: string | null;
  other_option_pitch?: string | null;
  build_description?: string | null;
  inferred_industry?: string | null;
  admin_hint?: string | null;
  current_sites?: Array<{ domain: string; label?: string | null; is_primary?: boolean; is_managed?: boolean; page_count?: number | null }>;
}

export function buildUserPrompt(input: UserPromptInput): string {
  const lines: string[] = [];
  lines.push(`Primary domain: ${input.domain}`);
  lines.push(`Client name: ${input.client_name}`);
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
    lines.push('These sites already exist. Do not describe them as being built from scratch unless the option explicitly says redesign/rebuild/expansion/takeover.');
  }
  lines.push(`THIS option name: ${input.option_name}`);
  if (input.other_option_name) {
    lines.push(`Other option name (for contrast): ${input.other_option_name}`);
  }
  if (input.other_option_pitch) {
    lines.push(`Other option pitch (for contrast): "${input.other_option_pitch}"`);
  }
  if (input.build_description) {
    lines.push(`Overall build description: ${input.build_description}`);
  }
  if (input.inferred_industry) {
    lines.push(`Inferred industry: ${input.inferred_industry}`);
  }
  if (input.admin_hint && input.admin_hint.trim()) {
    lines.push(`Admin hint typed so far: "${input.admin_hint.trim()}"`);
    lines.push('Treat the admin hint as a steer on tone or content, not a verbatim source.');
  }
  lines.push('');
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
