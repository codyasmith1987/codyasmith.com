// Proves the page-quality widgets count ONLY real user pages, not 404
// cache-busted assets, archives, wp-content, noindex URLs, or JS-rendered
// 0-word pages. Builds the title-missing + thin-content counts the same way
// url-insights.ts does (realUserPageRowFilters + realUserPageUrlExclusions +
// word_count>0 floor) against a seeded crawl_urls and asserts the noise is
// excluded. This is the H1 fix's regression guard (F3: 8 fake -> 0).
import assert from 'node:assert';
import { createClient } from '@libsql/client';
import { realUserPageRowFilters, realUserPageUrlExclusions } from '../src/lib/csv/page-count-sql.ts';

let passed = 0, failed = 0;
async function test(n, f) {
  try { await f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}
const C = 'c1', M = '2026-06';
const PAGE = `${realUserPageRowFilters('')} ${realUserPageUrlExclusions('url')}`;

async function freshDb() {
  const db = createClient({ url: ':memory:' });
  await db.execute(`CREATE TABLE crawl_urls (
    client_id TEXT, month TEXT, url TEXT, status_code INTEGER, content_type TEXT,
    indexability TEXT, title TEXT, title_length INTEGER, word_count INTEGER)`);
  const rows = [
    // 3 REAL pages: one missing-title, one thin (50 words), one healthy.
    ['https://f3.com/',           200, 'text/html', 'Indexable', '',       0,   800],
    ['https://f3.com/about',      200, 'text/html', 'Indexable', 'About',  5,   50 ],
    ['https://f3.com/services',   200, 'text/html', 'Indexable', 'Svc',    3,   600],
    // NOISE that must NOT count as pages with missing title / thin content:
    ['https://f3.com/x.webp?v=2', 404, 'text/html', 'Indexable', '',       0,   0  ], // 404 cache-busted asset
    ['https://f3.com/tag/seo/',   200, 'text/html', 'Indexable', '',       0,   10 ], // tag archive
    ['https://f3.com/wp-content/uploads/a.webp', 200, 'image/webp', '',     '', 0,  0 ], // wp asset
    ['https://f3.com/old',        200, 'text/html', 'Non-Indexable', '',    0,   5  ], // noindex
    ['https://f3.com/app',        200, 'text/html', 'Indexable', 'App',     3,   0  ], // JS-rendered, 0 words
  ];
  for (const r of rows) {
    await db.execute({
      sql: `INSERT INTO crawl_urls (client_id, month, url, status_code, content_type, indexability, title, title_length, word_count) VALUES (?,?,?,?,?,?,?,?,?)`,
      args: [C, M, ...r],
    });
  }
  return db;
}

await test('missing-title count = 1 (only the real page, not 404/tag/wp/noindex assets)', async () => {
  const db = await freshDb();
  const r = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM crawl_urls WHERE client_id=? AND month=? ${PAGE} AND (title IS NULL OR title='')`,
    args: [C, M],
  });
  assert.strictEqual(Number(r.rows[0].n), 1, `expected 1 real missing-title page, got ${r.rows[0].n}`);
});

await test('thin-content count = 1 (the 50-word real page; NOT the 0-word JS page or 404)', async () => {
  const db = await freshDb();
  const r = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM crawl_urls WHERE client_id=? AND month=? ${PAGE} AND word_count > 0 AND word_count < 200`,
    args: [C, M],
  });
  assert.strictEqual(Number(r.rows[0].n), 1, `expected 1 real thin page, got ${r.rows[0].n}`);
});

await test('without the filter, the noise inflates the counts (proves the filter is doing the work)', async () => {
  const db = await freshDb();
  // Old behavior: bare text/html check counted assets/archives/noindex too.
  const r = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM crawl_urls WHERE client_id=? AND month=? AND content_type LIKE 'text/html%' AND (title IS NULL OR title='')`,
    args: [C, M],
  });
  // homepage + 404 asset + tag + noindex = 4 (the bug); filtered version is 1.
  assert.ok(Number(r.rows[0].n) > 1, `old query should over-count; got ${r.rows[0].n}`);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
