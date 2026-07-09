// Seed the Raised Bar engagement (client + signers).
//
// Auto-provisions on app cold start so the admin doesn't have to walk
// through /portal/admin/clients and /portal/admin/users manually. Pure
// data seed — no Brevo email is sent from a migration; invites are sent
// when the admin clicks the button on /portal/admin/proposals/raised-bar.
//
// Idempotent: each insert is gated on a SELECT, so re-running this
// migration (or running it on an instance that already has the rows) is
// a no-op. Safe across instance scaling.

import turso from '../turso';
import { nanoid } from 'nanoid';
import type { Migration } from '../migrate';

const CLIENT_SLUG = 'raised-bar-group';
const CLIENT_NAME = 'Raised Bar Group';
const SIGNERS = [
  { name: 'Jason Roth', email: 'jasonroth1122@gmail.com' },
  { name: 'Kevin Adams', email: 'kevo.adams@gmail.com' },
];

const migration: Migration = {
  id: '014-seed-raised-bar',
  async up() {
    // 1) Resolve or create the Raised Bar Group client.
    let clientId: string;
    const existing = await turso.execute({
      sql: 'SELECT id FROM clients WHERE slug = ?',
      args: [CLIENT_SLUG],
    });
    if (existing.rows.length > 0) {
      clientId = existing.rows[0][0] as string;
    } else {
      clientId = nanoid();
      await turso.execute({
        sql: 'INSERT INTO clients (id, name, slug, active) VALUES (?, ?, ?, 1)',
        args: [clientId, CLIENT_NAME, CLIENT_SLUG],
      });
    }

    // 2) Resolve or create each signer user, attached to that client.
    for (const signer of SIGNERS) {
      const lookup = await turso.execute({
        sql: 'SELECT id FROM users WHERE email = ?',
        args: [signer.email.toLowerCase().trim()],
      });
      if (lookup.rows.length > 0) continue;

      const userId = nanoid();
      await turso.execute({
        sql: 'INSERT INTO users (id, email, name, role, client_id) VALUES (?, ?, ?, ?, ?)',
        args: [userId, signer.email.toLowerCase().trim(), signer.name, 'client', clientId],
      });
    }
  },
};

export default migration;
