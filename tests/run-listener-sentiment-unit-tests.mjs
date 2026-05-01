#!/usr/bin/env node
// Listener sentiment unit tests. Mocked Gemini, in-memory libsql for cache.
// Hand-rolled in the style of tests/run-billing-tests.mjs but importing engine
// modules directly because this is library code, not HTTP endpoints.
//
// Runs via tsx because the engine modules are TypeScript. See package.json.

import { createClient } from '@libsql/client';

import {
  analyzeWithLexicon,
  cacheKey,
  createCacheClient,
  parseAndValidateScore,
  scoreMention,
  PROMPT_VERSION,
  MODEL,
  SCORE_SYSTEM_PROMPT,
} from '../src/lib/sentiment-gemini.ts';
import { generateReport } from '../src/lib/sentiment.ts';
import { LISTENER_SENTIMENT_CACHE_SQL } from '../src/lib/migrations/013-listener-sentiment-cache.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass, detail: String(detail).slice(0, 300) });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 300)}`);
}

function geminiResponseFor({ score, label, positive_themes, negative_themes, key_phrases }) {
  return JSON.stringify({
    score,
    label,
    positive_themes: positive_themes ?? [],
    negative_themes: negative_themes ?? [],
    key_phrases: key_phrases ?? [],
  });
}

async function run() {
  // ============ analyzeWithLexicon ============
  console.log('--- lexicon path ---');
  const lexPositive = analyzeWithLexicon('I love this product, customer service was amazing.');
  test('lexicon positive label', lexPositive.label === 'positive', `got ${lexPositive.label}`);
  test('lexicon positive score > 0', lexPositive.score > 0, `got ${lexPositive.score}`);
  test('lexicon has positive words', lexPositive.positive.length > 0);
  test('lexicon key_phrases populated', Array.isArray(lexPositive.key_phrases) && lexPositive.key_phrases.length > 0);

  const lexEmpty = analyzeWithLexicon('');
  test('lexicon empty text neutral', lexEmpty.label === 'neutral', `got ${lexEmpty.label}`);
  test('lexicon empty score 0', lexEmpty.score === 0);
  test('lexicon empty arrays', lexEmpty.positive.length === 0 && lexEmpty.negative.length === 0);

  // ============ parseAndValidateScore ============
  console.log('--- parseAndValidateScore ---');
  const validJson = geminiResponseFor({ score: 0.7, label: 'positive', positive_themes: ['fast shipping'], negative_themes: [], key_phrases: ['fast shipping', 'great support'] });
  const parsed = parseAndValidateScore(validJson);
  test('valid response parses', parsed.score === 0.7 && parsed.label === 'positive');
  test('one-decimal precision enforced', parseAndValidateScore(geminiResponseFor({ score: 0.66, label: 'positive', key_phrases: ['a', 'b'] })).score === 0.7);

  const fenced = '```json\n' + validJson + '\n```';
  test('strips json fences', parseAndValidateScore(fenced).score === 0.7);

  let threw = false;
  try { parseAndValidateScore('not json'); } catch { threw = true; }
  test('rejects invalid JSON', threw);

  threw = false;
  try { parseAndValidateScore(geminiResponseFor({ score: 5, label: 'positive', key_phrases: ['a', 'b'] })); } catch (e) { threw = /Invalid score/.test(String(e)); }
  test('rejects score out of range', threw);

  threw = false;
  try { parseAndValidateScore(geminiResponseFor({ score: 0.5, label: 'rave', key_phrases: ['a', 'b'] })); } catch (e) { threw = /Invalid label/.test(String(e)); }
  test('rejects invalid label', threw);

  threw = false;
  try { parseAndValidateScore(JSON.stringify({ score: 0.5, label: 'positive', positive_themes: 'not an array', negative_themes: [], key_phrases: ['a', 'b'] })); } catch (e) { threw = /positive_themes/.test(String(e)); }
  test('rejects non-array positive_themes', threw);

  // ============ cacheKey ============
  console.log('--- cacheKey ---');
  const k1 = cacheKey('hello world');
  const k2 = cacheKey('hello world');
  const k3 = cacheKey('hello worlds');
  test('cacheKey stable', k1 === k2);
  test('cacheKey differs by text', k1 !== k3);
  test('cacheKey length 64', k1.length === 64);
  test('cacheKey prompt version sensitivity', cacheKey('x', 'v1', MODEL) !== cacheKey('x', 'v2', MODEL));
  test('cacheKey model sensitivity', cacheKey('x', PROMPT_VERSION, 'a') !== cacheKey('x', PROMPT_VERSION, 'b'));

  // ============ scoreMention with cache + gemini mocks ============
  console.log('--- scoreMention cascade ---');
  const memDb = createClient({ url: ':memory:' });
  await memDb.batch(LISTENER_SENTIMENT_CACHE_SQL, 'write');
  const cache = createCacheClient(memDb);

  let geminiCalls = 0;
  const mockGeminiHappy = {
    async scoreOnce(systemPrompt, userPrompt) {
      geminiCalls += 1;
      if (!systemPrompt.includes('brand monitoring analyst')) {
        throw new Error('mock gemini: system prompt missing analyst voice');
      }
      if (!userPrompt.includes('AcmeCorp')) {
        throw new Error('mock gemini: user prompt missing brand');
      }
      return geminiResponseFor({
        score: 0.8,
        label: 'positive',
        positive_themes: ['responsive support', 'reliable delivery'],
        negative_themes: [],
        key_phrases: ['responsive support', 'reliable delivery', 'trusted brand'],
      });
    },
  };

  const mention = {
    url: 'https://example.com/review',
    source_name: 'Example',
    source_type: 'review',
    full_text: 'AcmeCorp delivered on time and the support team was very helpful.',
  };

  const r1 = await scoreMention('AcmeCorp', mention, { gemini: mockGeminiHappy, cache });
  test('cascade Gemini happy path scored_by gemini', r1.scored_by === 'gemini');
  test('cascade returns mapped score', r1.score === 0.8);
  test('cascade returns mapped label', r1.label === 'positive');
  test('cascade returns positive themes', r1.positive.includes('responsive support'));
  test('cascade returns key_phrases', r1.key_phrases.length === 3);
  test('cascade Gemini called once', geminiCalls === 1);

  // Second call: cache hit, no Gemini
  const r2 = await scoreMention('AcmeCorp', mention, { gemini: mockGeminiHappy, cache });
  test('cascade cache hit scored_by gemini', r2.scored_by === 'gemini');
  test('cascade cache hit no Gemini call', geminiCalls === 1);
  test('cascade cache hit returns same score', r2.score === 0.8);

  // Mock Gemini that throws
  const mockGeminiThrows = {
    async scoreOnce() { throw new Error('quota exhausted'); },
  };
  const differentMention = { ...mention, full_text: 'A completely different mention. Nothing memorable here.' };
  const r3 = await scoreMention('AcmeCorp', differentMention, { gemini: mockGeminiThrows, cache });
  test('cascade Gemini throws falls back to lexicon', r3.scored_by === 'lexicon');
  test('cascade lexicon fallback returns valid label', ['positive', 'negative', 'neutral'].includes(r3.label));

  // Verify the failing-Gemini run did not write to cache
  const cacheCheckAfterFailure = await cache.get(cacheKey(differentMention.full_text));
  test('cascade does not cache lexicon results', cacheCheckAfterFailure === null);

  // Mock Gemini returning invalid JSON
  const mockGeminiInvalid = {
    async scoreOnce() { return 'not valid json at all'; },
  };
  const yetAnotherMention = { ...mention, full_text: 'Another distinct mention text for the invalid path.' };
  const r4 = await scoreMention('AcmeCorp', yetAnotherMention, { gemini: mockGeminiInvalid, cache });
  test('cascade invalid JSON falls back to lexicon', r4.scored_by === 'lexicon');

  // Mock Gemini returning out-of-range score
  const mockGeminiBadScore = {
    async scoreOnce() {
      return geminiResponseFor({ score: 99, label: 'positive', key_phrases: ['a', 'b'] });
    },
  };
  const oneMoreMention = { ...mention, full_text: 'Yet another distinct mention text for the bad score path.' };
  const r5 = await scoreMention('AcmeCorp', oneMoreMention, { gemini: mockGeminiBadScore, cache });
  test('cascade bad score falls back to lexicon', r5.scored_by === 'lexicon');

  // No Gemini available (deps.gemini = null), no cache hit, falls back to lexicon
  const r6 = await scoreMention('AcmeCorp', { ...mention, full_text: 'Distinct text for no-gemini path.' }, { gemini: null, cache });
  test('cascade no Gemini falls back to lexicon', r6.scored_by === 'lexicon');

  // Empty text path. Use a prompt-aware mock that honors the edge-case rule
  // (empty text returns neutral). Real Gemini's behavior on empty text is
  // verified by the prompt design and the integration test.
  const mockGeminiAware = {
    async scoreOnce(_sys, userPrompt) {
      const m = userPrompt.match(/Mention text:\n([\s\S]*?)\n\nScore this/);
      const text = (m && m[1] ? m[1] : '').trim();
      if (!text) {
        return geminiResponseFor({ score: 0, label: 'neutral', positive_themes: [], negative_themes: [], key_phrases: [] });
      }
      return geminiResponseFor({ score: 0.8, label: 'positive', positive_themes: ['fast shipping'], negative_themes: [], key_phrases: ['fast shipping', 'great support'] });
    },
  };
  const r7 = await scoreMention('AcmeCorp', { ...mention, full_text: '' }, { gemini: mockGeminiAware, cache });
  test('cascade empty text returns valid result', r7.scored_by === 'gemini' || r7.scored_by === 'lexicon');
  test('cascade empty text neutral', r7.label === 'neutral', `got label ${r7.label} score ${r7.score}`);
  test('cascade empty text score 0', r7.score === 0, `got ${r7.score}`);

  // ============ generateReport with mixed scored_by ============
  console.log('--- generateReport with mixed scored_by ---');
  const fakeScrapedMentions = [
    { url: 'https://example.com/a', source_name: 'Example A', source_type: 'review', snippet: 'positive snippet', full_text: 'great product, fast shipping', query_type: 'general' },
    { url: 'https://example.com/b', source_name: 'Example B', source_type: 'forum', snippet: 'negative snippet', full_text: 'terrible service, slow refunds', query_type: 'general' },
    { url: 'https://example.com/c', source_name: 'Example C', source_type: 'review', snippet: 'mixed snippet', full_text: 'okay product but expensive', query_type: 'general' },
  ];

  // Half use Gemini-mock returning positive, half use lexicon (via thrown Gemini)
  let alternateThrow = false;
  const mockGeminiAlternating = {
    async scoreOnce(_sys, userPrompt) {
      alternateThrow = !alternateThrow;
      if (alternateThrow) {
        return geminiResponseFor({
          score: 0.5,
          label: 'positive',
          positive_themes: ['fast shipping'],
          negative_themes: [],
          key_phrases: ['fast shipping', 'great quality'],
        });
      }
      throw new Error('alternating mock failure');
    },
  };

  const report = await generateReport(fakeScrapedMentions, 'AcmeCorp', { gemini: mockGeminiAlternating, cache });
  test('generateReport returns 3 mentions', report.mention_count === 3);
  test('generateReport overall_score in [0,100]', report.overall_score >= 0 && report.overall_score <= 100);
  test('generateReport overall_label valid', ['Strong', 'Positive', 'Mixed', 'Poor'].includes(report.overall_label));
  test('generateReport mixed scored_by present',
    report.mentions.some(m => m.scored_by === 'gemini') && report.mentions.some(m => m.scored_by === 'lexicon'));
  test('generateReport per-mention labels lowercase',
    report.mentions.every(m => ['positive', 'negative', 'neutral', 'mixed'].includes(m.sentiment_label)));
  test('generateReport overall label capitalized',
    /^(Strong|Positive|Mixed|Poor)$/.test(report.overall_label));
  test('generateReport source_breakdown computed', Object.keys(report.source_breakdown).length >= 1);
  test('generateReport source_breakdown shape',
    Object.values(report.source_breakdown).every(v => typeof v.count === 'number' && typeof v.avg_score === 'number'));

  // Empty-mention path
  const emptyReport = await generateReport([], 'AcmeCorp', { gemini: mockGeminiHappy, cache });
  test('generateReport empty mention_count 0', emptyReport.mention_count === 0);
  test('generateReport empty overall_score 50', emptyReport.overall_score === 50);

  // Progress callback fires
  let progressCalls = 0;
  await generateReport(fakeScrapedMentions, 'AcmeCorp', {
    gemini: mockGeminiHappy,
    cache,
    onMentionScored: () => { progressCalls += 1; },
  });
  test('generateReport progress callback fires per mention', progressCalls === 3);

  // ============ system prompt sanity ============
  console.log('--- system prompt sanity ---');
  test('system prompt mentions JSON shape', SCORE_SYSTEM_PROMPT.includes('"score"') && SCORE_SYSTEM_PROMPT.includes('"label"'));
  test('system prompt mentions all four labels',
    SCORE_SYSTEM_PROMPT.includes('"positive"') &&
    SCORE_SYSTEM_PROMPT.includes('"negative"') &&
    SCORE_SYSTEM_PROMPT.includes('"neutral"') &&
    SCORE_SYSTEM_PROMPT.includes('"mixed"'));
  test('system prompt warns no fences', SCORE_SYSTEM_PROMPT.includes('Do not wrap the response in markdown fences'));

  // ============ summary ============
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n=== Listener sentiment unit tests: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
