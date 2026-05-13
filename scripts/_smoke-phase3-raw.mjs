// Inspect the raw Gemini response without going through the validator.
// Captures size, candidate count attempt, and a sample to disk.

import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { writeFileSync } from 'node:fs';
import { GENERATE_SYSTEM_PROMPT, buildGeneratePrompt } from '../src/lib/naming/prompts/generate.ts';

const apiKey = (process.env.GEMINI_API_KEY || '').trim();
if (!apiKey) { console.error('GEMINI_API_KEY missing'); process.exit(1); }

const SEED = process.argv[2] || 'marketing consulting';

const ai = new GoogleGenerativeAI(apiKey);
const m = ai.getGenerativeModel({
  model: 'gemini-2.5-flash-lite',
  generationConfig: {
    temperature: 0.9,
    responseMimeType: 'application/json',
    maxOutputTokens: 65536,
  },
});

console.error(`[raw] generating for "${SEED}"...`);
const t1 = Date.now();
const result = await m.generateContent(buildGeneratePrompt(SEED));
const elapsed = Date.now() - t1;
const text = result.response.text();
console.error(`[raw] ${elapsed}ms, ${text.length} chars`);

// Inspect structure (no disk write; Windows /tmp issues)
const head = text.slice(0, 200);
const tail = text.slice(-200);
console.log('--- HEAD ---');
console.log(head);
console.log('--- TAIL ---');
console.log(tail);

// Try to parse
try {
  const obj = JSON.parse(text);
  if (obj.candidates && Array.isArray(obj.candidates)) {
    console.log(`\n[raw] candidates count: ${obj.candidates.length}`);
    const counts = {};
    for (const c of obj.candidates) {
      counts[c.typology] = (counts[c.typology] || 0) + 1;
    }
    console.log('[raw] typology counts:', JSON.stringify(counts));
  }
} catch (e) {
  console.error(`\n[raw] JSON parse failed: ${e.message}`);
  // Try to count "name" occurrences as a proxy for candidate count
  const nameCount = (text.match(/"name":/g) || []).length;
  console.error(`[raw] approximate candidate count (by "name": occurrences): ${nameCount}`);
}
