import turso from '../turso';
import type { Migration } from '../migrate';

// Enforce one site_issues row per (client_id, month, issue_name).
//
// Screaming Frog ships issues_overview_report.csv in BOTH the crawl root and
// /issues_reports/. They detect as the same format with different
// original_names, so neither supersedes the other (the supersession key
// includes original_name). Both files then write site_issues keyed by
// issue_name. With only id as PRIMARY KEY (migration 001) and a NON-unique
// index on (client_id, month) (migration 002), the second file's identical
// issue_names silently insert DUPLICATE rows -- the same issue double-counted
// in site_issues, which feeds the client-facing Technical Health score.
//
// The issues-overview and site-audit parsers want last-writer-wins on
// (client_id, month, issue_name): one row per issue, refreshed by a re-upload
// or a duplicate file. That requires a real UNIQUE constraint to back their
// ON CONFLICT(client_id, month, issue_name) upsert; without it SQLite throws
// "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint".
//
// Same dedup-then-index pattern as migration 055: collapse any existing
// duplicates (keep the newest per key) before creating the unique index so it
// can be built on dirty prod data.
const migration: Migration = {
  id: '058-site-issues-name-unique',
  async up() {
    // 1. Dedupe existing duplicates: keep the newest row per
    //    (client_id, month, issue_name), delete the rest, so the unique index
    //    can be created on data that already carries duplicates.
    await turso.execute(`
      DELETE FROM site_issues
       WHERE id NOT IN (
         SELECT id FROM (
           SELECT id,
                  ROW_NUMBER() OVER (
                    PARTITION BY client_id, month, issue_name
                    ORDER BY created_at DESC, id DESC
                  ) AS rn
           FROM site_issues
         ) WHERE rn = 1
       )
    `);
    // 2. Unique index backing the parsers' ON CONFLICT upsert.
    await turso.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_site_issues_name
      ON site_issues (client_id, month, issue_name)
    `);
  },
};

export default migration;
