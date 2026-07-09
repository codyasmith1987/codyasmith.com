// Recurring expense templates per client: the source for an invoice's
// Reimbursements section (plugin/tool licenses Cody pays for and passes through,
// e.g. Kadence, UptimeRobot). Cody's decision (2026-06-03): a recurring-template
// model, not a one-off ledger. Cadence-aware: a 'monthly' template recurs on
// every invoice, 'annual' roughly yearly, 'one_time' once. Table: migration 064.

import { nanoid } from 'nanoid';
import turso from './turso';

export type ExpenseFrequency = 'monthly' | 'annual' | 'one_time';

export interface ClientExpense {
  id: string;
  client_id: string;
  name: string;
  amount: number;
  frequency: ExpenseFrequency;
  active: number;
  last_billed_on: string | null;
  billed_invoice_id: string | null;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// Pure. Should this active template be billed onto an invoice dated `asOf`
// (YYYY-MM-DD)? monthly -> every invoice; one_time -> only if never billed;
// annual -> if never billed or ~11+ months since the last bill (tolerance so an
// early/late monthly run does not skip or double the yearly charge).
export function expenseDueForBilling(
  expense: { frequency: string; last_billed_on?: string | null; active?: number },
  asOf: string,
): boolean {
  if (expense.active === 0) return false;
  const last = expense.last_billed_on || null;
  switch (expense.frequency) {
    case 'monthly':
      return true;
    case 'one_time':
      return !last;
    case 'annual': {
      if (!last) return true;
      const lastDate = new Date(last + 'T00:00:00Z');
      const asOfDate = new Date(asOf + 'T00:00:00Z');
      const months = (asOfDate.getUTCFullYear() - lastDate.getUTCFullYear()) * 12
        + (asOfDate.getUTCMonth() - lastDate.getUTCMonth());
      return months >= 11;
    }
    default:
      return false;
  }
}

const COLS = 'id, client_id, name, amount, frequency, active, last_billed_on, billed_invoice_id, notes, created_by, created_at, updated_at';

function rowToExpense(columns: string[], row: any[]): ClientExpense {
  return Object.fromEntries(columns.map((c, i) => [c, row[i]])) as unknown as ClientExpense;
}

export async function addClientExpense(data: {
  client_id: string; name: string; amount: number; frequency: ExpenseFrequency;
  notes?: string | null; created_by: string;
}): Promise<string> {
  const id = nanoid();
  await turso.execute({
    sql: `INSERT INTO client_expenses (id, client_id, name, amount, frequency, notes, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [id, data.client_id, data.name, data.amount, data.frequency, data.notes ?? null, data.created_by],
  });
  return id;
}

export async function getClientExpenses(clientId: string): Promise<ClientExpense[]> {
  const r = await turso.execute({
    sql: `SELECT ${COLS} FROM client_expenses WHERE client_id = ? ORDER BY active DESC, name`,
    args: [clientId],
  });
  return r.rows.map(row => rowToExpense(r.columns, row as any[]));
}

// Active templates due to be billed onto an invoice dated `asOf`.
export async function getExpensesDueForBilling(clientId: string, asOf: string): Promise<ClientExpense[]> {
  const r = await turso.execute({
    sql: `SELECT ${COLS} FROM client_expenses WHERE client_id = ? AND active = 1`,
    args: [clientId],
  });
  return r.rows.map(row => rowToExpense(r.columns, row as any[])).filter(e => expenseDueForBilling(e, asOf));
}

export async function markExpensesBilled(ids: string[], dateISO: string, invoiceId: string): Promise<void> {
  for (const id of ids) {
    await turso.execute({
      sql: `UPDATE client_expenses SET last_billed_on = ?, billed_invoice_id = ?, updated_at = datetime('now') WHERE id = ?`,
      args: [dateISO, invoiceId, id],
    });
  }
}

// When an invoice that billed recurring-expense templates is deleted, un-stamp
// those templates so they become due again on the next generation (otherwise an
// annual/one_time template would silently skip its cycle - dual-audit finding).
export async function clearExpenseBillingForInvoice(invoiceId: string): Promise<void> {
  await turso.execute({
    sql: `UPDATE client_expenses SET last_billed_on = NULL, billed_invoice_id = NULL, updated_at = datetime('now') WHERE billed_invoice_id = ?`,
    args: [invoiceId],
  });
}

export async function updateClientExpense(
  id: string,
  data: Partial<{ name: string; amount: number; frequency: ExpenseFrequency; active: number; notes: string | null }>,
): Promise<void> {
  const allowed = new Set(['name', 'amount', 'frequency', 'active', 'notes']);
  const fields: string[] = [];
  const args: any[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || !allowed.has(k)) continue;
    fields.push(`${k} = ?`);
    args.push(v);
  }
  if (!fields.length) return;
  fields.push("updated_at = datetime('now')");
  args.push(id);
  await turso.execute({ sql: `UPDATE client_expenses SET ${fields.join(', ')} WHERE id = ?`, args });
}

export async function deleteClientExpense(id: string): Promise<void> {
  await turso.execute({ sql: `DELETE FROM client_expenses WHERE id = ?`, args: [id] });
}
