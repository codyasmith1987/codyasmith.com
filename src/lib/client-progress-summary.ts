// Slice 25 — client-facing milestone progress summary.
//
// Three-bucket read surface for the dashboard: what's being worked
// on right now, what just finished, what's coming up next. Reads
// the existing milestones table populated by Slice 11 at contract
// provisioning. No new storage, no new writes, no new admin
// endpoints, no new job types.
//
// Client_visible respects are hard:
//
//   - `milestones.client_visible = 1`
//   - parent `projects.client_visible = 1`
//   - parent `contracts.status = 'active'`
//
// Milestones on completed/cancelled contracts are not "coming up"
// because the work is done/stopped. Internal-only rows never leak.
//
// Sentence-building rules:
//
//   inProgress: one active milestone, lowest sort_order wins.
//     Copy = client_update_text when non-empty, else title.
//     Sentence = "Working on {copy}".
//   justFinished: most recently completed (status='completed',
//     completed_at IS NOT NULL) within JUST_FINISHED_WINDOW_DAYS.
//     Copy = client_update_text when non-empty, else title.
//     Sentence = "Just finished {copy}".
//   comingUp: next not_started milestone, earliest due_date first
//     (NULLS LAST), tiebreak by lowest sort_order.
//     Copy = client_update_text when non-empty, else title.
//     Sentence = "Coming up: {copy}".
//
// Empty state (no active contract, no client_visible milestones,
// or only on_hold/cancelled rows) returns `{ hasAny: false }` —
// the dashboard renders nothing, no fake "nothing to report"
// placeholder. Matches the zero-fake-placeholder rule used by
// the narrator's `generateNowVerdict` and the traffic card.
//
// Optional `contractId` scopes the lookup to one contract. When
// omitted the builder surveys every active contract under the
// client.

import turso from './turso';

export const JUST_FINISHED_WINDOW_DAYS = 30;

export interface ProgressSummary {
  inProgress?: string;
  justFinished?: string;
  comingUp?: string;
  hasAny: boolean;
}

interface MilestoneRow {
  id: string;
  title: string;
  client_update_text: string | null;
  status: string;
  due_date: string | null;
  completed_at: string | null;
  sort_order: number;
}

function copyFor(row: MilestoneRow): string {
  const t = (row.client_update_text ?? '').trim();
  return t.length > 0 ? t : row.title;
}

async function loadInProgress(
  clientId: string,
  contractId?: string
): Promise<MilestoneRow | null> {
  const sql = `SELECT m.id, m.title, m.client_update_text, m.status,
                      m.due_date, m.completed_at, m.sort_order
               FROM milestones m
               JOIN projects p ON p.id = m.project_id
               JOIN contracts co ON co.id = p.contract_id
               WHERE co.client_id = ?
                 AND co.status = 'active'
                 AND p.client_visible = 1
                 AND m.client_visible = 1
                 AND m.status = 'in_progress'
                 ${contractId ? 'AND co.id = ?' : ''}
               ORDER BY m.sort_order ASC, m.id ASC
               LIMIT 1`;
  const args: any[] = contractId ? [clientId, contractId] : [clientId];
  const r = await turso.execute({ sql, args });
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    id: String(row[0]),
    title: String(row[1]),
    client_update_text: (row[2] as string | null) ?? null,
    status: String(row[3]),
    due_date: (row[4] as string | null) ?? null,
    completed_at: (row[5] as string | null) ?? null,
    sort_order: Number(row[6]),
  };
}

async function loadJustFinished(
  clientId: string,
  contractId?: string
): Promise<MilestoneRow | null> {
  const sql = `SELECT m.id, m.title, m.client_update_text, m.status,
                      m.due_date, m.completed_at, m.sort_order
               FROM milestones m
               JOIN projects p ON p.id = m.project_id
               JOIN contracts co ON co.id = p.contract_id
               WHERE co.client_id = ?
                 AND co.status = 'active'
                 AND p.client_visible = 1
                 AND m.client_visible = 1
                 AND m.status = 'completed'
                 AND m.completed_at IS NOT NULL
                 AND m.completed_at >= datetime('now', '-' || ? || ' days')
                 ${contractId ? 'AND co.id = ?' : ''}
               ORDER BY m.completed_at DESC
               LIMIT 1`;
  const args: any[] = contractId
    ? [clientId, JUST_FINISHED_WINDOW_DAYS, contractId]
    : [clientId, JUST_FINISHED_WINDOW_DAYS];
  const r = await turso.execute({ sql, args });
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    id: String(row[0]),
    title: String(row[1]),
    client_update_text: (row[2] as string | null) ?? null,
    status: String(row[3]),
    due_date: (row[4] as string | null) ?? null,
    completed_at: (row[5] as string | null) ?? null,
    sort_order: Number(row[6]),
  };
}

async function loadComingUp(
  clientId: string,
  contractId?: string
): Promise<MilestoneRow | null> {
  // ORDER BY due_date ASC NULLS LAST isn't portable via libSQL — express
  // it as a two-key sort where the null-indicator flips NULLs to the end.
  const sql = `SELECT m.id, m.title, m.client_update_text, m.status,
                      m.due_date, m.completed_at, m.sort_order
               FROM milestones m
               JOIN projects p ON p.id = m.project_id
               JOIN contracts co ON co.id = p.contract_id
               WHERE co.client_id = ?
                 AND co.status = 'active'
                 AND p.client_visible = 1
                 AND m.client_visible = 1
                 AND m.status = 'not_started'
                 ${contractId ? 'AND co.id = ?' : ''}
               ORDER BY CASE WHEN m.due_date IS NULL THEN 1 ELSE 0 END ASC,
                        m.due_date ASC,
                        m.sort_order ASC,
                        m.id ASC
               LIMIT 1`;
  const args: any[] = contractId ? [clientId, contractId] : [clientId];
  const r = await turso.execute({ sql, args });
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    id: String(row[0]),
    title: String(row[1]),
    client_update_text: (row[2] as string | null) ?? null,
    status: String(row[3]),
    due_date: (row[4] as string | null) ?? null,
    completed_at: (row[5] as string | null) ?? null,
    sort_order: Number(row[6]),
  };
}

export async function buildProgressSummary(
  clientId: string,
  contractId?: string
): Promise<ProgressSummary> {
  const [ip, jf, cu] = await Promise.all([
    loadInProgress(clientId, contractId),
    loadJustFinished(clientId, contractId),
    loadComingUp(clientId, contractId),
  ]);

  const summary: ProgressSummary = { hasAny: false };
  if (ip) {
    summary.inProgress = `Working on ${copyFor(ip)}`;
    summary.hasAny = true;
  }
  if (jf) {
    summary.justFinished = `Just finished ${copyFor(jf)}`;
    summary.hasAny = true;
  }
  if (cu) {
    summary.comingUp = `Coming up: ${copyFor(cu)}`;
    summary.hasAny = true;
  }
  return summary;
}
