// Seed the standard-v6 contract template into the contract_templates table.
//
// (Renamed from 053-seed-standard-v6 to 054 so it sorts after the committed
// 053-issued-reports-and-update-requests migration. The runner keys on the
// full id string, so the old name was not a functional collision, but two
// files sharing the "053" prefix was a readability hazard.)
//
// v6 (client-jargon + pricing + IP pass, 2026-05-31) changes from v5:
//   - Section 3.1: drops the internal "ecosystem (A/B/C)" label for
//     plain "size band" language by navigable page count; additional-site
//     discount eighty percent (80%) -> ninety percent (90%); pooled hours
//     stated as the full sum per site (no hours discount); adds that the
//     Schedule A band assignment controls. Removes a stray internal HTML
//     comment that leaked an audit file path.
//   - Section 3.2 (Marketing Consulting): softened the brand-continuity
//     line; replaced the stale strategy-call / deep-advisory examples with
//     the bounded model (phone access, scheduled call, research advisories
//     "if any", portal reporting + monthly report where included, operations
//     consulting where included); the scope cap now explicitly covers access
//     and calls; points to the new section 10.4 for research ownership.
//   - Section 5.1: "ecosystem placements" -> "site size bands".
//   - Section 10.2: Marketing Consulting research carved OUT of Client-owned
//     Final Deliverables.
//   - NEW Section 10.4: Marketing Consulting research, its analysis, and the
//     methods behind it are Practice IP; the Client gets a license to use a
//     delivered output, never ownership; this section controls over 10.2.
//
// The 90% additional-site factor and full pooled hours here match the
// canonical product_driven_v1 pricing path (MULTI_SITE_DISCOUNT = 0.90 in
// products/web-management.ts), so a generated contract's prose agrees with
// its Schedule A numbers. The legacy raised_bar_v1 formula is deprecated and
// no live proposal uses it.
//
// Per the append-only template rule (same reason v4/v5 were new versions),
// this is a new version, not an edit of v5: agreements already signed
// against v5 keep their hash baseline. New agreements pick the latest via
// getLatestContractTemplate('standard'), so they get v6 automatically.
//
// Like 021/051/052, the markdown source is bundled at build time via Vite's
// ?raw query and the hash is computed over the raw source.

import { createHash } from 'node:crypto';
import turso from '../turso';
import type { Migration } from '../migrate';

import templateBody from '../../contracts/templates/standard-v6.md?raw';

const SLUG = 'standard';
const VERSION = 6;
const TITLE = 'Standard Client Services Agreement';

const migration: Migration = {
  id: '054-seed-standard-v6',
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
