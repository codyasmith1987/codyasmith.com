// Initial schema — all existing tables from auth.ts ensurePortalTables() and db.ts ensureTables()
// This is a migration of the existing schema, not new tables.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '001-initial-schema',
  async up() {
    // Portal tables (from auth.ts ensurePortalTables)
    await turso.batch([
      `CREATE TABLE IF NOT EXISTS clients (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT,
        role TEXT NOT NULL DEFAULT 'client',
        client_id TEXT REFERENCES clients(id),
        created_at TEXT DEFAULT (datetime('now')),
        last_login_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        expires_at TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS magic_links (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL REFERENCES users(id),
        expires_at TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        filename TEXT NOT NULL,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        month TEXT NOT NULL,
        s3_key TEXT NOT NULL,
        uploaded_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS csv_uploads (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        original_name TEXT NOT NULL,
        detected_format TEXT NOT NULL,
        row_count INTEGER NOT NULL DEFAULT 0,
        month TEXT NOT NULL,
        uploaded_by TEXT NOT NULL REFERENCES users(id),
        processed_at TEXT,
        error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS metrics (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        month TEXT NOT NULL,
        category TEXT NOT NULL,
        metric_key TEXT NOT NULL,
        metric_value REAL NOT NULL,
        source TEXT,
        csv_upload_id TEXT REFERENCES csv_uploads(id),
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(client_id, month, category, metric_key)
      )`,
      `CREATE TABLE IF NOT EXISTS keyword_rankings (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        month TEXT NOT NULL,
        keyword TEXT NOT NULL,
        position INTEGER,
        search_volume INTEGER,
        url TEXT,
        change_val INTEGER,
        seo_difficulty INTEGER,
        source TEXT,
        csv_upload_id TEXT REFERENCES csv_uploads(id),
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS site_issues (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        month TEXT NOT NULL,
        issue_name TEXT NOT NULL,
        issue_type TEXT,
        priority TEXT,
        affected_urls INTEGER,
        pct_of_total REAL,
        description TEXT,
        how_to_fix TEXT,
        csv_upload_id TEXT REFERENCES csv_uploads(id),
        created_at TEXT DEFAULT (datetime('now'))
      )`,
    ], 'write');

    // Public site tables (from db.ts ensureTables)
    await turso.batch([
      `CREATE TABLE IF NOT EXISTS scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        brand TEXT NOT NULL,
        domain TEXT,
        input_type TEXT NOT NULL,
        overall_score INTEGER,
        overall_label TEXT,
        mention_count INTEGER DEFAULT 0,
        summary TEXT,
        top_positive_phrases TEXT,
        top_negative_phrases TEXT,
        source_breakdown TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS mentions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id INTEGER NOT NULL,
        url TEXT NOT NULL,
        source_name TEXT,
        source_type TEXT,
        snippet TEXT,
        sentiment_score REAL,
        sentiment_label TEXT,
        key_phrases TEXT,
        query_type TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (scan_id) REFERENCES scans(id)
      )`,
      `CREATE TABLE IF NOT EXISTS leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id INTEGER NOT NULL,
        first_name TEXT NOT NULL,
        email TEXT NOT NULL,
        brand_searched TEXT,
        domain_searched TEXT,
        overall_score INTEGER,
        consent_given INTEGER NOT NULL DEFAULT 0,
        consent_timestamp TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (scan_id) REFERENCES scans(id)
      )`,
      `CREATE TABLE IF NOT EXISTS rate_limits (
        ip TEXT NOT NULL,
        scan_date TEXT NOT NULL,
        scan_count INTEGER DEFAULT 1,
        PRIMARY KEY (ip, scan_date)
      )`,
    ], 'write');
  },
};

export default migration;
