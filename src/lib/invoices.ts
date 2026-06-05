// Invoices, invoice items, payments, approvals, and change orders — CRUD helpers

import { nanoid } from 'nanoid';
import turso from './turso';
import { clearExpenseBillingForInvoice } from './client-expenses';

// --- Column allowlists for dynamic UPDATE builders ---
const UPDATABLE_COLUMNS: Record<string, Set<string>> = {
  invoices: new Set(['status', 'issued_date', 'due_date', 'subtotal', 'tax', 'total', 'amount_paid', 'notes', 'client_visible', 'billing_period_start', 'billing_period_end', 'last_reminder_sent', 'title', 'terms_label', 'bill_to_snapshot', 'reminders_paused', 'invoice_number', 'extra_recipient_email']),
  invoice_items: new Set(['description', 'quantity', 'unit_price', 'amount', 'sort_order', 'name', 'sub_description', 'frequency', 'category']),
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

// 'carried_forward' (Part B, 2026-06-05): a terminal status for an overdue
// invoice whose unpaid balance + accrued interest were rolled onto a newer
// invoice. It is NOT open, NOT dunned, and NOT counted in the account balance
// (every collection query whitelists sent/partial/overdue), but it stays
// client-visible so the client sees it was carried forward (with a note linking
// the new invoice).
export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'partial' | 'overdue' | 'cancelled' | 'carried_forward';

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
  title: string | null;
  terms_label: string | null;
  bill_to_snapshot: string | null;
  reminders_paused: number;
  extra_recipient_email: string | null;
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

// Cross-client list of at-signing invoices (no billing period) still
// awaiting payment. These gate work starting per contract 5.2, so the
// admin needs one place to see what is blocked. Joined to client name.
export async function getAwaitingAtSigningInvoices(): Promise<Array<{
  id: string; invoice_number: string; total: number; amount_paid: number;
  issued_date: string | null; due_date: string | null; status: string;
  client_id: string; client_name: string;
}>> {
  return queryAll(
    `SELECT i.id, i.invoice_number, i.total, i.amount_paid, i.issued_date, i.due_date, i.status, i.client_id,
            c.name AS client_name
       FROM invoices i JOIN clients c ON c.id = i.client_id
      WHERE i.billing_period_start IS NULL
        AND i.amount_paid < i.total
        AND i.status IN ('sent','partial','overdue')
      ORDER BY i.issued_date ASC, i.created_at ASC`
  );
}

// Overdue invoices for the admin "Overdue" count/list. Matches a row whether
// or not the daily cron has flipped it to 'overdue' yet: an already-marked
// 'overdue' row, OR a still-'sent'/'partial' row already past its due date.
// (The old query keyed only on status='sent', so once markOverdueInvoices ran
// the count dropped to 0 even with overdue invoices present.) amount_paid <
// total excludes anything fully settled.
export async function getOverdueInvoices(): Promise<Invoice[]> {
  return queryAll(
    "SELECT * FROM invoices WHERE (status = 'overdue' OR ((status = 'sent' OR status = 'partial') AND due_date < date('now'))) AND amount_paid < total ORDER BY due_date",
    []
  );
}

// Account-statement aggregate for one client: total owed across all open
// invoices, the portion of that already overdue (same predicate as
// getOverdueInvoices), and the count. Open = total - amount_paid summed over
// not-fully-settled sent/partial/overdue rows. Used by the admin invoices
// summary strip. (The client portal computes its own balance from the
// client_visible subset so the figure always matches the rows it renders.)
export async function getClientOpenBalance(clientId: string): Promise<{ open: number; overdue: number; count: number }> {
  const row = await queryOne(
    `SELECT
       COALESCE(SUM(total - amount_paid), 0) AS open,
       COALESCE(SUM(CASE WHEN status = 'overdue' OR (status IN ('sent','partial') AND due_date < date('now')) THEN total - amount_paid ELSE 0 END), 0) AS overdue,
       COUNT(*) AS count
     FROM invoices
     WHERE client_id = ? AND status IN ('sent','partial','overdue') AND amount_paid < total`,
    [clientId]);
  return { open: row?.open ?? 0, overdue: row?.overdue ?? 0, count: row?.count ?? 0 };
}

// Client-safe: excludes created_by, contract_id, milestone_id (admin context)
export async function getClientVisibleInvoices(clientId: string): Promise<Pick<Invoice, 'id' | 'invoice_number' | 'status' | 'issued_date' | 'due_date' | 'total' | 'amount_paid' | 'notes'>[]> {
  return queryAll(
    'SELECT id, invoice_number, status, issued_date, due_date, total, amount_paid, notes FROM invoices WHERE client_id = ? AND client_visible = 1 ORDER BY created_at DESC',
    [clientId]
  );
}

export async function updateInvoice(id: string, data: Partial<Pick<Invoice,
  'status' | 'issued_date' | 'due_date' | 'subtotal' | 'tax' | 'total' | 'amount_paid' | 'notes' | 'client_visible' |
  'billing_period_start' | 'billing_period_end' | 'last_reminder_sent' |
  'title' | 'terms_label' | 'bill_to_snapshot' | 'reminders_paused' | 'invoice_number' | 'extra_recipient_email'
>>): Promise<void> {
  // The invoice number is editable (manual override of the auto-generated one),
  // but must stay unique. Reject a collision with a DIFFERENT invoice before
  // writing. The caller surfaces this as a 409, not a 500.
  if (data.invoice_number !== undefined) {
    if (!String(data.invoice_number).trim()) {
      throw new Error('Invoice number cannot be empty');
    }
    const clash = await getInvoiceByNumber(data.invoice_number);
    if (clash && clash.id !== id) {
      throw new Error(`Invoice number "${data.invoice_number}" is already in use`);
    }
  }
  // Couple visibility to a balance-bearing status (dual audit 2026-06-05): when an
  // invoice moves into sent/partial/overdue, the CLIENT must be able to see it --
  // otherwise their portal balance (computed from the client_visible subset)
  // understates what they owe. Default client_visible=1 on that transition unless
  // the caller is explicitly setting it (so a deliberate hide still wins). Covers
  // admin status edits + recordPayment's flip to 'partial'; markOverdueInvoices
  // sets it in its own raw UPDATE.
  if (data.status && ['sent', 'partial', 'overdue'].includes(data.status) && data.client_visible === undefined) {
    data = { ...data, client_visible: 1 };
  }
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

// --- Category-aware subtotals (Services / Reimbursements / Past due) ---
// Pure. A NULL or absent category counts as 'services', so legacy flat invoices
// keep a Services subtotal equal to their old subtotal and 0 in the others.
// past_due + late_interest (Part B roll-forward) are grouped into pastDue so a
// carried balance + its interest render separately from current-period services
// and the Services subtotal isn't inflated by carried debt.
export function splitSubtotals(
  items: Array<{ amount: number; category?: string | null }>,
): { services: number; reimbursements: number; pastDue: number; total: number } {
  let services = 0;
  let reimbursements = 0;
  let pastDue = 0;
  for (const item of items) {
    const c = item.category || 'services';
    if (c === 'reimbursements') reimbursements += item.amount;
    else if (c === 'past_due' || c === 'late_interest') pastDue += item.amount;
    else services += item.amount;
  }
  return { services, reimbursements, pastDue, total: services + reimbursements + pastDue };
}

export async function getInvoiceSubtotals(invoiceId: string): Promise<{ services: number; reimbursements: number; pastDue: number; total: number }> {
  return splitSubtotals(await getInvoiceItems(invoiceId));
}

// --- Duplicate ---
// Pure. Advance a 'YYYY-MM-DD' date by n months, clamping the day to the target
// month length (e.g. Jan 31 plus 1 month becomes Feb 28). Used to roll a
// duplicated invoice's billing period forward to the next cycle.
export function addMonthsToDate(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const monthIndex = (m - 1) + n;
  const ny = y + Math.floor(monthIndex / 12);
  const nm = ((monthIndex % 12) + 12) % 12; // 0-based target month
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${ny}-${pad(nm + 1)}-${pad(nd)}`;
}

// Pure. Build the header field set plus line items for a duplicate. The billing
// period rolls forward one month; tax/title/terms carry over; every line item
// copies verbatim (name, sub_description, frequency, category) so a duplicate is
// a faithful starting point to tweak. Status/visibility are forced by
// duplicateInvoice, not here.
export function buildDuplicatePayload(
  src: Invoice,
  items: InvoiceItem[],
): {
  header: { title: string | null; terms_label: string | null; tax: number; billing_period_start: string | null; billing_period_end: string | null };
  items: Array<{ name: string | null; sub_description: string | null; description: string; frequency: string | null; category: string; quantity: number; unit_price: number }>;
} {
  return {
    header: {
      title: src.title ?? null,
      terms_label: src.terms_label ?? null,
      tax: src.tax ?? 0,
      billing_period_start: src.billing_period_start ? addMonthsToDate(src.billing_period_start, 1) : null,
      billing_period_end: src.billing_period_end ? addMonthsToDate(src.billing_period_end, 1) : null,
    },
    items: items.map(it => ({
      name: it.name ?? null,
      sub_description: it.sub_description ?? null,
      description: it.description,
      frequency: it.frequency ?? null,
      category: it.category || 'services',
      quantity: it.quantity,
      unit_price: it.unit_price,
    })),
  };
}

// Clone an invoice into a new editable DRAFT (the duplicate button). The copy is
// not client-visible and gets a fresh generated number. Returns the new id +
// number. EMAIL/visibility side effects: none (draft, hidden).
export async function duplicateInvoice(sourceId: string, createdBy: string): Promise<{ id: string; invoice_number: string }> {
  const src = await getInvoice(sourceId);
  if (!src) throw new Error('Source invoice not found');
  const items = await getInvoiceItems(sourceId);

  const { id, invoice_number } = await createInvoiceWithGeneratedNumber({
    contract_id: src.contract_id,
    client_id: src.client_id,
    milestone_id: src.milestone_id ?? undefined,
    notes: src.notes ?? undefined,
    created_by: createdBy,
  });

  const payload = buildDuplicatePayload(src, items);
  await updateInvoice(id, {
    status: 'draft',
    client_visible: 0,
    title: payload.header.title,
    terms_label: payload.header.terms_label,
    tax: payload.header.tax,
    billing_period_start: payload.header.billing_period_start,
    billing_period_end: payload.header.billing_period_end,
  });

  for (const item of payload.items) {
    await addInvoiceItem({ invoice_id: id, ...item });
  }

  return { id, invoice_number };
}

export async function deleteInvoice(id: string): Promise<void> {
  // Un-stamp any recurring-expense templates this invoice billed, so they become
  // due again on the next generation instead of silently skipping their cycle.
  await clearExpenseBillingForInvoice(id);
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
  name: string | null;
  sub_description: string | null;
  description: string;
  frequency: string | null;
  category: string;
  quantity: number;
  unit_price: number;
  amount: number;
  sort_order: number;
  created_at: string;
}

export async function addInvoiceItem(data: {
  invoice_id: string;
  description: string;
  name?: string | null;
  sub_description?: string | null;
  frequency?: string | null;
  category?: string | null;
  quantity?: number;
  unit_price: number;
  sort_order?: number | null;
}): Promise<string> {
  const id = nanoid();
  const qty = data.quantity ?? 1;
  const amount = qty * data.unit_price;
  await turso.execute({
    sql: `INSERT INTO invoice_items (id, invoice_id, name, sub_description, description, frequency, category, quantity, unit_price, amount, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, data.invoice_id, data.name ?? null, data.sub_description ?? null,
      data.description, data.frequency ?? null, data.category ?? 'services',
      qty, data.unit_price, amount, data.sort_order ?? 0,
    ],
  });
  await recalculateInvoiceTotals(data.invoice_id);
  return id;
}

export async function getInvoiceItems(invoiceId: string): Promise<InvoiceItem[]> {
  return queryAll('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort_order, created_at', [invoiceId]);
}

export async function updateInvoiceItem(id: string, data: Partial<Pick<InvoiceItem,
  'description' | 'quantity' | 'unit_price' | 'sort_order' | 'name' | 'sub_description' | 'frequency' | 'category'
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
    // A terminal invoice (carried_forward / cancelled) keeps its status: a stray
    // payment against a rolled-forward invoice must not resurrect it to
    // partial/sent and reintroduce its balance alongside the new invoice (dual
    // audit 2026-06-05). amount_paid still records for the audit trail.
    const isTerminal = invoice.status === 'carried_forward' || invoice.status === 'cancelled';
    const newStatus: InvoiceStatus = isTerminal ? invoice.status : (totalPaid >= invoice.total ? 'paid' : 'partial');
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
      // Terminal statuses (carried_forward / cancelled) are sticky: deleting a
      // payment must not resurrect a rolled-forward/cancelled invoice (dual audit
      // 2026-06-05).
      const isTerminal = invoice.status === 'carried_forward' || invoice.status === 'cancelled';
      const newStatus: InvoiceStatus = isTerminal ? invoice.status : (totalPaid >= invoice.total ? 'paid' : totalPaid > 0 ? 'partial' : invoice.status === 'paid' ? 'sent' : invoice.status);
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
