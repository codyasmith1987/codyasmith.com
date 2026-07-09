// Contract template registry.
//
// The markdown source of truth lives in the repo at
// src/contracts/templates/{slug}.md. Migration 021 (and any future
// template-bumping migration) snapshots a version into this table so
// historical signed agreements render identically even if the repo file
// is later edited. Render at view/sign time reads only from DB rows.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '020-contract-templates',
  async up() {
    await turso.execute(`
      CREATE TABLE IF NOT EXISTS contract_templates (
        slug TEXT NOT NULL,
        version INTEGER NOT NULL,
        title TEXT NOT NULL,
        body_markdown TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (slug, version)
      )
    `);

    await turso.execute(`CREATE INDEX IF NOT EXISTS idx_contract_templates_slug ON contract_templates(slug, version DESC)`);
  },
};

export default migration;
