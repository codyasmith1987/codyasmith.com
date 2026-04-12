// Add permissions column to users for granular access control

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '005-extend-roles',
  async up() {
    try {
      await turso.execute('ALTER TABLE users ADD COLUMN permissions TEXT');
    } catch {
      // Column already exists — expected on re-run
    }
  },
};

export default migration;
