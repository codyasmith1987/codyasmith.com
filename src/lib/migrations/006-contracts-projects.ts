// Contracts, projects, milestones, tasks, and task artifacts
// Core delivery spine: Client → Contract → Project → Milestone → Task → Artifact

import turso from '../turso';
import type { Migration } from '../migrate';

const migration: Migration = {
  id: '006-contracts-projects',
  async up() {
    await turso.batch([
      // Contracts — the top-level agreement with a client
      `CREATE TABLE IF NOT EXISTS contracts (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL REFERENCES clients(id),
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        type TEXT NOT NULL DEFAULT 'fixed',
        total_value REAL,
        start_date TEXT,
        end_date TEXT,
        signed_at TEXT,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,

      // Projects — a deliverable scope within a contract
      `CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        contract_id TEXT NOT NULL REFERENCES contracts(id),
        client_id TEXT NOT NULL REFERENCES clients(id),
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'not_started',
        sort_order INTEGER NOT NULL DEFAULT 0,
        client_visible INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,

      // Milestones — checkpoints within a project, visible to client
      `CREATE TABLE IF NOT EXISTS milestones (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'not_started',
        due_date TEXT,
        completed_at TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        client_visible INTEGER NOT NULL DEFAULT 1,
        client_update_text TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,

      // Tasks — internal work items under a milestone
      `CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        milestone_id TEXT NOT NULL REFERENCES milestones(id),
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'todo',
        priority TEXT NOT NULL DEFAULT 'normal',
        assigned_to TEXT REFERENCES users(id),
        estimated_hours REAL,
        actual_hours REAL,
        due_date TEXT,
        completed_at TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        client_visible INTEGER NOT NULL DEFAULT 0,
        client_update_text TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,

      // Task artifacts — files/deliverables attached to tasks
      `CREATE TABLE IF NOT EXISTS task_artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        file_id TEXT REFERENCES files(id),
        label TEXT NOT NULL,
        artifact_type TEXT NOT NULL DEFAULT 'file',
        url TEXT,
        client_visible INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )`,

      // Indexes for common queries
      'CREATE INDEX IF NOT EXISTS idx_contracts_client ON contracts(client_id)',
      'CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status)',
      'CREATE INDEX IF NOT EXISTS idx_projects_contract ON projects(contract_id)',
      'CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id)',
      'CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones(project_id)',
      'CREATE INDEX IF NOT EXISTS idx_tasks_milestone ON tasks(milestone_id)',
      'CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to)',
      'CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)',
      'CREATE INDEX IF NOT EXISTS idx_artifacts_task ON task_artifacts(task_id)',
    ], 'write');
  },
};

export default migration;
