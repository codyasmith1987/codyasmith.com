// Cloudflare integration tables.
//
// Slice D of the data-ingestion overhaul. Pull-model — the portal
// hits CF's GraphQL Analytics API on demand and stores daily
// aggregates so the dashboard reads from local tables instead of
// calling CF on every page load.
//
// Per-site credentials: each managed domain has its own CF zone,
// so cloudflare_zone_id + cloudflare_api_token live on
// client_sites (not on clients). Token stored plaintext for v1;
// the user-supplied tokens should be scoped to "Zone Analytics:Read"
// only, limiting blast radius. A future migration can move them to
// an encrypted column once we have a key-management strategy.
//
// V1 storage shape: two tables, both keyed by
// (client_id, site_id, date). Daily granularity matches CF's
// httpRequests1dGroups aggregate without paying for hour-by-hour
// resolution we don't surface anywhere yet. Bot management +
// AI Crawl Control breakdown deferred to a v2 migration that
// adds two more tables when we wire those queries.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '040-cloudflare',
  async up() {
    // ----- Per-site credentials -----
    await turso.execute(`
      ALTER TABLE client_sites ADD COLUMN cloudflare_zone_id TEXT
    `);
    await turso.execute(`
      ALTER TABLE client_sites ADD COLUMN cloudflare_api_token TEXT
    `);
    await turso.execute(`
      ALTER TABLE client_sites ADD COLUMN cloudflare_last_synced_at TEXT
    `);

    // ----- Daily HTTP traffic + threats -----
    // One row per (client, site, date). Populated by the sync
    // endpoint from CF's httpRequests1dGroups dataset.
    // requests / cached_requests in count, bytes / cached_bytes in
    // bytes, threats is CF's count of malicious/suspicious requests
    // blocked or challenged, page_views is the count of HTML 200s.
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS cloudflare_traffic_daily (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        site_id TEXT NOT NULL REFERENCES client_sites(id),
        date TEXT NOT NULL,
        requests INTEGER,
        cached_requests INTEGER,
        bytes INTEGER,
        cached_bytes INTEGER,
        threats INTEGER,
        page_views INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cf_traffic_unique
      ON cloudflare_traffic_daily(client_id, site_id, date)
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_cf_traffic_client_date
      ON cloudflare_traffic_daily(client_id, date)
    `);

    // ----- Daily security events -----
    // One row per (client, site, date). Aggregates the firewall
    // events stream by date + action. Each action gets its own
    // column so the dashboard can show "WAF events" vs "rate
    // limit triggers" without a separate query.
    //
    // Actions tracked: block, challenge (interactive challenge),
    // jschallenge (JS challenge), managed_challenge, log (logged
    // but not blocked), rate_limit (rate-limited responses).
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS cloudflare_security_daily (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        site_id TEXT NOT NULL REFERENCES client_sites(id),
        date TEXT NOT NULL,
        total_events INTEGER,
        block_events INTEGER,
        challenge_events INTEGER,
        managed_challenge_events INTEGER,
        js_challenge_events INTEGER,
        log_events INTEGER,
        rate_limit_events INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    await turso.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cf_security_unique
      ON cloudflare_security_daily(client_id, site_id, date)
    `);
    await turso.execute(`
      CREATE INDEX IF NOT EXISTS idx_cf_security_client_date
      ON cloudflare_security_daily(client_id, date)
    `);
  },
};

export default migration;
