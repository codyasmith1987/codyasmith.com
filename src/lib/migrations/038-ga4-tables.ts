// Google Analytics 4 tables.
//
// GA4 exports five distinct CSV shapes per cycle per site:
//   - Reports snapshot: multi-block (topline KPIs + session
//     source/medium + first user source/medium + a session
//     source/medium duplicate + Google Ads campaign sessions)
//   - Traffic acquisition by channel grouping
//   - Pages and screens (landing page or page path)
//   - Tech overview (multi-block: platform + OS + device category)
//   - Demographic details by country
//
// One file maps to multiple tables here (the multi-block ones get
// split across topline / source_medium / campaigns). The parser
// chooses which to fill based on the block header it encounters.
//
// Every table has (client_id, csv_upload_id, month) so the standard
// CSV_CHILD_TABLES sweep clears it on re-upload or delete.
//
// Per the data-ingestion overhaul (May 24 2026 audit) — Slice B.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '038-ga4-tables',
  async up() {
    // Topline KPIs from Reports snapshot block 1. One row per upload.
    // The start_date / end_date are pulled from the GA4 file's
    // embedded comment headers so the portal can show "for the
    // period April 12 to May 9" alongside the numbers.
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS ga4_topline (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT NOT NULL REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        start_date TEXT,
        end_date TEXT,
        active_users INTEGER,
        new_users INTEGER,
        sessions INTEGER,
        avg_engagement_time_per_active_user REAL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_ga4_topline_client_month ON ga4_topline(client_id, month)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_ga4_topline_upload ON ga4_topline(csv_upload_id)`);

    // Channel grouping data from Traffic acquisition file. Multiple
    // rows per upload, one per channel (Organic Search, Organic
    // Social, Direct, Paid Search, etc.).
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS ga4_channels (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT NOT NULL REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        channel TEXT NOT NULL,
        sessions INTEGER,
        engaged_sessions INTEGER,
        engagement_rate REAL,
        avg_engagement_time_per_session REAL,
        events_per_session REAL,
        event_count INTEGER,
        key_events INTEGER,
        session_key_event_rate REAL,
        total_revenue REAL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_ga4_channels_client_month ON ga4_channels(client_id, month)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_ga4_channels_upload ON ga4_channels(csv_upload_id)`);

    // Source / medium from Reports snapshot blocks 2 and 3. kind
    // distinguishes "session" (block 2: sessions, key events, total
    // revenue) from "first_user" (block 3: active users). AI
    // referrals (chatgpt.com, perplexity, claude.ai, copilot,
    // gemini) are derived at query time from this table.
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS ga4_source_medium (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT NOT NULL REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        kind TEXT NOT NULL,                -- 'session' or 'first_user'
        source_medium TEXT NOT NULL,
        sessions INTEGER,
        active_users INTEGER,
        key_events INTEGER,
        total_revenue REAL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_ga4_sm_client_month ON ga4_source_medium(client_id, month, kind)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_ga4_sm_upload ON ga4_source_medium(csv_upload_id)`);

    // Top pages from Pages_and_screens or Landing_page export. GA4
    // emits either of those depending on which dimension the admin
    // selected before exporting; the parser supports both and stores
    // either as page_path.
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS ga4_pages (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT NOT NULL REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        page_path TEXT NOT NULL,
        views INTEGER,
        active_users INTEGER,
        views_per_active_user REAL,
        avg_engagement_time_per_active_user REAL,
        event_count INTEGER,
        key_events INTEGER,
        total_revenue REAL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_ga4_pages_client_month ON ga4_pages(client_id, month)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_ga4_pages_upload ON ga4_pages(csv_upload_id)`);

    // Device / OS / platform from Tech overview multi-block. kind:
    // 'platform' (just "Web" usually), 'os' (iOS, Android, Windows,
    // Mac, Linux, Chrome OS), 'device_category' ("web / mobile",
    // "web / desktop", "web / tablet", "web / smart tv").
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS ga4_tech (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT NOT NULL REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        active_users INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_ga4_tech_client_month ON ga4_tech(client_id, month, kind)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_ga4_tech_upload ON ga4_tech(csv_upload_id)`);

    // Country breakdown from Demographic_details_Country export.
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS ga4_geography (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT NOT NULL REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        country TEXT NOT NULL,
        active_users INTEGER,
        new_users INTEGER,
        engaged_sessions INTEGER,
        engagement_rate REAL,
        avg_engagement_time_per_active_user REAL,
        event_count INTEGER,
        key_events INTEGER,
        total_revenue REAL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_ga4_geo_client_month ON ga4_geography(client_id, month)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_ga4_geo_upload ON ga4_geography(csv_upload_id)`);

    // Google Ads campaign sessions from Reports snapshot block 5.
    // Small table — usually 1-5 rows per upload, just the active
    // campaign names with their session counts. Lets the portal
    // narrate "Lead Gen Search drove N sessions this month."
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS ga4_campaigns (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        csv_upload_id TEXT NOT NULL REFERENCES csv_uploads(id),
        month TEXT NOT NULL,
        campaign_name TEXT NOT NULL,
        sessions INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_ga4_campaigns_client_month ON ga4_campaigns(client_id, month)`);
    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_ga4_campaigns_upload ON ga4_campaigns(csv_upload_id)`);
  },
};

export default migration;
