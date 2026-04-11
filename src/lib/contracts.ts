// Contracts, projects, milestones, tasks, and task artifacts — CRUD helpers

import { nanoid } from 'nanoid';
import turso from './turso';

// --- Column allowlists for dynamic UPDATE builders ---
// Runtime guard against SQL column injection. TypeScript types disappear at runtime;
// these allowlists enforce valid column names regardless of caller.

const UPDATABLE_COLUMNS: Record<string, Set<string>> = {
  contracts: new Set(['title', 'description', 'status', 'type', 'total_value', 'start_date', 'end_date', 'signed_at']),
  projects: new Set(['title', 'description', 'status', 'sort_order', 'client_visible']),
  milestones: new Set(['title', 'description', 'status', 'due_date', 'completed_at', 'sort_order', 'client_visible', 'client_update_text']),
  tasks: new Set(['title', 'description', 'status', 'priority', 'assigned_to', 'estimated_hours', 'actual_hours', 'due_date', 'completed_at', 'sort_order', 'client_visible', 'client_update_text']),
};

function buildSafeUpdate(table: string, id: string, data: Record<string, any>): { sql: string; args: any[] } | null {
  const allowed = UPDATABLE_COLUMNS[table];
  if (!allowed) throw new Error(`No allowlist defined for table: ${table}`);
  const fields: string[] = [];
  const args: any[] = [];
  for (const [key, val] of Object.entries(data)) {
    if (val === undefined) continue;
    if (!allowed.has(key)) throw new Error(`Invalid column "${key}" for table "${table}"`);
    fields.push(`${key} = ?`);
    args.push(val);
  }
  if (fields.length === 0) return null;
  fields.push("updated_at = datetime('now')");
  args.push(id);
  return { sql: `UPDATE ${table} SET ${fields.join(', ')} WHERE id = ?`, args };
}

// --- Query helpers (same pattern as db.ts) ---

async function queryOne(sql: string, args: any[] = []): Promise<any | undefined> {
  const result = await turso.execute({ sql, args });
  if (result.rows.length === 0) return undefined;
  return Object.fromEntries(result.columns.map((col, i) => [col, result.rows[0][i]]));
}

async function queryAll(sql: string, args: any[] = []): Promise<any[]> {
  const result = await turso.execute({ sql, args });
  return result.rows.map(row =>
    Object.fromEntries(result.columns.map((col, i) => [col, row[i]]))
  );
}

// ============================================================
// Contracts
// ============================================================

export type ContractStatus = 'draft' | 'sent' | 'active' | 'completed' | 'cancelled';
export type ContractType = 'fixed' | 'retainer' | 'hourly';

export interface Contract {
  id: string;
  client_id: string;
  title: string;
  description: string | null;
  status: ContractStatus;
  type: ContractType;
  total_value: number | null;
  start_date: string | null;
  end_date: string | null;
  signed_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export async function createContract(data: {
  client_id: string;
  title: string;
  description?: string;
  type?: ContractType;
  total_value?: number;
  start_date?: string;
  end_date?: string;
  created_by: string;
}): Promise<string> {
  const id = nanoid();
  await turso.execute({
    sql: `INSERT INTO contracts (id, client_id, title, description, type, total_value, start_date, end_date, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, data.client_id, data.title, data.description ?? null,
      data.type ?? 'fixed', data.total_value ?? null,
      data.start_date ?? null, data.end_date ?? null, data.created_by,
    ],
  });
  return id;
}

export async function getContract(id: string): Promise<Contract | undefined> {
  return queryOne('SELECT * FROM contracts WHERE id = ?', [id]);
}

export async function getContractsByClient(clientId: string): Promise<Contract[]> {
  return queryAll('SELECT * FROM contracts WHERE client_id = ? ORDER BY created_at DESC', [clientId]);
}

export async function getContractsByStatus(status: ContractStatus): Promise<Contract[]> {
  return queryAll('SELECT * FROM contracts WHERE status = ? ORDER BY updated_at DESC', [status]);
}

export async function getAllContracts(): Promise<Contract[]> {
  return queryAll('SELECT * FROM contracts ORDER BY updated_at DESC');
}

export async function updateContract(id: string, data: Partial<Pick<Contract,
  'title' | 'description' | 'status' | 'type' | 'total_value' | 'start_date' | 'end_date' | 'signed_at'
>>): Promise<void> {
  const update = buildSafeUpdate('contracts', id, data);
  if (!update) return;
  await turso.execute(update);
}

// Cascade delete: removes all projects, milestones, tasks, and artifacts under this contract.
// Call only after confirming the user intends to delete the entire contract tree.
export async function deleteContract(id: string): Promise<void> {
  // Get all projects under this contract
  const projects = await getProjectsByContract(id);
  for (const project of projects) {
    await deleteProject(project.id);
  }
  await turso.execute({ sql: 'DELETE FROM contracts WHERE id = ?', args: [id] });
}

// ============================================================
// Projects
// ============================================================

export type ProjectStatus = 'not_started' | 'in_progress' | 'on_hold' | 'completed' | 'cancelled';

export interface Project {
  id: string;
  contract_id: string;
  client_id: string;
  title: string;
  description: string | null;
  status: ProjectStatus;
  sort_order: number;
  client_visible: number;
  created_at: string;
  updated_at: string;
}

export async function createProject(data: {
  contract_id: string;
  client_id: string;
  title: string;
  description?: string;
  client_visible?: boolean;
}): Promise<string> {
  const id = nanoid();
  await turso.execute({
    sql: `INSERT INTO projects (id, contract_id, client_id, title, description, client_visible)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      id, data.contract_id, data.client_id, data.title,
      data.description ?? null, data.client_visible === false ? 0 : 1,
    ],
  });
  return id;
}

export async function getProject(id: string): Promise<Project | undefined> {
  return queryOne('SELECT * FROM projects WHERE id = ?', [id]);
}

export async function getProjectsByContract(contractId: string): Promise<Project[]> {
  return queryAll('SELECT * FROM projects WHERE contract_id = ? ORDER BY sort_order, created_at', [contractId]);
}

export async function getProjectsByClient(clientId: string): Promise<Project[]> {
  return queryAll('SELECT * FROM projects WHERE client_id = ? ORDER BY sort_order, created_at', [clientId]);
}

// Client-safe: excludes sort_order, contract_id (admin context)
export async function getClientVisibleProjects(clientId: string): Promise<Pick<Project, 'id' | 'title' | 'description' | 'status' | 'created_at' | 'updated_at'>[]> {
  return queryAll(
    'SELECT id, title, description, status, created_at, updated_at FROM projects WHERE client_id = ? AND client_visible = 1 ORDER BY sort_order, created_at',
    [clientId]
  );
}

export async function updateProject(id: string, data: Partial<Pick<Project,
  'title' | 'description' | 'status' | 'sort_order' | 'client_visible'
>>): Promise<void> {
  const update = buildSafeUpdate('projects', id, data);
  if (!update) return;
  await turso.execute(update);
}

// Cascade delete: removes all milestones, tasks, and artifacts under this project.
export async function deleteProject(id: string): Promise<void> {
  const milestones = await getMilestonesByProject(id);
  for (const ms of milestones) {
    await deleteMilestone(ms.id);
  }
  await turso.execute({ sql: 'DELETE FROM projects WHERE id = ?', args: [id] });
}

// ============================================================
// Milestones
// ============================================================

export type MilestoneStatus = 'not_started' | 'in_progress' | 'completed';

export interface Milestone {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: MilestoneStatus;
  due_date: string | null;
  completed_at: string | null;
  sort_order: number;
  client_visible: number;
  client_update_text: string | null;
  created_at: string;
  updated_at: string;
}

export async function createMilestone(data: {
  project_id: string;
  title: string;
  description?: string;
  due_date?: string;
  client_visible?: boolean;
  client_update_text?: string;
}): Promise<string> {
  const id = nanoid();
  await turso.execute({
    sql: `INSERT INTO milestones (id, project_id, title, description, due_date, client_visible, client_update_text)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, data.project_id, data.title, data.description ?? null,
      data.due_date ?? null, data.client_visible === false ? 0 : 1,
      data.client_update_text ?? null,
    ],
  });
  return id;
}

export async function getMilestone(id: string): Promise<Milestone | undefined> {
  return queryOne('SELECT * FROM milestones WHERE id = ?', [id]);
}

export async function getMilestonesByProject(projectId: string): Promise<Milestone[]> {
  return queryAll('SELECT * FROM milestones WHERE project_id = ? ORDER BY sort_order, created_at', [projectId]);
}

// Client-safe: excludes sort_order, internal description kept (client needs context), adds client_update_text
export async function getClientVisibleMilestones(projectId: string): Promise<Pick<Milestone, 'id' | 'title' | 'description' | 'status' | 'due_date' | 'completed_at' | 'client_update_text'>[]> {
  return queryAll(
    'SELECT id, title, description, status, due_date, completed_at, client_update_text FROM milestones WHERE project_id = ? AND client_visible = 1 ORDER BY sort_order, created_at',
    [projectId]
  );
}

export async function updateMilestone(id: string, data: Partial<Pick<Milestone,
  'title' | 'description' | 'status' | 'due_date' | 'completed_at' | 'sort_order' | 'client_visible' | 'client_update_text'
>>): Promise<void> {
  const update = buildSafeUpdate('milestones', id, data);
  if (!update) return;
  await turso.execute(update);
}

// Cascade delete: removes all tasks and artifacts under this milestone.
export async function deleteMilestone(id: string): Promise<void> {
  const tasks = await getTasksByMilestone(id);
  for (const task of tasks) {
    await deleteTask(task.id);
  }
  await turso.execute({ sql: 'DELETE FROM milestones WHERE id = ?', args: [id] });
}

// ============================================================
// Tasks
// ============================================================

export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done' | 'blocked';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface Task {
  id: string;
  milestone_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigned_to: string | null;
  estimated_hours: number | null;
  actual_hours: number | null;
  due_date: string | null;
  completed_at: string | null;
  sort_order: number;
  client_visible: number;
  client_update_text: string | null;
  created_at: string;
  updated_at: string;
}

export async function createTask(data: {
  milestone_id: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  assigned_to?: string;
  estimated_hours?: number;
  due_date?: string;
  client_visible?: boolean;
  client_update_text?: string;
}): Promise<string> {
  const id = nanoid();
  await turso.execute({
    sql: `INSERT INTO tasks (id, milestone_id, title, description, priority, assigned_to, estimated_hours, due_date, client_visible, client_update_text)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, data.milestone_id, data.title, data.description ?? null,
      data.priority ?? 'normal', data.assigned_to ?? null,
      data.estimated_hours ?? null, data.due_date ?? null,
      data.client_visible ? 1 : 0, data.client_update_text ?? null,
    ],
  });
  return id;
}

export async function getTask(id: string): Promise<Task | undefined> {
  return queryOne('SELECT * FROM tasks WHERE id = ?', [id]);
}

export async function getTasksByMilestone(milestoneId: string): Promise<Task[]> {
  return queryAll('SELECT * FROM tasks WHERE milestone_id = ? ORDER BY sort_order, created_at', [milestoneId]);
}

export async function getTasksByAssignee(userId: string): Promise<Task[]> {
  return queryAll(
    "SELECT * FROM tasks WHERE assigned_to = ? AND status != 'done' ORDER BY priority DESC, due_date",
    [userId]
  );
}

// Client-safe: excludes estimated_hours, actual_hours, assigned_to, priority, sort_order, internal description
export async function getClientVisibleTasks(milestoneId: string): Promise<Pick<Task, 'id' | 'title' | 'status' | 'client_update_text'>[]> {
  return queryAll(
    'SELECT id, title, status, client_update_text FROM tasks WHERE milestone_id = ? AND client_visible = 1 ORDER BY sort_order, created_at',
    [milestoneId]
  );
}

export async function updateTask(id: string, data: Partial<Pick<Task,
  'title' | 'description' | 'status' | 'priority' | 'assigned_to' | 'estimated_hours' | 'actual_hours' |
  'due_date' | 'completed_at' | 'sort_order' | 'client_visible' | 'client_update_text'
>>): Promise<void> {
  const update = buildSafeUpdate('tasks', id, data);
  if (!update) return;
  await turso.execute(update);
}

// Cascade delete: removes all artifacts under this task.
export async function deleteTask(id: string): Promise<void> {
  await turso.execute({ sql: 'DELETE FROM task_artifacts WHERE task_id = ?', args: [id] });
  await turso.execute({ sql: 'DELETE FROM tasks WHERE id = ?', args: [id] });
}

// ============================================================
// Task Artifacts
// ============================================================

export type ArtifactType = 'file' | 'link' | 'screenshot';

export interface TaskArtifact {
  id: string;
  task_id: string;
  file_id: string | null;
  label: string;
  artifact_type: ArtifactType;
  url: string | null;
  client_visible: number;
  created_at: string;
}

export async function createTaskArtifact(data: {
  task_id: string;
  label: string;
  artifact_type?: ArtifactType;
  file_id?: string;
  url?: string;
  client_visible?: boolean;
}): Promise<string> {
  const id = nanoid();
  await turso.execute({
    sql: `INSERT INTO task_artifacts (id, task_id, file_id, label, artifact_type, url, client_visible)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, data.task_id, data.file_id ?? null, data.label,
      data.artifact_type ?? 'file', data.url ?? null,
      data.client_visible ? 1 : 0,
    ],
  });
  return id;
}

export async function getArtifactsByTask(taskId: string): Promise<TaskArtifact[]> {
  return queryAll('SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY created_at', [taskId]);
}

// Client-safe: excludes file_id (internal reference)
export async function getClientVisibleArtifacts(taskId: string): Promise<Pick<TaskArtifact, 'id' | 'label' | 'artifact_type' | 'url' | 'created_at'>[]> {
  return queryAll(
    'SELECT id, label, artifact_type, url, created_at FROM task_artifacts WHERE task_id = ? AND client_visible = 1 ORDER BY created_at',
    [taskId]
  );
}

export async function deleteTaskArtifact(id: string): Promise<void> {
  await turso.execute({ sql: 'DELETE FROM task_artifacts WHERE id = ?', args: [id] });
}
