// Seed the standard-v3 contract template into the contract_templates table.
//
// Bundles the markdown source from the repo at build time via Vite's
// ?raw query. The hash is computed deterministically over the raw
// markdown source. Idempotent on (slug, version) so re-running this
// migration is safe. A future version bump (slug stays "standard",
// version goes to 2) is a new migration that inserts another row;
// existing agreements continue to point at version 1.

import { createHash } from 'node:crypto';
import turso from '../turso';
import type { Migration } from '../migrate';

// Bundle the markdown source into the build. Vite's ?raw query yields
// the file contents as a string. Importing this way keeps the migration
// self-contained and works on DigitalOcean App Platform without a runtime
// filesystem lookup.
import templateBody from '../../contracts/templates/standard-v3.md?raw';

const SLUG = 'standard';
const VERSION = 3; // The v3 master client services agreement.
const TITLE = 'Standard Client Services Agreement';

const migration: Migration = {
  id: '021-seed-standard-v3',
  async up() {
    const bodyHash = createHash('sha256').update(templateBody).digest('hex');

    await turso.execute({
      sql: `INSERT OR IGNORE INTO contract_templates
              (slug, version, title, body_markdown, body_hash)
            VALUES (?, ?, ?, ?, ?)`,
      args: [SLUG, VERSION, TITLE, templateBody, bodyHash],
    });
  },
};

export default migration;
