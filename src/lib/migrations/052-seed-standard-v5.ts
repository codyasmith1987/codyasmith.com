// Seed the standard-v5 contract template into the contract_templates table.
//
// v5 is identical to v4 except it removes two stray markup lines
// (</content> and </invoke>) that were accidentally saved into the v4
// source and printed as literal garbage at the end of every executed
// contract PDF and the on-screen render. Per the append-only template
// rule (the same reason v4 was a new version, not an edit of v3), the
// fix is a new version rather than an in-place edit: agreements already
// signed against v4 keep their hash baseline intact. New agreements pick
// the latest version via getLatestContractTemplate('standard'), so they
// get the clean v5 automatically.
//
// Like migrations 021 and 051, the markdown source is bundled at build
// time via Vite's ?raw query and the hash is computed over the raw source.

import { createHash } from 'node:crypto';
import turso from '../turso';
import type { Migration } from '../migrate';

import templateBody from '../../contracts/templates/standard-v5.md?raw';

const SLUG = 'standard';
const VERSION = 5;
const TITLE = 'Standard Client Services Agreement';

const migration: Migration = {
  id: '052-seed-standard-v5',
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
