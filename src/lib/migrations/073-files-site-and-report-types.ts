// Document experience foundation (2026-06-15).
//
// Two additive columns, both nullable, both idempotent — no table rebuild:
//   - files.site_id: which managed site a document belongs to. NULL means
//     engagement-level / not site-specific (e.g. a Strategic Recommendations
//     doc that spans every site). References client_sites.id conceptually but
//     kept as a plain TEXT column (no FK) to match the existing additive
//     pattern and avoid rebuilding the prod files table. Lets the client's
//     Reports view split a multi-site client's deliverables by site, and lets
//     the upload auto-tagger record the detected site.
//   - client_sites.aliases: optional comma-separated short codes (e.g.
//     "ZKH,ZipKit") used to recognize a site from an uploaded filename during
//     auto-tagging. NULL = derive from domain + label only.
//
// The new report categories (performance_summary, site_health_report,
// advisory) are application-level values in the existing free-text
// files.category column, so they need no schema change — see storage.ts.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '073-files-site-and-report-types',
  async up() {
    const fileCols = new Set(
      (await turso.execute(`PRAGMA table_info(files)`)).rows.map(r => String(r[1])),
    );
    if (!fileCols.has('site_id')) {
      await turso.execute(`ALTER TABLE files ADD COLUMN site_id TEXT`);
    }
    await turso.execute(
      `CREATE INDEX IF NOT EXISTS idx_files_client_site ON files(client_id, site_id)`,
    );

    const siteCols = new Set(
      (await turso.execute(`PRAGMA table_info(client_sites)`)).rows.map(r => String(r[1])),
    );
    if (!siteCols.has('aliases')) {
      await turso.execute(`ALTER TABLE client_sites ADD COLUMN aliases TEXT`);
    }
  },
};

export default migration;
