// Per-site monthly + onboarding overrides.
//
// Use cases:
//   - Pro-bono: a charity site at $0 monthly, $0 onboarding.
//   - Grandfathered: a legacy client (ZKH model) where the per-site
//     dollar amount is the truth, not a discount off retail.
//   - Per-site sweetheart deals carved out from the standard formula.
//
// Semantics:
//   - NULL = use the formula (multi-site 0.80 multiplier + ecosystem
//     routing apply as normal).
//   - Any non-null value (including 0) = use that exact amount as the
//     site's per-site contribution. The 0.80 multi-site multiplier is
//     skipped for that site because the override IS the price.
//   - Client-level discount_rate still applies uniformly per existing
//     pricing pipeline behavior; clients with grandfathered overrides
//     should leave discount_rate at 0.
//
// No migration of existing data. Existing sites get NULL overrides,
// preserving current behavior.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '047-site-pricing-overrides',
  async up() {
    try {
      await turso.execute(`
        ALTER TABLE client_sites ADD COLUMN monthly_override REAL
      `);
    } catch (err: any) {
      if (!/duplicate column/i.test(String(err?.message || ''))) throw err;
    }
    try {
      await turso.execute(`
        ALTER TABLE client_sites ADD COLUMN onboarding_override REAL
      `);
    } catch (err: any) {
      if (!/duplicate column/i.test(String(err?.message || ''))) throw err;
    }
  },
};

export default migration;
