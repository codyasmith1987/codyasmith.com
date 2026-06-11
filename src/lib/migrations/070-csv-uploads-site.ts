// Per-site keying for uploaded data (multi-site Phase 1, 2026-06-11).
//
// csv_uploads was keyed by (client, month, format, filename) only. For a
// multi-site client (ZipKit: zipkithomes.com + mountainvalleyprefab.com) two
// sites' exports share filenames (ga4 snapshots, gsc Queries.csv, ...), so the
// second site's upload would SUPERSEDE the first site's data -- silent data
// loss, not even blending. This adds:
//   - csv_uploads.site_id (nullable; references client_sites.id). NULL means
//     "the client's primary/only site" -- true for every historical row (all
//     pre-existing uploads are single-site or ZKH-primary data), so no
//     backfill guessing is needed and single-site clients never change.
//   - the live-uniqueness index gains the site dimension (COALESCE to '' so
//     two NULLs still collide as before), letting the same filename live
//     once PER SITE per month.
// Crawl-family tables already self-identify by hostname per row; the upload
// site_id exists for the families that cannot (GA4, GSC, keywords, metrics).

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '070-csv-uploads-site',
  async up() {
    const cols = await turso.execute(`PRAGMA table_info(csv_uploads)`);
    if (!new Set(cols.rows.map(r => String(r[1]))).has('site_id')) {
      await turso.execute(`ALTER TABLE csv_uploads ADD COLUMN site_id TEXT`);
    }
    // Replace the live-unique index with the site-aware key. DROP + CREATE is
    // safe: both are idempotent and the window is within one migration run.
    await turso.execute(`DROP INDEX IF EXISTS ux_csv_uploads_live`);
    await turso.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_csv_uploads_live
      ON csv_uploads (client_id, month, detected_format, original_name, COALESCE(site_id, ''))
      WHERE error IS NULL
    `);
  },
};

export default migration;
