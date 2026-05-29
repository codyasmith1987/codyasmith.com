#!/usr/bin/env node
// Unit tests for the shared report helpers (src/lib/reports/_shared.ts).
// Both report assemblers depend on these, so pin them. Runs via tsx.

import { escCell, table, fmtInt, fmtSignedPct, deltaCell } from '../src/lib/reports/_shared.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 200)}`);
}

function run() {
  // escCell
  test('escCell maps pipe to slash, newline to space', escCell('a|b\nc') === 'a/b c');
  test('escCell leaves bold markers', escCell('**x**') === '**x**');

  // table
  {
    const t = table(['A', 'B'], [['1', '2'], ['3', '4']]);
    const lines = t.split('\n');
    test('table has header/sep/2 body lines', lines.length === 4 && lines[0] === '| A | B |' && lines[1] === '| --- | --- |');
    test('table sanitizes a piped cell', table(['A'], [['x|y']]).includes('x/y'));
  }

  // fmtInt
  test('fmtInt thousands', fmtInt(1234567) === '1,234,567');
  test('fmtInt null -> empty', fmtInt(null) === '');
  test('fmtInt rounds', fmtInt(12.6) === '13');

  // fmtSignedPct
  test('fmtSignedPct positive', fmtSignedPct(0.182) === '+18.2%');
  test('fmtSignedPct negative', fmtSignedPct(-0.05) === '-5.0%');
  test('fmtSignedPct null -> empty', fmtSignedPct(null) === '');

  // deltaCell
  test('deltaCell new (null prior)', deltaCell(null, 5) === 'new');
  test('deltaCell null prior + zero current -> empty', deltaCell(null, 0) === '');
  test('deltaCell flat', deltaCell(100, 100) === 'flat');
  test('deltaCell down pct', deltaCell(39, 15) === fmtSignedPct((15 - 39) / 39));
  test('deltaCell zero prior -> absolute fallback', deltaCell(0, 5) === '+5');
  test('deltaCell both null -> empty', deltaCell(null, null) === '');

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

run();
