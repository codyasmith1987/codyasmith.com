// Billing engine — recurring invoice generation, hours tracking, overage, pending charges, reminders

import { nanoid } from 'nanoid';
import turso from './turso';
import { getAllContracts, getContract, type Contract } from './contracts';
import { createInvoice, generateInvoiceNumber, addInvoiceItem, getInvoice, updateInvoice } from './invoices';
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

export function getCurrentBillingPeriod(billingDay: number): { start: string; end: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed

  // If we haven't reached billing day this month, the current period started last month
  if (now.getDate() < billingDay) {
    const startMonth = month === 0 ? 11 : month - 1;
    const startYear = month === 0 ? year - 1 : year;
    const start = `${startYear}-${String(startMonth + 1).padStart(2, '0')}-${String(billingDay).padStart(2, '0')}`;
    const end = `${year}-${String(month + 1).padStart(2, '0')}-${String(billingDay - 1).padStart(2, '0')}`;
    return { start, end };
  }

  // Otherwise, current period started this month
  const endMonth = month === 11 ? 0 : month + 1;
  const endYear = month === 11 ? year + 1 : year;
  const start = `${year}-${String(month + 1).padStart(2, '0')}-${String(billingDay).padStart(2, '0')}`;
  const end = `${endYear}-${String(endMonth + 1).padStart(2, '0')}-${String(billingDay - 1).padStart(2, '0')}`;
  return { start, end };
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

export async function generateInvoiceForContract(contract: Contract, createdBy: string): Promise<string | null> {
  if (contract.status !== 'active' || contract.billing_cadence !== 'monthly' || !contract.billing_day || !contract.recurring_amount) {
    return null;
  }

  const period = getCurrentBillingPeriod(contract.billing_day);

  // Check if invoice already exists for this period
  if (await invoiceExistsForPeriod(contract.id, period.start, period.end)) {
    return null;
  }

  // Check if billing day has arrived
  const today = new Date().getDate();
  if (today < contract.billing_day) {
    return null;
  }

  // Generate the invoice
  const invoiceNumber = await generateInvoiceNumber();
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + (contract.payment_terms_days ?? 30));

  const invoiceId = await createInvoice({
    contract_id: contract.id,
    client_id: contract.client_id,
    invoice_number: invoiceNumber,
    due_date: dueDate.toISOString().split('T')[0],
    created_by: createdBy,
  });

  // Set billing period
  await updateInvoice(invoiceId, {
    billing_period_start: period.start,
    billing_period_end: period.end,
    issued_date: new Date().toISOString().split('T')[0],
    status: 'draft',
    client_visible: 1,
  });

  // Add recurring amount line item
  await addInvoiceItem({
    invoice_id: invoiceId,
    description: `${contract.title} (${period.start} to ${period.end})`,
    quantity: 1,
    unit_price: contract.recurring_amount,
  });

  // Add pending charges (change orders, overage, one-time)
  const pendingCharges = await getPendingChargesForContract(contract.id);
  const chargeIds: string[] = [];
  for (const charge of pendingCharges) {
    await addInvoiceItem({
      invoice_id: invoiceId,
      description: charge.description,
      quantity: 1,
      unit_price: charge.amount,
    });
    chargeIds.push(charge.id);
  }

  // Mark charges as billed
  if (chargeIds.length > 0) {
    await markChargesAsBilled(chargeIds, invoiceId);
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
    "SELECT * FROM invoices WHERE status = 'sent' AND due_date <= ? AND due_date >= date('now') AND last_reminder_sent IS NULL AND amount_paid < total",
    [cutoff.toISOString().split('T')[0]]
  );
}

export async function sendDueReminders(): Promise<number> {
  const { sendEmail } = await import('./email');
  const dueInvoices = await getDueInvoices(3);
  let sent = 0;

  for (const invoice of dueInvoices) {
    try {
      const contract = await getContract(invoice.contract_id);
      if (!contract) continue;

      const users = await getUsersByClientId(contract.client_id);
      if (users.length === 0) continue;

      const portalUrl = import.meta.env.SITE || 'https://codyasmith.com';
      const ok = await sendEmail(
        users.map(u => ({ email: u.email, name: u.name })),
        `Invoice ${invoice.invoice_number}: payment due ${invoice.due_date}`,
        `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
          <h2 style="color: #171717; margin-bottom: 16px;">Payment reminder</h2>
          <p style="color: #525252; line-height: 1.6; margin-bottom: 8px;">
            Invoice <strong>${invoice.invoice_number}</strong> for <strong>$${invoice.total.toFixed(2)}</strong> is due on <strong>${invoice.due_date}</strong>.
          </p>
          ${invoice.amount_paid > 0 ? `<p style="color: #525252; line-height: 1.6; margin-bottom: 8px;">Amount paid so far: $${invoice.amount_paid.toFixed(2)}. Remaining: $${(invoice.total - invoice.amount_paid).toFixed(2)}.</p>` : ''}
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
