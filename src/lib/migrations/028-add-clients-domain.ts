// Add domain column to clients. Lets the Gemini-assisted research
// endpoint scope Serper queries to the client's actual site, and
// future Schedule A site rows pull domain values directly off the
// client row.

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '028-add-clients-domain',
  async up() {
    try {
      await turso.execute('ALTER TABLE clients ADD COLUMN domain TEXT');
    } catch {
      // Column already exists — expected on re-run
    }
  },
};

export default migration;
