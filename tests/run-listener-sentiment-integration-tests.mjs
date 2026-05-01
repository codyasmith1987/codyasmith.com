#!/usr/bin/env node
// Listener sentiment integration tests. Real Gemini, real Turso (file://).
// Gated by GEMINI_API_KEY validity. Skips with a clear message if absent.
// Runs via tsx because the engine modules are TypeScript.

import 'dotenv/config';
import { createClient } from '@libsql/client';

import {
  cacheKey,
  createCacheClient,
  createGeminiScoreClient,
  scoreMention,
  PROMPT_VERSION,
  MODEL,
} from '../src/lib/sentiment-gemini.ts';
import { LISTENER_SENTIMENT_CACHE_SQL } from '../src/lib/migrations/013-listener-sentiment-cache.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass, detail: String(detail).slice(0, 300) });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 300)}`);
}

const apiKey = (process.env.GEMINI_API_KEY || '').trim();
if (!apiKey || !apiKey.startsWith('AIza')) {
  console.log('SKIP: GEMINI_API_KEY missing or placeholder. Integration test requires a real key.');
  console.log('      Set GEMINI_API_KEY=AIza... in .env, then re-run.');
  process.exit(0);
}

const tursoUrl = (process.env.TURSO_DATABASE_URL || '').trim();
if (!tursoUrl) {
  console.error('TURSO_DATABASE_URL missing. Required for cache-backed integration test.');
  process.exit(1);
}

const turso = createClient(
  process.env.TURSO_AUTH_TOKEN
    ? { url: tursoUrl, authToken: process.env.TURSO_AUTH_TOKEN }
    : { url: tursoUrl },
);

// Apply migration if not already applied (idempotent CREATE IF NOT EXISTS).
await turso.batch(LISTENER_SENTIMENT_CACHE_SQL, 'write');

const cache = createCacheClient(turso);
const gemini = createGeminiScoreClient(apiKey);

async function run() {
  // Use a unique-per-run text so we always exercise Gemini, not the cache.
  const fixtureText = `AcmeCorp shipped my order in two days and the customer support team responded to my refund request within an hour. The packaging was thoughtful and the product matched the website description. I have ordered from them three times now and every experience has been smooth. ${Date.now()}`;
  const fixtureMention = {
    url: 'https://example.com/reviews/acme',
    source_name: 'ExampleReview',
    source_type: 'review',
    full_text: fixtureText,
  };

  console.log('--- real Gemini scoring (one call) ---');
  const start = Date.now();
  let scored;
  try {
    scored = await scoreMention('AcmeCorp', fixtureMention, { gemini, cache });
  } catch (err) {
    test('Gemini scoring did not throw', false, err instanceof Error ? err.message : String(err));
    summarize();
    process.exit(1);
  }
  const elapsedMs = Date.now() - start;
  console.log(`Scored in ${elapsedMs}ms`);

  test('scored result returned', !!scored);
  test('scored_by gemini (not lexicon fallback)', scored.scored_by === 'gemini', `got ${scored?.scored_by}`);
  test('score in [-1, 1]', scored.score >= -1 && scored.score <= 1, `got ${scored?.score}`);
  test('label is one of four', ['positive', 'negative', 'neutral', 'mixed'].includes(scored.label), `got ${scored?.label}`);
  test('positive themes is array of strings', Array.isArray(scored.positive) && scored.positive.every((s) => typeof s === 'string'));
  test('negative themes is array of strings', Array.isArray(scored.negative) && scored.negative.every((s) => typeof s === 'string'));
  test('key_phrases is array of strings', Array.isArray(scored.key_phrases) && scored.key_phrases.every((s) => typeof s === 'string'));
  test('key_phrases length 2 to 5 or empty', scored.key_phrases.length === 0 || (scored.key_phrases.length >= 2 && scored.key_phrases.length <= 5), `got ${scored?.key_phrases?.length}`);

  // Print sample so the result is visible during validation
  console.log('Sample scored output:');
  console.log(`  score:           ${scored.score}`);
  console.log(`  label:           ${scored.label}`);
  console.log(`  positive themes: ${JSON.stringify(scored.positive)}`);
  console.log(`  negative themes: ${JSON.stringify(scored.negative)}`);
  console.log(`  key_phrases:     ${JSON.stringify(scored.key_phrases)}`);
  console.log(`  scored_by:       ${scored.scored_by}`);

  console.log('\n--- cache write verification ---');
  const expectedKey = cacheKey(fixtureText, PROMPT_VERSION, MODEL);
  const cached = await cache.get(expectedKey);
  test('cache row written for the fixture text', cached !== null, `cache_key ${expectedKey.slice(0, 16)}...`);
  test('cached value matches scored output', cached?.value?.score === scored.score && cached?.value?.label === scored.label);

  console.log('\n--- cache hit on repeat call ---');
  const start2 = Date.now();
  const scored2 = await scoreMention('AcmeCorp', fixtureMention, { gemini, cache });
  const elapsed2 = Date.now() - start2;
  console.log(`Re-scored in ${elapsed2}ms (should be near-instant from cache)`);
  test('repeat call returns scored_by gemini', scored2.scored_by === 'gemini');
  test('repeat call returns same score', scored2.score === scored.score);

  summarize();
  if (results.some((r) => !r.pass)) process.exit(1);
}

function summarize() {
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n=== Listener sentiment integration tests: ${passed} passed, ${failed} failed ===`);
}

run().catch((err) => {
  console.error('Integration test runner crashed:', err);
  process.exit(1);
});
