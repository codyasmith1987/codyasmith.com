// Add missing indexes for query performance on portal tables

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '002-add-indexes',
  async up() {
    await turso.batch([
      'CREATE INDEX IF NOT EXISTS idx_metrics_client_month ON metrics(client_id, month)',
      'CREATE INDEX IF NOT EXISTS idx_metrics_client_month_cat ON metrics(client_id, month, category)',
      'CREATE INDEX IF NOT EXISTS idx_keywords_client_month ON keyword_rankings(client_id, month)',
      'CREATE INDEX IF NOT EXISTS idx_keywords_client_source ON keyword_rankings(client_id, month, source)',
      'CREATE INDEX IF NOT EXISTS idx_issues_client_month ON site_issues(client_id, month)',
      'CREATE INDEX IF NOT EXISTS idx_files_client_month ON files(client_id, month)',
      'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)',
      'CREATE INDEX IF NOT EXISTS idx_csv_uploads_client ON csv_uploads(client_id, month)',
      'CREATE INDEX IF NOT EXISTS idx_magic_links_token ON magic_links(token_hash)',
    ], 'write');
  },
};

export default migration;
