// Billing engine — recurring invoice generation, hours tracking, overage, pending charges, reminders

import { nanoid } from 'nanoid';
import turso from './turso';
import { getAllContracts, getContract, type Contract } from './contracts';
import { createInvoiceWithGeneratedNumber, addInvoiceItem, getInvoice, updateInvoice } from './invoices';
import { getExpensesDueForBilling, markExpensesBilled } from './client-expenses';
import { getAgreementByContractId, getClientMetadata } from './agreements';
import { resolveInvoiceRecipients } from './invoice-emails';
import { createNotification } from './notifications';
import { getUsersByClientId } from './auth';
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

export async function generateInvoiceForContract(contract: Contract, createdBy: string, now: Date = new Date()): Promise<string | null> {
  if (contract.status !== 'active' || contract.billing_cadence !== 'monthly' || !contract.billing_day || !contract.recurring_amount) {
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

  // Add recurring amount line item (structured: a monthly Services line named
  // for the contract, with the billing period as the sub-description). Amount
  // unchanged; description kept for the legacy fallback.
  await addInvoiceItem({
    invoice_id: invoiceId,
    name: contract.title,
    sub_description: `${period.start} to ${period.end}`,
    description: `${contract.title} (${period.start} to ${period.end})`,
    category: 'services',
    frequency: 'monthly',
    quantity: 1,
    unit_price: contract.recurring_amount,
  });

  // Contracted pass-through: the monthly plugin/software management fee from the
  // signed Schedule A (a Services line, distinct from out-of-pocket
  // reimbursements). Summed across sites to match the hand-invoice presentation.
  const agreement = await getAgreementByContractId(contract.id);
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
    "SELECT * FROM invoices WHERE status = 'sent' AND due_date <= ? AND due_date >= date('now') AND last_reminder_sent IS NULL AND amount_paid < total AND (reminders_paused = 0 OR reminders_paused IS NULL)",
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

export async function sendDueReminders(): Promise<number> {
  const { sendEmail } = await import('./email');
  const dueInvoices = await getDueInvoices(3);
  let sent = 0;

  for (const invoice of dueInvoices) {
    try {
      const contract = await getContract(invoice.contract_id);
      if (!contract) continue;

      // Recipient model (Cody, 2026-06-04): a payment reminder is a financial
      // notice, so it goes to the billing contact + accountant CC, not every
      // portal user. Falls back to the first portal user if no contact is set.
      const meta = await getClientMetadata(invoice.client_id).catch(() => null);
      const users = await getUsersByClientId(invoice.client_id);
      const recipients = resolveInvoiceRecipients({
        primaryEmail: meta?.primary_contact_email,
        billingCcEmail: meta?.billing_cc_email,
        extraEmail: invoice.extra_recipient_email,
        fallbackEmails: users.map(u => u.email),
      });
      if (recipients.to.length === 0) continue;

      const portalUrl = import.meta.env.SITE || 'https://codyasmith.com';
      // An at-signing invoice (no billing period) gates work starting per
      // section 5.2; a recurring invoice keeps service going. Name the
      // consequence so the client understands what is at stake.
      const isAtSigning = !invoice.billing_period_start;
      const subject = isAtSigning
        ? `Your invoice to get started is due ${invoice.due_date}. Work begins once it clears.`
        : `Invoice ${invoice.invoice_number}: payment due ${invoice.due_date}`;
      const leadLine = isAtSigning
        ? `Your at-signing invoice <strong>${invoice.invoice_number}</strong> for <strong>$${invoice.total.toFixed(2)}</strong> is due on <strong>${invoice.due_date}</strong>. Work begins as soon as it clears.`
        : `Invoice <strong>${invoice.invoice_number}</strong> for <strong>$${invoice.total.toFixed(2)}</strong> is due on <strong>${invoice.due_date}</strong>.`;
      const ok = await sendEmail(
        recipients.to.map(e => ({ email: e, name: '' })),
        subject,
        `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #171717; margin-bottom: 16px;">${isAtSigning ? 'Getting started' : 'Payment reminder'}</h2>
          <p style="color: #525252; line-height: 1.6; margin-bottom: 8px;">${leadLine}</p>
          ${invoice.amount_paid > 0 ? `<p style="color: #525252; line-height: 1.6; margin-bottom: 8px;">Amount paid so far: $${invoice.amount_paid.toFixed(2)}. Remaining: $${(invoice.total - invoice.amount_paid).toFixed(2)}.</p>` : ''}
          <a href="${portalUrl}/portal/invoices" style="display: inline-block; background: #f59e0b; color: #0a0a0a; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; margin-top: 16px;">
            View invoice in portal
          </a>
          <p style="color: #a3a3a3; font-size: 12px; margin-top: 32px;">
            <a href="${portalUrl}" style="color: #a3a3a3;">codyasmith.com</a>
          </p>
        </div>
        `,
        { cc: recipients.cc.map(e => ({ email: e })) }
      );

      if (ok) {
        await updateInvoice(invoice.id, { last_reminder_sent: new Date().toISOString() });
        sent++;
      }
    } catch (err) {
      logger.error(`Failed to send reminder for invoice ${invoice.id}`, err);
    }
  }

  return sent;
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
      WHERE status = 'overdue' AND due_date IS NOT NULL`
  );
  return rows.filter(inv => isAutoOverdueEmailEligible(inv) && isOverdueNoticeDue(inv, now));
}

// Send an overdue notice to each eligible invoice's billing contact (+ the
// accountant CC and any per-invoice extra). Firm but kind, value-first (keep
// the engagement uninterrupted). Stamps last_reminder_sent so the weekly
// cadence advances. Honors reminders_paused via the candidate query. Returns
// the count sent. Run from the daily cron, after markOverdueInvoices.
export async function sendOverdueNotices(now: Date = new Date()): Promise<number> {
  const { sendEmail } = await import('./email');
  const candidates = await getOverdueNoticeCandidates(now);
  let sent = 0;

  for (const invoice of candidates) {
    try {
      const meta = await getClientMetadata(invoice.client_id).catch(() => null);
      const users = await getUsersByClientId(invoice.client_id);
      const recipients = resolveInvoiceRecipients({
        primaryEmail: meta?.primary_contact_email,
        billingCcEmail: meta?.billing_cc_email,
        extraEmail: invoice.extra_recipient_email,
        fallbackEmails: users.map(u => u.email),
      });
      if (recipients.to.length === 0) continue;

      const portalUrl = import.meta.env.SITE || 'https://codyasmith.com';
      const balance = invoice.total - (invoice.amount_paid || 0);
      const balanceStr = '$' + balance.toFixed(2);
      const isAtSigning = !invoice.billing_period_start;
      const subject = `Past due: invoice ${invoice.invoice_number} (${balanceStr})`;
      // Name the consequence so the reminder is useful, not just a nag: an
      // at-signing invoice gates work starting; a recurring one keeps service
      // going. Keep it warm and resolvable (reply to sort it out).
      const stakesLine = isAtSigning
        ? 'Work begins as soon as it clears, so settling it gets us moving.'
        : 'Keeping it current keeps your service running without interruption.';
      const ok = await sendEmail(
        recipients.to.map(e => ({ email: e, name: '' })),
        subject,
        `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #171717; margin-bottom: 16px;">A quick note on invoice ${invoice.invoice_number}</h2>
          <p style="color: #525252; line-height: 1.6; margin-bottom: 8px;">Invoice <strong>${invoice.invoice_number}</strong> was due on <strong>${invoice.due_date}</strong> and shows a balance of <strong>${balanceStr}</strong>. ${stakesLine}</p>
          <p style="color: #525252; line-height: 1.6; margin-bottom: 8px;">If it is already on its way, thank you and please disregard. If something needs sorting out, just reply and we will take care of it.</p>
          <a href="${portalUrl}/portal/invoices" style="display: inline-block; background: #f59e0b; color: #0a0a0a; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px; margin-top: 16px;">
            View invoice in portal
          </a>
          <p style="color: #a3a3a3; font-size: 12px; margin-top: 32px;">
            <a href="${portalUrl}" style="color: #a3a3a3;">codyasmith.com</a>
          </p>
        </div>
        `,
        { cc: recipients.cc.map(e => ({ email: e })) }
      );

      if (ok) {
        await updateInvoice(invoice.id, { last_reminder_sent: now.toISOString() });
        sent++;
      }
    } catch (err) {
      logger.error(`Failed to send overdue notice for invoice ${invoice.id}`, err);
    }
  }

  return sent;
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

  const would_generate: Array<{ contract_id: string; title: string; client_id: string; period_start: string; period_end: string; amount: number }> = [];
  const contracts = await getAllContracts();
  for (const c of contracts) {
    if (c.status !== 'active' || c.billing_cadence !== 'monthly' || !c.billing_day || !c.recurring_amount) continue;
    const period = getUpcomingBillingPeriod(c.billing_day, now);
    if (await invoiceExistsForPeriod(c.id, period.start, period.end)) continue;
    const issueThreshold = new Date(period.start + 'T00:00:00');
    issueThreshold.setDate(issueThreshold.getDate() - 7);
    if (now < issueThreshold) continue;
    // Match what the generator will actually bill so the dry-run total is
    // accurate: recurring + contracted pass-through + due recurring expenses.
    const billDateP = now.toISOString().split('T')[0];
    const dueExp = await getExpensesDueForBilling(c.client_id, billDateP);
    const reimbTotal = dueExp.reduce((s, e) => s + e.amount, 0);
    const agr = await getAgreementByContractId(c.id);
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

  const due = await getDueInvoices(3);
  const would_remind = (due as any[]).map(i => ({
    id: i.id as string,
    invoice_number: i.invoice_number as string,
    due_date: (i.due_date as string | null) ?? null,
    total: i.total as number,
  }));

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
  const would_send_overdue = overdueRows
    .filter(i => isAutoOverdueEmailEligible({ ...i, status: 'overdue' }) && isOverdueNoticeDue(i, now))
    .map(i => ({
      id: i.id as string,
      invoice_number: i.invoice_number as string,
      due_date: (i.due_date as string | null) ?? null,
      balance: (i.total as number) - ((i.amount_paid as number) || 0),
    }));

  return { would_generate, would_mark_overdue, would_remind, would_send_overdue };
}
