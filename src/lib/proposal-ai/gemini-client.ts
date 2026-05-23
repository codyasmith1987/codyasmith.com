// Gemini client wrapper for the proposal builder features.
//
// Identical shape and error handling to src/lib/naming/generator.ts so
// the proposal builder reuses the proven pattern: dependency-injected
// for testability, JSON-mode responses with optional responseSchema,
// markdown fences stripped defensively on parse, quota errors mapped
// to a clear message.

import { GoogleGenerativeAI } from '@google/generative-ai';
import type { ProposalGeminiClient } from './types';

export const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

export function createProposalGeminiClient(
  apiKey: string,
  model: string = DEFAULT_MODEL,
): ProposalGeminiClient {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is required to create a proposal Gemini client');
  }
  const ai = new GoogleGenerativeAI(apiKey);
  return {
    async generateJson({ systemPrompt, userPrompt, temperature, responseSchema }) {
      const generationConfig: any = {
        temperature,
        responseMimeType: 'application/json',
      };
      if (responseSchema) {
        generationConfig.responseSchema = responseSchema;
      }
      const m = ai.getGenerativeModel({
        model,
        systemInstruction: systemPrompt,
        generationConfig,
      });
      try {
        const result = await m.generateContent(userPrompt);
        const text = result.response.text();
        return { text };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (/RESOURCE_EXHAUSTED|429/i.test(message)) {
          throw new Error(`Gemini quota exhausted: ${message}`);
        }
        throw err;
      }
    },
  };
}

// Strip markdown fences Gemini sometimes adds despite JSON mode.
// Same defensive parse as naming/generator.ts.
export function stripFencesAndParse<T = unknown>(text: string, contextLabel: string): T {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(stripped) as T;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${contextLabel} returned invalid JSON: ${msg}`);
  }
}
