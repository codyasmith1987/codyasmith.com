// Throwaway smoke test for the Phase 3 generator + validator.
// Runs real Gemini, checks whether the validator passes. If it fails,
// prints the rule that failed and the offending data so we can decide
// whether the validator is too strict or the prompt needs revision.

import 'dotenv/config';
import {
  generate,
  createGeminiClient,
  GeneratorValidationError,
} from '../src/lib/naming/generator.ts';

const SEED = process.argv[2] || 'marketing consulting';

const apiKey = (process.env.GEMINI_API_KEY || '').trim();
if (!apiKey) {
  console.error('GEMINI_API_KEY missing');
  process.exit(1);
}
const gemini = createGeminiClient(apiKey);

console.error(`[smoke] generating for "${SEED}" (cache bypassed)...`);
const t1 = Date.now();
let result;
try {
  result = await generate({ seed: SEED }, { gemini });
} catch (err) {
  if (err instanceof GeneratorValidationError) {
    console.error(`[smoke] VALIDATION FAILED at rule: ${err.rule}`);
    console.error(`[smoke] details: ${err.details}`);
    process.exit(2);
  }
  console.error('[smoke] generation error:', err?.message || String(err));
  process.exit(1);
}
const elapsed = Date.now() - t1;
console.error(`[smoke] generation: ${elapsed}ms, ${result.candidates.length} candidates`);

// Per-typology distribution
const typoCounts = {};
for (const c of result.candidates) {
  typoCounts[c.typology] = (typoCounts[c.typology] || 0) + 1;
}
console.error('[smoke] typology counts:', JSON.stringify(typoCounts));

// Sample 3 from each typology
const samples = {};
for (const c of result.candidates) {
  if (!samples[c.typology]) samples[c.typology] = [];
  if (samples[c.typology].length < 3) samples[c.typology].push(c);
}
console.log(JSON.stringify({ elapsed_ms: elapsed, total: result.candidates.length, typology_counts: typoCounts, samples }, null, 2));
