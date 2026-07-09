import assert from 'node:assert';
import { realUserPageRowFilters, realUserPageUrlExclusions } from '../src/lib/csv/page-count-sql.ts';

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); console.log(`[PASS] ${name}`); passed++; } catch (e) { console.error(`[FAIL] ${name}: ${e.message}`); failed++; } }

test('realUserPageRowFilters enforces 200 + html + indexable', () => {
  const s = realUserPageRowFilters('cu');
  assert.match(s, /cu\.status_code = 200/);
  assert.match(s, /cu\.content_type.*LIKE '%html%'/);
  assert.match(s, /cu\.indexability.*!= 'non-indexable'/);
});

test('realUserPageRowFilters with no prefix targets bare columns', () => {
  const s = realUserPageRowFilters('');
  assert.match(s, /status_code = 200/);
  assert.doesNotMatch(s, /\.\s*status_code/);
});

test('realUserPageUrlExclusions covers taxonomy + utility + pagination', () => {
  const s = realUserPageUrlExclusions('url');
  for (const frag of ['/tag/', '/category/', '/author/', '/feed', '/wp-content/', '/wp-admin/', '/wp-json/', '?paged=', '/page/[0-9]']) {
    assert.ok(s.includes(frag), `missing exclusion: ${frag}`);
  }
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
