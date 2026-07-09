import turso from '../turso';
import type { Migration } from '../migrate';

// Enforce: at most ONE live (non-superseded, non-errored) csv_uploads row
// per (client_id, month, detected_format, original_name). Historical
// superseded/errored rows are unconstrained (kept for audit). Makes the
// per-filename supersession invariant DB-enforced so the concurrent batch
// upload path cannot create two live duplicates for the same key.
const migration: Migration = {
  id: '055-csv-uploads-live-unique',
  async up() {
    // 1. Dedupe existing LIVE duplicates: keep the newest per key, mark the
    //    rest superseded, so the unique index can be created on dirty data.
    await turso.execute(`
      UPDATE csv_uploads
         SET error = 'Superseded by newer upload'
       WHERE error IS NULL
         AND id NOT IN (
           SELECT id FROM (
             SELECT id,
                    ROW_NUMBER() OVER (
                      PARTITION BY client_id, month, detected_format, original_name
                      ORDER BY created_at DESC, id DESC
                    ) AS rn
             FROM csv_uploads
             WHERE error IS NULL
           ) WHERE rn = 1
         )
    `);
    // 2. Partial unique index: only constrains live rows.
    await turso.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_csv_uploads_live
      ON csv_uploads (client_id, month, detected_format, original_name)
      WHERE error IS NULL
    `);
  },
};

export default migration;
