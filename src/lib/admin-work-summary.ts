// Admin work summary — three-bucket triage from the existing queue.
//
// Pure function. No DB queries, no side effects. Operates entirely
// on the AdminQueue that loadAdminQueue() already produces.
//
// Buckets:
//   actNow   — Cody must act on these
//   waiting   — ball is in someone else's court
//   upcoming  — awareness items coming in the next few weeks
//
// locked_periods is intentionally omitted — informational, not actionable.

import type { AdminQueue } from './admin-queue';

export interface WorkItem {
  label: string;         // always-plural noun: "failed jobs", "blockers"
  detail: string | null; // top row's what · where when count=1
  anchor: string;        // #section_key for scroll link
  count: number;         // total underlying rows
}

export interface WorkSummary {
  actNow: WorkItem[];
  waiting: WorkItem[];
  upcoming: WorkItem[];
}

// --- Section → bucket mapping ---

interface Mapping {
  bucket: 'actNow' | 'waiting' | 'upcoming';
  severity: number;
  label: string;
}

const SECTION_MAP: Record<string, Mapping> = {
  failed_jobs:             { bucket: 'actNow',   severity: 0,  label: 'failed jobs' },
  failed_imports:          { bucket: 'actNow',   severity: 1,  label: 'failed imports' },
  stale_pending:           { bucket: 'actNow',   severity: 2,  label: 'stuck imports' },
  late:                    { bucket: 'actNow',   severity: 3,  label: 'late invoices' },
  overdue_milestones:      { bucket: 'actNow',   severity: 4,  label: 'overdue milestones' },
  unbilled_needs_approval: { bucket: 'actNow',   severity: 5,  label: 'expenses need approval' },
  unbilled_manual_review:  { bucket: 'actNow',   severity: 6,  label: 'expenses need review' },
  drafts:                  { bucket: 'actNow',   severity: 7,  label: 'draft invoices' },
  expired:                 { bucket: 'actNow',   severity: 8,  label: 'expired contracts' },
  missing_automation:      { bucket: 'actNow',   severity: 9,  label: 'missing automation' },
  google_sync_attention:   { bucket: 'actNow',   severity: 10, label: 'Google sources unhealthy' },
  csv_source_attention:    { bucket: 'actNow',   severity: 11, label: 'CSV sources unhealthy' },
  missing_billing_contact: { bucket: 'actNow',   severity: 12, label: 'contracts with no reminder route' },
  pending_approvals:       { bucket: 'waiting',  severity: 0,  label: 'pending approvals' },
  due_soon:                { bucket: 'waiting',  severity: 1,  label: 'invoices due soon' },
  upcoming_milestones:     { bucket: 'upcoming', severity: 0,  label: 'milestones coming up' },
  expiring:                { bucket: 'upcoming', severity: 1,  label: 'contracts expiring' },
  unbilled_auto_bill:      { bucket: 'upcoming', severity: 2,  label: 'auto-bill expenses queued' },
};

// Exported for test coverage verification only.
export const MAPPED_SECTION_KEYS = Object.keys(SECTION_MAP);

export function buildWorkSummary(queue: AdminQueue): WorkSummary {
  type Ranked = WorkItem & { _sev: number };

  const bins: Record<'actNow' | 'waiting' | 'upcoming', Ranked[]> = {
    actNow: [],
    waiting: [],
    upcoming: [],
  };

  // Hard blockers → act now (highest priority)
  const hard = queue.blockers.filter((b) => b.severity === 'hard');
  if (hard.length > 0) {
    bins.actNow.push({
      label: 'blockers',
      detail: hard.length === 1 ? hard[0].title : null,
      anchor: '#blockers',
      count: hard.length,
      _sev: -1,
    });
  }

  // Soft blockers → waiting
  const soft = queue.blockers.filter((b) => b.severity === 'soft');
  if (soft.length > 0) {
    bins.waiting.push({
      label: 'known limitations',
      detail: soft.length === 1 ? soft[0].title : null,
      anchor: '#blockers',
      count: soft.length,
      _sev: 2,
    });
  }

  // Sections → buckets
  for (const section of queue.sections) {
    if (section.count === 0) continue;
    const m = SECTION_MAP[section.key];
    if (!m) continue;

    const top = section.rows[0];
    bins[m.bucket].push({
      label: m.label,
      detail: section.count === 1 && top ? `${top.what} · ${top.where}` : null,
      anchor: `#${section.key}`,
      count: section.count,
      _sev: m.severity,
    });
  }

  // Sort by severity, strip internal field
  const strip = (items: Ranked[]): WorkItem[] => {
    items.sort((a, b) => a._sev - b._sev);
    return items.map(({ _sev, ...rest }) => rest);
  };

  return {
    actNow: strip(bins.actNow),
    waiting: strip(bins.waiting),
    upcoming: strip(bins.upcoming),
  };
}
