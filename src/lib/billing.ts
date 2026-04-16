// Billing engine — recurring invoice generation, hours tracking, overage, pending charges, reminders

import { nanoid } from 'nanoid';
import turso from './turso';
import { getAllContracts, getContract, type Contract } from './contracts';
import { createInvoice, generateInvoiceNumber, addInvoiceItem, getInvoice, updateInvoice } from './invoices';
import { createNotification } from './notifications';
import { getUsersByClientId } from './auth';
import { resolveReminderRecipients, getClientProfile } from './clients';
import {
  DEFAULT_REMINDER_RULE,
  getContractReminderRule,
  nextReminderTick,
  type ReminderRule,
} from './contract-rules';
import { logger } from './logger';

// --- Query helpers ---
async function queryOne(sql: string, args: any[] = []): Promise<any | undefined> {
  const result = await turso.execute({ sql, args });
  if (result.rows.length === 0) return undefined;
  return Object.fromEntries(result.columns.map((col, i) => [col, result.rows[0][i]]));
}
async function queryAll(sql: string, args: any[] = []): Promise<any[]> {
  const result = await turso.execute({ sql, args });
  return result.rows.map(row => Object.fromEntries(result.columns.map((col, i) => [col, row[i]])));
}

// ============================================================
// Billing Period
// ============================================================

function formatUtcDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Returns the [start, end] dates (inclusive, YYYY-MM-DD UTC) of the
// billing period the given Date falls within, given a billing anchor
// day. All arithmetic uses UTC so the result is timezone-independent
// — matches nextBillingRunIso in contracts.ts.
//
// The period runs from billingDay of one month to (billingDay-1) of the
// next month. Examples with billingDay=9:
//   now = Apr 15  → period = 2026-04-09 .. 2026-05-08
//   now = Apr 03  → period = 2026-03-09 .. 2026-04-08
//
// Edge case billingDay=1: end = last day of the current month.
//
// The `now` argument is injectable so unit tests can pin a reference date.
// billingDay is clamped to [1, 28] — matches the contracts schema bounds.
export function getCurrentBillingPeriod(
  billingDay: number,
  now: Date = new Date()
): { start: string; end: string } {
  const day = Math.max(1, Math.min(28, Math.floor(billingDay)));
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-indexed

  let startMs: number;
  let endMs: number;
  if (now.getUTCDate() >= day) {
    // Current period started this month on `day`, ends next month on `day - 1`.
    startMs = Date.UTC(year, month, day);
    endMs = Date.UTC(year, month + 1, day - 1);
  } else {
    // Haven't hit billing day yet this month — period started last month.
    startMs = Date.UTC(year, month - 1, day);
    endMs = Date.UTC(year, month, day - 1);
  }
  return { start: formatUtcDate(startMs), end: formatUtcDate(endMs) };
}

export async function invoiceExistsForPeriod(contractId: string, periodStart: string, periodEnd: string): Promise<boolean> {
  const row = await queryOne(
    'SELECT COUNT(*) as cnt FROM invoices WHERE contract_id = ? AND billing_period_start = ? AND billing_period_end = ?',
    [contractId, periodStart, periodEnd]
  );
  return (row?.cnt ?? 0) > 0;
}

// ============================================================
// Pending Charges
// ============================================================

export interface PendingCharge {
  id: string;
  contract_id: string;
  description: string;
  amount: number;
  source_type: string;
  source_id: string | null;
  billed_invoice_id: string | null;
  created_at: string;
}

export async function createPendingCharge(data: {
  contract_id: string;
  description: string;
  amount: number;
  source_type: string;
  source_id?: string;
}): Promise<string> {
  const id = nanoid();
  await turso.execute({
    sql: 'INSERT INTO pending_charges (id, contract_id, description, amount, source_type, source_id) VALUES (?, ?, ?, ?, ?, ?)',
    args: [id, data.contract_id, data.description, data.amount, data.source_type, data.source_id ?? null],
  });
  return id;
}

export async function getPendingChargesForContract(contractId: string): Promise<PendingCharge[]> {
  // Only sweep auto_bill + legacy/null-classified charges into invoices.
  // needs_approval and manual_review stay unbilled until Cody acts on them
  // (approve → auto_bill, or delete). Matches the admin queue's treatment:
  // auto_bill + unknown are the billing queue; needs_approval and
  // manual_review are the action queue.
  return queryAll(
    `SELECT * FROM pending_charges
     WHERE contract_id = ? AND billed_invoice_id IS NULL
       AND (classification IS NULL OR classification NOT IN ('needs_approval', 'manual_review'))
     ORDER BY created_at`,
    [contractId]
  );
}

export async function markChargesAsBilled(chargeIds: string[], invoiceId: string): Promise<void> {
  for (const id of chargeIds) {
    await turso.execute({
      sql: 'UPDATE pending_charges SET billed_invoice_id = ? WHERE id = ?',
      args: [invoiceId, id],
    });
  }
}

// ============================================================
// Hours Tracking / Overage
// ============================================================

export async function getContractHoursForPeriod(contractId: string, periodStart: string, periodEnd: string): Promise<{
  total: number; included: number; overage: number; overageAmount: number;
}> {
  const contract = await getContract(contractId);
  if (!contract) return { total: 0, included: 0, overage: 0, overageAmount: 0 };

  // Sum actual_hours for tasks under this contract's projects where completed_at is within period
  const row = await queryOne(
    `SELECT COALESCE(SUM(t.actual_hours), 0) as total_hours
     FROM tasks t
     JOIN milestones m ON m.id = t.milestone_id
     JOIN projects p ON p.id = m.project_id
     WHERE p.contract_id = ?
       AND t.actual_hours IS NOT NULL
       AND t.completed_at >= ?
       AND t.completed_at < ?`,
    [contractId, periodStart, periodEnd + 'T23:59:59']
  );

  const total = row?.total_hours ?? 0;
  const included = contract.included_hours ?? 0;
  const overage = Math.max(0, total - included);
  const overageAmount = overage * (contract.overage_rate ?? 0);

  return { total, included, overage, overageAmount };
}

export async function updateOverageCharge(contractId: string, periodStart: string, periodEnd: string): Promise<void> {
  const hours = await getContractHoursForPeriod(contractId, periodStart, periodEnd);

  // Find existing overage pending charge for this period
  const existing = await queryOne(
    "SELECT id, amount FROM pending_charges WHERE contract_id = ? AND source_type = 'overage' AND billed_invoice_id IS NULL AND description LIKE ?",
    [contractId, `%${periodStart}%`]
  );

  if (hours.overageAmount > 0) {
    if (existing) {
      // Update existing charge
      await turso.execute({
        sql: 'UPDATE pending_charges SET amount = ?, description = ? WHERE id = ?',
        args: [hours.overageAmount, `Overage: ${hours.overage.toFixed(1)}h over ${hours.included}h included (${periodStart} to ${periodEnd})`, existing.id],
      });
    } else {
      // Create new charge
      await createPendingCharge({
        contract_id: contractId,
        description: `Overage: ${hours.overage.toFixed(1)}h over ${hours.included}h included (${periodStart} to ${periodEnd})`,
        amount: hours.overageAmount,
        source_type: 'overage',
      });
    }
  } else if (existing) {
    // No overage — remove the pending charge
    await turso.execute({ sql: 'DELETE FROM pending_charges WHERE id = ?', args: [existing.id] });
  }
}

// ============================================================
// Recurring Invoice Generation
// ============================================================

// Test-only fault injection point. Set to a nonzero integer to force
// generateInvoiceForContract to throw after staging the Nth write inside
// its transaction, proving rollback atomicity. Never set outside tests.
let __testFaultAfter: number | null = null;
export function __setBillingTxFaultAfter(n: number | null): void {
  __testFaultAfter = n;
}

export async function generateInvoiceForContract(
  contract: Contract,
  createdBy: string,
  nowFn: () => Date = () => new Date()
): Promise<string | null> {
  if (
    contract.status !== 'active' ||
    contract.billing_cadence !== 'monthly' ||
    !contract.billing_day ||
    !contract.recurring_amount
  ) {
    return null;
  }

  const now = nowFn();
  const period = getCurrentBillingPeriod(contract.billing_day, now);

  // Billing day reached for the CURRENT UTC month?
  if (now.getUTCDate() < contract.billing_day) {
    return null;
  }

  // App-level dedupe — covered structurally by uq_invoices_contract_period,
  // but we check first to avoid burning an invoice number on a no-op.
  if (await invoiceExistsForPeriod(contract.id, period.start, period.end)) {
    return null;
  }

  // Locked-period guard: if any data period for this client overlaps the
  // billing period and is locked, refuse to generate. This prevents
  // billing mutations against months that Cody has frozen for reporting.
  const lockedOverlap = await queryOne(
    `SELECT period_start, locked_at FROM periods
     WHERE client_id = ?
       AND locked_at IS NOT NULL
       AND period_start <= ?
       AND period_end >= ?
     LIMIT 1`,
    [contract.client_id, period.end, period.start]
  );
  if (lockedOverlap) {
    throw new Error(
      `billing period ${period.start}..${period.end} overlaps locked period ${lockedOverlap.period_start} (locked since ${lockedOverlap.locked_at})`
    );
  }

  // Pre-compute everything we need before opening the transaction so the
  // tx body contains only DB writes.
  const invoiceId = nanoid();
  const invoiceNumber = await generateInvoiceNumber();
  const dueDate = new Date(now.getTime() + (contract.payment_terms_days ?? 30) * 86400000);
  const dueDateStr = dueDate.toISOString().split('T')[0];
  const issuedDateStr = now.toISOString().split('T')[0];

  const pendingCharges = await getPendingChargesForContract(contract.id);
  const recurringItemId = nanoid();
  const chargeItemIds = pendingCharges.map(() => nanoid());

  // Compute subtotal / total locally — no DB read/write dance.
  const recurringAmount = contract.recurring_amount!;
  const subtotal =
    recurringAmount + pendingCharges.reduce((acc, c) => acc + c.amount, 0);
  const total = subtotal; // no tax support yet

  let staged = 0;
  const maybeFault = () => {
    staged++;
    if (__testFaultAfter !== null && staged >= __testFaultAfter) {
      throw new Error(`__TEST_FAULT_AFTER_${staged}`);
    }
  };

  const tx = await turso.transaction('write');
  try {
    // 1. Insert the invoice row with every persistent field populated.
    // The UNIQUE(contract_id, billing_period_start, billing_period_end)
    // index backstops invoiceExistsForPeriod — a concurrent runner will
    // fail here rather than silently duplicate.
    await tx.execute({
      sql: `INSERT INTO invoices
            (id, contract_id, client_id, invoice_number, status,
             issued_date, due_date, subtotal, tax, total, amount_paid,
             client_visible, billing_period_start, billing_period_end, created_by)
            VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, 0, ?, 0, 1, ?, ?, ?)`,
      args: [
        invoiceId,
        contract.id,
        contract.client_id,
        invoiceNumber,
        issuedDateStr,
        dueDateStr,
        subtotal,
        total,
        period.start,
        period.end,
        createdBy,
      ],
    });
    maybeFault();

    // 2. Recurring line item.
    await tx.execute({
      sql: `INSERT INTO invoice_items
            (id, invoice_id, description, quantity, unit_price, amount, sort_order)
            VALUES (?, ?, ?, 1, ?, ?, 0)`,
      args: [
        recurringItemId,
        invoiceId,
        `${contract.title} (${period.start} to ${period.end})`,
        recurringAmount,
        recurringAmount,
      ],
    });
    maybeFault();

    // 3. Pending-charge line items + mark-billed, all under the same tx.
    for (let i = 0; i < pendingCharges.length; i++) {
      const charge = pendingCharges[i];
      await tx.execute({
        sql: `INSERT INTO invoice_items
              (id, invoice_id, description, quantity, unit_price, amount, sort_order)
              VALUES (?, ?, ?, 1, ?, ?, ?)`,
        args: [
          chargeItemIds[i],
          invoiceId,
          charge.description,
          charge.amount,
          charge.amount,
          i + 1,
        ],
      });
      maybeFault();
      await tx.execute({
        sql: `UPDATE pending_charges SET billed_invoice_id = ? WHERE id = ?`,
        args: [invoiceId, charge.id],
      });
      maybeFault();
    }

    await tx.commit();
    return invoiceId;
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

export async function generateRecurringInvoices(createdBy: string): Promise<{ generated: string[]; skipped: string[] }> {
  const contracts = await getAllContracts();
  const generated: string[] = [];
  const skipped: string[] = [];

  for (const contract of contracts) {
    try {
      const invoiceId = await generateInvoiceForContract(contract, createdBy);
      if (invoiceId) {
        generated.push(invoiceId);

        // Notify client (System 5)
        const invoice = await getInvoice(invoiceId);
        if (invoice) {
          const users = await getUsersByClientId(contract.client_id);
          for (const user of users) {
            await createNotification({
              user_id: user.id,
              type: 'invoice_sent',
              title: 'Invoice ready',
              body: `Invoice ${invoice.invoice_number} for ${invoice.billing_period_start} to ${invoice.billing_period_end} is ready ($${invoice.total.toFixed(2)})`,
              entity_type: 'invoice',
              entity_id: invoiceId,
            });
          }
        }
      } else {
        skipped.push(contract.id);
      }
    } catch (err) {
      logger.error(`Failed to generate invoice for contract ${contract.id}`, err);
      skipped.push(contract.id);
    }
  }

  return { generated, skipped };
}

// checkAndGenerateInvoices removed in Phase 1 Step 5 — use the
// scheduled_jobs runner (src/lib/jobs/runner.ts) instead.

// ============================================================
// Due Date Reminders (System 4 — called by scheduled_jobs runner)
// ============================================================

// A single tick that planDueReminders has decided to fire for one
// invoice. Passed back to sendDueReminders so the caller can exercise
// both the decision layer and the email layer independently, which
// makes the behavior testable without actually sending email.
export interface ReminderPlanItem {
  invoice: {
    id: string;
    invoice_number: string;
    due_date: string;
    total: number;
    amount_paid: number;
    contract_id: string;
    client_id: string;
    reminder_ticks_sent_json: string;
  };
  contract: Contract;
  rule: ReminderRule;
  tick: string; // e.g. 'before:7', 'after:3'
}

// Fetches every open (sent + unpaid) invoice and, for each, reads the
// owning contract's reminder_rule_json (or falls back to the global
// default) and asks nextReminderTick whether a tick is due right now.
// Returns the list of plan items that WOULD be sent.
//
// This is the pure decision layer. It does not send email or mutate
// any rows — tests call it directly and assert on the result.
export async function planDueReminders(
  now: Date = new Date()
): Promise<ReminderPlanItem[]> {
  const invoices = await queryAll(
    `SELECT id, invoice_number, due_date, total, amount_paid,
            contract_id, client_id, reminder_ticks_sent_json
     FROM invoices
     WHERE status = 'sent' AND amount_paid < total
     ORDER BY due_date ASC`
  );

  const plan: ReminderPlanItem[] = [];
  for (const invoice of invoices) {
    const contract = await getContract(invoice.contract_id);
    if (!contract) continue;

    const ruleFromContract = await getContractReminderRule(contract.id);
    const rule = ruleFromContract ?? DEFAULT_REMINDER_RULE;

    let sentTicks: string[] = [];
    try {
      const parsed = JSON.parse(invoice.reminder_ticks_sent_json ?? '[]');
      if (Array.isArray(parsed)) sentTicks = parsed.filter((t): t is string => typeof t === 'string');
    } catch {
      // Leave sentTicks as empty array on parse failure — we'd rather
      // fire a duplicate reminder than skip a real one.
      sentTicks = [];
    }

    const tick = nextReminderTick({
      dueDate: invoice.due_date,
      now,
      rule,
      sentTicks,
    });
    if (tick) {
      plan.push({ invoice, contract, rule, tick });
    }
  }

  return plan;
}

// Appends a tick to the invoice's reminder_ticks_sent_json column.
// Exported so tests can exercise the state-transition layer directly.
export async function markReminderTickSent(
  invoiceId: string,
  tick: string,
  nowIso: string = new Date().toISOString()
): Promise<void> {
  const current = await queryOne(
    'SELECT reminder_ticks_sent_json FROM invoices WHERE id = ?',
    [invoiceId]
  );
  if (!current) return;
  let sent: string[] = [];
  try {
    const parsed = JSON.parse(current.reminder_ticks_sent_json ?? '[]');
    if (Array.isArray(parsed)) sent = parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    sent = [];
  }
  if (!sent.includes(tick)) sent.push(tick);
  await turso.execute({
    sql: `UPDATE invoices
          SET reminder_ticks_sent_json = ?, last_reminder_sent = ?
          WHERE id = ?`,
    args: [JSON.stringify(sent), nowIso, invoiceId],
  });
}

// The old one-liner: compute the plan, fan out the emails, stamp the
// ticks. Test coverage lives on planDueReminders + markReminderTickSent
// so this thin wrapper only has to be eyeballed for email formatting.
export async function sendDueReminders(): Promise<number> {
  const { sendEmail } = await import('./email');
  const plan = await planDueReminders();
  let sent = 0;

  for (const item of plan) {
    try {
      // Three-layer recipient resolution (Slice 12):
      //   1. Contacts with receives_reminders=1 and 'billing' or
      //      'primary' role — the honest routing layer.
      //   2. clients.primary_contact_email — fallback when no contacts
      //      are seeded yet.
      //   3. getUsersByClientId — legacy path, last-ditch fallback.
      const fallbackUsers = await getUsersByClientId(item.contract.client_id);
      const clientProfile = await getClientProfile(item.contract.client_id);
      const recipients = await resolveReminderRecipients(
        item.contract.client_id,
        fallbackUsers.map((u) => ({ email: u.email, name: u.name })),
        clientProfile?.primary_contact_email ?? null
      );
      if (recipients.length === 0) continue;

      const portalUrl = import.meta.env.SITE || 'https://codyasmith.com';
      const tickLabel = item.tick.startsWith('before:')
        ? `${item.tick.split(':')[1]} days before due`
        : `${item.tick.split(':')[1]} days past due`;
      const invoice = item.invoice;
      const remaining = invoice.total - invoice.amount_paid;
      const ok = await sendEmail(
        recipients,
        `Invoice ${invoice.invoice_number} — payment reminder (${tickLabel})`,
        `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #171717; margin-bottom: 16px;">Payment reminder</h2>
          <p style="color: #525252; line-height: 1.6; margin-bottom: 8px;">
            Invoice <strong>${invoice.invoice_number}</strong> for <strong>$${invoice.total.toFixed(2)}</strong> is due on <strong>${invoice.due_date}</strong>.
          </p>
          ${
            invoice.amount_paid > 0
              ? `<p style="color: #525252; line-height: 1.6; margin-bottom: 8px;">Amount paid so far: $${invoice.amount_paid.toFixed(2)}. Remaining: $${remaining.toFixed(2)}.</p>`
              : ''
          }
          <a href="${portalUrl}/portal/invoices" style="display: inline-block; background: #f59e0b; color: #0a0a0a; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; margin-top: 16px;">
            View invoice in portal
          </a>
          <p style="color: #a3a3a3; font-size: 12px; margin-top: 32px;">
            <a href="${portalUrl}" style="color: #a3a3a3;">codyasmith.com</a>
          </p>
        </div>
        `
      );

      if (ok) {
        await markReminderTickSent(invoice.id, item.tick);
        sent++;
      }
    } catch (err) {
      logger.error(`Failed to send reminder for invoice ${item.invoice.id}`, err);
    }
  }

  return sent;
}

// checkAndSendReminders removed in Phase 1 Step 5 — scheduled_jobs runner.
