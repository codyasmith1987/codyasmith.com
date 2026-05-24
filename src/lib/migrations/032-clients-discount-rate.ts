// Add discount_rate to clients. Per-client percentage discount that
// flows through every portal pricing surface (proposal builder
// pricing, Schedule A line items, future invoice generation).
//
// Stored as a decimal: 0.10 = 10% off. Default 0 means no discount.
// Range expected 0..1; the pricing layer clamps anything out of band.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '032-clients-discount-rate',
  async up() {
    try {
      await turso.execute('ALTER TABLE clients ADD COLUMN discount_rate REAL NOT NULL DEFAULT 0');
    } catch {
      // Column already exists; expected on re-run.
    }
  },
};

export default migration;
