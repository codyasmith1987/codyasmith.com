// Approvals and change orders
// Approvals: client sign-off on milestones/deliverables
// Change orders: scope/cost modifications to a contract

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '008-approvals-change-orders',
  async up() {
    await turso.batch([
      // Approvals — client-facing sign-off requests
      `CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL REFERENCES contracts(id),
        milestone_id TEXT REFERENCES milestones(id),
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        requested_by TEXT NOT NULL REFERENCES users(id),
        responded_by TEXT REFERENCES users(id),
        requested_at TEXT DEFAULT (datetime('now')),
        responded_at TEXT,
        response_note TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,

      // Change orders — modifications to contract scope or cost
      `CREATE TABLE IF NOT EXISTS change_orders (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL REFERENCES contracts(id),
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        cost_impact REAL NOT NULL DEFAULT 0,
        time_impact_days INTEGER NOT NULL DEFAULT 0,
        requested_by TEXT NOT NULL REFERENCES users(id),
        approved_by TEXT REFERENCES users(id),
        approved_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,

      // Indexes
      'CREATE INDEX IF NOT EXISTS idx_approvals_contract ON approvals(contract_id)',
      'CREATE INDEX IF NOT EXISTS idx_approvals_milestone ON approvals(milestone_id)',
      'CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status)',
      'CREATE INDEX IF NOT EXISTS idx_change_orders_contract ON change_orders(contract_id)',
      'CREATE INDEX IF NOT EXISTS idx_change_orders_status ON change_orders(status)',
    ], 'write');
  },
};

export default migration;
