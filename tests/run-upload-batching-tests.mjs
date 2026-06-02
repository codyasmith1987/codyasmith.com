// Upload-batching planner tests.
//
// planUploadBatches packs an array of { name, size } files into request
// batches that stay under ALL THREE caps simultaneously:
//   maxFiles  — hard file-count ceiling per request
//   maxBytes  — multipart body byte ceiling per request
//   maxRows   — estimated DB-row ceiling per request (the new lever)
//
// Row estimate per file is Math.ceil(size / 120) — a conservative
// ~120-bytes-per-row floor that OVER-estimates row count, so batches
// come out smaller/safer. A single file whose estimate exceeds any cap
// gets its own batch (it can't be packed with anything).
//
// Oracle: every expected value is hand-reasoned from the input sizes,
// not derived from prior code. The real bug this guards: a folder of
// byte-small but row-DENSE link files (success_(2xx)_inlinks 6799 rows,
// https_urls_inlinks 6367, *_inlinks 3138 each) packed into one batch
// by file-count + bytes alone, becoming tens of thousands of rows and
// hundreds of DB round-trips, blowing Cloudflare's 100s origin window.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { planUploadBatches } from '../src/lib/csv/upload-batching.ts';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`[PASS] ${name}`); passed++; }
  catch (e) { console.error(`[FAIL] ${name}: ${e.message}`); failed++; }
}

const CAPS = { maxFiles: 10, maxBytes: 8 * 1024 * 1024, maxRows: 2500 };
const estRows = (size) => Math.ceil(size / 120);

// Helper: every batch must respect all three caps.
function assertCapsHeld(batches, caps) {
  for (const b of batches) {
    const bytes = b.reduce((s, f) => s + (f.size || 0), 0);
    const rows = b.reduce((s, f) => s + estRows(f.size || 0), 0);
    // A single-file batch is allowed to exceed caps (nothing smaller to do).
    if (b.length > 1) {
      assert.ok(b.length <= caps.maxFiles, `batch file count ${b.length} > maxFiles ${caps.maxFiles}`);
      assert.ok(bytes <= caps.maxBytes, `batch bytes ${bytes} > maxBytes ${caps.maxBytes}`);
      assert.ok(rows <= caps.maxRows, `batch est rows ${rows} > maxRows ${caps.maxRows}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Test 1: a single dense link file (6799-row estimate, size 6799*120) lands
// in its OWN batch because its estimate alone exceeds maxRows=2500.
// ---------------------------------------------------------------------------
test('a single row-dense file gets its own batch', () => {
  const dense = { name: 'success_(2xx)_inlinks.csv', size: 6799 * 120 }; // 815880 bytes
  assert.strictEqual(estRows(dense.size), 6799, 'sanity: estimate is 6799 rows');
  const batches = planUploadBatches([dense], CAPS);
  assert.strictEqual(batches.length, 1, 'expected exactly 1 batch');
  assert.strictEqual(batches[0].length, 1, 'dense file alone in its batch');
  assert.strictEqual(batches[0][0].name, 'success_(2xx)_inlinks.csv');
});

// ---------------------------------------------------------------------------
// Test 2: a dense file does NOT absorb siblings — small files queued before
// AND after it stay out of its batch.
// ---------------------------------------------------------------------------
test('dense file is isolated; neighbors are not packed with it', () => {
  const small1 = { name: 'a.csv', size: 1200 };  // 10 rows
  const dense  = { name: 'big_inlinks.csv', size: 6367 * 120 }; // 6367 rows > 2500
  const small2 = { name: 'b.csv', size: 1200 };  // 10 rows
  const batches = planUploadBatches([small1, dense, small2], CAPS);
  // small1 in one batch, dense alone, small2 in another batch.
  const denseBatch = batches.find(b => b.some(f => f.name === 'big_inlinks.csv'));
  assert.strictEqual(denseBatch.length, 1, 'dense file must be alone');
  assertCapsHeld(batches, CAPS);
  // No file is dropped.
  const total = batches.reduce((s, b) => s + b.length, 0);
  assert.strictEqual(total, 3, 'all 3 files accounted for');
});

// ---------------------------------------------------------------------------
// Test 3: maxRows is the binding cap for a pile of medium files.
// Each file = 300 rows (size 300*120 = 36000). 8 fit under maxRows
// (8*300=2400 <= 2500; 9th => 2700 > 2500). 8 <= maxFiles(10), so rows
// binds first. 20 such files => 3 batches: 8, 8, 4.
// ---------------------------------------------------------------------------
test('maxRows binds before maxFiles for medium-density files', () => {
  const files = Array.from({ length: 20 }, (_, i) => ({ name: `m${i}.csv`, size: 300 * 120 }));
  const batches = planUploadBatches(files, CAPS);
  assert.strictEqual(batches.length, 3, 'expected 3 batches (8, 8, 4)');
  assert.strictEqual(batches[0].length, 8, 'first batch packs 8 (2400 rows)');
  assert.strictEqual(batches[1].length, 8, 'second batch packs 8');
  assert.strictEqual(batches[2].length, 4, 'last batch holds remaining 4');
  assertCapsHeld(batches, CAPS);
});

// ---------------------------------------------------------------------------
// Test 4: maxFiles is the binding cap for many tiny files.
// Each file = 10 rows (size 1200). 10 files = 100 rows << maxRows, so the
// file-count cap (10) binds. 35 files => 4 batches: 10,10,10,5.
// ---------------------------------------------------------------------------
test('maxFiles binds before maxRows for many tiny files', () => {
  const files = Array.from({ length: 35 }, (_, i) => ({ name: `t${i}.csv`, size: 1200 }));
  const batches = planUploadBatches(files, CAPS);
  assert.strictEqual(batches.length, 4, 'expected 4 batches (10,10,10,5)');
  assert.deepStrictEqual(batches.map(b => b.length), [10, 10, 10, 5]);
  assertCapsHeld(batches, CAPS);
});

// ---------------------------------------------------------------------------
// Test 5: maxBytes is the binding cap for a few large-but-sparse files.
// Each file = 3MB (3*1024*1024 = 3145728 bytes), estRows = ceil/120 =
// 26214 rows... that EXCEEDS maxRows on its own, so each would be its own
// batch. To isolate the BYTES cap, use files just under the per-file row
// cap but heavy in bytes is impossible with /120. Instead verify: three
// 3MB files cannot share a batch because 3*3MB = 9MB > 8MB byte cap.
// (Each is also row-dense, so the row cap isolates them too; either way
// they must not co-batch.) This guards the byte cap stays enforced.
// ---------------------------------------------------------------------------
test('large files never share a batch past the byte cap', () => {
  const files = Array.from({ length: 3 }, (_, i) => ({ name: `L${i}.csv`, size: 3 * 1024 * 1024 }));
  const batches = planUploadBatches(files, CAPS);
  for (const b of batches) {
    const bytes = b.reduce((s, f) => s + f.size, 0);
    assert.ok(bytes <= CAPS.maxBytes || b.length === 1,
      `multi-file batch ${bytes} bytes exceeds ${CAPS.maxBytes}`);
  }
  const total = batches.reduce((s, b) => s + b.length, 0);
  assert.strictEqual(total, 3, 'all 3 large files accounted for');
});

// ---------------------------------------------------------------------------
// Test 6: empty input -> no batches.
// ---------------------------------------------------------------------------
test('empty input yields no batches', () => {
  assert.deepStrictEqual(planUploadBatches([], CAPS), []);
});

// ---------------------------------------------------------------------------
// Test 7: the real ZKH dense set. The five dense inlinks files each exceed
// maxRows, so each is isolated; the rest of a 155-file folder packs under
// the caps. Reconstruct the worst offenders and assert isolation + no loss.
// ---------------------------------------------------------------------------
test('ZKH dense inlinks files are each isolated, nothing lost', () => {
  const dense = [
    { name: 'success_(2xx)_inlinks.csv', size: 6799 * 120 },
    { name: 'https_urls_inlinks.csv', size: 6367 * 120 },
    { name: 'follow_inlinks.csv', size: 3138 * 120 },
    { name: 'self_referencing_inlinks.csv', size: 3138 * 120 },
    { name: 'index_inlinks.csv', size: 3138 * 120 },
  ];
  // Plus 50 tiny issue files (8 rows each).
  const tiny = Array.from({ length: 50 }, (_, i) => ({ name: `issue_${i}.csv`, size: 960 }));
  const all = [...dense, ...tiny];
  const batches = planUploadBatches(all, CAPS);
  // Each dense file must be alone.
  for (const d of dense) {
    const b = batches.find(x => x.some(f => f.name === d.name));
    assert.strictEqual(b.length, 1, `${d.name} must be isolated`);
  }
  assertCapsHeld(batches, CAPS);
  const total = batches.reduce((s, b) => s + b.length, 0);
  assert.strictEqual(total, all.length, 'every file accounted for');
});

// ---------------------------------------------------------------------------
// Test 8: DRIFT-LOCK — csv.astro must carry the SAME row-cap algorithm
// inline (it can't import a TS module into the browser script). Guard the
// load-bearing constants + the /120 estimate + the 2500 row cap appear in
// the inline script so the two copies can't silently diverge.
// ---------------------------------------------------------------------------
test('DRIFT-LOCK: csv.astro inline batching mirrors the row cap', () => {
  const astroPath = fileURLToPath(new URL('../src/pages/portal/admin/csv.astro', import.meta.url));
  const src = readFileSync(astroPath, 'utf8');
  assert.ok(/MAX_BATCH_ROWS\s*=\s*2500/.test(src),
    'csv.astro must define MAX_BATCH_ROWS = 2500');
  assert.ok(/MAX_BATCH_FILES\s*=\s*10/.test(src),
    'csv.astro must keep MAX_BATCH_FILES = 10');
  assert.ok(/MAX_BATCH_BYTES\s*=\s*8\s*\*\s*1024\s*\*\s*1024/.test(src),
    'csv.astro must keep MAX_BATCH_BYTES = 8MB');
  // The /120 estimate must be present so dense files self-isolate.
  assert.ok(/\/\s*120/.test(src), 'csv.astro must estimate rows as size / 120');
  // The row cap must actually gate batch packing (a wouldExceedRows check).
  assert.ok(/wouldExceedRows/.test(src),
    'csv.astro must branch on wouldExceedRows so the row cap is enforced');
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
