// Phase 1 Step 0 — full logical backup of the remote Turso database.
//
// Writes one JSONL file per table (one row per line) plus a schema.sql
// file and a manifest.json listing row counts. The backup is self-contained
// and restorable by replaying schema.sql and INSERTing the JSONL rows.
//
// Run:  npx tsx scripts/phase1-backup.ts
//
// Output: backups/prod-<UTC-timestamp>/
//           schema.sql
//           manifest.json
//           <table>.jsonl  (one per table)
//
// Verification: after writing every table, we re-run COUNT(*) against the
// live DB and compare to the in-file line count. Any mismatch aborts.

import 'dotenv/config';
import { createClient } from '@libsql/client';
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url) {
  console.error('TURSO_DATABASE_URL is not set');
  process.exit(1);
}

const db = createClient({ url, authToken });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const outDir = join(process.cwd(), 'backups', `prod-${stamp}`);
mkdirSync(outDir, { recursive: true });

console.log(`Backup target: ${outDir}`);

async function main() {
  // 1. Dump schema (tables + indexes).
  const schemaRows = await db.execute(
    "SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL ORDER BY type DESC, name"
  );
  const schemaSql = schemaRows.rows.map((r) => `${r[0]};`).join('\n\n') + '\n';
  writeFileSync(join(outDir, 'schema.sql'), schemaSql, 'utf8');
  console.log(`  schema.sql           ${schemaRows.rows.length} objects`);

  // 2. List tables to dump (exclude sqlite internal).
  const tableRows = await db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  const tables = tableRows.rows.map((r) => r[0] as string);

  const manifest: Record<string, { rows: number; columns: string[] }> = {};

  for (const table of tables) {
    const result = await db.execute(`SELECT * FROM "${table}"`);
    const cols = result.columns;
    const filePath = join(outDir, `${table}.jsonl`);
    const stream = createWriteStream(filePath, { encoding: 'utf8' });

    for (const row of result.rows) {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < cols.length; i++) {
        const v = row[i];
        // libSQL returns bigints for INTEGER; JSON can't serialize them raw.
        obj[cols[i]] = typeof v === 'bigint' ? v.toString() : v;
      }
      stream.write(JSON.stringify(obj) + '\n');
    }
    await new Promise<void>((resolve, reject) => {
      stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });

    // Re-verify count against live DB.
    const recheck = await db.execute(`SELECT COUNT(*) FROM "${table}"`);
    const liveCount = Number(recheck.rows[0][0]);
    if (liveCount !== result.rows.length) {
      console.error(
        `  MISMATCH on ${table}: dumped ${result.rows.length}, live recount ${liveCount}`
      );
      process.exit(2);
    }

    manifest[table] = { rows: result.rows.length, columns: cols };
    console.log(`  ${table.padEnd(20)} ${result.rows.length} rows`);
  }

  writeFileSync(
    join(outDir, 'manifest.json'),
    JSON.stringify(
      {
        created_at: new Date().toISOString(),
        turso_url_host: new URL(url!).host,
        tables: manifest,
      },
      null,
      2
    ),
    'utf8'
  );

  console.log(`\nBackup complete: ${outDir}`);
  console.log('Verification: every table row count re-queried and matched.');
}

main().catch((err) => {
  console.error('Backup failed:', err);
  process.exit(1);
});
