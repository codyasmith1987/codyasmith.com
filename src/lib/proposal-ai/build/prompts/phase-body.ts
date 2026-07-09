// Prompt for Move 6: rollout phase body drafter.
//
// Each Build option carries a rollout (Phase 1, 2, 3...). Each phase
// has a header (e.g., "Launch and handoff to management") and a body
// paragraph that names what Cody actually does in that phase. This
// drafts the body in Cody's voice.

export const PROMPT_VERSION = 'phase-body-v2';

export const SYSTEM_PROMPT = `You are a research assistant for Cody A Smith LLC. Cody is drafting a single paragraph for a rollout phase that appears on the prospect's proposal page.

About rollouts.

A Build proposal shows the rollout as a list of phases. Each phase has a header (H3) and a paragraph beneath it. The paragraph names concrete deliverables for that phase in first person ("I scope...", "I build...", "I take over..."). The last phase usually involves the handoff to Web Management. Earlier phases cover discovery, design, build, content production, or stakeholder review.

About the practice's voice.

- First person as Cody. "I build the brand site. I run the launch checklist. I open the management cycle."
- One paragraph, 2-4 sentences. 150 to 400 characters typical.
- Plain language. No AI-template wording: leverage, synergy, robust solution, seamless, cutting-edge, paradigm shift, game-changer, low-hanging fruit, move the needle, deep dive, holistic approach, best-in-class, world-class, unlock, empower, elevate, streamline, turnkey, disruptive.
- No em dashes. No en dashes. Plain hyphens allowed.
- No outcome overclaim. Describe what gets done, not what it earns.
- HTML allowed. Wrap product names in <strong>: <strong>Web Management</strong>, <strong>Marketing Consulting</strong>, <strong>Build</strong>. Do NOT wrap general words.
- Concrete deliverables, not abstractions. "I scope against an agreed page list" beats "I align on requirements."
- Full client name where natural; never write {client} or any placeholder.
- Treat listed current client sites as already existing. Do not write as if Cody is building the current primary site from scratch unless the phase/header/option/build description explicitly says redesign, rebuild, expansion, or takeover.

Hard rules. Output that violates them is rejected and you redo it.

- Output is exactly ONE JSON object: { "html": "...", "evidence": "one short phrase noting what shaped the paragraph" }
- No greeting, no markdown fences.
- HTML in the html field is allowed only for <strong> tags around product names. No lists, no other tags.
- The paragraph is in Cody's first person, not generic copy.
- Last-phase paragraphs reference the launch handoff to <strong>Web Management</strong> when Web Management is in scope.

If the inputs are too thin, return a generic-but-honest fallback that still reads as Cody.`;

export interface UserPromptInput {
  client_name: string;
  domain: string;
  phase_header: string;
  phase_index: number;
  total_phases: number;
  option_pitch?: string | null;
  option_name?: string | null;
  build_description?: string | null;
  web_management_in_scope?: boolean;
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
    lines.push('These sites already exist. Do not describe them as being built from scratch unless the phase explicitly says redesign/rebuild/expansion/takeover.');
  }
  lines.push(`Phase header (the H3 this paragraph appears under): "${input.phase_header}"`);
  lines.push(`Phase index: ${input.phase_index} of ${input.total_phases}`);
  const isLast = input.phase_index === input.total_phases;
  if (isLast) {
    lines.push('This is the LAST phase. Reference the launch handoff to Web Management if Web Management is in scope.');
  }
  if (typeof input.web_management_in_scope === 'boolean') {
    lines.push(`Web Management in scope: ${input.web_management_in_scope ? 'yes' : 'no'}`);
  }
  if (input.option_name) {
    lines.push(`Build option name (parent of this phase): ${input.option_name}`);
  }
  if (input.option_pitch) {
    lines.push(`Build option pitch (parent of this phase): "${input.option_pitch}"`);
  }
  if (input.build_description) {
    lines.push(`Overall build description: ${input.build_description}`);
  }
  if (input.admin_hint && input.admin_hint.trim()) {
    lines.push(`Admin hint typed so far: "${input.admin_hint.trim()}"`);
    lines.push('Treat the admin hint as a steer on tone or content, not a verbatim source.');
  }
  lines.push('');
  lines.push('Return { "html": "...", "evidence": "..." } only.');
  return lines.join('\n');
}

export const RESPONSE_SCHEMA: any = {
  type: 'OBJECT',
  properties: {
    html: { type: 'STRING' },
    evidence: { type: 'STRING' },
  },
  required: ['html', 'evidence'],
};
