// Invoices, invoice items, payments, approvals, and change orders — CRUD helpers

import { nanoid } from 'nanoid';
import turso from './turso';

// --- Column allowlists for dynamic UPDATE builders ---
const UPDATABLE_COLUMNS: Record<string, Set<string>> = {
  invoices: new Set(['status', 'issued_date', 'due_date', 'subtotal', 'tax', 'total', 'amount_paid', 'notes', 'client_visible', 'billing_period_start', 'billing_period_end', 'last_reminder_sent']),
  invoice_items: new Set(['description', 'quantity', 'unit_price', 'amount', 'sort_order']),
  change_orders: new Set(['title', 'description', 'status', 'cost_impact', 'time_impact_days']),
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

// --- Query helpers ---

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
// Invoices
// ============================================================

export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'partial' | 'overdue' | 'cancelled';

export interface Invoice {
  id: string;
  contract_id: string;
  client_id: string;
  milestone_id: string | null;
  invoice_number: string;
  status: InvoiceStatus;
  issued_date: string | null;
  due_date: string | null;
  subtotal: number;
  tax: number;
  total: number;
  amount_paid: number;
  notes: string | null;
  client_visible: number;
  billing_period_start: string | null;
  billing_period_end: string | null;
  last_reminder_sent: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export async function generateInvoiceNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const result = await turso.execute({
    sql: 'SELECT invoice_number FROM invoices WHERE invoice_number LIKE ?',
    args: [`INV-${year}-%`],
  });
  let maxSeq = 0;
  const re = new RegExp(`^INV-${year}-(\\d+)$`);
  for (const row of result.rows as any[]) {
    const match = String(row[0] || '').match(re);
    if (!match) continue;
    const n = Number.parseInt(match[1], 10);
    if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
  }
  const seq = (maxSeq + 1).toString().padStart(4, '0');
  return `INV-${year}-${seq}`;
}

export interface CreateInvoiceInput {
  contract_id: string;
  client_id: string;
  milestone_id?: string;
  invoice_number: string;
  due_date?: string;
  notes?: string;
  created_by: string;
}

function isInvoiceNumberCollision(err: any): boolean {
  const message = String(err?.message || err || '');
  return /UNIQUE/i.test(message) && /invoice/i.test(message);
}

function isDatabaseBusy(err: any): boolean {
  return /SQLITE_BUSY|database is locked/i.test(String(err?.message || err || ''));
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function createInvoice(data: CreateInvoiceInput): Promise<string> {
  const id = nanoid();
  await turso.execute({
    sql: `INSERT INTO invoices (id, contract_id, client_id, milestone_id, invoice_number, due_date, notes, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, data.contract_id, data.client_id, data.milestone_id ?? null,
      data.invoice_number, data.due_date ?? null, data.notes ?? null,
      data.created_by,
    ],
  });
  return id;
}

export async function createInvoiceWithGeneratedNumber(
  data: Omit<CreateInvoiceInput, 'invoice_number'>,
): Promise<{ id: string; invoice_number: string }> {
  let lastErr: any;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const invoice_number = await generateInvoiceNumber();
      const id = await createInvoice({ ...data, invoice_number });
      return { id, invoice_number };
    } catch (err: any) {
      lastErr = err;
      if (!isInvoiceNumberCollision(err) && !isDatabaseBusy(err)) throw err;
      await delay(50 * (attempt + 1));
    }
  }
  throw lastErr;
}

export async function getInvoice(id: string): Promise<Invoice | undefined> {
  return queryOne('SELECT * FROM invoices WHERE id = ?', [id]);
}

export async function getInvoiceByNumber(invoiceNumber: string): Promise<Invoice | undefined> {
  return queryOne('SELECT * FROM invoices WHERE invoice_number = ?', [invoiceNumber]);
}

export async function getInvoicesByClient(clientId: string): Promise<Invoice[]> {
  return queryAll('SELECT * FROM invoices WHERE client_id = ? ORDER BY created_at DESC', [clientId]);
}

export async function getInvoicesByContract(contractId: string): Promise<Invoice[]> {
  return queryAll('SELECT * FROM invoices WHERE contract_id = ? ORDER BY created_at DESC', [contractId]);
}

export async function getInvoicesByStatus(status: InvoiceStatus): Promise<Invoice[]> {
  return queryAll('SELECT * FROM invoices WHERE status = ? ORDER BY created_at DESC', [status]);
}

export async function getOverdueInvoices(): Promise<Invoice[]> {
  return queryAll(
    "SELECT * FROM invoices WHERE status = 'sent' AND due_date < date('now') ORDER BY due_date",
    []
  );
}

// Client-safe: excludes created_by, contract_id, milestone_id (admin context)
export async function getClientVisibleInvoices(clientId: string): Promise<Pick<Invoice, 'id' | 'invoice_number' | 'status' | 'issued_date' | 'due_date' | 'total' | 'amount_paid' | 'notes'>[]> {
  return queryAll(
    'SELECT id, invoice_number, status, issued_date, due_date, total, amount_paid, notes FROM invoices WHERE client_id = ? AND client_visible = 1 ORDER BY created_at DESC',
    [clientId]
  );
}

export async function updateInvoice(id: string, data: Partial<Pick<Invoice,
  'status' | 'issued_date' | 'due_date' | 'subtotal' | 'tax' | 'total' | 'amount_paid' | 'notes' | 'client_visible'
>>): Promise<void> {
  const update = buildSafeUpdate('invoices', id, data);
  if (!update) return;
  await turso.execute(update);
}

// Non-atomic: reads items, reads invoice, writes totals in 3 separate operations.
// A concurrent item write between getInvoiceItems and updateInvoice could produce stale totals.
// Acceptable for single-admin portal. If multi-admin support is added, wrap in a transaction.
export async function recalculateInvoiceTotals(invoiceId: string): Promise<void> {
  const items = await getInvoiceItems(invoiceId);
  const subtotal = items.reduce((sum, item) => sum + item.amount, 0);
  const invoice = await getInvoice(invoiceId);
  const tax = invoice?.tax ?? 0;
  await updateInvoice(invoiceId, { subtotal, total: subtotal + tax });
}

export async function deleteInvoice(id: string): Promise<void> {
  await turso.execute({ sql: 'DELETE FROM invoice_items WHERE invoice_id = ?', args: [id] });
  await turso.execute({ sql: 'DELETE FROM payments WHERE invoice_id = ?', args: [id] });
  await turso.execute({ sql: 'DELETE FROM invoices WHERE id = ?', args: [id] });
}

// ============================================================
// Invoice Items
// ============================================================

export interface InvoiceItem {
  id: string;
  invoice_id: string;
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  sort_order: number;
  created_at: string;
}

export async function addInvoiceItem(data: {
  invoice_id: string;
  description: string;
  quantity?: number;
  unit_price: number;
}): Promise<string> {
  const id = nanoid();
  const qty = data.quantity ?? 1;
  const amount = qty * data.unit_price;
  await turso.execute({
    sql: `INSERT INTO invoice_items (id, invoice_id, description, quantity, unit_price, amount)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [id, data.invoice_id, data.description, qty, data.unit_price, amount],
  });
  await recalculateInvoiceTotals(data.invoice_id);
  return id;
}

export async function getInvoiceItems(invoiceId: string): Promise<InvoiceItem[]> {
  return queryAll('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, created_at', [invoiceId]);
}

export async function updateInvoiceItem(id: string, data: Partial<Pick<InvoiceItem,
  'description' | 'quantity' | 'unit_price' | 'sort_order'
>>): Promise<void> {
  const allowed = UPDATABLE_COLUMNS.invoice_items;
  const fields: string[] = [];
  const args: any[] = [];
  for (const [key, val] of Object.entries(data)) {
    if (val === undefined) continue;
    if (!allowed.has(key)) throw new Error(`Invalid column "${key}" for table "invoice_items"`);
    fields.push(`${key} = ?`);
    args.push(val);
  }
  if (fields.length === 0) return;

  // Recalculate amount if quantity or unit_price changed (computed field, not user-supplied)
  if (data.quantity !== undefined || data.unit_price !== undefined) {
    const existing = await queryOne('SELECT * FROM invoice_items WHERE id = ?', [id]);
    if (existing) {
      const qty = data.quantity ?? existing.quantity;
      const price = data.unit_price ?? existing.unit_price;
      fields.push('amount = ?');
      args.push(qty * price);
    }
  }

  args.push(id);
  await turso.execute({
    sql: `UPDATE invoice_items SET ${fields.join(', ')} WHERE id = ?`,
    args,
  });

  // Recalculate parent invoice totals
  const item = await queryOne('SELECT invoice_id FROM invoice_items WHERE id = ?', [id]);
  if (item) await recalculateInvoiceTotals(item.invoice_id);
}

export async function deleteInvoiceItem(id: string): Promise<void> {
  const item = await queryOne('SELECT invoice_id FROM invoice_items WHERE id = ?', [id]);
  await turso.execute({ sql: 'DELETE FROM invoice_items WHERE id = ?', args: [id] });
  if (item) await recalculateInvoiceTotals(item.invoice_id);
}

// ============================================================
// Payments
// ============================================================

export interface Payment {
  id: string;
  invoice_id: string;
  amount: number;
  payment_method: string | null;
  reference: string | null;
  paid_at: string;
  recorded_by: string;
  notes: string | null;
  created_at: string;
}

// Overpayment policy: allowed. Admin may record payments exceeding invoice total (e.g. credit, prepayment).
// Status is set to 'paid' when totalPaid >= total. Caller should validate amount if rejection is desired.
export async function recordPayment(data: {
  invoice_id: string;
  amount: number;
  payment_method?: string;
  reference?: string;
  paid_at: string;
  recorded_by: string;
  notes?: string;
}): Promise<string> {
  const id = nanoid();
  await turso.execute({
    sql: `INSERT INTO payments (id, invoice_id, amount, payment_method, reference, paid_at, recorded_by, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, data.invoice_id, data.amount, data.payment_method ?? null,
      data.reference ?? null, data.paid_at, data.recorded_by,
      data.notes ?? null,
    ],
  });

  // Update invoice amount_paid and status
  const payments = await getPaymentsByInvoice(data.invoice_id);
  const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
  const invoice = await getInvoice(data.invoice_id);
  if (invoice) {
    const newStatus: InvoiceStatus = totalPaid >= invoice.total ? 'paid' : 'partial';
    await updateInvoice(data.invoice_id, { amount_paid: totalPaid, status: newStatus });
  }

  return id;
}

export async function getPaymentsByInvoice(invoiceId: string): Promise<Payment[]> {
  return queryAll('SELECT * FROM payments WHERE invoice_id = ? ORDER BY paid_at DESC', [invoiceId]);
}

export async function deletePayment(id: string): Promise<void> {
  const payment = await queryOne('SELECT invoice_id FROM payments WHERE id = ?', [id]);
  await turso.execute({ sql: 'DELETE FROM payments WHERE id = ?', args: [id] });

  // Recalculate invoice totals
  if (payment) {
    const remaining = await getPaymentsByInvoice(payment.invoice_id);
    const totalPaid = remaining.reduce((sum, p) => sum + p.amount, 0);
    const invoice = await getInvoice(payment.invoice_id);
    if (invoice) {
      const newStatus: InvoiceStatus = totalPaid >= invoice.total ? 'paid' : totalPaid > 0 ? 'partial' : invoice.status === 'paid' ? 'sent' : invoice.status;
      await updateInvoice(payment.invoice_id, { amount_paid: totalPaid, status: newStatus });
    }
  }
}

// ============================================================
// Approvals
// ============================================================

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'revision_requested';

export interface Approval {
  id: string;
  contract_id: string;
  milestone_id: string | null;
  title: string;
  description: string | null;
  status: ApprovalStatus;
  requested_by: string;
  responded_by: string | null;
  requested_at: string;
  responded_at: string | null;
  response_note: string | null;
  created_at: string;
  updated_at: string;
}

export async function createApproval(data: {
  contract_id: string;
  milestone_id?: string;
  title: string;
  description?: string;
  requested_by: string;
}): Promise<string> {
  const id = nanoid();
  await turso.execute({
    sql: `INSERT INTO approvals (id, contract_id, milestone_id, title, description, requested_by)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      id, data.contract_id, data.milestone_id ?? null,
      data.title, data.description ?? null, data.requested_by,
    ],
  });
  return id;
}

export async function getApproval(id: string): Promise<Approval | undefined> {
  return queryOne('SELECT * FROM approvals WHERE id = ?', [id]);
}

export async function getApprovalsByContract(contractId: string): Promise<Approval[]> {
  return queryAll('SELECT * FROM approvals WHERE contract_id = ? ORDER BY created_at DESC', [contractId]);
}

export async function getPendingApprovals(contractId?: string): Promise<Approval[]> {
  if (contractId) {
    return queryAll(
      "SELECT * FROM approvals WHERE contract_id = ? AND status = 'pending' ORDER BY created_at",
      [contractId]
    );
  }
  return queryAll("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at");
}

// Rejects if approval is already resolved (not pending). Returns false if blocked.
export async function respondToApproval(id: string, data: {
  status: 'approved' | 'rejected' | 'revision_requested';
  responded_by: string;
  response_note?: string;
}): Promise<boolean> {
  const existing = await getApproval(id);
  if (!existing || existing.status !== 'pending') return false;
  await turso.execute({
    sql: `UPDATE approvals SET status = ?, responded_by = ?, responded_at = datetime('now'), response_note = ?, updated_at = datetime('now') WHERE id = ?`,
    args: [data.status, data.responded_by, data.response_note ?? null, id],
  });
  return true;
}

// ============================================================
// Change Orders
// ============================================================

export type ChangeOrderStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

export interface ChangeOrder {
  id: string;
  contract_id: string;
  title: string;
  description: string | null;
  status: ChangeOrderStatus;
  cost_impact: number;
  time_impact_days: number;
  requested_by: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function createChangeOrder(data: {
  contract_id: string;
  title: string;
  description?: string;
  cost_impact?: number;
  time_impact_days?: number;
  requested_by: string;
}): Promise<string> {
  const id = nanoid();
  await turso.execute({
    sql: `INSERT INTO change_orders (id, contract_id, title, description, cost_impact, time_impact_days, requested_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, data.contract_id, data.title, data.description ?? null,
      data.cost_impact ?? 0, data.time_impact_days ?? 0, data.requested_by,
    ],
  });
  return id;
}

export async function getChangeOrder(id: string): Promise<ChangeOrder | undefined> {
  return queryOne('SELECT * FROM change_orders WHERE id = ?', [id]);
}

export async function getChangeOrdersByContract(contractId: string): Promise<ChangeOrder[]> {
  return queryAll('SELECT * FROM change_orders WHERE contract_id = ? ORDER BY created_at DESC', [contractId]);
}

export async function updateChangeOrder(id: string, data: Partial<Pick<ChangeOrder,
  'title' | 'description' | 'status' | 'cost_impact' | 'time_impact_days'
>>): Promise<void> {
  const update = buildSafeUpdate('change_orders', id, data);
  if (!update) return;
  await turso.execute(update);
}

// Rejects if change order is already approved. Returns false if blocked.
export async function approveChangeOrder(id: string, approvedBy: string): Promise<boolean> {
  const existing = await getChangeOrder(id);
  if (!existing || existing.status === 'approved') return false;
  await turso.execute({
    sql: `UPDATE change_orders SET status = 'approved', approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    args: [approvedBy, id],
  });
  return true;
}
