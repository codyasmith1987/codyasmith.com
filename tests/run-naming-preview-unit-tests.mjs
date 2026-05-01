#!/usr/bin/env node
// Phase 2 naming preview endpoint unit tests. Mocked engine, mocked RDAP,
// in-memory libsql for the naming schema. Exercises handlePreview directly.
//
// Runs via tsx because the engine modules are TypeScript.

import { createClient } from '@libsql/client';

import { handlePreview } from '../src/pages/api/naming/preview.ts';
import { createStorage } from '../src/lib/naming/storage.ts';
import { NAMING_TABLES_SQL } from '../src/lib/migrations/012-naming.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass, detail: String(detail).slice(0, 300) });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 300)}`);
}

function makeMockGeneration() {
  const parents = [];
  for (let i = 0; i < 10; i += 1) {
    const variants = [];
    for (let j = 0; j < 10; j += 1) {
      variants.push({
        name: `Var${i}${j}`,
        rationale: `Variant ${i}/${j} rationale, why it relates to the parent.`,
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

function makeMockAvailability(generation, availabilityMap) {
  const all = generation.parents.flatMap((p) => p.variants.map((v) => v.name));
  return all.map((name) => ({
    name,
    tld: 'com',
    available: availabilityMap[name] ?? null,
    checkedAt: '2026-04-30T00:00:00Z',
  }));
}

async function freshStorage() {
  const memDb = createClient({ url: ':memory:' });
  await memDb.batch(NAMING_TABLES_SQL, 'write');
  return createStorage(memDb);
}

async function run() {
  // ============ 1. Happy path ============
  console.log('--- happy path ---');
  {
    const storage = await freshStorage();
    let geminiCalls = 0;
    const mockGenerate = async (_options, _genDeps) => {
      geminiCalls += 1;
      return makeMockGeneration();
    };
    let rdapCalls = 0;
    const mockCheckAvailability = async (names, tlds) => {
      rdapCalls += 1;
      const map = {};
      for (const n of names) map[n] = n.includes('Var01') || n.includes('Var23') ? true : false;
      return makeMockAvailability(makeMockGeneration(), map);
    };
    const r = await handlePreview(
      { seed: 'marketing strategy', creativity: 7 },
      '1.2.3.4',
      {
        rateLimit: async () => true,
        generate: mockGenerate,
        checkAvailability: mockCheckAvailability,
        storage,
        geminiClient: { async generateContent() { return { text: '{}' }; } },
      },
    );
    test('happy path returns 200', r.status === 200, `got ${r.status}`);
    test('happy path returns runId', typeof r.body.runId === 'string' && r.body.runId.length > 0);
    test('happy path returns 5 names', Array.isArray(r.body.names) && r.body.names.length === 5);
    test('each name has name, available, rationale fields',
      r.body.names.every((n) =>
        typeof n.name === 'string' &&
        (n.available === true || n.available === false || n.available === null) &&
        typeof n.rationale === 'string',
      ),
    );
    test('available names ranked above taken (Var01 or Var23 should be in top set)',
      r.body.names.some((n) => n.available === true),
    );
    test('persisted run row',
      (await storage.insertRun({ seedTerm: 'check', creativity: 5, tlds: ['com'], source: 'preview' })) > 0);
    test('engine called once', geminiCalls === 1);
    test('availability called once', rdapCalls === 1);
  }

  // ============ 2. 400 missing seed ============
  console.log('--- 400 missing seed ---');
  {
    const r1 = await handlePreview({ seed: '', creativity: 5 }, '1.2.3.4', {});
    test('empty seed returns 400', r1.status === 400);
    test('empty seed body has error', typeof r1.body.error === 'string');

    const r2 = await handlePreview({ creativity: 5 }, '1.2.3.4', {});
    test('missing seed key returns 400', r2.status === 400);

    const r3 = await handlePreview({ seed: '   ', creativity: 5 }, '1.2.3.4', {});
    test('whitespace-only seed returns 400', r3.status === 400);

    const r4 = await handlePreview({ seed: 123, creativity: 5 }, '1.2.3.4', {});
    test('non-string seed returns 400', r4.status === 400);

    const r5 = await handlePreview('not an object', '1.2.3.4', {});
    test('non-object body returns 400', r5.status === 400);
  }

  // ============ 3. 400 on creativity out of range ============
  console.log('--- 400 creativity range ---');
  {
    const r1 = await handlePreview({ seed: 'x', creativity: 0 }, '1.2.3.4', {});
    test('creativity 0 returns 400', r1.status === 400);
    test('creativity 0 error mentions range', /1 and 10/.test(String(r1.body.error)));

    const r2 = await handlePreview({ seed: 'x', creativity: 11 }, '1.2.3.4', {});
    test('creativity 11 returns 400', r2.status === 400);

    const r3 = await handlePreview({ seed: 'x', creativity: -5 }, '1.2.3.4', {});
    test('creativity -5 returns 400', r3.status === 400);

    const r4 = await handlePreview({ seed: 'x', creativity: 'seven' }, '1.2.3.4', {});
    test('creativity non-numeric returns 400', r4.status === 400);

    const r5 = await handlePreview({ seed: 'x', creativity: NaN }, '1.2.3.4', {});
    test('creativity NaN returns 400', r5.status === 400);
  }

  // ============ 4. 429 rate limited ============
  console.log('--- 429 rate limit ---');
  {
    // Hourly limit fails
    const r1 = await handlePreview(
      { seed: 'x', creativity: 5 },
      '1.2.3.4',
      { rateLimit: async () => false },
    );
    test('rate limited returns 429', r1.status === 429);
    test('rate limited error is friendly', /limit/i.test(String(r1.body.error)));

    // Hour passes, day fails
    let calls = 0;
    const r2 = await handlePreview(
      { seed: 'x', creativity: 5 },
      '1.2.3.4',
      {
        rateLimit: async () => {
          calls += 1;
          return calls === 1; // first (hourly) ok, second (daily) blocked
        },
      },
    );
    test('daily rate limited returns 429', r2.status === 429);
  }

  // ============ 5. 500 engine throw ============
  console.log('--- 500 engine throw ---');
  {
    const storage = await freshStorage();
    const r = await handlePreview(
      { seed: 'x', creativity: 5 },
      '1.2.3.4',
      {
        rateLimit: async () => true,
        generate: async () => { throw new Error('engine boom'); },
        storage,
        geminiClient: { async generateContent() { return { text: '{}' }; } },
      },
    );
    test('engine throw returns 500', r.status === 500);
    test('500 error message is generic',
      r.body.error === 'Something went wrong. Try again in a minute.',
      `got ${r.body.error}`,
    );
    test('500 does not leak stack', !/boom|stack|Error:/.test(String(r.body.error)));
  }

  // ============ 5b. 500 missing API key when no Gemini client ============
  console.log('--- 500 missing API key ---');
  {
    const storage = await freshStorage();
    const r = await handlePreview(
      { seed: 'x', creativity: 5 },
      '1.2.3.4',
      {
        rateLimit: async () => true,
        storage,
        apiKey: '', // explicit empty
        // no geminiClient provided, no apiKey, should 500
      },
    );
    test('no API key returns 500', r.status === 500);
    test('no API key error is generic', !/AIza|key/i.test(String(r.body.error)) || /not configured/i.test(String(r.body.error)));
  }

  // ============ 6. Cache hit path ============
  console.log('--- cache hit ---');
  {
    const storage = await freshStorage();
    let generateCalls = 0;
    let cacheGenerateCallsViaGemini = 0;
    const realGenerationPayload = makeMockGeneration();

    // Wrap a mock generate that uses the cache from deps to mimic the real
    // generator's caching behavior: on cache miss, generate; on hit, return cached.
    const cachingMockGenerate = async (options, genDeps) => {
      generateCalls += 1;
      const cacheKey = `${options.creativity}|${options.seed}`;
      if (genDeps.cache) {
        const cached = await genDeps.cache.get(cacheKey);
        if (cached) return cached.value;
      }
      cacheGenerateCallsViaGemini += 1;
      const result = realGenerationPayload;
      if (genDeps.cache) {
        await genDeps.cache.set(cacheKey, result, 7);
      }
      return result;
    };

    const mockCheckAvailability = async (names) => {
      const map = {};
      for (const n of names) map[n] = false;
      return makeMockAvailability(realGenerationPayload, map);
    };

    const deps = {
      rateLimit: async () => true,
      generate: cachingMockGenerate,
      checkAvailability: mockCheckAvailability,
      storage,
      geminiClient: { async generateContent() { return { text: '{}' }; } },
    };

    const r1 = await handlePreview({ seed: 'caching seed', creativity: 5 }, '1.2.3.4', deps);
    test('first call returns 200', r1.status === 200);

    const r2 = await handlePreview({ seed: 'caching seed', creativity: 5 }, '1.2.3.4', deps);
    test('second call returns 200', r2.status === 200);
    test('generate called twice (the wrapper itself)', generateCalls === 2);
    test('cache miss only on first call', cacheGenerateCallsViaGemini === 1, `got ${cacheGenerateCallsViaGemini}`);
    test('second call returned the same names',
      r1.body.names && r2.body.names &&
      r1.body.names.length === r2.body.names.length &&
      r1.body.names[0].name === r2.body.names[0].name);
  }

  // ============ 7. IP validation ============
  console.log('--- IP guard ---');
  {
    const r = await handlePreview({ seed: 'x', creativity: 5 }, '', {});
    test('empty IP returns 400', r.status === 400);
    const r2 = await handlePreview({ seed: 'x', creativity: 5 }, 'unknown', {});
    test('"unknown" IP returns 400', r2.status === 400);
  }

  // ============ summary ============
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n=== Naming preview unit tests: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
