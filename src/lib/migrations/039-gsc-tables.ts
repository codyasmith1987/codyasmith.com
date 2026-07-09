// Google Search Console tables.
//
// GSC exports five dimension files (Pages, Queries, Countries,
// Devices, Search appearance) all with the same column shape:
//   <Dimension>, Clicks, Impressions, CTR, Position
// Plus a time-series Chart.csv (Date, Clicks, Impressions, CTR,
// Position) and a metadata Filters.csv (Filter, Value).
//
// One unified gsc_dimensions table holds all five dimension files
// with a dimension_type tag, since the column shape is identical.
// gsc_chart holds the time-series; gsc_filters holds the export
// metadata (search type, date range).
//
// Per the data-ingestion overhaul (May 24 2026 audit) — Slice C.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '039-gsc-tables',
  async up() {
    // Single table for all dimension exports. dimension_type
    // distinguishes 'page', 'query', 'country', 'device',
    // 'search_appearance'. ctr is stored as a 0..1 float, position
    // as decimal (e.g., 12.76).
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS gsc_dimensions (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT NOT NULL REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        dimension_type TEXT NOT NULL,
        dimension_value TEXT NOT NULL,
        clicks INTEGER,
        impressions INTEGER,
        ctr REAL,
        position REAL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_gsc_dim_client_month_type ON gsc_dimensions(client_id, month, dimension_type)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_gsc_dim_upload ON gsc_dimensions(csv_upload_id)`);

    // Time-series chart export (Chart.csv). One row per day in the
    // export window. The portal renders a weekly or monthly roll-up
    // on top of this for the search-performance trend chart.
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS gsc_chart (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT NOT NULL REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        date TEXT NOT NULL,
        clicks INTEGER,
        impressions INTEGER,
        ctr REAL,
        position REAL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_gsc_chart_client_month ON gsc_chart(client_id, month)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_gsc_chart_date ON gsc_chart(client_id, date)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_gsc_chart_upload ON gsc_chart(csv_upload_id)`);

    // Export metadata (Filters.csv). Small table — typically 2-3
    // rows per upload (Search type, Date range). Kept so the
    // dashboard can show "Last 6 months, web search" alongside
    // the data without inferring from the date range alone.
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS gsc_filters (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT NOT NULL REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        filter_key TEXT NOT NULL,
        filter_value TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_gsc_filters_client_month ON gsc_filters(client_id, month)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_gsc_filters_upload ON gsc_filters(csv_upload_id)`);
  },
};

export default migration;
