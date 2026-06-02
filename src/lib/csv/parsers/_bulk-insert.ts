import turso from '../../turso';

// One network round-trip per BATCH_CHUNK statements via turso.batch (Turso is
// a REMOTE libsql DB). Replaces the old Promise.all(chunk.map(execute)) which
// did one round-trip PER ROW — a 2,118-row export was ~43 round-trips and
// 524'd at the Cloudflare edge. turso.batch sends many statements atomically
// in a single request (same pattern as crawl-overview.ts and migration 001).
// The `db` param defaults to the prod singleton; tests inject an in-memory client.
export const BATCH_CHUNK = 100;

export async function bulkInsert(
  sql: string,
  allArgs: any[][],
  db: typeof turso = turso,
): Promise<void> {
  if (allArgs.length === 0) return;
  const statements = allArgs.map(args => ({ sql, args }));
  for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
    await db.batch(statements.slice(i, i + BATCH_CHUNK), 'write');
  }
}
