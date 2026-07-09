// Unit tests for the mapLimit helper exported from upload.ts.
// Tests the helper in isolation — no DB, no Astro, no network.
// Run: npx tsx tests/run-upload-concurrency-tests.mjs

import assert from 'node:assert';
import { mapLimit } from '../src/pages/portal/api/csv/upload.ts';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`[PASS] ${name}`);
    passed++;
  } catch (e) {
    console.error(`[FAIL] ${name}: ${e.message}`);
    failed++;
  }
}

// Test (a): never exceeds the concurrency limit; all results present in order.
await test('mapLimit: max in-flight never exceeds limit=3 with 20 items', async () => {
  const limit = 3;
  const itemCount = 20;
  let inFlight = 0;
  let maxInFlight = 0;

  const results = await mapLimit(
    Array.from({ length: itemCount }, (_, i) => i),
    limit,
    async (item, index) => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      // Small async yield so concurrency is observable
      await new Promise(r => setTimeout(r, 2));
      inFlight--;
      return item * 2;
    },
  );

  assert.strictEqual(results.length, itemCount, `Expected ${itemCount} results, got ${results.length}`);
  assert(maxInFlight <= limit, `Max in-flight was ${maxInFlight}, exceeded limit ${limit}`);

  // Verify all items present in input order with correct values
  for (let i = 0; i < itemCount; i++) {
    assert.strictEqual(results[i].status, 'fulfilled', `results[${i}] should be fulfilled`);
    assert.strictEqual(results[i].value, i * 2, `results[${i}].value should be ${i * 2}`);
  }
});

// Test (b): preserves order and captures rejections in correct positions.
await test('mapLimit: preserves order + captures rejections', async () => {
  // Items: 0-9. Odd indices throw; even indices return index*3.
  const items = Array.from({ length: 10 }, (_, i) => i);

  const results = await mapLimit(items, 4, async (item) => {
    await new Promise(r => setTimeout(r, 1));
    if (item % 2 !== 0) throw new Error(`reject-${item}`);
    return item * 3;
  });

  assert.strictEqual(results.length, 10, 'Should have 10 results');

  for (let i = 0; i < 10; i++) {
    if (i % 2 === 0) {
      assert.strictEqual(results[i].status, 'fulfilled', `results[${i}] should be fulfilled`);
      assert.strictEqual(results[i].value, i * 3, `results[${i}].value should be ${i * 3}`);
    } else {
      assert.strictEqual(results[i].status, 'rejected', `results[${i}] should be rejected`);
      assert(
        results[i].reason?.message === `reject-${i}`,
        `results[${i}].reason.message should be "reject-${i}", got "${results[i].reason?.message}"`,
      );
    }
  }
});

// Test (c): limit=1 is fully sequential (max in-flight == 1).
await test('mapLimit: limit=1 is sequential (max in-flight == 1)', async () => {
  let inFlight = 0;
  let maxInFlight = 0;

  await mapLimit(Array.from({ length: 5 }, (_, i) => i), 1, async (item) => {
    inFlight++;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    await new Promise(r => setTimeout(r, 1));
    inFlight--;
    return item;
  });

  assert.strictEqual(maxInFlight, 1, `With limit=1, max in-flight should be 1, got ${maxInFlight}`);
});

// Test (d): empty input returns empty array immediately.
await test('mapLimit: empty input returns empty array', async () => {
  const results = await mapLimit([], 5, async () => 'never');
  assert.strictEqual(results.length, 0, 'Empty input should yield empty results');
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
