import assert from 'node:assert';
import { createClient } from '@libsql/client';
import { bulkInsert } from '../src/lib/csv/parsers/_bulk-insert.ts';
let passed=0, failed=0;
async function test(n,f){try{await f();console.log(`[PASS] ${n}`);passed++}catch(e){console.error(`[FAIL] ${n}: ${e.message}`);failed++}}

await test('bulkInsert writes all rows via batch with exact values (250 rows > one chunk)', async () => {
  const db = createClient({ url: 'file::memory:?cache=shared' });
  await db.execute(`CREATE TABLE t (a TEXT, b INTEGER)`);
  const sql = `INSERT INTO t (a,b) VALUES (?,?)`;
  const rows = Array.from({length: 250}, (_,i) => [`k${i}`, i]);
  await bulkInsert(sql, rows, db);
  const out = await db.execute(`SELECT a,b FROM t ORDER BY b`);
  assert.strictEqual(out.rows.length, 250);
  assert.strictEqual(out.rows[0].a, 'k0');
  assert.strictEqual(Number(out.rows[0].b), 0);
  assert.strictEqual(out.rows[249].a, 'k249');
  assert.strictEqual(Number(out.rows[249].b), 249);
});

await test('bulkInsert with empty input writes nothing and does not throw', async () => {
  const db = createClient({ url: 'file::memory:?cache=shared' });
  await db.execute(`CREATE TABLE t2 (a TEXT)`);
  await bulkInsert(`INSERT INTO t2 (a) VALUES (?)`, [], db);
  const out = await db.execute(`SELECT COUNT(*) AS n FROM t2`);
  assert.strictEqual(Number(out.rows[0].n), 0);
});

console.log(`\n${passed}/${passed+failed} passed`); if(failed>0) process.exit(1);
