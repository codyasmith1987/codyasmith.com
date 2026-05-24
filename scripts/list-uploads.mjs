// Quick diagnostic: list all clients and recent uploads so we can
// see what DB this .env is pointing at and whether the upload Cody
// described actually lives here.

import 'dotenv/config';
import { createClient } from '@libsql/client';

const url = (process.env.TURSO_DATABASE_URL || '').trim();
const authToken = (process.env.TURSO_AUTH_TOKEN || '').replace(/\s+/g, '');
const turso = createClient(authToken ? { url, authToken } : { url });

// Print the connection target (host only, no token) so we know which
// DB we're inspecting without leaking the URL itself.
try {
  const u = new URL(url);
  console.log(`Connected to: ${u.host}\n`);
} catch {
  console.log(`Connected to: (could not parse URL)\n`);
}

const clients = await turso.execute('SELECT id, name, slug FROM clients ORDER BY name');
console.log(`Clients (${clients.rows.length}):`);
for (const r of clients.rows) console.log(`  ${r[1]}  (id=${r[0]}, slug=${r[2]})`);

const uploads = await turso.execute(
  'SELECT id, client_id, original_name, detected_format, month, row_count, processed_at, error, created_at FROM csv_uploads ORDER BY created_at DESC LIMIT 30'
);
console.log(`\nLast ${uploads.rows.length} uploads (newest first):`);
for (const r of uploads.rows) {
  const id = r[0];
  const clientId = r[1];
  const name = r[2];
  const fmt = r[3];
  const month = r[4];
  const rowCount = r[5];
  const err = r[7];
  const created = r[8];
  const errChip = err ? ` ERROR/SUPERSEDED:${String(err).slice(0, 40)}` : '';
  console.log(`  ${created}  client=${clientId}  ${month}  ${fmt}  rows=${rowCount}  ${name}${errChip}`);
}
