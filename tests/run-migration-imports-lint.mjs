#!/usr/bin/env node
// Lint: migrations may only import from a verified-safe allowlist.
//
// A migration is an IMMUTABLE SNAPSHOT. It must touch only the schema that
// existed at its own point in the chain. Importing a live application helper
// couples the migration to code whose column lists drift over time, so adding
// a column later retroactively breaks a fresh-DB replay of the OLD migration.
//
// This actually happened: 025-seed-cody-test imported upsertClientMetadata from
// ../agreements, whose CLIENT_METADATA_COLS later gained billing_cc_email
// (migration 067). On a fresh DB, 025 runs long before 067, so the seed INSERT
// failed with "table client_metadata has no column named billing_cc_email" and
// `npm run build` (which runs migrations via middleware while prerendering)
// died. Existing DBs were fine because 025 was already applied and never
// re-runs. See docs/BUGFIX-LOG.md.
//
// The allowlist below is intentionally tiny. To add to it, the import must be
// either (a) immutable (static raw template content, a node builtin, the DB
// client, the Migration type) or (b) verified to replay cleanly on a fresh DB
// against only prior-migration schema. NEVER allow a schema-bearing data helper
// (agreements, invoices, clients, billing, ...). Inline the SQL instead.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MIGRATIONS_DIR = join(ROOT, 'src/lib/migrations');

// Exact-match specifiers a migration is allowed to import from.
const ALLOWED = new Set([
  '../turso',                        // the DB client
  '../migrate',                      // Migration type only
  'nanoid',                          // id generation
  '@libsql/client',                  // types
  // Verified-safe app imports (static constant / pure logic over prior-migration
  // schema; both confirmed to replay cleanly on a fresh DB). Grandfathered.
  '../proposal-configs/raised-bar',  // static config blob, serialized to one JSON column
  '../csv/coverage-signals',         // pure recompute over data_coverage (migration 056)
]);

// Pattern-allowed specifiers.
function specAllowed(spec) {
  if (spec.endsWith('?raw')) return true;       // static template file content
  if (spec.startsWith('node:')) return true;    // node builtins
  return ALLOWED.has(spec);
}

const IMPORT_RE = /import\s+(?:type\s+)?(?:[^'"`]*?\sfrom\s+)?['"]([^'"]+)['"]/g;

function run() {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.ts')).sort();
  const violations = [];

  for (const file of files) {
    const src = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const spec = m[1];
      if (!specAllowed(spec)) {
        violations.push(`${file}: imports '${spec}'`);
      }
    }
  }

  if (violations.length === 0) {
    console.log(`[PASS] all ${files.length} migrations import only from the safe allowlist`);
    console.log('\n1/1 passed');
    return;
  }

  console.log(`[FAIL] migration(s) import non-allowlisted modules (${violations.length}):`);
  for (const v of violations) console.log('  ' + v);
  console.log('\nMigrations must be self-contained snapshots. Inline the SQL with the');
  console.log('columns that existed at this migration\'s point in the chain, or, if the');
  console.log('import is genuinely immutable/verified-safe, add it to ALLOWED with a note.');
  console.log('\n0/1 passed');
  process.exit(1);
}

run();
