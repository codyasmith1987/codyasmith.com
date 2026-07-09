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
    ['https://f3.com/old',        200, 'text/html', 'Non-Indexable', 'Old', 3,   500], // noindex REAL page (a real "blocked" problem)
    ['https://f3.com/app',        200, 'text/html', 'Indexable', 'App',     3,   0  ], // JS-rendered, 0 words
    ['https://f3.com/tag/old/',   200, 'text/html', 'Non-Indexable', 'Tag', 3,   10 ], // noindex ARCHIVE (expected, NOT a blocked page)
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

await test('indexability "pages blocked" counts real noindex pages, NOT CMS noindex archives (M4)', async () => {
  const db = await freshDb();
  const BLOCKED = `AND status_code = 200 AND LOWER(IFNULL(content_type, '')) LIKE '%html%' ${realUserPageUrlExclusions('url')}`;
  const r = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM crawl_urls WHERE client_id=? AND month=? ${BLOCKED} AND indexability IS NOT NULL AND indexability != 'Indexable'`,
    args: [C, M],
  });
  // Only /old (real noindex page) counts; /tag/old/ (noindex archive) and the
  // 404 asset are excluded.
  assert.strictEqual(Number(r.rows[0].n), 1, `expected 1 real blocked page, got ${r.rows[0].n}`);
});

await test('duplicate-content groups real pages by content_hash, excludes archives/blank-hash', async () => {
  const db = createClient({ url: ':memory:' });
  await db.execute(`CREATE TABLE url_structure_urls (
    client_id TEXT, month TEXT, url TEXT, content_type TEXT, status_code INTEGER,
    indexability TEXT, content_hash TEXT)`);
  const rows = [
    ['https://f3.com/a',        'text/html', 200, 'Indexable', 'AAA'], // dup group AAA (2 real pages)
    ['https://f3.com/a-copy',   'text/html', 200, 'Indexable', 'AAA'],
    ['https://f3.com/unique',   'text/html', 200, 'Indexable', 'BBB'], // unique hash -> not a group
    ['https://f3.com/tag/x/',   'text/html', 200, 'Indexable', 'CCC'], // archive: excluded even though...
    ['https://f3.com/tag/y/',   'text/html', 200, 'Indexable', 'CCC'], // ...two share hash CCC
    ['https://f3.com/blank',    'text/html', 200, 'Indexable', ''   ], // blank hash excluded
  ];
  for (const r of rows) await db.execute({ sql: `INSERT INTO url_structure_urls (client_id, month, url, content_type, status_code, indexability, content_hash) VALUES (?,?,?,?,?,?,?)`, args: [C, M, ...r] });
  const r = await db.execute({
    sql: `SELECT content_hash, COUNT(*) AS n FROM url_structure_urls
          WHERE client_id=? AND month=? AND content_hash IS NOT NULL AND content_hash != ''
            ${realUserPageRowFilters('')} ${realUserPageUrlExclusions('url')}
          GROUP BY content_hash HAVING COUNT(*) > 1`,
    args: [C, M],
  });
  // Only AAA qualifies: BBB is unique, CCC is archive pages (excluded), blank excluded.
  assert.strictEqual(r.rows.length, 1, `expected 1 dup group, got ${r.rows.length}`);
  assert.strictEqual(String(r.rows[0].content_hash), 'AAA');
  assert.strictEqual(Number(r.rows[0].n), 2);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
