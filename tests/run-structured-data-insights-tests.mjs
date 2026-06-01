import assert from 'node:assert';
import {
  emptyStructuredData,
  topSchemaTypes,
} from '../src/lib/dashboard/structured-data-insights.ts';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`[PASS] ${name}`); passed++; }
  catch (err) { console.error(`[FAIL] ${name}: ${err.message}`); failed++; }
}

test('emptyStructuredData is fully zeroed', () => {
  assert.deepStrictEqual(emptyStructuredData(), {
    pages_with_errors: 0,
    pages_with_warnings: 0,
    total_errors: 0,
    total_warnings: 0,
    top_types: {},
    samples: [],
  });
});

test('topSchemaTypes counts pages per type, highest first', () => {
  const out = topSchemaTypes([
    'Article, Organization',
    'Article, BreadcrumbList',
    'Article',
  ]);
  assert.deepStrictEqual(out, { Article: 3, BreadcrumbList: 1, Organization: 1 });
  assert.deepStrictEqual(Object.keys(out), ['Article', 'BreadcrumbList', 'Organization']);
});

test('topSchemaTypes counts a repeated type within one page only once', () => {
  const out = topSchemaTypes(['Article, Article, Article']);
  assert.deepStrictEqual(out, { Article: 1 });
});

test('topSchemaTypes ignores null/undefined/blank and trims', () => {
  const out = topSchemaTypes([null, undefined, '', '  Article ,  , Organization ']);
  assert.deepStrictEqual(out, { Article: 1, Organization: 1 });
});

test('topSchemaTypes respects the limit', () => {
  const out = topSchemaTypes(['A, B, C, D'], 2);
  assert.deepStrictEqual(Object.keys(out).length, 2);
  // All four tie at count 1; alphabetical tie-break selects A and B.
  assert.deepStrictEqual(out, { A: 1, B: 1 });
});

test('topSchemaTypes returns {} for all-empty input', () => {
  assert.deepStrictEqual(topSchemaTypes([null, '', undefined]), {});
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
