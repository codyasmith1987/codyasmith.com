// Seed the standard-v4 contract template into the contract_templates table.
//
// v4 corrects section 3.3 build payment from 50% at signing / 50% at
// launch to 100% at signing (Cody's decision, 2026-05-28), so the
// contract body agrees with the pricing engine and Schedule A's new
// "Amount due at signing" block, which bill the full build at signing.
//
// Like migration 021, the markdown source is bundled at build time via
// Vite's ?raw query and the hash is computed over the raw source. v3
// stays seeded and immutable; agreements created before this deploy keep
// pointing at v3. New agreements pick the latest version via
// getLatestContractTemplate('standard'), so they get v4 automatically.

import { createHash } from 'node:crypto';
import turso from '../turso';
import type { Migration } from '../migrate';

import templateBody from '../../contracts/templates/standard-v4.md?raw';

const SLUG = 'standard';
const VERSION = 4;
const TITLE = 'Standard Client Services Agreement';

const migration: Migration = {
  id: '051-seed-standard-v4',
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
