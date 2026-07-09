// One-shot script: list csv_uploads for a client/month and surface
// any that are superseded (same client + month + detected_format,
// older created_at). Also counts data rows in child tables grouped
// by csv_upload_id to confirm whether the supersede sweep actually
// cleared them.
//
// Usage:
//   node scripts/find-duplicates.mjs <client_id> <month>
// e.g.
//   node scripts/find-duplicates.mjs zipkit-homes 2026-05

import 'dotenv/config';
import { createClient } from '@libsql/client';

const url = (process.env.TURSO_DATABASE_URL || '').trim();
const authToken = (process.env.TURSO_AUTH_TOKEN || '').replace(/\s+/g, '');
if (!url) {
  console.error('TURSO_DATABASE_URL not set. Add it to .env.');
  process.exit(1);
}
const turso = createClient(authToken ? { url, authToken } : { url });

const [, , clientArg, monthArg] = process.argv;
if (!clientArg || !monthArg) {
  console.error('Usage: node scripts/find-duplicates.mjs <client_id> <month>');
  process.exit(1);
}

// All child tables that hold per-upload data; if any of these has
// rows tied to a csv_upload_id that's no longer the "latest" for
// that (client, month, format), it's stale and should be deleted.
const CHILD_TABLES = [
  'metrics', 'site_issues', 'site_issue_urls', 'keyword_rankings',
  'crawl_urls', 'redirect_chains', 'image_urls', 'content_urls',
  'security_urls', 'structured_data_urls', 'accessibility_urls',
  'raw_csv_data',
  'ga4_topline', 'ga4_channels', 'ga4_source_medium', 'ga4_pages',
  'ga4_tech', 'ga4_geography', 'ga4_campaigns',
  'gsc_dimensions', 'gsc_chart', 'gsc_filters',
];

async function main() {
  // Resolve client by id or slug.
  const clientRes = await turso.execute({
    sql: 'SELECT id, name, slug FROM clients WHERE id = ? OR slug = ?',
    args: [clientArg, clientArg],
  });
  if (clientRes.rows.length === 0) {
    console.error(`No client found for "${clientArg}".`);
    const all = await turso.execute('SELECT id, name, slug FROM clients ORDER BY name');
    console.error('Known clients:');
    for (const r of all.rows) console.error(`  ${r[1]}  (id=${r[0]}, slug=${r[2]})`);
    process.exit(1);
  }
  const clientId = clientRes.rows[0][0];
  const clientName = clientRes.rows[0][1];
  console.log(`\nClient: ${clientName} (${clientId})\nMonth: ${monthArg}\n`);

  // All uploads for this client+month, oldest first.
  const uploads = await turso.execute({
    sql: `SELECT id, original_name, detected_format, row_count, processed_at, error, created_at
          FROM csv_uploads
          WHERE client_id = ? AND month = ?
          ORDER BY detected_format, created_at ASC`,
    args: [clientId, monthArg],
  });
  if (uploads.rows.length === 0) {
    console.log('No uploads found for this client+month. Nothing to clean.');
    return;
  }

  console.log(`Found ${uploads.rows.length} csv_uploads row(s):\n`);

  // Group by detected_format and identify the latest in each group.
  const groups = new Map();
  for (const r of uploads.rows) {
    const fmt = r[2];
    if (!groups.has(fmt)) groups.set(fmt, []);
    groups.get(fmt).push({
      id: r[0], filename: r[1], format: fmt, rowCount: r[3],
      processedAt: r[4], error: r[5], createdAt: r[6],
    });
  }

  const staleIds = [];
  for (const [fmt, rows] of groups) {
    if (rows.length === 1) continue; // No duplicates for this format.
    console.log(`Format: ${fmt}  (${rows.length} uploads)`);
    for (let i = 0; i < rows.length; i++) {
      const isLatest = i === rows.length - 1;
      const marker = isLatest ? '  CURRENT' : '  SUPERSEDED';
      console.log(`  ${marker}  ${rows[i].id}  ${rows[i].filename}  rows=${rows[i].rowCount}  created=${rows[i].createdAt}`);
      if (!isLatest) staleIds.push(rows[i].id);
    }
    console.log('');
  }

  if (staleIds.length === 0) {
    console.log('No duplicate (superseded) uploads found. Data is already deduped.\n');
    return;
  }

  // Check each child table for rows tied to stale upload ids — that
  // would mean the supersede sweep missed them and the data is
  // actually duplicated.
  console.log(`\nChecking child tables for orphaned data tied to ${staleIds.length} superseded upload(s)...\n`);
  const placeholders = staleIds.map(() => '?').join(',');
  let orphanFound = false;
  for (const table of CHILD_TABLES) {
    try {
      const r = await turso.execute({
        sql: `SELECT COUNT(*) FROM ${table} WHERE csv_upload_id IN (${placeholders})`,
        args: staleIds,
      });
      const n = Number(r.rows[0][0]) || 0;
      if (n > 0) {
        orphanFound = true;
        console.log(`  ${table}: ${n} orphaned row(s) — these are duplicates`);
      }
    } catch (err) {
      // Table might not exist on this DB yet; skip silently.
    }
  }
  if (!orphanFound) {
    console.log('  None. The supersede sweep cleared child-table rows correctly.\n');
  }

  console.log('\nTo delete the superseded csv_uploads rows + any orphaned data, run:');
  console.log('  node scripts/find-duplicates.mjs <client> <month> --delete\n');

  if (process.argv.includes('--delete')) {
    console.log('Deleting...');
    // Delete orphan data first.
    for (const table of CHILD_TABLES) {
      try {
        const r = await turso.execute({
          sql: `DELETE FROM ${table} WHERE csv_upload_id IN (${placeholders})`,
          args: staleIds,
        });
        if (r.rowsAffected && Number(r.rowsAffected) > 0) {
          console.log(`  ${table}: deleted ${r.rowsAffected} row(s)`);
        }
      } catch { /* ignore missing table */ }
    }
    // Then delete the csv_uploads rows themselves.
    const del = await turso.execute({
      sql: `DELETE FROM csv_uploads WHERE id IN (${placeholders})`,
      args: staleIds,
    });
    console.log(`  csv_uploads: deleted ${del.rowsAffected} row(s)`);
    console.log('\nDone.\n');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
