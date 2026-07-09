// Raw CSV storage for files the portal accepts but does not yet have
// a typed parser for.
//
// Until now the CSV pipeline returned format='unknown' for anything
// not matching a known signature, and the upload UI surfaced that as
// an error. That denied real data — every Screaming Frog crawl
// produces ~250 CSVs and only ~15 have hot parsers; every Google
// Analytics 4 export is currently denied; every Google Search Console
// export is currently denied; every Cloudflare PDF is denied.
//
// The new contract: nothing is denied. If a CSV doesn't match a
// signature, its raw text + detected headers land here, the upload
// record is marked detected_format='unknown_stored', and the admin
// upload UI shows it as "stored, not yet visualized." A later slice
// can add a typed parser for any specific filename pattern and
// retroactively process every stored row without re-upload.
//
// The volumes are bounded by the upload route's 10MB/file and 50K
// row limits, so storing as TEXT is acceptable. If the table grows
// past a few GB we can revisit (gzip column, or move to object
// storage).
//
// Indexed lookups:
//   - by (client_id, month) to show "all unprocessed data for this
//     client this month" in the upload UI
//   - by csv_upload_id for re-import cleanup (matches the
//     CSV_CHILD_TABLES sweep pattern)
//   - by filename to find candidate uploads when a new parser ships
//     and we want to retroactively process

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '037-raw-csv-data',
  async up() {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS raw_csv_data (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT NOT NULL REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        filename TEXT NOT NULL,
        headers TEXT,
        row_count INTEGER DEFAULT 0,
        raw_text TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_raw_csv_client_month
      ON raw_csv_data(client_id, month)
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_raw_csv_upload
      ON raw_csv_data(csv_upload_id)
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_raw_csv_filename
      ON raw_csv_data(filename)
    `);
  },
};

export default migration;
