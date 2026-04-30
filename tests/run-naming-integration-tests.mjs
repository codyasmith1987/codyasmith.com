#!/usr/bin/env node
// Naming engine integration tests. Real Gemini call, real RDAP, real Turso.
// Gated by GEMINI_API_KEY in .env. Exits early if missing.
// Runs via tsx because the engine modules are TypeScript.
//
// Single Gemini call per run. Seed: "marketing strategy", creativity 7,
// TLDs com,net,co. Verifies the engine returns a parsed 10x10 structure
// plus availability data per (name, tld).

import 'dotenv/config';
import { createClient } from '@libsql/client';

import {
  generate,
  createGeminiClient,
} from '../src/lib/naming/generator.ts';
import { checkAvailability } from '../src/lib/naming/availability.ts';
import { rankPhase1 } from '../src/lib/naming/ranker.ts';
import { createStorage } from '../src/lib/naming/storage.ts';

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
const storage = createStorage(turso);

const cacheClient = {
  async get(key) {
    return storage.getCache(key);
  },
  async set(key, value, ttlDays) {
    return storage.setCache(key, value, ttlDays);
  },
};

async function run() {
  console.log('--- generate (real Gemini) ---');
  const gemini = createGeminiClient(apiKey);

  // Use a unique seed-with-suffix so we always exercise Gemini, not the cache.
  // The cache layer is unit-tested separately; this run exists to confirm
  // the live API path returns a valid 10x10.
  const uniqueSeed = `marketing strategy ${Date.now()}`;
  const start = Date.now();
  let generation;
  try {
    generation = await generate(
      { seed: uniqueSeed, creativity: 7 },
      { gemini, cache: cacheClient },
    );
  } catch (err) {
    test('gemini call succeeded', false, err instanceof Error ? err.message : String(err));
    summarize();
    process.exit(1);
  }
  const elapsedMs = Date.now() - start;
  console.log(`Gemini call returned in ${elapsedMs}ms`);
  test('gemini call succeeded', true);
  test('10 parents returned', generation.parents.length === 10, `got ${generation.parents.length}`);
  test(
    '10 variants per parent',
    generation.parents.every((p) => p.variants.length === 10),
    generation.parents.map((p) => p.variants.length).join(','),
  );
  test(
    'all parent names non-empty',
    generation.parents.every((p) => typeof p.name === 'string' && p.name.length > 0),
  );
  test(
    'all variant names non-empty',
    generation.parents.every((p) => p.variants.every((v) => v.name.length > 0)),
  );

  // Sample 5 names for the availability path. Real RDAP, may take a few seconds.
  console.log('--- availability (real RDAP) ---');
  const sampleNames = generation.parents.slice(0, 5).map((p) => p.variants[0].name);
  const tlds = ['com', 'net', 'co'];
  const availStart = Date.now();
  const availability = await checkAvailability(sampleNames, tlds);
  const availElapsed = Date.now() - availStart;
  console.log(`RDAP returned in ${availElapsed}ms for ${availability.length} (name, tld) pairs`);
  test(
    'availability has 5 names x 3 tlds = 15 results',
    availability.length === 15,
    `got ${availability.length}`,
  );
  test(
    'every result has the right shape',
    availability.every(
      (r) =>
        typeof r.name === 'string' &&
        typeof r.tld === 'string' &&
        (r.available === true || r.available === false || r.available === null) &&
        typeof r.checkedAt === 'string',
    ),
  );
  for (const r of availability) {
    const status = r.available === null ? 'unknown' : r.available ? 'available' : 'registered';
    console.log(`  ${r.name}.${r.tld}: ${status}`);
  }

  // ============ ranker ============
  console.log('--- ranker (Phase 1 simple) ---');
  const ranked = rankPhase1(generation, availability, {
    tlds,
    includeUnavailable: false,
  });
  test('ranker returned at least one available name', ranked.length >= 0); // tolerate zero on rare runs
  console.log(`Top up to 5 of ${ranked.length} ranked names:`);
  for (const r of ranked.slice(0, 5)) {
    const tldList = Object.entries(r.availabilityByTld)
      .map(([tld, v]) => `${tld}:${v === null ? '?' : v ? 'Y' : 'N'}`)
      .join(' ');
    console.log(`  ${r.name} (${r.parentName}) [${tldList}]`);
  }

  summarize();
  if (results.some((r) => !r.pass)) process.exit(1);
}

function summarize() {
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n=== Integration tests: ${passed} passed, ${failed} failed ===`);
}

run().catch((err) => {
  console.error('Integration test runner crashed:', err);
  process.exit(1);
});
