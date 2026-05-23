// Contract template loader.
//
// Reads from the contract_templates table (seeded by migrations 021,
// and future template-bump migrations). Templates are immutable per
// (slug, version) so agreements that pin a specific version render
// identically forever. The repo file at src/contracts/templates/{slug}.md
// is the source of truth for new versions; the DB is the immutable
// historical record.

import turso from './turso';

export interface ContractTemplate {
  slug: string;
  version: number;
  title: string;
  body_markdown: string;
  body_hash: string;
  created_at: string;
}

export async function getContractTemplate(slug: string, version: number): Promise<ContractTemplate | null> {
  const result = await turso.execute({
    sql: `SELECT slug, version, title, body_markdown, body_hash, created_at
            FROM contract_templates
           WHERE slug = ? AND version = ?
           LIMIT 1`,
    args: [slug, version],
  });
  const row = result.rows[0];
  if (!row) return null;
  return {
    slug: row[0] as string,
    version: row[1] as number,
    title: row[2] as string,
    body_markdown: row[3] as string,
    body_hash: row[4] as string,
    created_at: row[5] as string,
  };
}

export async function getLatestContractTemplate(slug: string): Promise<ContractTemplate | null> {
  const result = await turso.execute({
    sql: `SELECT slug, version, title, body_markdown, body_hash, created_at
            FROM contract_templates
           WHERE slug = ?
           ORDER BY version DESC
           LIMIT 1`,
    args: [slug],
  });
  const row = result.rows[0];
  if (!row) return null;
  return {
    slug: row[0] as string,
    version: row[1] as number,
    title: row[2] as string,
    body_markdown: row[3] as string,
    body_hash: row[4] as string,
    created_at: row[5] as string,
  };
}
