import assert from 'node:assert';
import {
  FORMAT_TO_CATEGORY,
  COVERAGE_CATEGORIES,
  coverageCountsFromStatements,
  coverageCountsFilePresent,
  buildCoverageUpsert,
} from '../src/lib/csv/coverage-signals.ts';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`[PASS] ${name}`); passed++; }
  catch (err) { console.error(`[FAIL] ${name}: ${err.message}`); failed++; }
}

// ── Matrix integrity ────────────────────────────────────────────────────────

test('every FORMAT_TO_CATEGORY value exists in COVERAGE_CATEGORIES', () => {
  for (const [format, category] of Object.entries(FORMAT_TO_CATEGORY)) {
    assert.ok(
      COVERAGE_CATEGORIES[category],
      `format ${format} maps to category ${category} which is not in COVERAGE_CATEGORIES`,
    );
  }
});

test('every COVERAGE_CATEGORIES entry has a non-empty table and a valid kind', () => {
  for (const [key, cat] of Object.entries(COVERAGE_CATEGORIES)) {
    assert.strictEqual(cat.category, key, `category key ${key} must match its .category`);
    assert.ok(typeof cat.table === 'string' && cat.table.length > 0, `category ${key} missing table`);
    assert.ok(
      cat.kind === 'file-present' || cat.kind === 'signal',
      `category ${key} has invalid kind ${cat.kind}`,
    );
  }
});

test('every signal category lists >=1 dbSignalColumns and >=1 signalArgIndices', () => {
  for (const [key, cat] of Object.entries(COVERAGE_CATEGORIES)) {
    if (cat.kind !== 'signal') continue;
    assert.ok(
      Array.isArray(cat.dbSignalColumns) && cat.dbSignalColumns.length >= 1,
      `signal category ${key} must list >=1 dbSignalColumns`,
    );
    assert.ok(
      Array.isArray(cat.signalArgIndices) && cat.signalArgIndices.length >= 1,
      `signal category ${key} must list >=1 signalArgIndices`,
    );
  }
});

test('file-present categories carry no signal metadata', () => {
  for (const [key, cat] of Object.entries(COVERAGE_CATEGORIES)) {
    if (cat.kind !== 'file-present') continue;
    assert.ok(cat.dbSignalColumns === undefined, `file-present ${key} must not list dbSignalColumns`);
    assert.ok(cat.signalArgIndices === undefined, `file-present ${key} must not list signalArgIndices`);
  }
});

test('the three signal categories are exactly accessibility, structured_data, content_quality', () => {
  const signal = Object.keys(COVERAGE_CATEGORIES)
    .filter(k => COVERAGE_CATEGORIES[k].kind === 'signal')
    .sort();
  assert.deepStrictEqual(signal, ['accessibility', 'content_quality', 'structured_data']);
});

// ── Signal-arg indices locked to the real builder INSERT column order ───────
// accessibility_urls INSERT columns (0-based):
//   0 id, 1 client_id, 2 csv_upload_id, 3 month, 4 url, 5 hostname,
//   6 status_code, 7 content_type, 8 indexability,
//   9 all_violations, 10 best_practice_violations,
//   11 wcag_20a_violations, 12 wcag_20aa_violations, 13 wcag_20aaa_violations,
//   14 wcag_21a_violations, 15 wcag_21aa_violations,
//   16 wcag_22a_violations, 17 wcag_22aa_violations, 18 raw_json
test('accessibility signalArgIndices match the builder column order', () => {
  assert.deepStrictEqual(COVERAGE_CATEGORIES.accessibility.signalArgIndices, [9, 10, 11, 12, 15]);
  assert.deepStrictEqual(
    COVERAGE_CATEGORIES.accessibility.dbSignalColumns,
    ['all_violations', 'best_practice_violations', 'wcag_20a_violations', 'wcag_20aa_violations', 'wcag_21aa_violations'],
  );
});

// structured_data_urls INSERT columns (0-based):
//   0 id, 1 client_id, 2 csv_upload_id, 3 month, 4 url, 5 hostname,
//   6 error_count, 7 warning_count, 8 rich_result_errors, 9 rich_result_warnings,
//   10 total_types, 11 unique_types, 12 types_list, 13 rich_result_features,
//   14 indexability, 15 raw_json
test('structured_data signalArgIndices match the builder column order', () => {
  assert.deepStrictEqual(COVERAGE_CATEGORIES.structured_data.signalArgIndices, [6, 7, 10]);
  assert.deepStrictEqual(
    COVERAGE_CATEGORIES.structured_data.dbSignalColumns,
    ['error_count', 'warning_count', 'total_types'],
  );
});

// content_urls INSERT columns (0-based):
//   0 id, 1 client_id, 2 csv_upload_id, 3 month, 4 url, 5 hostname,
//   6 word_count, 7 sentence_count, 8 avg_words_per_sentence, 9 flesch_reading_ease,
//   10 readability_grade, 11 closest_near_duplicate_url, 12 near_duplicate_count,
//   13 closest_semantic_similar_url, 14 semantic_similarity_score,
//   15 semantic_relevance_score, 16 spelling_errors, 17 grammar_errors,
//   18 language, 19 raw_json
test('content_quality signalArgIndices match the builder column order', () => {
  assert.deepStrictEqual(COVERAGE_CATEGORIES.content_quality.signalArgIndices, [9, 16, 17, 12]);
  assert.deepStrictEqual(
    COVERAGE_CATEGORIES.content_quality.dbSignalColumns,
    ['flesch_reading_ease', 'spelling_errors', 'grammar_errors', 'near_duplicate_count'],
  );
});

// ── coverageCountsFromStatements: signal family ─────────────────────────────
// Fake accessibility insert statements matching the real 19-arg layout.
function fakeAccessibilityStmt(signalValues) {
  // signalValues: optional { allViolations, bestPractice, wcag20a, wcag20aa, wcag21aa }
  const v = signalValues || {};
  const args = new Array(19).fill(null);
  args[0] = 'id';        // id
  args[1] = 'c1';        // client_id
  args[2] = 'up1';       // csv_upload_id
  args[3] = '2026-05';   // month
  args[4] = 'https://x'; // url
  args[5] = 'x';         // hostname
  args[9] = v.allViolations ?? null;
  args[10] = v.bestPractice ?? null;
  args[11] = v.wcag20a ?? null;
  args[12] = v.wcag20aa ?? null;
  args[15] = v.wcag21aa ?? null;
  return { sql: 'INSERT INTO accessibility_urls ...', args };
}

test('all-null signal columns over 5 rows -> rowsTotal:5, rowsMeasured:0, measured:0', () => {
  const stmts = [fakeAccessibilityStmt(), fakeAccessibilityStmt(), fakeAccessibilityStmt(),
    fakeAccessibilityStmt(), fakeAccessibilityStmt()];
  const got = coverageCountsFromStatements('accessibility', stmts);
  assert.deepStrictEqual(got, { rowsTotal: 5, rowsMeasured: 0, measured: 0 });
});

test('one row with all_violations=3 -> measured:1, rowsMeasured:1', () => {
  const stmts = [fakeAccessibilityStmt(), fakeAccessibilityStmt({ allViolations: 3 }),
    fakeAccessibilityStmt(), fakeAccessibilityStmt(), fakeAccessibilityStmt()];
  const got = coverageCountsFromStatements('accessibility', stmts);
  assert.deepStrictEqual(got, { rowsTotal: 5, rowsMeasured: 1, measured: 1 });
});

test('a literal 0 in a signal column counts as measured (0 is real, not null)', () => {
  const stmts = [fakeAccessibilityStmt({ allViolations: 0 })];
  const got = coverageCountsFromStatements('accessibility', stmts);
  assert.deepStrictEqual(got, { rowsTotal: 1, rowsMeasured: 1, measured: 1 });
});

test('a real signal in a NON-first signal position (wcag21aa) still counts', () => {
  const stmts = [fakeAccessibilityStmt(), fakeAccessibilityStmt({ wcag21aa: 2 })];
  const got = coverageCountsFromStatements('accessibility', stmts);
  assert.deepStrictEqual(got, { rowsTotal: 2, rowsMeasured: 1, measured: 1 });
});

test('empty statements array -> all zeros, measured:0', () => {
  const got = coverageCountsFromStatements('accessibility', []);
  assert.deepStrictEqual(got, { rowsTotal: 0, rowsMeasured: 0, measured: 0 });
});

// ── coverageCountsFromStatements: file-present family ───────────────────────
test('file-present category via coverageCountsFromStatements: rowsMeasured == rowsTotal, measured:1', () => {
  const stmts = [{ sql: 'x', args: [] }, { sql: 'x', args: [] }, { sql: 'x', args: [] }];
  const got = coverageCountsFromStatements('crawl', stmts);
  assert.deepStrictEqual(got, { rowsTotal: 3, rowsMeasured: 3, measured: 1 });
});

test('file-present with zero statements -> rowsTotal:0, rowsMeasured:0, measured:1 (file provided)', () => {
  const got = coverageCountsFromStatements('crawl', []);
  assert.deepStrictEqual(got, { rowsTotal: 0, rowsMeasured: 0, measured: 1 });
});

// ── coverageCountsFilePresent ───────────────────────────────────────────────
test('coverageCountsFilePresent(7) -> rowsTotal:7, rowsMeasured:7, measured:1', () => {
  assert.deepStrictEqual(coverageCountsFilePresent(7), { rowsTotal: 7, rowsMeasured: 7, measured: 1 });
});

test('coverageCountsFilePresent(0) -> measured:1 (a 0-row standalone upload is still measured)', () => {
  assert.deepStrictEqual(coverageCountsFilePresent(0), { rowsTotal: 0, rowsMeasured: 0, measured: 1 });
});

// ── buildCoverageUpsert ─────────────────────────────────────────────────────
test('buildCoverageUpsert SQL contains ON CONFLICT(client_id, month, category) and 8 args', () => {
  const { sql, args } = buildCoverageUpsert({
    clientId: 'c1', month: '2026-05', category: 'accessibility', uploadId: 'up1',
    rowsTotal: 5, rowsMeasured: 0, measured: 0,
  });
  assert.ok(/ON CONFLICT\(client_id, month, category\)/.test(sql), 'SQL must have the ON CONFLICT clause');
  assert.ok(/INSERT INTO data_coverage/.test(sql), 'SQL must INSERT INTO data_coverage');
  assert.ok(/'csv_upload'/.test(sql), 'source must be the literal csv_upload in SQL');
  assert.strictEqual(args.length, 8, 'must return 8 args (source is a SQL literal, not an arg)');
});

test('buildCoverageUpsert arg layout: [id, client_id, month, category, measured, rows_total, rows_measured, csv_upload_id]', () => {
  const { args } = buildCoverageUpsert({
    clientId: 'c1', month: '2026-05', category: 'accessibility', uploadId: 'up1',
    rowsTotal: 5, rowsMeasured: 2, measured: 1,
  });
  // args[0] is a generated id (nanoid) — just assert it is a non-empty string.
  assert.ok(typeof args[0] === 'string' && args[0].length > 0, 'arg0 is a generated id');
  assert.strictEqual(args[1], 'c1');
  assert.strictEqual(args[2], '2026-05');
  assert.strictEqual(args[3], 'accessibility');
  assert.strictEqual(args[4], 1);   // measured
  assert.strictEqual(args[5], 5);   // rows_total
  assert.strictEqual(args[6], 2);   // rows_measured
  assert.strictEqual(args[7], 'up1'); // csv_upload_id
});

test('buildCoverageUpsert generates a fresh id each call', () => {
  const a = buildCoverageUpsert({ clientId: 'c', month: 'm', category: 'crawl', uploadId: 'u', rowsTotal: 1, rowsMeasured: 1, measured: 1 });
  const b = buildCoverageUpsert({ clientId: 'c', month: 'm', category: 'crawl', uploadId: 'u', rowsTotal: 1, rowsMeasured: 1, measured: 1 });
  assert.notStrictEqual(a.args[0], b.args[0], 'ids must differ');
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
