#!/usr/bin/env node
// Naming engine unit tests. Mocked Gemini, mocked RDAP, in-memory libsql.
// Hand-rolled in the style of tests/run-billing-tests.mjs but importing engine
// modules directly because Phase 1 is library code, not HTTP endpoints.
//
// Runs via tsx because the engine modules are TypeScript and Node alone cannot
// import .ts. See package.json `test` script.

import { createClient } from '@libsql/client';

import {
  generate,
  parseAndValidate,
  sha256,
} from '../src/lib/naming/generator.ts';
import { checkAvailability, clearBootstrapCache } from '../src/lib/naming/availability.ts';
import { rankPhase1 } from '../src/lib/naming/ranker.ts';
import { createStorage } from '../src/lib/naming/storage.ts';
import { antiPatternsForCreativity, ANTI_PATTERNS } from '../src/lib/naming/anti-patterns.ts';
import { temperatureForCreativity, DEFAULTS } from '../src/lib/naming/config.ts';
import { buildGeneratePrompt } from '../src/lib/naming/prompts/generate.ts';
import { NAMING_TABLES_SQL } from '../src/lib/migrations/012-naming.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass, detail: String(detail).slice(0, 300) });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 300)}`);
}

function mockGenerationPayload() {
  const parents = [];
  for (let i = 0; i < DEFAULTS.PARENTS_PER_GENERATION; i += 1) {
    const variants = [];
    for (let j = 0; j < DEFAULTS.VARIANTS_PER_PARENT; j += 1) {
      variants.push({
        name: `Var${i}${j}`,
        rationale: `Variant ${i}/${j} rationale.`,
      });
    }
    parents.push({
      name: `Parent${i}`,
      rationale: `Parent ${i} rationale tying to seed.`,
      variants,
    });
  }
  return { parents };
}

async function run() {
  // ============ config ============
  console.log('--- config ---');
  test('temperature creativity 1', temperatureForCreativity(1) === 0.3);
  test(
    'temperature creativity 5',
    Math.abs(temperatureForCreativity(5) - 0.7) < 1e-9,
    `got ${temperatureForCreativity(5)}`,
  );
  test('temperature creativity 10', temperatureForCreativity(10) === 1.0);
  test('temperature clamp low', temperatureForCreativity(0) === 0.3);
  test('temperature clamp high', temperatureForCreativity(11) === 1.0);

  // ============ anti-patterns ============
  console.log('--- anti-patterns ---');
  test('anti basic at 1', antiPatternsForCreativity(1) === ANTI_PATTERNS.basic);
  test('anti mid at 5', antiPatternsForCreativity(5) === ANTI_PATTERNS.mid);
  test('anti high at 10', antiPatternsForCreativity(10) === ANTI_PATTERNS.high);

  // ============ prompt builder ============
  console.log('--- prompt builder ---');
  const prompt = buildGeneratePrompt('marketing strategy', 7, ['ly', 'ify']);
  test('prompt has seed', prompt.includes('marketing strategy'));
  test('prompt has creativity', prompt.includes('7/10'));
  test('prompt has anti-pattern list', prompt.includes('ly, ify'));
  test('prompt has none when empty', buildGeneratePrompt('x', 9, []).includes('none'));

  // ============ parseAndValidate ============
  console.log('--- parseAndValidate ---');
  const validJson = JSON.stringify(mockGenerationPayload());
  const validParsed = parseAndValidate(validJson);
  test('valid 10x10 parses', validParsed.parents.length === 10);
  test('valid 10x10 variants', validParsed.parents[0].variants.length === 10);

  const fenced = '```json\n' + validJson + '\n```';
  test('strips json fences', parseAndValidate(fenced).parents.length === 10);

  const fencedPlain = '```\n' + validJson + '\n```';
  test('strips plain fences', parseAndValidate(fencedPlain).parents.length === 10);

  let threw = false;
  try {
    parseAndValidate('not json');
  } catch {
    threw = true;
  }
  test('rejects invalid JSON', threw);

  threw = false;
  try {
    parseAndValidate(JSON.stringify({ parents: [] }));
  } catch (e) {
    threw = /expected 10/.test(String(e));
  }
  test('rejects 0 parents', threw);

  threw = false;
  try {
    const wrongCount = mockGenerationPayload();
    wrongCount.parents[0].variants.pop();
    parseAndValidate(JSON.stringify(wrongCount));
  } catch (e) {
    threw = /expected 10/.test(String(e));
  }
  test('rejects 9 variants', threw);

  threw = false;
  try {
    const missingName = mockGenerationPayload();
    missingName.parents[3].variants[2].name = '';
    parseAndValidate(JSON.stringify(missingName));
  } catch (e) {
    threw = /invalid name/.test(String(e));
  }
  test('rejects empty variant name', threw);

  // ============ sha256 cache key ============
  console.log('--- cache key ---');
  const k1 = sha256('v1|gemini-2.5-flash-lite|7|marketing strategy');
  const k2 = sha256('v1|gemini-2.5-flash-lite|7|marketing strategy');
  const k3 = sha256('v1|gemini-2.5-flash-lite|6|marketing strategy');
  test('sha256 stable', k1 === k2);
  test('sha256 differs by input', k1 !== k3);
  test('sha256 length 64', k1.length === 64);

  // ============ generate() with mocks ============
  console.log('--- generate with mocks ---');
  let geminiCalls = 0;
  const mockGemini = {
    async generateContent({ systemPrompt, temperature }) {
      geminiCalls += 1;
      // Verify the prompt was built and temperature mapped
      if (!systemPrompt.includes('marketing strategy')) {
        throw new Error('mock gemini: prompt missing seed');
      }
      if (Math.abs(temperature - 0.7) > 1e-9) {
        throw new Error(`mock gemini: temperature was ${temperature}`);
      }
      return { text: JSON.stringify(mockGenerationPayload()) };
    },
  };

  const cacheStore = new Map();
  const mockCache = {
    async get(key) {
      const entry = cacheStore.get(key);
      return entry ? { value: entry, expiresAt: 'never' } : null;
    },
    async set(key, value) {
      cacheStore.set(key, value);
    },
  };

  const r1 = await generate(
    { seed: 'marketing strategy', creativity: 5 },
    { gemini: mockGemini, cache: mockCache },
  );
  test('generate returns 10 parents', r1.parents.length === 10);
  test('generate calls gemini once', geminiCalls === 1);

  const r2 = await generate(
    { seed: 'marketing strategy', creativity: 5 },
    { gemini: mockGemini, cache: mockCache },
  );
  test('generate cache hit, no second gemini call', geminiCalls === 1);
  test('generate returns cached structure', r2.parents.length === 10);

  await generate(
    { seed: 'marketing strategy', creativity: 5, cache: false },
    { gemini: mockGemini, cache: mockCache },
  );
  test('generate cache=false bypasses cache', geminiCalls === 2);

  // ============ checkAvailability with mock fetch ============
  console.log('--- availability with mock fetch ---');
  clearBootstrapCache();
  const bootstrapStub = {
    com: 'https://rdap.example.com',
    net: 'https://rdap.example.com',
    co: 'https://rdap.example.com',
  };

  const fetchCalls = [];
  const mockFetch = async (url) => {
    fetchCalls.push(String(url));
    const u = String(url);
    if (u.includes('available-name')) {
      return { ok: false, status: 404 };
    }
    if (u.includes('registered-name')) {
      return { ok: true, status: 200 };
    }
    return { ok: false, status: 500 };
  };

  const avail = await checkAvailability(
    ['available-name', 'registered-name', 'unknown-name'],
    ['com', 'net'],
    { fetch: mockFetch, bootstrap: bootstrapStub },
  );
  test('availability 6 results', avail.length === 6);
  test(
    'availability available-name available',
    avail.find((r) => r.name === 'available-name' && r.tld === 'com')?.available === true,
  );
  test(
    'availability registered-name not available',
    avail.find((r) => r.name === 'registered-name' && r.tld === 'com')?.available === false,
  );
  test(
    'availability unknown is null',
    avail.find((r) => r.name === 'unknown-name' && r.tld === 'com')?.available === null,
  );

  // ============ rankPhase1 ============
  console.log('--- ranker ---');
  const generation = {
    parents: [
      {
        name: 'Alpha',
        rationale: 'A',
        variants: [
          { name: 'Aa', rationale: '1' },
          { name: 'Bbbbbb', rationale: '2' },
          { name: 'Cc', rationale: '3' },
          { name: 'Dd', rationale: '4' },
          { name: 'Ee', rationale: '5' },
          { name: 'Ff', rationale: '6' },
          { name: 'Gg', rationale: '7' },
          { name: 'Hh', rationale: '8' },
          { name: 'Ii', rationale: '9' },
          { name: 'Jj', rationale: '10' },
        ],
      },
    ],
  };
  // Pad to 10 parents to satisfy any downstream invariants in future ranker upgrades
  for (let i = 1; i < 10; i += 1) {
    generation.parents.push({
      name: `P${i}`,
      rationale: '',
      variants: Array.from({ length: 10 }, (_, j) => ({
        name: `P${i}V${j}`,
        rationale: '',
      })),
    });
  }

  const availMatrix = [
    { name: 'Aa', tld: 'com', available: true, checkedAt: 'x' },
    { name: 'Aa', tld: 'net', available: true, checkedAt: 'x' },
    { name: 'Aa', tld: 'co', available: true, checkedAt: 'x' },
    { name: 'Bbbbbb', tld: 'com', available: true, checkedAt: 'x' },
    { name: 'Bbbbbb', tld: 'net', available: false, checkedAt: 'x' },
    { name: 'Bbbbbb', tld: 'co', available: false, checkedAt: 'x' },
    { name: 'Cc', tld: 'com', available: false, checkedAt: 'x' },
    { name: 'Cc', tld: 'net', available: false, checkedAt: 'x' },
    { name: 'Cc', tld: 'co', available: false, checkedAt: 'x' },
  ];

  const ranked = rankPhase1(generation, availMatrix, {
    tlds: ['com', 'net', 'co'],
    includeUnavailable: false,
  });
  test('ranker filters Cc (none available)', !ranked.find((r) => r.name === 'Cc'));
  test('ranker first is Aa (3 of 3)', ranked[0].name === 'Aa');
  test('ranker Aa availableTldCount 3', ranked[0].availableTldCount === 3);
  test('ranker Bbbbbb second (1 of 3)', ranked[1].name === 'Bbbbbb');

  const rankedAll = rankPhase1(generation, availMatrix, {
    tlds: ['com', 'net', 'co'],
    includeUnavailable: true,
  });
  test('ranker includeUnavailable returns all 100', rankedAll.length === 100);

  // ============ storage with in-memory libsql ============
  console.log('--- storage round-trip on :memory: ---');
  const memDb = createClient({ url: ':memory:' });
  await memDb.batch(NAMING_TABLES_SQL, 'write');

  const tables = await memDb.execute(
    `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'naming_%'`,
  );
  test('migration creates 8 naming tables', tables.rows.length === 8);

  const storage = createStorage(memDb);
  const runId = await storage.insertRun({
    seedTerm: 'marketing strategy',
    creativity: 7,
    tlds: ['com', 'net'],
    source: 'preview',
  });
  test('insertRun returns numeric id', typeof runId === 'number' && runId > 0);

  const idMap = await storage.insertNames(runId, {
    parents: [
      {
        name: 'Aa',
        rationale: 'parent',
        variants: [{ name: 'Bb', rationale: 'variant' }],
      },
    ],
  });
  test('insertNames returns id map', idMap.size === 2);
  test('insertNames keys', idMap.has('Aa') && idMap.has('Bb'));

  await storage.insertAvailability(idMap, [
    { name: 'Aa', tld: 'com', available: true, checkedAt: '2026-04-30T00:00:00Z' },
    { name: 'Bb', tld: 'com', available: false, checkedAt: '2026-04-30T00:00:00Z' },
  ]);
  const availRows = await memDb.execute(`SELECT name_id, tld, available FROM naming_availability`);
  test('insertAvailability wrote 2 rows', availRows.rows.length === 2);

  const cacheKey = 'test-cache-key';
  const noCache = await storage.getCache(cacheKey);
  test('getCache miss returns null', noCache === null);
  await storage.setCache(cacheKey, { hello: 'world' }, 7);
  const hit = await storage.getCache(cacheKey);
  test('getCache hit returns value', hit?.value?.hello === 'world');

  // ============ summary ============
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n=== Unit tests: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
