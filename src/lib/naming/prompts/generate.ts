// Phase 3 generation prompts. Path C: four parallel typology-specific calls.
// One template, type-specific clause injected per call. Each call asks for
// approximately 50 candidates of a single typology; validator floors at 30
// per call. Bumped via DEFAULTS.PROMPT_VERSION (v4) so cache invalidates.

import type { Typology } from '../types';

const TYPOLOGY_CLAUSES: Record<Typology, string> = {
  descriptive: `Generate descriptive names: names that describe the offering directly using real words from the seed's domain. The name should make the category obvious without being generic.`,
  suggestive: `Generate suggestive names: names that imply benefits, qualities, or feelings without describing the offering directly. The connection should be evocative, not literal.`,
  associative: `Generate associative or metaphoric names: names borrowed from unrelated domains used as metaphor. Sources include atmospheric phenomena, geological formations, animals, mythology, food, music, architecture, or any other concrete domain that maps interesting attributes onto the seed.`,
  abstract: `Generate abstract or coined names: invented words, portmanteaus (combining two real words), or phonetic compressions (recognizable phrases compressed into a single word). The rationale for each candidate must identify which technique was used and must contain one of the words 'portmanteau', 'compression', 'compresses', 'blend', or 'blends'.`,
};

export function buildGeneratePrompt(
  seed: string,
  typology?: Typology,
  retryToken?: string,
): string {
  // Phase 3 Path C: typology must be provided. The signature keeps `seed`
  // as the first arg for backward-compat with Phase 1/2 callers; legacy
  // callers passing only seed will hit the runtime check below.
  if (!typology) {
    throw new Error('Phase 3 buildGeneratePrompt requires typology argument');
  }

  const clause = TYPOLOGY_CLAUSES[typology];

  const retryNote = retryToken
    ? `\n\nNOTE: a previous response from you on this same prompt failed downstream validation. Re-generate with attention to: name length 4 to 15 characters, no forbidden suffixes, no duplicate names within this batch, all rationales 30 to 240 characters. Vary your output from the previous attempt. (regeneration token: ${retryToken})`
    : '';

  return `You are a domain naming engine. You produce candidate brand names for a single typological position per request.

THIS REQUEST
${clause}

OUTPUT STRUCTURE
Generate approximately 25 candidates. The downstream validator requires at least 15 candidates to accept this batch. Each candidate has: name, 1-sentence rationale in plain language (no jargon), and tonality vector with five axes scored 1-5 (serious-to-playful, modern-to-classical, descriptive-to-abstract, technical-to-emotional, conservative-to-bold).

NAMING RULES
- Capitalized first letter, ASCII letters and optional internal hyphens only, no spaces, no digits.
- Length 4 to 15 characters.
- Real English words must be spelled correctly.
- Forbidden suffixes (case-insensitive, applied to end of name): Lab, HQ, Studio, Works, Co, Hub, Pro, Plus, Apex, Edge, Core, Mark, Flow, Forge, Sync, Wave, Sphere, Logic, Sense, Path, Drive, Shift, ly, ify.
- No duplicate names within this batch.

RATIONALE RULES
Every rationale must answer one of: memorability hook (what makes it stick), positioning angle (what it implies about the brand), or sound-shape reason (rhythm, mouthfeel, alliteration). Rationales must be plain language, the kind of thing you would say to a small business owner, not a linguist. Length 30 to 240 characters. Forbidden: etymology restatement, generic implications ("suggests reliability"), tautology, simple seed-anchoring.

OUTPUT JSON SHAPE
Return strict JSON, no surrounding prose, no markdown fences. Do not include a typology field on each candidate; the orchestrator stamps it after the call.

{
  "candidates": [
    {
      "name": "CandidateName",
      "rationale": "1-sentence plain-language rationale",
      "tonality": {
        "serious_playful": 1-5,
        "modern_classical": 1-5,
        "descriptive_abstract": 1-5,
        "technical_emotional": 1-5,
        "conservative_bold": 1-5
      }
    }
  ]
}

Aim for approximately 25 candidates. Validator requires at least 15. Stop generating once you reach approximately 25; do not exceed 30. Output token budget is finite; runaway generation will be truncated and rejected.${retryNote}

Seed term: "${seed}"`;
}

// Legacy export kept so Phase 1/2 test imports still resolve at parse time.
// Phase 3 generator does not import this; it builds typology-specific prompts.
export const GENERATE_SYSTEM_PROMPT = 'PHASE_3_USES_TYPOLOGY_SPECIFIC_PROMPTS_VIA_BUILD_GENERATE_PROMPT';
