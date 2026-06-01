import assert from 'node:assert';
import {
  WCAG_BUCKETS,
  emptyAccessibility,
  buildAccessibilityByLevel,
} from '../src/lib/dashboard/accessibility-insights.ts';

let passed = 0;
function test(name, fn) { fn(); console.log(`[PASS] ${name}`); passed++; }

test('WCAG_BUCKETS has the seven per-URL columns', () => {
  assert.strictEqual(WCAG_BUCKETS.length, 7);
  assert.deepStrictEqual(
    WCAG_BUCKETS.map(b => b.column),
    ['wcag_20a_violations','wcag_20aa_violations','wcag_20aaa_violations',
     'wcag_21a_violations','wcag_21aa_violations','wcag_22a_violations','wcag_22aa_violations'],
  );
});

test('emptyAccessibility is fully zeroed', () => {
  assert.deepStrictEqual(emptyAccessibility(), {
    pages_with_violations: 0, total_violations: 0, by_level: {}, samples: [],
  });
});

test('buildAccessibilityByLevel keeps only positive buckets, in order', () => {
  const out = buildAccessibilityByLevel({
    wcag_20a_violations: 3,
    wcag_20aa_violations: 0,
    wcag_21aa_violations: 5,
  });
  assert.deepStrictEqual(out, { 'WCAG 2.0 A': 3, 'WCAG 2.1 AA': 5 });
  assert.deepStrictEqual(Object.keys(out), ['WCAG 2.0 A', 'WCAG 2.1 AA']);
});

test('buildAccessibilityByLevel coalesces NULL/undefined/NaN to 0 and drops them', () => {
  const out = buildAccessibilityByLevel({
    wcag_20a_violations: null,
    wcag_20aa_violations: undefined,
    wcag_20aaa_violations: NaN,
    wcag_21a_violations: 2,
  });
  assert.deepStrictEqual(out, { 'WCAG 2.1 A': 2 });
});

test('buildAccessibilityByLevel returns {} for all-zero input', () => {
  assert.deepStrictEqual(buildAccessibilityByLevel({ wcag_20a_violations: 0 }), {});
});

console.log(`\n${passed}/${passed} passed`);
