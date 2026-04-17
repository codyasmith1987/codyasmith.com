// Admin work queue aggregator.
//
// One function, one structured result. Every signal is a real query
// against live state. No cached, inferred, or decorative rows. The
// dashboard renders exactly what this returns.
//
// Ordering matters: sections are returned ordered by consequence, not
// aesthetics. Render order reflects execution order.

import turso from './turso';
import { getLockedPeriods } from './periods';
import { loadGoogleSyncAttentionSection } from './jobs/google-sync-health';
import { loadCsvSourceAttentionSection } from './jobs/csv-source-health';
import { loadMissingBillingContactSection } from './jobs/billing-contact-health';

// --- Types ---

export interface QueueRowAction {
  label: string;
  method: 'POST' | 'DELETE';
  url: string;
  confirm?: string;
}

export interface QueueRow {
  id: string;
  what: string;
  where: string;          // client / contract context
  why: string;            // why this needs attention
  action: string;         // what to do next
  link?: string;          // optional deep link
  meta?: string;          // optional small suffix (amount, date, etc)
  quickActions?: QueueRowAction[]; // optional inline buttons that mutate state
}

export interface QueueSection {
  key: string;
  label: string;
  count: number;
  rows: QueueRow[];
}

export interface Blocker {
  key: string;
  severity: 'hard' | 'soft';
  title: string;
  detail: string;
  action: string;
}

export interface AdminQueue {
  generatedAt: string;
  sections: QueueSection[];
  blockers: Blocker[];
  counts: Record<string, number>;
}

// --- Helper ---

async function all(sql: string, args: any[] = []): Promise<any[][]> {
  const r = await turso.execute({ sql, args });
  return r.rows.map((row) => Array.from(row));
}

function fmtMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function daysFromToday(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  const msPerDay = 86400000;
  const a = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const b = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((a - b) / msPerDay);
}

// --- Main ---

export async function loadAdminQueue(): Promise<AdminQueue> {
  // 1. Failed scheduled jobs — automation is broken
  const failedJobsRows = await all(
    `SELECT id, job_type, scheduled_for, last_run_at, last_result, payload_json
     FROM scheduled_jobs
     WHERE status = 'failed'
     ORDER BY COALESCE(last_run_at, scheduled_for) DESC
     LIMIT 20`
  );
  const failedJobs: QueueSection = {
    key: 'failed_jobs',
    label: 'Failed scheduled jobs',
    count: failedJobsRows.length,
    rows: failedJobsRows.map((r) => {
      let contractHint = '';
      try {
        const p = r[5] ? JSON.parse(r[5]) : null;
        if (p?.contract_id) contractHint = `contract ${String(p.contract_id).slice(0, 8)}`;
      } catch {}
      return {
        id: String(r[0]),
        what: `${r[1]} job failed`,
        where: contractHint || 'no contract bound',
        why: String(r[4] ?? 'no error message'),
        action: 'inspect the error and re-enqueue or fix root cause',
      };
    }),
  };

  // 2. Failed imports — data ingestion broken
  const failedImportsRows = await all(
    `SELECT i.id, i.source, i.original_name, i.error, i.started_at, c.name
     FROM imports i
     JOIN clients c ON c.id = i.client_id
     WHERE i.status = 'failed'
     ORDER BY i.started_at DESC
     LIMIT 20`
  );
  const failedImports: QueueSection = {
    key: 'failed_imports',
    label: 'Failed imports',
    count: failedImportsRows.length,
    rows: failedImportsRows.map((r) => ({
      id: String(r[0]),
      what: `${r[2]}`,
      where: `${r[5]} · ${r[1]}`,
      why: String(r[3] ?? 'unknown error'),
      action: 'open the CSV, confirm format, re-upload with a corrected file',
      link: '/portal/admin/csv',
    })),
  };

  // 3. Stale pending imports — a crash left a content_hash poisoned
  const stalePendingRows = await all(
    `SELECT i.id, i.source, i.original_name, i.started_at, c.name
     FROM imports i
     JOIN clients c ON c.id = i.client_id
     WHERE i.status = 'pending'
       AND i.started_at < datetime('now', '-10 minutes')
     ORDER BY i.started_at`
  );
  const stalePending: QueueSection = {
    key: 'stale_pending',
    label: 'Stale pending imports',
    count: stalePendingRows.length,
    rows: stalePendingRows.map((r) => ({
      id: String(r[0]),
      what: `${r[2]}`,
      where: `${r[4]} · ${r[1]}`,
      why: `pending since ${r[3]} — an earlier ingestion crashed mid-write`,
      action: 'manually mark this import failed so the same file can be re-uploaded',
    })),
  };

  // 4. Late invoices — money we are owed and haven't chased
  const lateRows = await all(
    `SELECT i.id, i.invoice_number, i.total, i.amount_paid, i.due_date, c.name, co.title
     FROM invoices i
     JOIN clients c ON c.id = i.client_id
     JOIN contracts co ON co.id = i.contract_id
     WHERE i.status = 'sent'
       AND i.due_date < date('now')
       AND i.amount_paid < i.total
     ORDER BY i.due_date ASC`
  );
  const lateInvoices: QueueSection = {
    key: 'late',
    label: 'Late invoices',
    count: lateRows.length,
    rows: lateRows.map((r) => {
      const total = Number(r[2]);
      const paid = Number(r[3]);
      const outstanding = total - paid;
      const overdueBy = Math.abs(daysFromToday(String(r[4])) ?? 0);
      return {
        id: String(r[0]),
        what: `${r[1]} late ${overdueBy}d`,
        where: `${r[5]} · ${r[6]}`,
        why: `${fmtMoney(outstanding)} outstanding, was due ${r[4]}`,
        action: 'chase payment directly, or mark paid if already received outside the system',
        link: `/portal/admin/invoices`,
        meta: fmtMoney(outstanding),
      };
    }),
  };

  // 5. Due-soon invoices — next 7 days, still unpaid
  const dueSoonRows = await all(
    `SELECT i.id, i.invoice_number, i.total, i.amount_paid, i.due_date, c.name, co.title
     FROM invoices i
     JOIN clients c ON c.id = i.client_id
     JOIN contracts co ON co.id = i.contract_id
     WHERE i.status = 'sent'
       AND i.due_date BETWEEN date('now') AND date('now', '+7 days')
       AND i.amount_paid < i.total
     ORDER BY i.due_date ASC`
  );
  const dueSoon: QueueSection = {
    key: 'due_soon',
    label: 'Due soon (7 days)',
    count: dueSoonRows.length,
    rows: dueSoonRows.map((r) => {
      const total = Number(r[2]);
      const paid = Number(r[3]);
      const outstanding = total - paid;
      const inDays = daysFromToday(String(r[4])) ?? 0;
      return {
        id: String(r[0]),
        what: `${r[1]} due in ${inDays}d`,
        where: `${r[5]} · ${r[6]}`,
        why: `${fmtMoney(outstanding)} due ${r[4]}`,
        action: 'confirm the client has received it; reminder will fire if configured',
        link: `/portal/admin/invoices`,
        meta: fmtMoney(outstanding),
      };
    }),
  };

  // 6. Draft invoices awaiting review
  // Excludes null-period drafts (phantoms from old non-transactional code).
  // After the Phase 1 cleanup these should not exist at all, but the
  // filter is defensive — if one ever reappears, it's a bug not a task.
  const draftRows = await all(
    `SELECT i.id, i.invoice_number, i.total, i.billing_period_start, i.billing_period_end,
            i.created_at, c.name, co.title
     FROM invoices i
     JOIN clients c ON c.id = i.client_id
     JOIN contracts co ON co.id = i.contract_id
     WHERE i.status = 'draft'
       AND i.billing_period_start IS NOT NULL
     ORDER BY i.created_at DESC`
  );
  const drafts: QueueSection = {
    key: 'drafts',
    label: 'Draft invoices awaiting review',
    count: draftRows.length,
    rows: draftRows.map((r) => ({
      id: String(r[0]),
      what: `${r[1]}`,
      where: `${r[6]} · ${r[7]}`,
      why: `${fmtMoney(Number(r[2]))} covering ${r[3]} → ${r[4]}; not sent yet so no reminders fire`,
      action: 'review, then mark sent so billing workflow continues',
      link: `/portal/admin/invoices`,
      meta: fmtMoney(Number(r[2])),
      quickActions: [
        {
          label: 'mark sent',
          method: 'POST',
          url: `/portal/api/admin/invoices/${r[0]}/mark-sent`,
          confirm: `Mark ${r[1]} as sent? This triggers the client notification and starts the reminder clock.`,
        },
      ],
    })),
  };

  // 7. Unbilled expenses — split by classification so Slice 10's
  // commercial truth drives the queue. A needs_approval expense
  // blocks Cody's calendar; an auto_bill expense is just awareness.
  // manual_review is the "uncategorized" catch-all that still
  // requires a decision before billing picks it up.
  const unbilledRows = await all(
    `SELECT pc.id, pc.description, pc.amount, pc.created_at, co.title, c.name,
            pc.classification, pc.category, pc.needs_approval
     FROM pending_charges pc
     JOIN contracts co ON co.id = pc.contract_id
     JOIN clients c ON c.id = co.client_id
     WHERE pc.billed_invoice_id IS NULL
     ORDER BY pc.created_at DESC`
  );
  type UnbilledBuckets = {
    needs_approval: any[][];
    manual_review: any[][];
    auto_bill: any[][];
    unknown: any[][];
  };
  const buckets: UnbilledBuckets = {
    needs_approval: [],
    manual_review: [],
    auto_bill: [],
    unknown: [],
  };
  for (const r of unbilledRows) {
    const cls = String(r[6] ?? '');
    if (cls === 'needs_approval' || Number(r[8]) === 1) buckets.needs_approval.push(r);
    else if (cls === 'manual_review') buckets.manual_review.push(r);
    else if (cls === 'auto_bill') buckets.auto_bill.push(r);
    else buckets.unknown.push(r);
  }

  function unbilledRow(r: any[], defaultWhy: string): QueueRow {
    const categoryTag = r[7] ? ` [${r[7]}]` : '';
    return {
      id: String(r[0]),
      what: `${String(r[1])}${categoryTag}`,
      where: `${r[5]} · ${r[4]}`,
      why: defaultWhy,
      action: '',
      link: '/portal/admin/expenses',
      meta: fmtMoney(Number(r[2])),
    };
  }

  const unbilledNeedsApproval: QueueSection = {
    key: 'unbilled_needs_approval',
    label: 'Expenses needing approval',
    count: buckets.needs_approval.length,
    rows: buckets.needs_approval.map((r) => ({
      ...unbilledRow(r, `${fmtMoney(Number(r[2]))} classified needs_approval at entry — will NOT auto-attach`),
      action: 'review, then either approve into the next invoice or reject outright',
      quickActions: [
        {
          label: 'approve',
          method: 'POST',
          url: `/portal/api/admin/expenses/${r[0]}/approve`,
          confirm: `Approve expense "${r[1]}" for ${fmtMoney(Number(r[2]))}? This reclassifies it as auto_bill so the next invoice run attaches it.`,
        },
        {
          label: 'reject',
          method: 'DELETE',
          url: `/portal/api/admin/expenses/${r[0]}`,
          confirm: `Reject expense "${r[1]}" for ${fmtMoney(Number(r[2]))}? The pending charge will be deleted outright. Re-enter the expense if you change your mind.`,
        },
      ],
    })),
  };
  const unbilledManualReview: QueueSection = {
    key: 'unbilled_manual_review',
    label: 'Expenses awaiting decision',
    count: buckets.manual_review.length,
    rows: buckets.manual_review.map((r) => ({
      ...unbilledRow(r, `${fmtMoney(Number(r[2]))} classified manual_review (uncategorized or category not in rule)`),
      action: 'decide: assign a category, approve for next invoice, or reject',
    })),
  };
  const unbilledAutoBill: QueueSection = {
    key: 'unbilled_auto_bill',
    label: 'Auto-billable expenses',
    count: buckets.auto_bill.length + buckets.unknown.length,
    rows: [...buckets.auto_bill, ...buckets.unknown].map((r) => {
      const cls = String(r[6] ?? 'legacy');
      return {
        ...unbilledRow(
          r,
          `${fmtMoney(Number(r[2]))} will auto-attach to the next invoice (classification=${cls})`
        ),
        action: 'no action — leave it for the next billing run, or pin manually to an open draft',
      };
    }),
  };

  // 7b. Overdue milestones — delivery has slipped.
  // A milestone with a due_date in the past and status != 'completed'
  // represents real delivery drift. Joins up to contract.status =
  // 'active' so cancelled/completed contracts don't drag in noise.
  const overdueMsRows = await all(
    `SELECT m.id, m.title, m.due_date, m.status, p.title, co.title, cl.name
     FROM milestones m
     JOIN projects p ON p.id = m.project_id
     JOIN contracts co ON co.id = p.contract_id
     JOIN clients cl ON cl.id = co.client_id
     WHERE m.status != 'completed'
       AND m.due_date IS NOT NULL
       AND m.due_date < date('now')
       AND co.status = 'active'
     ORDER BY m.due_date ASC`
  );
  const overdueMilestones: QueueSection = {
    key: 'overdue_milestones',
    label: 'Overdue milestones',
    count: overdueMsRows.length,
    rows: overdueMsRows.map((r) => {
      const daysOver = Math.abs(daysFromToday(String(r[2])) ?? 0);
      return {
        id: String(r[0]),
        what: `${r[1]} (${r[3]})`,
        where: `${r[6]} · ${r[5]} · ${r[4]}`,
        why: `due ${r[2]} — overdue by ${daysOver}d`,
        action: 'advance the milestone, re-estimate due date, or mark blocked',
        link: '/portal/admin/contracts',
      };
    }),
  };

  // 7c. Upcoming milestones (14 days) — awareness, not blocker.
  const upcomingMsRows = await all(
    `SELECT m.id, m.title, m.due_date, m.status, p.title, co.title, cl.name
     FROM milestones m
     JOIN projects p ON p.id = m.project_id
     JOIN contracts co ON co.id = p.contract_id
     JOIN clients cl ON cl.id = co.client_id
     WHERE m.status != 'completed'
       AND m.due_date IS NOT NULL
       AND m.due_date BETWEEN date('now') AND date('now', '+14 days')
       AND co.status = 'active'
     ORDER BY m.due_date ASC`
  );
  const upcomingMilestones: QueueSection = {
    key: 'upcoming_milestones',
    label: 'Upcoming milestones (14 days)',
    count: upcomingMsRows.length,
    rows: upcomingMsRows.map((r) => {
      const inDays = daysFromToday(String(r[2])) ?? 0;
      return {
        id: String(r[0]),
        what: `${r[1]} (${r[3]})`,
        where: `${r[6]} · ${r[5]} · ${r[4]}`,
        why: `due ${r[2]} — ${inDays}d from now`,
        action: 'check progress and confirm the due date is realistic',
        link: '/portal/admin/contracts',
      };
    }),
  };

  // 8. Expiring contracts — renewal decision coming up
  const expiringRows = await all(
    `SELECT id, client_id, title, end_date
     FROM contracts
     WHERE status = 'active'
       AND end_date IS NOT NULL
       AND end_date BETWEEN date('now') AND date('now', '+30 days')
     ORDER BY end_date ASC`
  );
  // Join client names separately to keep the SQL simple.
  const clientNameById = new Map<string, string>();
  if (expiringRows.length > 0) {
    const rows = await all(
      `SELECT id, name FROM clients WHERE id IN (` +
        expiringRows.map(() => '?').join(',') +
        ')',
      expiringRows.map((r) => r[1])
    );
    for (const r of rows) clientNameById.set(String(r[0]), String(r[1]));
  }
  const expiring: QueueSection = {
    key: 'expiring',
    label: 'Contracts ending soon (30 days)',
    count: expiringRows.length,
    rows: expiringRows.map((r) => {
      const inDays = daysFromToday(String(r[3])) ?? 0;
      return {
        id: String(r[0]),
        what: `${r[2]}`,
        where: clientNameById.get(String(r[1])) ?? 'unknown client',
        why: `ends in ${inDays}d on ${r[3]}`,
        action: 'talk to the client about renewing, extending, or closing',
        link: '/portal/admin/contracts',
      };
    }),
  };

  // 8b. Expired but still active — end_date is in the past and nobody
  // has renewed, extended, or cancelled. Real commercial risk: billing
  // automation will keep charging if a scheduled job is still queued.
  const expiredRows = await all(
    `SELECT c.id, c.title, cl.name, c.end_date, c.billing_cadence, c.recurring_amount
     FROM contracts c
     JOIN clients cl ON cl.id = c.client_id
     WHERE c.status = 'active'
       AND c.end_date IS NOT NULL
       AND c.end_date < date('now')
     ORDER BY c.end_date ASC`
  );
  const expired: QueueSection = {
    key: 'expired',
    label: 'Expired but still active',
    count: expiredRows.length,
    rows: expiredRows.map((r) => {
      const daysOver = Math.abs(daysFromToday(String(r[3])) ?? 0);
      const billingNote =
        r[4] === 'monthly' && r[5]
          ? ` · still billing ${fmtMoney(Number(r[5]))}/month`
          : '';
      return {
        id: String(r[0]),
        what: String(r[1]),
        where: String(r[2]),
        why: `ended ${daysOver}d ago on ${r[3]}${billingNote}`,
        action: 'renew, extend, or mark cancelled — automation keeps running while status stays active',
        link: '/portal/admin/contracts',
      };
    }),
  };

  // 9. Pending approvals — client is waiting on a decision.
  // Joined against the contacts table to flag approvals where the
  // client has no 'approval'-role contact seeded — those approvals
  // cannot be nudged through a known channel and should surface as
  // a data-hygiene warning.
  const pendingApprovalsRows = await all(
    `SELECT a.id, a.title, a.contract_id, co.title AS contract_title, c.name, c.id AS client_id
     FROM approvals a
     JOIN contracts co ON co.id = a.contract_id
     JOIN clients c ON c.id = co.client_id
     WHERE a.status = 'pending'
     ORDER BY a.created_at DESC`
  );
  // Batch-lookup approval-role contact counts per client to avoid N+1.
  const uniqueClientIds = Array.from(
    new Set(pendingApprovalsRows.map((r) => String(r[5])))
  );
  const approvalContactCounts = new Map<string, number>();
  if (uniqueClientIds.length > 0) {
    const placeholders = uniqueClientIds.map(() => '?').join(',');
    const countRows = await all(
      `SELECT client_id, COUNT(*) FROM contacts
       WHERE client_id IN (${placeholders})
         AND active = 1
         AND roles_json LIKE '%"approval"%'
       GROUP BY client_id`,
      uniqueClientIds
    );
    for (const r of countRows) {
      approvalContactCounts.set(String(r[0]), Number(r[1]));
    }
  }
  const pendingApprovals: QueueSection = {
    key: 'pending_approvals',
    label: 'Pending approvals',
    count: pendingApprovalsRows.length,
    rows: pendingApprovalsRows.map((r) => {
      const clientId = String(r[5]);
      const approverCount = approvalContactCounts.get(clientId) ?? 0;
      const missingApprover = approverCount === 0;
      return {
        id: String(r[0]),
        what: String(r[1]),
        where: `${r[4]} · ${r[3]}`,
        why: missingApprover
          ? 'awaiting client sign-off — no approval-role contact seeded for this client'
          : 'awaiting client sign-off',
        action: missingApprover
          ? 'seed an approval-role contact on this client, then nudge them'
          : 'nudge the client or convert to a change order',
        link: '/portal/admin/approvals',
      };
    }),
  };

  // 10. Contracts missing automation — silent-failure canary
  // An active monthly contract with no pending/running generate_invoices
  // job means automation is about to silently stop for that contract.
  const missingAutoRows = await all(
    `SELECT c.id, c.title, cl.name, c.billing_day
     FROM contracts c
     JOIN clients cl ON cl.id = c.client_id
     WHERE c.status = 'active'
       AND c.billing_cadence = 'monthly'
       AND c.billing_day IS NOT NULL
       AND c.recurring_amount IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM scheduled_jobs sj
         WHERE sj.job_type = 'generate_invoices'
           AND sj.status IN ('pending', 'running')
           AND sj.payload_json LIKE '%"contract_id":"' || c.id || '"%'
       )`
  );
  const missingAuto: QueueSection = {
    key: 'missing_automation',
    label: 'Contracts missing automation',
    count: missingAutoRows.length,
    rows: missingAutoRows.map((r) => ({
      id: String(r[0]),
      what: String(r[1]),
      where: String(r[2]),
      why: `no pending generate_invoices job — automation has stopped for this contract`,
      action: 'enqueue a generate_invoices job manually or investigate why re-enqueue did not fire',
      link: '/portal/admin/contracts',
    })),
  };

  // 11. Google data sources needing attention (Slice 18f) —
  // surfaces misconfigured, never-synced, stale, or failed-halted
  // gsc/ga4 bindings so Cody has one place to see what needs
  // action. Healthy bindings (active pending/running sync job OR
  // within the freshness window) do not surface. Rules and the
  // stale threshold live in src/lib/jobs/google-sync-health.ts.
  const googleSyncAttention = await loadGoogleSyncAttentionSection();

  // 12. CSV data sources needing attention (Slice 18g) —
  // surfaces enabled non-Google CSV bindings whose most recent
  // import failed, whose upload has never happened, or whose
  // latest applied import is older than the stale threshold.
  // Only the three Ubersuggest kinds that actually have parsers
  // + heartbeat paths in this repo. Rules and threshold live in
  // src/lib/jobs/csv-source-health.ts.
  const csvSourceAttention = await loadCsvSourceAttentionSection();

  // 13. Contracts with no reminder route (Slice 23) — surfaces
  // active recurring contracts where the 3-layer
  // resolveReminderRecipients fallback produces an empty array.
  // Slice 22 made the reminder sweep self-perpetuating; this
  // closes the silent-failure hole where the chain runs forever
  // but can never reach a recipient. Rules live in
  // src/lib/jobs/billing-contact-health.ts.
  const missingBillingContact = await loadMissingBillingContactSection();

  // 14. Locked periods (Slice 16) — spine-integrity signal.
  // Every month Cody has frozen surfaces here with an unlock quick
  // action. No count alarm, no red — locked is a feature, not a
  // failure. The row exists so admins see at a glance which months
  // cannot currently be re-ingested.
  const lockedPeriods = await getLockedPeriods();
  const lockedPeriodsSection: QueueSection = {
    key: 'locked_periods',
    label: 'Locked periods',
    count: lockedPeriods.length,
    rows: lockedPeriods.map((p) => ({
      id: p.id,
      what: `${p.period_start} → ${p.period_end}`,
      where: p.client_name,
      why: `frozen at ${p.locked_at} — ingestion is blocked for this period`,
      action: 'leave locked to protect reported state, or unlock explicitly to allow corrections',
      link: '/portal/admin/contracts',
      quickActions: [
        {
          label: 'unlock',
          method: 'POST',
          url: `/portal/api/admin/periods/${p.id}/unlock`,
          confirm: `Unlock ${p.period_start}? Any subsequent CSV upload for this month will be able to rewrite the snapshots.`,
        },
      ],
    })),
  };

  // --- Blockers (honest debt, always visible) ---
  const blockers: Blocker[] = [];

  // Dynamic: is external cron actually hitting the runner?
  // Heuristic: any pending job whose scheduled_for is more than 60 minutes
  // in the past implies the runner has not been called recently enough to
  // drain the queue. Zero such rows is still not proof the cron is wired —
  // it could just mean nothing is due. So we always surface the static
  // blocker note below too.
  const overdueJobsRes = await turso.execute(
    `SELECT COUNT(*) FROM scheduled_jobs
     WHERE status = 'pending' AND scheduled_for < datetime('now', '-60 minutes')`
  );
  const overdueJobsCount = Number(overdueJobsRes.rows[0][0]);
  if (overdueJobsCount > 0) {
    blockers.push({
      key: 'cron_stuck',
      severity: 'hard',
      title: `${overdueJobsCount} scheduled job(s) overdue by more than an hour`,
      detail:
        'Pending jobs exist whose scheduled_for is over 60 minutes in the past. The runner has not been hit recently.',
      action:
        'hit POST /portal/api/jobs/run manually, or confirm the external cron is calling it on schedule',
    });
  }

  // Static blockers — always shown until code proves them resolved.
  blockers.push({
    key: 'cron_not_wired',
    severity: 'hard',
    title: 'External cron for /portal/api/jobs/run is not wired',
    detail:
      'The scheduled_jobs runner only fires when something hits POST /portal/api/jobs/run with x-jobs-secret. No external scheduler has been confirmed in prod.',
    action:
      'point an hourly cron (cron-job.org, UptimeRobot, Cloudflare cron, etc.) at the endpoint with the JOBS_RUNNER_SECRET header',
  });

  blockers.push({
    key: 'reminders_require_sent',
    severity: 'soft',
    title: 'Reminders only fire for invoices in status sent',
    detail:
      'generateInvoiceForContract always writes status=draft. sendDueReminders queries status=sent. Until drafts are manually promoted, no reminder emails ever go out.',
    action:
      'either review and mark drafts as sent manually each cycle, or add a trusted auto-promote rule once the loop has run for one full cycle',
  });

  // Stale-pending sweep: the handler exists and self-perpetuates. It is
  // considered operational only if a pending OR running cleanup_stale_imports
  // job is actually queued. If the chain ever breaks (handler crash, manual
  // delete, etc.) this flips to a hard blocker.
  const sweepQueued = await turso.execute(
    `SELECT COUNT(*) FROM scheduled_jobs
     WHERE job_type = 'cleanup_stale_imports' AND status IN ('pending', 'running')`
  );
  if (Number(sweepQueued.rows[0][0]) === 0) {
    blockers.push({
      key: 'stale_pending_sweep_stopped',
      severity: 'hard',
      title: 'Stale-pending imports sweep has stopped',
      detail:
        'No cleanup_stale_imports job is queued. The handler is supposed to self-enqueue its next run. If this list shows rows under Stale pending imports, they will never auto-recover.',
      action:
        're-seed the sweep via scripts/phase1-seed-stale-import-sweep.ts and investigate why the chain broke',
    });
  }

  // The old "period locking is dead" blocker is gone as of Slice 16 —
  // isPeriodLocked is now enforced in ingest-v2, and lock/unlock
  // endpoints exist. No static blocker here anymore.

  // --- Assemble ---
  // Order by consequence, not aesthetics. Expired-but-active lands high
  // because it's silent commercial drift — money moves under a dead
  // agreement. Missing-automation lands last as a silent-failure canary.
  const sections: QueueSection[] = [
    failedJobs,
    failedImports,
    stalePending,
    lateInvoices,
    drafts,
    unbilledNeedsApproval,
    unbilledManualReview,
    unbilledAutoBill,
    overdueMilestones,
    upcomingMilestones,
    dueSoon,
    expired,
    expiring,
    pendingApprovals,
    missingAuto,
    googleSyncAttention,
    csvSourceAttention,
    missingBillingContact,
    lockedPeriodsSection,
  ];

  const counts: Record<string, number> = {};
  for (const s of sections) counts[s.key] = s.count;
  counts.blockers = blockers.length;

  return {
    generatedAt: new Date().toISOString(),
    sections,
    blockers,
    counts,
  };
}
