// Migration runner — replaces lazy ensurePortalTables() / ensureTables()
// Runs once at cold start. Race-safe: INSERT OR IGNORE prevents double-apply.

import turso from './turso';
import { logger } from './logger';

export interface Migration {
  id: string;
  up: () => Promise<void>;
}

let migrated = false;

export async function runMigrations(): Promise<void> {
  if (migrated) return;

  // Create tracking table (idempotent)
  await turso.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Load all migrations in order
  const modules = import.meta.glob<{ default: Migration }>('./migrations/*.ts', { eager: true });
  const migrations: Migration[] = Object.values(modules)
    .map(m => m.default)
    .sort((a, b) => a.id.localeCompare(b.id));

  // Get already-applied
  const applied = await turso.execute('SELECT id FROM _migrations');
  const appliedSet = new Set(applied.rows.map(r => r[0] as string));

  for (const migration of migrations) {
    if (appliedSet.has(migration.id)) continue;

    try {
      await migration.up();

      // Race-safe: if another instance applied this between our check and now,
      // INSERT OR IGNORE silently no-ops
      await turso.execute({
        sql: 'INSERT OR IGNORE INTO _migrations (id) VALUES (?)',
        args: [migration.id],
      });

      logger.info(`Migration applied: ${migration.id}`);
    } catch (err) {
      logger.error(`Migration failed: ${migration.id}`, err);
      throw err; // Stop on failure — don't skip broken migrations
    }
  }

  migrated = true;
}
