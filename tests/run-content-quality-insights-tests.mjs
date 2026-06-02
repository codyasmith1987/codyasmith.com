import assert from 'node:assert';
import {
  emptyContentQuality,
  readabilityBand,
  HARD_TO_READ_FLESCH_THRESHOLD,
} from '../src/lib/dashboard/content-quality-insights.ts';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`[PASS] ${name}`); passed++; }
  catch (err) { console.error(`[FAIL] ${name}: ${err.message}`); failed++; }
}

test('emptyContentQuality is fully zeroed with all sub-metrics unmeasured', () => {
  assert.deepStrictEqual(emptyContentQuality(), {
    near_duplicate_count: 0,
    near_duplicate_samples: [],
    spelling_grammar_count: 0,
    spelling_grammar_samples: [],
    hard_to_read_count: 0,
    hard_to_read_samples: [],
    measured: {
      near_duplicate: false,
      spelling_grammar: false,
      readability: false,
    },
  });
});

test('HARD_TO_READ_FLESCH_THRESHOLD is 50', () => {
  assert.strictEqual(HARD_TO_READ_FLESCH_THRESHOLD, 50);
});

test('readabilityBand maps the Flesch bands', () => {
  assert.strictEqual(readabilityBand(90), 'very easy');
  assert.strictEqual(readabilityBand(80), 'very easy');
  assert.strictEqual(readabilityBand(70), 'easy');
  assert.strictEqual(readabilityBand(60), 'easy');
  assert.strictEqual(readabilityBand(55), 'fairly difficult');
  assert.strictEqual(readabilityBand(50), 'fairly difficult');
  assert.strictEqual(readabilityBand(40), 'difficult');
  assert.strictEqual(readabilityBand(30), 'difficult');
  assert.strictEqual(readabilityBand(10), 'very dense');
  assert.strictEqual(readabilityBand(0), 'very dense');
  // exclusive upper side of each band
  assert.strictEqual(readabilityBand(79), 'easy');
  assert.strictEqual(readabilityBand(59), 'fairly difficult');
  assert.strictEqual(readabilityBand(49), 'difficult');
  assert.strictEqual(readabilityBand(29), 'very dense');
  // negative Flesch (real for very dense technical text) -> very dense
  assert.strictEqual(readabilityBand(-10), 'very dense');
});

test('readabilityBand returns null for null/undefined/NaN/Infinity', () => {
  assert.strictEqual(readabilityBand(null), null);
  assert.strictEqual(readabilityBand(undefined), null);
  assert.strictEqual(readabilityBand(NaN), null);
  assert.strictEqual(readabilityBand(Infinity), null);
  assert.strictEqual(readabilityBand(-Infinity), null);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
