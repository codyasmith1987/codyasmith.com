// Billing engine — recurring invoice generation, hours tracking, overage, pending charges, reminders

import { nanoid } from 'nanoid';
import turso from './turso';
import { getAllContracts, getContract, type Contract } from './contracts';
import { createInvoiceWithGeneratedNumber, addInvoiceItem, getInvoice, updateInvoice } from './invoices';
import { getExpensesDueForBilling, markExpensesBilled } from './client-expenses';
import { getAgreementByContractId, getClientMetadata, type ClientAgreement } from './agreements';
import { resolveInvoiceRecipients } from './invoice-emails';
import { createNotification } from './notifications';
import { getUsersByClientId, clientIsManualBilling } from './auth';
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

// Format a Date as YYYY-MM-DD from its LOCAL components (not toISOString,
// which is UTC and can shift the day across a timezone boundary).
function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Build a Date for (year, monthIndex, day) but CAP day to that month's
// actual length, so a billingDay of 29-31 never overflows into the next
// month (e.g. billingDay=31 in February). day=0 is preserved (it means
// "last day of the prior month", used for the day-before-the-1st case).
function periodDate(year: number, monthIndex: number, day: number): Date {
  if (day <= 0) return new Date(year, monthIndex, day);
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  return new Date(year, monthIndex, Math.min(day, lastDay));
}

export function getCurrentBillingPeriod(billingDay: number, now: Date = new Date()): { start: string; end: string } {
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed

  // A period anchored on day D runs from D of one month to (D-1) of the
  // next. Built with periodDate so D=1 yields the last day of the start
  // month (not the malformed "YYYY-MM-00" the old string math produced)
  // AND D=29-31 caps to the real last day of short months instead of
  // overflowing. `now` is injectable for deterministic tests.
  if (now.getDate() < billingDay) {
    // Haven't reached billing day this month: the period started on
    // billingDay of LAST month and ends the day before billingDay of THIS
    // month.
    const start = periodDate(year, month - 1, billingDay);
    const end = periodDate(year, month, billingDay - 1);
    return { start: fmtDate(start), end: fmtDate(end) };
  }

  // Otherwise the period started on billingDay of THIS month and ends the
  // day before billingDay of NEXT month.
  const start = periodDate(year, month, billingDay);
  const end = periodDate(year, month + 1, billingDay - 1);
  return { start: fmtDate(start), end: fmtDate(end) };
}

// The NEXT service period after the one containing `now`. Used to issue
// recurring invoices ~7 days ahead (contract section 5.3). The day after
// the current period ends is the next period's start (a billingDay
// boundary), so we re-evaluate getCurrentBillingPeriod there.
export function getUpcomingBillingPeriod(billingDay: number, now: Date = new Date()): { start: string; end: string } {
  const cur = getCurrentBillingPeriod(billingDay, now);
  const nextStart = new Date(cur.end + 'T00:00:00');
  nextStart.setDate(nextStart.getDate() + 1);
  return getCurrentBillingPeriod(billingDay, nextStart);
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
  return queryAll(
    'SELECT * FROM pending_charges WHERE contract_id = ? AND billed_invoice_id IS NULL ORDER BY created_at',
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

// Derive the ITEMIZED recurring service lines from a signed Schedule A (Cody's
// hard rule: every invoice is always itemized, never a single combined line).
// Returns one line per Web Management site (its own monthly contribution) plus
// the Marketing Consulting retainer line. Returns null when the Schedule A has
// no such breakdown (legacy contracts / no linked agreement) so the caller
// falls back to a single line. Pure + unit-tested. Pass-through, pending
// charges, and reimbursements are added separately by the caller.
export function deriveRecurringLineItems(
  scheduleA: any,
  period: { start: string; end: string }
): Array<{ name: string; sub_description: string; description: string; category: string; frequency: string; quantity: number; unit_price: number }> | null {
  if (!scheduleA || typeof scheduleA !== 'object') return null;
  const sub = `${period.start} to ${period.end}`;
  const lines: Array<{ name: string; sub_description: string; description: string; category: string; frequency: string; quantity: number; unit_price: number }> = [];

  const wm = scheduleA.web_management;
  if (wm && Array.isArray(wm.sites)) {
    // Primary first, then the rest in their listed order.
    const sites = [...wm.sites].sort((a: any, b: any) => (b?.is_primary ? 1 : 0) - (a?.is_primary ? 1 : 0));
    for (const s of sites) {
      const amt = Number(s?.monthly_contribution) || 0;
      if (amt > 0 && s?.domain) {
        const name = `Web Management - ${s.domain}`;
        lines.push({ name, sub_description: sub, description: name, category: 'services', frequency: 'monthly', quantity: 1, unit_price: amt });
      }
    }
  }

  const mcAmt = Number(scheduleA.marketing_consulting?.monthly_retainer) || 0;
  if (mcAmt > 0) {
    lines.push({ name: 'Marketing Consulting', sub_description: sub, description: 'Marketing Consulting', category: 'services', frequency: 'monthly', quantity: 1, unit_price: mcAmt });
  }

  return lines.length > 0 ? lines : null;
}

export async function generateInvoiceForContract(contract: Contract, createdBy: string, now: Date = new Date()): Promise<string | null> {
  if (contract.status !== 'active' || contract.billing_cadence !== 'monthly' || !contract.billing_day || !contract.recurring_amount) {
    return null;
  }

  // Manual-billing gate (Cody, 2026-06-05): a hand-billed client is never
  // auto-generated -- Cody invoices them by hand (e.g. ZipKit until the v7
  // re-paper). Marking/visibility is unaffected; this only skips auto-creation.
  if (await clientIsManualBilling(contract.client_id)) {
    return null;
  }

  // Per contract section 5.3, recurring invoices are issued ~7 days BEFORE
  // the service period begins. So we bill the UPCOMING period (not the one
  // containing today) and only once we are within 7 days of its start.
  // The at-signing invoice covers the first period, so the recurring engine
  // naturally picks up from the next one with no overlap.
  const period = getUpcomingBillingPeriod(contract.billing_day, now);

  // Already issued for that period?
  if (await invoiceExistsForPeriod(contract.id, period.start, period.end)) {
    return null;
  }

  // Too early: not yet within the 7-day advance window.
  const issueThreshold = new Date(period.start + 'T00:00:00');
  issueThreshold.setDate(issueThreshold.getDate() - 7);
  if (now < issueThreshold) {
    return null;
  }

  // Itemize the recurring lines from the signed Schedule A (always-itemized
  // rule). Load the agreement once (reused below for pass-through). Reconcile
  // against the contract's recurring_amount BEFORE creating anything: on a
  // mismatch, HALT (Cody, 2026-06-04: never send a wrong invoice) by throwing,
  // which generateRecurringInvoices logs + alerts on. recurringLines is null
  // when there is no linked agreement (a standalone/legacy contract) OR the
  // Schedule A has no WM/MC breakdown (a flat-fee custom contract); in either
  // case the single-line fallback below applies.
  //
  // NOTE (dual audit, 2026-06-04): invoice GENERATION is deliberately NOT gated
  // on having an agreement. An earlier version returned null here when no
  // agreement was linked, which silently stopped auto-billing for active
  // standalone/unlinked monthly contracts that previously billed via the
  // fallback. The v7 section 5.8 dunning/interest/suspension policy is scoped to
  // portal-contract clients separately, in sendOverdueNotices -- not here.
  const agreement = await getAgreementByContractId(contract.id);
  const recurringLines = deriveRecurringLineItems(agreement?.schedule_a, period);
  if (recurringLines) {
    const sum = recurringLines.reduce((s, l) => s + l.unit_price * l.quantity, 0);
    if (Math.abs(sum - contract.recurring_amount) > 0.01) {
      throw new Error(`reconcile mismatch for contract ${contract.id}: Schedule A recurring lines $${sum.toFixed(2)} do not equal contract.recurring_amount $${Number(contract.recurring_amount).toFixed(2)}; itemized invoice not generated`);
    }
  }

  // Generate the invoice with a collision-safe invoice number. Manual
  // invoice creation uses the same helper, so recurring and ad hoc
  // invoices share one numbering contract.
  const dueDate = new Date(now);
  dueDate.setDate(dueDate.getDate() + (contract.payment_terms_days ?? 30));

  const { id: invoiceId } = await createInvoiceWithGeneratedNumber({
    contract_id: contract.id,
    client_id: contract.client_id,
    due_date: dueDate.toISOString().split('T')[0],
    created_by: createdBy,
  });

  // Set billing period (the upcoming period this invoice covers).
  // Issue as 'sent', not 'draft': getDueInvoices and markOverdueInvoices
  // both filter status = 'sent', so a draft recurring invoice would never
  // be reminded or marked overdue, and the client portal would badge it
  // 'Draft' / hide it from the amount-due widget while the issuance
  // notification says it is ready. The at-signing path already issues as
  // 'sent'; recurring must match so the whole collection pipeline engages.
  await updateInvoice(invoiceId, {
    billing_period_start: period.start,
    billing_period_end: period.end,
    issued_date: now.toISOString().split('T')[0],
    status: 'sent',
    client_visible: 1,
  });

  // Recurring lines: itemized per Schedule A (always-itemized rule), or a single
  // line as a legacy fallback. sort_order is set explicitly on every line below
  // so display order is deterministic (getInvoiceItems orders by sort_order).
  let so = 0;
  if (recurringLines) {
    for (const l of recurringLines) {
      await addInvoiceItem({ invoice_id: invoiceId, sort_order: so++, ...l });
    }
  } else {
    await addInvoiceItem({
      invoice_id: invoiceId,
      sort_order: so++,
      name: contract.title,
      sub_description: `${period.start} to ${period.end}`,
      description: `${contract.title} (${period.start} to ${period.end})`,
      category: 'services',
      frequency: 'monthly',
      quantity: 1,
      unit_price: contract.recurring_amount,
    });
  }

  // Contracted pass-through: the monthly plugin/software management fee from the
  // signed Schedule A (a Services line, distinct from out-of-pocket
  // reimbursements). Summed across sites to match the hand-invoice presentation.
  const passThrough: any[] = Array.isArray(agreement?.schedule_a?.pass_through_items)
    ? agreement!.schedule_a.pass_through_items
    : [];
  const passThroughTotal = passThrough.reduce((sum: number, p: any) => sum + (Number(p?.monthly_cost) || 0), 0);
  if (passThroughTotal > 0) {
    const rates = new Set(passThrough.map((p: any) => Number(p?.monthly_cost) || 0));
    const sub = rates.size === 1
      ? `${passThrough.length} ${passThrough.length === 1 ? 'site' : 'sites'} x $${[...rates][0]}`
      : `${passThrough.length} items`;
    await addInvoiceItem({
      invoice_id: invoiceId,
      sort_order: so++,
      name: 'Plugin Management Fee',
      sub_description: sub,
      description: 'Plugin Management Fee',
      category: 'services',
      frequency: 'monthly',
      quantity: 1,
      unit_price: passThroughTotal,
    });
  }

  // Add pending charges (change orders, overage, one-time)
  const pendingCharges = await getPendingChargesForContract(contract.id);
  const chargeIds: string[] = [];
  for (const charge of pendingCharges) {
    await addInvoiceItem({
      invoice_id: invoiceId,
      sort_order: so++,
      name: charge.description,
      description: charge.description,
      category: 'services',
      quantity: 1,
      unit_price: charge.amount,
    });
    chargeIds.push(charge.id);
  }

  // Mark charges as billed
  if (chargeIds.length > 0) {
    await markChargesAsBilled(chargeIds, invoiceId);
  }

  // Reimbursements: active recurring-expense templates due for this invoice's
  // date (cadence-aware). Each becomes a category='reimbursements' line, then
  // its last_billed_on is stamped so annual/one_time templates do not re-bill.
  const billDate = now.toISOString().split('T')[0];
  const dueExpenses = await getExpensesDueForBilling(contract.client_id, billDate);
  const billedExpenseIds: string[] = [];
  for (const exp of dueExpenses) {
    await addInvoiceItem({
      invoice_id: invoiceId,
      sort_order: so++,
      name: exp.name,
      description: exp.name,
      category: 'reimbursements',
      frequency: exp.frequency,
      quantity: 1,
      unit_price: exp.amount,
    });
    billedExpenseIds.push(exp.id);
  }
  if (billedExpenseIds.length > 0) {
    await markExpensesBilled(billedExpenseIds, billDate, invoiceId);
  }

  return invoiceId;
}

export async function generateRecurringInvoices(createdBy: string): Promise<{ generated: string[]; skipped: string[]; emailed: number; email_failed: number }> {
  const { sendInvoiceEmail } = await import('./invoice-emails');
  const contracts = await getAllContracts();
  const generated: string[] = [];
  const skipped: string[] = [];
  let emailed = 0, email_failed = 0;

  for (const contract of contracts) {
    try {
      const invoiceId = await generateInvoiceForContract(contract, createdBy);
      if (invoiceId) {
        generated.push(invoiceId);

        // Notify client in-portal (the bell).
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

        // Auto-EMAIL the invoice (with PDF) to the billing contact + accountant
        // CC, exactly like the at-signing invoice. Without this the recurring
        // engine generated invoices the client never received by email -- the
        // billing was "on auto" only up to the in-portal notification. Soft-fail
        // so a send hiccup never aborts the rest of the run; failures surface in
        // email_failed for the daily-cron admin alert.
        try {
          const r = await sendInvoiceEmail(invoiceId);
          if (r.ok) emailed++; else { email_failed++; logger.error(`recurring invoice ${invoiceId} email not sent: ${r.reason}`); }
        } catch (err) {
          email_failed++;
          logger.error(`recurring invoice ${invoiceId} email threw`, err);
        }
      } else {
        skipped.push(contract.id);
      }
    } catch (err: any) {
      logger.error(`Failed to generate invoice for contract ${contract.id}`, err);
      skipped.push(contract.id);
      // Halt-and-alert (Cody, 2026-06-04): a thrown generate error (e.g. a
      // Schedule A reconcile mismatch) skips that contract WITHOUT emitting a
      // wrong invoice, and tells the admin so it can be fixed.
      try {
        const { onAutomatedFailure } = await import('./triggers');
        await onAutomatedFailure('generateInvoiceForContract', `Contract ${contract.id}: ${err?.message || 'failed'}`);
      } catch (e) { logger.error('generate failure alert failed', e); }
    }
  }

  return { generated, skipped, emailed, email_failed };
}

// Lightweight check — call on page load
export async function checkAndGenerateInvoices(createdBy: string): Promise<void> {
  try {
    await generateRecurringInvoices(createdBy);
  } catch (err) {
    logger.error('Auto-generate invoices check failed', err);
  }
}

// ============================================================
// Due Date Reminders (System 4 — called after email.ts exists)
// ============================================================

export async function getDueInvoices(withinDays: number = 3): Promise<any[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + withinDays);
  return queryAll(
    "SELECT * FROM invoices WHERE status = 'sent' AND due_date <= ? AND due_date >= date('now') AND last_reminder_sent IS NULL AND amount_paid < total AND (reminders_paused = 0 OR reminders_paused IS NULL) ORDER BY due_date, invoice_number",
    [cutoff.toISOString().split('T')[0]]
  );
}

// Single source of truth for "which invoices the cron marks overdue". Used by
// markOverdueInvoices AND previewDailyCron's would_mark_overdue so the dry run
// can never drift from the live run. Includes 'partial' (Cody, 2026-06-04): a
// partially-paid past-due invoice is MARKED overdue for visibility; whether it
// gets an automatic notice is decided separately (isAutoOverdueEmailEligible
// only emails fully-unpaid ones).
export const OVERDUE_MARK_WHERE =
  `status IN ('sent', 'partial') AND amount_paid < total AND due_date < date('now') AND (reminders_paused = 0 OR reminders_paused IS NULL)`;

// Transition unpaid-past-due invoices to 'overdue' so the client-visible status
// fires. Run from the daily cron. Returns the number of invoices marked.
export async function markOverdueInvoices(): Promise<number> {
  const result = await turso.execute({
    sql: `UPDATE invoices SET status = 'overdue', updated_at = datetime('now') WHERE ${OVERDUE_MARK_WHERE}`,
  });
  return result.rowsAffected ?? 0;
}

// A per-call cached agreement-by-contract lookup. The dunning paths resolve the
// same contract's agreement more than once (eligibility gate + section 5.8
// stage), and a client run can repeat contracts; the cache keeps it to one DB
// read per contract per run.
function makeAgreementLookup() {
  const cache = new Map<string, ClientAgreement | null>();
  return async (contractId: string | null | undefined): Promise<ClientAgreement | null> => {
    if (!contractId) return null;
    if (!cache.has(contractId)) cache.set(contractId, await getAgreementByContractId(contractId));
    return cache.get(contractId) ?? null;
  };
}

// A per-call cached "is this client hand-billed" lookup. Mirrors
// makeAgreementLookup so a run reads each client's flag once.
function makeManualBillingLookup() {
  const cache = new Map<string, boolean>();
  return async (clientId: string): Promise<boolean> => {
    if (!cache.has(clientId)) cache.set(clientId, await clientIsManualBilling(clientId));
    return cache.get(clientId)!;
  };
}

// The dunning MESSAGE TYPE for an overdue notice, given the section-5.8 version
// that drove the stage (from resolveDunningStage) and the stage. Three types
// (Cody, 2026-06-05):
//   'default' -- a non-standard client with no executed portal contract (section
//                5.8 version 0). Plain past-due message + a faint reminder of the
//                30-day written notice to cancel. No interest, no suspension.
//   'firm'    -- a portal-contract client, under 30 days past due.
//   'final'   -- a portal-contract client, 30+ days: the section 5.8 escalation.
// (Manual-billing clients are filtered out entirely before this; they get no
// automated notice at all.)
export type DunningMessageType = 'default' | 'firm' | 'final';
export function dunningMessageType(section58Version: number, stage: DunningStage): DunningMessageType {
  if (section58Version === 0) return 'default';
  return stage;
}

// The per-invoice extra recipient to honor for a CONSOLIDATED notice. An extra
// recipient is scoped to a single invoice (migration 067), so for a per-client
// email listing several invoices we honor it ONLY when EVERY listed invoice
// carries the SAME non-empty extra (the common case is a single invoice).
// A mix of "extra on one, none on another" returns undefined so one invoice's
// one-off contact never receives another invoice's number and balance.
// Normalized for case/whitespace so 'A@x.com' and 'a@x.com' count as the same.
export function sharedExtraRecipient(invoices: Array<{ extra_recipient_email?: string | null }>): string | undefined {
  const norm = invoices.map(i => (i.extra_recipient_email || '').trim().toLowerCase());
  if (!norm[0] || !norm.every(e => e === norm[0])) return undefined;
  return invoices[0].extra_recipient_email || undefined;
}

// One HTML table row per invoice for a consolidated notice. Shows the number,
// due date, and balance owed. Shared by reminders and overdue notices.
function invoiceRowHtml(inv: { invoice_number: string; due_date: string | null; total: number; amount_paid: number | null }): string {
  const balance = inv.total - (inv.amount_paid || 0);
  return `<tr>
    <td style="padding: 8px 0; color: #525252; font-size: 14px;">${inv.invoice_number}</td>
    <td style="padding: 8px 0; color: #737373; font-size: 13px; text-align: center;">${inv.due_date || ''}</td>
    <td style="padding: 8px 0; color: #171717; font-size: 14px; text-align: right; font-weight: 600;">$${balance.toFixed(2)}</td>
  </tr>`;
}

// Send pre-due payment reminders, ONE email per client per run (Cody,
// 2026-06-04: a client with several invoices due gets a single consolidated
// notice, not one email per invoice -- "sven gets confused easily"). Each
// invoice's last_reminder_sent is still stamped so the cadence gate stays
// per-invoice. Recipients follow the financial-notice model (billing contact +
// accountant CC, not every portal user). Returns counts of emails sent/failed.
export async function sendDueReminders(): Promise<{ sent: number; failed: number }> {
  const { sendEmail } = await import('./email');
  const dueInvoices = await getDueInvoices(3);

  // Group by client so each client receives a single reminder email.
  const byClient = new Map<string, any[]>();
  for (const inv of dueInvoices) {
    const arr = byClient.get(inv.client_id) || [];
    arr.push(inv);
    byClient.set(inv.client_id, arr);
  }

  // Manual-billing gate (Cody, 2026-06-05): a hand-billed client gets NO
  // automated reminders. Every other client does, regardless of portal-contract
  // status (a non-standard client is still reminded; only the section 5.8
  // escalation -- in sendOverdueNotices -- is portal-contract-only).
  const isManual = makeManualBillingLookup();
  const portalUrl = import.meta.env.SITE || 'https://codyasmith.com';
  let sent = 0, failed = 0;

  for (const [clientId, invoices] of byClient) {
    try {
      if (await isManual(clientId)) continue;
      // Recipient model (Cody, 2026-06-04): a payment reminder is a financial
      // notice, so it goes to the billing contact + accountant CC, not every
      // portal user. Falls back to the first portal user if no contact is set.
      const meta = await getClientMetadata(clientId).catch(() => null);
      const users = await getUsersByClientId(clientId);
      const recipients = resolveInvoiceRecipients({
        primaryEmail: meta?.primary_contact_email,
        billingCcEmail: meta?.billing_cc_email,
        extraEmail: sharedExtraRecipient(invoices),
        fallbackEmails: users.map(u => u.email),
      });
      if (recipients.to.length === 0) continue;

      const total = invoices.reduce((s, i) => s + (i.total - (i.amount_paid || 0)), 0);
      const multi = invoices.length > 1;
      const anyAtSigning = invoices.some(i => !i.billing_period_start);
      const subject = multi
        ? `Payment reminder: ${invoices.length} invoices ($${total.toFixed(2)})`
        : (!invoices[0].billing_period_start
            ? `Your invoice to get started is due ${invoices[0].due_date}. Work begins once it clears.`
            : `Invoice ${invoices[0].invoice_number}: payment due ${invoices[0].due_date}`);
      // In the multi case the at-signing framing is appended (so a new client
      // whose at-signing and recurring invoices come due together is still told
      // their work is gated on the at-signing payment -- it must not be lost in
      // consolidation).
      const lead = multi
        ? `You have ${invoices.length} invoices coming due, totaling <strong>$${total.toFixed(2)}</strong>.${anyAtSigning ? ' One of these is your at-signing invoice; that work begins as soon as it clears.' : ''}`
        : (!invoices[0].billing_period_start
            ? `Your at-signing invoice <strong>${invoices[0].invoice_number}</strong> for <strong>$${invoices[0].total.toFixed(2)}</strong> is due on <strong>${invoices[0].due_date}</strong>. Work begins as soon as it clears.`
            : `Invoice <strong>${invoices[0].invoice_number}</strong> for <strong>$${invoices[0].total.toFixed(2)}</strong> is due on <strong>${invoices[0].due_date}</strong>.`);
      const ok = await sendEmail(
        recipients.to.map(e => ({ email: e, name: '' })),
        subject,
        `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #171717; margin-bottom: 16px;">${anyAtSigning && !multi ? 'Getting started' : 'Payment reminder'}</h2>
          <p style="color: #525252; line-height: 1.6; margin-bottom: 8px;">${lead}</p>
          ${multi ? `<table style="width: 100%; border-collapse: collapse; margin: 16px 0;">${invoices.map(invoiceRowHtml).join('')}</table>` : ''}
          <a href="${portalUrl}/portal/invoices" style="display: inline-block; background: #f59e0b; color: #0a0a0a; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; margin-top: 16px;">
            View ${multi ? 'invoices' : 'invoice'} in portal
          </a>
          <p style="color: #a3a3a3; font-size: 12px; margin-top: 32px;">
            <a href="${portalUrl}" style="color: #a3a3a3;">codyasmith.com</a>
          </p>
        </div>
        `,
        { cc: recipients.cc.map(e => ({ email: e })) }
      );

      if (ok) {
        const stamp = new Date().toISOString();
        for (const inv of invoices) await updateInvoice(inv.id, { last_reminder_sent: stamp });
        sent++;
      } else {
        failed++;
      }
    } catch (err) {
      logger.error(`Failed to send reminders for client ${clientId}`, err);
      failed++;
    }
  }

  return { sent, failed };
}

// Lightweight check — call on admin page load
export async function checkAndSendReminders(): Promise<void> {
  try {
    await sendDueReminders();
  } catch (err) {
    logger.error('Auto-send reminders check failed', err);
  }
}

// ============================================================
// Overdue Notices (Cody, 2026-06-04: first at due+7, then weekly until paid)
// ============================================================

// Pure cadence predicate, unit-tested: is an overdue invoice due for an
// overdue notice as of `now`? The first notice fires 7 days after the due
// date; subsequent notices fire weekly, keyed off last_reminder_sent. The
// caller is responsible for the status/paid/reminders-paused gates (so this
// stays a pure date function). All math in UTC for determinism.
export function isOverdueNoticeDue(
  inv: { due_date: string | null; last_reminder_sent: string | null },
  now: Date = new Date()
): boolean {
  if (!inv.due_date) return false;
  const due = new Date(inv.due_date + 'T00:00:00Z');
  if (isNaN(due.getTime())) return false;
  const firstNotice = new Date(due);
  firstNotice.setUTCDate(firstNotice.getUTCDate() + 7);
  if (now < firstNotice) return false;
  if (!inv.last_reminder_sent) return true;
  const last = new Date(inv.last_reminder_sent);
  if (isNaN(last.getTime())) return true;
  const weekAfterLast = new Date(last);
  weekAfterLast.setUTCDate(weekAfterLast.getUTCDate() + 7);
  return now >= weekAfterLast;
}

// Whole days an invoice is past its due date as of `now` (0 if not past due,
// no due date, or an unparseable date). UTC for determinism. Pure + tested.
export function daysPastDue(dueDate: string | null, now: Date = new Date()): number {
  if (!dueDate) return 0;
  const due = new Date(dueDate + 'T00:00:00Z');
  if (isNaN(due.getTime())) return 0;
  const ms = now.getTime() - due.getTime();
  if (ms <= 0) return 0;
  return Math.floor(ms / 86400000);
}

// Dunning escalation stage for an overdue invoice, keyed off days past the due
// date. Maps to v7 section 5.8:
//   'firm'  -- first/continued weekly notice, firm but kind (under 30 days).
//   'final' -- 30+ days past due: the notice names the service-interruption
//              consequence (continued non-payment lets the Practice pause
//              non-critical work now and, after additional written notice and
//              an opportunity to cure, suspend the product, which can take a
//              site offline) and that interest accrues per the agreement. The
//              actual suspension always stays a manual admin action; this only
//              controls the message. The caller restricts 'final' to clients on
//              an executed portal contract -- a legacy client never agreed to
//              the section 5.8 terms, so it stays at 'firm'.
export type DunningStage = 'firm' | 'final';
export function overdueStage(daysPast: number): DunningStage {
  return daysPast >= 30 ? 'final' : 'firm';
}

// The minimum executed portal-agreement template version that carries the
// section 5.8 late-payment terms (1.5%/mo interest + the pause/suspend ladder).
// v6 introduced them; v7 hardened them (and v7 alone expressly bargained the
// site-can-go-offline consequence). A client on a pre-v6 / paper / no agreement
// never agreed to section 5.8 and is never escalated to the 'final' notice.
export const MIN_SECTION_5_8_VERSION = 6;
// The version that expressly bargained the site-unavailability consequence, so
// only this version's clients see the explicit "can take the site offline"
// wording in the 'final' notice.
export const SITE_OFFLINE_BARGAINED_VERSION = 7;

// Resolve the consolidated overdue-notice stage for one client. The notice is
// grouped per client, but a client can hold several contracts at different
// template versions and ages. 'final' (the section 5.8 escalation that names
// interest + the suspension consequence) fires ONLY when an invoice that is
// ITSELF on an executed section-5.8 agreement (template_version >= MIN) is 30+
// days past due. The 30-day trigger must be met by a section-5.8 invoice, never
// by an unrelated legacy/no-agreement invoice that merely shares the email.
// Returns the stage and the highest section-5.8 template version among the
// invoices that drove it, so the caller uses exactly the consequence language
// that version bargained for (v7 = site-can-go-offline; v6 = suspend after
// notice and cure, no offline assertion). Pure + unit-tested.
export function resolveDunningStage(
  invoices: Array<{ daysPast: number; section58Version: number | null }>
): { stage: DunningStage; section58Version: number } {
  const eligible = invoices.filter(i => i.section58Version != null && i.section58Version >= MIN_SECTION_5_8_VERSION);
  if (eligible.length === 0) return { stage: 'firm', section58Version: 0 };
  const maxDays = Math.max(...eligible.map(i => i.daysPast));
  const maxVersion = Math.max(...eligible.map(i => i.section58Version as number));
  return { stage: overdueStage(maxDays), section58Version: maxVersion };
}

// Auto-email eligibility for an overdue invoice (Cody, 2026-06-04: a
// partially-paid invoice is MARKED overdue for visibility but is NOT
// auto-dunned; only a fully-unpaid overdue invoice gets an automatic notice).
// Pure + unit-tested, separate from the date cadence below. The admin can
// still manually Send a partial-paid overdue invoice; this gates only the cron.
export function isAutoOverdueEmailEligible(
  inv: { status: string; amount_paid: number | null; total: number; reminders_paused?: number | null }
): boolean {
  if (inv.status !== 'overdue') return false;
  if (inv.reminders_paused === 1) return false;
  const paid = inv.amount_paid || 0;
  if (paid > 0) return false;        // partially paid -> marked overdue, not auto-emailed
  if (paid >= inv.total) return false; // fully paid (shouldn't be overdue, but guard)
  return true;
}

// The overdue invoices that should receive an automatic notice right now. SQL
// narrows to overdue + has-a-due-date; the pure predicates apply the
// fully-unpaid eligibility rule and the due+7 / weekly cadence, so both are
// testable in one place. `now` is injectable for tests.
export async function getOverdueNoticeCandidates(now: Date = new Date()): Promise<any[]> {
  const rows = await queryAll(
    `SELECT * FROM invoices
      WHERE status = 'overdue' AND due_date IS NOT NULL
      ORDER BY due_date, invoice_number`
  );
  return rows.filter(inv => isAutoOverdueEmailEligible(inv) && isOverdueNoticeDue(inv, now));
}

// Send an overdue notice to each eligible invoice's billing contact (+ the
// accountant CC and any per-invoice extra). Firm but kind, value-first (keep
// the engagement uninterrupted). Stamps last_reminder_sent so the weekly
// cadence advances. Honors reminders_paused via the candidate query. Returns
// the count sent. Run from the daily cron, after markOverdueInvoices.
export async function sendOverdueNotices(now: Date = new Date()): Promise<{ sent: number; failed: number }> {
  const { sendEmail } = await import('./email');
  const candidates = await getOverdueNoticeCandidates(now);

  // Consolidate per client: one notice per client per run listing every overdue
  // invoice (Cody, 2026-06-04: "sven gets confused easily"). last_reminder_sent
  // is still stamped per invoice so each one's weekly cadence advances.
  const byClient = new Map<string, any[]>();
  for (const inv of candidates) {
    const arr = byClient.get(inv.client_id) || [];
    arr.push(inv);
    byClient.set(inv.client_id, arr);
  }

  // lookupAgr drives the section 5.8 message type (executed v6+); isManual gates
  // a fully hand-billed client out of all automated notices.
  const lookupAgr = makeAgreementLookup();
  const isManual = makeManualBillingLookup();
  const portalUrl = import.meta.env.SITE || 'https://codyasmith.com';
  let sent = 0, failed = 0;

  for (const [clientId, invoices] of byClient) {
    try {
      if (await isManual(clientId)) continue;
      const meta = await getClientMetadata(clientId).catch(() => null);
      const users = await getUsersByClientId(clientId);
      const recipients = resolveInvoiceRecipients({
        primaryEmail: meta?.primary_contact_email,
        billingCcEmail: meta?.billing_cc_email,
        extraEmail: sharedExtraRecipient(invoices),
        fallbackEmails: users.map(u => u.email),
      });
      if (recipients.to.length === 0) continue;

      const balance = invoices.reduce((s, i) => s + (i.total - (i.amount_paid || 0)), 0);
      const balanceStr = '$' + balance.toFixed(2);
      const multi = invoices.length > 1;

      // Escalation stage (Phase 4, section 5.8). resolveDunningStage drives
      // 'final' (30+ days) ONLY from invoices that are THEMSELVES on an executed
      // section-5.8 agreement (template_version >= 6) -- never from an unrelated
      // legacy/no-agreement invoice that merely shares this client's email. A
      // pre-v6 / paper / no-agreement client never agreed to section 5.8 and
      // stays at the firm notice. section58Version is the version that drove the
      // stage, so the body uses exactly the consequence that version bargained
      // for. Any actual suspension is always a manual admin action; this only
      // sets the wording. We require status === 'executed' so a rolled-back or
      // voided-but-still-linked agreement can never back the escalation.
      const stageInvoices: Array<{ daysPast: number; section58Version: number | null }> = [];
      for (const inv of invoices) {
        // An invoice counts toward the section 5.8 stage only if it is on an
        // EXECUTED portal agreement at v6+. A non-standard client (no executed
        // agreement) yields section58Version 0 -> the 'default' message.
        const agr = await lookupAgr(inv.contract_id);
        const section58Version = agr && agr.status === 'executed' && agr.template_version >= MIN_SECTION_5_8_VERSION ? agr.template_version : null;
        stageInvoices.push({ daysPast: daysPastDue(inv.due_date, now), section58Version });
      }
      const { stage, section58Version } = resolveDunningStage(stageInvoices);
      const offlineBargained = section58Version >= SITE_OFFLINE_BARGAINED_VERSION;
      const msgType = dunningMessageType(section58Version, stage);

      const subject = stage === 'final'
        ? `Action needed to avoid service interruption: ${balanceStr} past due`
        : (multi ? `Past due: ${invoices.length} invoices (${balanceStr})` : `Past due: invoice ${invoices[0].invoice_number} (${balanceStr})`);

      const listOrLead = multi
        ? `<p style="color: #525252; line-height: 1.6; margin-bottom: 8px;">The following invoices are past due, totaling <strong>${balanceStr}</strong>:</p>
           <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">${invoices.map(invoiceRowHtml).join('')}</table>`
        : `<p style="color: #525252; line-height: 1.6; margin-bottom: 8px;">Invoice <strong>${invoices[0].invoice_number}</strong> was due on <strong>${invoices[0].due_date}</strong> and shows a balance of <strong>${balanceStr}</strong>.</p>`;

      let bodyMid: string;
      if (msgType === 'final') {
        // 30+ days past due, client on an executed section-5.8 contract. Name
        // the consequence plainly: continued non-payment lets us pause
        // non-critical work now and, after additional written notice and an
        // opportunity to cure, suspend the affected service. Interest accrues
        // per the agreement. Everything is reversible on payment. The explicit
        // "site can go offline" consequence is bargained only in v7 section 5.8,
        // so it is added only for a v7+ contract; a v6 contract gets the same
        // ladder without that assertion (which v6's text does not support).
        const offlineSentence = offlineBargained
          ? ' For a managed site that can mean hosting, backups, and monitoring stop, which can take the site offline.'
          : '';
        bodyMid = `
          <p style="color: #525252; line-height: 1.6; margin-bottom: 8px;">This balance is now more than 30 days past due. Under our agreement, an unpaid balance accrues interest at 1.5% per month, and continued non-payment allows us to pause non-critical work now and, after further written notice and a chance to make it right, to suspend the affected service.${offlineSentence}</p>
          <p style="color: #525252; line-height: 1.6; margin-bottom: 8px;">I would much rather keep everything running. If there is a problem with the invoice or the timing, just reply and we will work it out. A suspension is always reversible once the balance is settled.</p>`;
      } else if (msgType === 'default') {
        // Non-standard client: no executed portal contract, so NO interest or
        // suspension language (they never agreed to section 5.8). Plain past-due
        // nudge + a FAINT reminder of the 30-day written notice to cancel, to
        // hold our position (Cody, 2026-06-05).
        bodyMid = `
          <p style="color: #525252; line-height: 1.6; margin-bottom: 8px;">When you have a moment, please settle this so your account stays current. If it is already on its way, thank you and please disregard, and if anything needs sorting out, just reply and we will take care of it.</p>
          <p style="color: #a3a3a3; line-height: 1.5; font-size: 12px; margin-top: 20px;">As a reminder, ending an engagement requires thirty (30) days' written notice.</p>`;
      } else {
        // Portal-contract client, under 30 days past due (firm but kind).
        const stakesLine = invoices.some(i => !i.billing_period_start)
          ? 'Settling it gets your work moving.'
          : 'Keeping it current keeps your service running without interruption.';
        bodyMid = `
          <p style="color: #525252; line-height: 1.6; margin-bottom: 8px;">${stakesLine}</p>
          <p style="color: #525252; line-height: 1.6; margin-bottom: 8px;">If it is already on its way, thank you and please disregard. If something needs sorting out, just reply and we will take care of it.</p>`;
      }

      const ok = await sendEmail(
        recipients.to.map(e => ({ email: e, name: '' })),
        subject,
        `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #171717; margin-bottom: 16px;">${stage === 'final' ? 'A past-due balance that needs attention' : (multi ? 'A quick note on your past-due invoices' : `A quick note on invoice ${invoices[0].invoice_number}`)}</h2>
          ${listOrLead}
          ${bodyMid}
          <a href="${portalUrl}/portal/invoices" style="display: inline-block; background: #f59e0b; color: #0a0a0a; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; margin-top: 16px;">
            View ${multi ? 'invoices' : 'invoice'} in portal
          </a>
          <p style="color: #a3a3a3; font-size: 12px; margin-top: 32px;">
            <a href="${portalUrl}" style="color: #a3a3a3;">codyasmith.com</a>
          </p>
        </div>
        `,
        { cc: recipients.cc.map(e => ({ email: e })) }
      );

      if (ok) {
        const stamp = now.toISOString();
        for (const inv of invoices) await updateInvoice(inv.id, { last_reminder_sent: stamp });
        sent++;
      } else {
        failed++;
      }
    } catch (err) {
      logger.error(`Failed to send overdue notice for client ${clientId}`, err);
      failed++;
    }
  }

  return { sent, failed };
}

// Read-only preview of what the daily cron WOULD do, for verifying the
// trigger before it fires real invoices. Mirrors the gating in
// generateInvoiceForContract, markOverdueInvoices, and getDueInvoices, but
// issues no INSERT/UPDATE and sends no email. Backs /api/cron/daily?dry=1.
export async function previewDailyCron(): Promise<{
  would_generate: Array<{ contract_id: string; title: string; client_id: string; period_start: string; period_end: string; amount: number }>;
  would_mark_overdue: Array<{ id: string; invoice_number: string; due_date: string | null }>;
  would_remind: Array<{ id: string; invoice_number: string; due_date: string | null; total: number }>;
  would_send_overdue: Array<{ id: string; invoice_number: string; due_date: string | null; balance: number }>;
}> {
  const now = new Date();
  // Shared cached lookups so the dry run matches the live senders/generator and
  // each contract/client is read once across the whole preview.
  const lookupAgr = makeAgreementLookup();
  const isManual = makeManualBillingLookup();

  const would_generate: Array<{ contract_id: string; title: string; client_id: string; period_start: string; period_end: string; amount: number }> = [];
  const contracts = await getAllContracts();
  for (const c of contracts) {
    if (c.status !== 'active' || c.billing_cadence !== 'monthly' || !c.billing_day || !c.recurring_amount) continue;
    if (await isManual(c.client_id)) continue; // hand-billed; not auto-generated
    const period = getUpcomingBillingPeriod(c.billing_day, now);
    if (await invoiceExistsForPeriod(c.id, period.start, period.end)) continue;
    const issueThreshold = new Date(period.start + 'T00:00:00');
    issueThreshold.setDate(issueThreshold.getDate() - 7);
    if (now < issueThreshold) continue;
    // Match what the generator will actually bill so the dry-run total is
    // accurate: recurring + contracted pass-through + due recurring expenses.
    // (Generation is not gated on an agreement; see generateInvoiceForContract.)
    const billDateP = now.toISOString().split('T')[0];
    const dueExp = await getExpensesDueForBilling(c.client_id, billDateP);
    const reimbTotal = dueExp.reduce((s, e) => s + e.amount, 0);
    const agr = await lookupAgr(c.id);
    const ptItems: any[] = Array.isArray(agr?.schedule_a?.pass_through_items) ? agr!.schedule_a.pass_through_items : [];
    const ptTotal = ptItems.reduce((s: number, p: any) => s + (Number(p?.monthly_cost) || 0), 0);
    would_generate.push({
      contract_id: c.id,
      title: c.title,
      client_id: c.client_id,
      period_start: period.start,
      period_end: period.end,
      amount: c.recurring_amount + ptTotal + reimbTotal,
    });
  }

  const overdueRes = await turso.execute({
    sql: `SELECT id, invoice_number, due_date FROM invoices WHERE ${OVERDUE_MARK_WHERE}`,
  });
  const would_mark_overdue = (overdueRes.rows as any[]).map(r => ({
    id: r[0] as string,
    invoice_number: r[1] as string,
    due_date: (r[2] as string | null) ?? null,
  }));

  // would_remind / would_send_overdue apply the manual-billing gate so the dry
  // run shows exactly who the live senders would email (hand-billed clients are
  // excluded; non-standard clients ARE included -- they get the default notice).
  const due = await getDueInvoices(3);
  const would_remind: Array<{ id: string; invoice_number: string; due_date: string | null; total: number }> = [];
  for (const i of due as any[]) {
    if (await isManual(i.client_id)) continue;
    would_remind.push({
      id: i.id as string,
      invoice_number: i.invoice_number as string,
      due_date: (i.due_date as string | null) ?? null,
      total: i.total as number,
    });
  }

  // Overdue notices the cron would send right now (due+7, then weekly). The
  // live cron runs markOverdueInvoices BEFORE sendOverdueNotices, so an invoice
  // still 'sent' but already past due would be marked overdue and then noticed
  // in the same run. To preview the real outcome (not the pre-mark state), the
  // dry run includes 'sent'-and-past-due rows alongside 'overdue' ones, then
  // applies the SAME eligibility (fully-unpaid only; partials are marked
  // overdue but never auto-emailed) and cadence sendOverdueNotices uses. We
  // pass status='overdue' into the eligibility predicate because that is the
  // status these rows will hold after markOverdueInvoices runs.
  const overdueRows = await queryAll(
    `SELECT * FROM invoices
      WHERE due_date IS NOT NULL
        AND (status = 'overdue' OR (status IN ('sent', 'partial') AND due_date < date('now')))`
  );
  const would_send_overdue: Array<{ id: string; invoice_number: string; due_date: string | null; balance: number }> = [];
  for (const i of overdueRows) {
    if (!(isAutoOverdueEmailEligible({ ...i, status: 'overdue' }) && isOverdueNoticeDue(i, now))) continue;
    if (await isManual(i.client_id)) continue;
    would_send_overdue.push({
      id: i.id as string,
      invoice_number: i.invoice_number as string,
      due_date: (i.due_date as string | null) ?? null,
      balance: (i.total as number) - ((i.amount_paid as number) || 0),
    });
  }

  return { would_generate, would_mark_overdue, would_remind, would_send_overdue };
}
