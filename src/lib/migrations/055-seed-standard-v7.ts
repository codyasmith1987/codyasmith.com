// Seed the standard-v7 contract template into the contract_templates table.
//
// v7 (billing-teeth + hardening pass, 2026-06-04) changes from v6, grounded in
// the overdue/proration/suspension issues surfaced in practice and in Utah-law
// research (docs/contract-v6-hardening-2026-06-04.md + docs/utah-contract-law-
// research-2026-06-04.md):
//   - 2 + 5.3: products still priced separately but may appear on ONE
//     consolidated, itemized invoice (puts the consolidated-invoice billing
//     model on-contract); each invoice carries a unique number; each recurring
//     line states its own service period.
//   - 3.1: multi-site re-banding when a site grows past its band; clean site
//     removal (recalc pool + per-site pricing; one site != a "product").
//   - 4: pause escape-hatch closed (only a current account may pause; a pause
//     does not toll the 5.8 clock or prorate the period).
//   - 5.6: the $15/site plugin fee relabeled as a Practice fee in Schedule A,
//     not an at-cost third-party pass-through.
//   - 5.8: interest stated as 1.5%/mo (18%/yr) accruing from the invoice date
//     (Utah Code 15-1-1: no commercial usury cap); suspension expressly
//     authorizes letting the site/server go offline / ceasing to fund hosting
//     on >30-day non-payment + 10-day notice & cure, with good-faith /
//     preserve-data / no-irreversible-acts guardrails (the gross-negligence
//     carve-out in 12 cannot be disclaimed, so the protection is behavioral);
//     resumption requires past-due + interest + collection costs + a $250/
//     product resumption fee.
//   - 17.2: non-payment terminable for cause at >30 days + 10-day notice;
//     suspension and termination are independent, cumulative, non-tolling
//     remedies (Utah favors this, Helf v. Chevron 2015 UT 81); no double
//     recovery for the same unpaid amount.
//   - 17.3: NO-PRORATION / whole-month-earned-for-reserved-capacity clause
//     (Utah does not apply heightened penalty scrutiny, Comcast of Utah 2012
//     UT 49); cross-referenced from 4 and 17.1. Credential handover REWRITTEN:
//     the Practice never withholds/alters the Client's own accounts/credentials/
//     domains (avoids conversion, Fibro Trust 1999 UT 13); it may only DEFER
//     its own offboarding deliverables until paid current.
//   - 21: force majeure no longer excuses prospectively-billed recurring fees.
//
// The credential reframe (17.3) is the one clause the research flagged as
// genuinely unsettled in Utah; the conservative rewrite here is the safe path
// and may still benefit from an attorney spot-check.
//
// Per the append-only template rule, this is a new version, not an edit of v6:
// agreements signed against v6 keep their hash baseline. New agreements pick
// the latest via getLatestContractTemplate('standard'), so they get v7.
//
// Like 021/051/052/054, the markdown source is bundled at build time via Vite's
// ?raw query and the hash is computed over the raw source.

import { createHash } from 'node:crypto';
import turso from '../turso';
import type { Migration } from '../migrate';

import templateBody from '../../contracts/templates/standard-v7.md?raw';

const SLUG = 'standard';
const VERSION = 7;
const TITLE = 'Standard Client Services Agreement';

const migration: Migration = {
  id: '055-seed-standard-v7',
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
