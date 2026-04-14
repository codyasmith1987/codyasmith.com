// Admin expense entry — minimum viable pass-through/monthly expense flow.
//
// The billing engine already reads pending_charges during
// generateInvoiceForContract and attaches unbilled ones to the next
// invoice (billed_invoice_id IS NULL means "attach on next run"). This
// route exists so Cody can actually create those rows without touching
// the database.
//
// POST — create an unbilled expense for a contract.
//   body: { contract_id, description, amount, target_invoice_id? }
//   target_invoice_id is optional. If omitted, billed_invoice_id stays
//   NULL so the charge attaches to the NEXT recurring invoice run.
//   If provided, it must reference a draft invoice on the same contract
//   — the charge is immediately bound to that invoice, but no totals
//   are recalculated here. (Cody's manual add to a draft invoice path
//   can live in a later step.)
//
// GET — list unbilled expenses, optionally filtered by contract_id.
//   Used by /portal/admin/expenses.astro and by the future admin work
//   queue's "unbilled expenses" signal.

import type { APIRoute } from 'astro';
import { nanoid } from 'nanoid';
import turso from '../../../../../lib/turso';
import { getContract } from '../../../../../lib/contracts';
import {
  classifyExpense,
  getContractPassthroughRule,
  getMonthToDateInCategory,
} from '../../../../../lib/contract-rules';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const body = await request.json();
    const contractId = String(body.contract_id ?? '').trim();
    const description = String(body.description ?? '').trim();
    const amount = Number(body.amount);
    const targetInvoiceId = body.target_invoice_id ? String(body.target_invoice_id).trim() : null;
    const category =
      typeof body.category === 'string' && body.category.trim().length > 0
        ? body.category.trim()
        : null;

    if (!contractId) return json({ error: 'contract_id is required' }, 400);
    if (!description) return json({ error: 'description is required' }, 400);
    if (!Number.isFinite(amount) || amount <= 0) {
      return json({ error: 'amount must be a positive number' }, 400);
    }
    if (category !== null && category.length > 64) {
      return json({ error: 'category is too long (max 64 chars)' }, 400);
    }

    const contract = await getContract(contractId);
    if (!contract) return json({ error: 'contract not found' }, 404);
    if (contract.status !== 'active') {
      return json({ error: `contract is ${contract.status}, not active` }, 409);
    }

    // If a target_invoice_id is provided, it must exist and belong to
    // this contract and still be a draft. We do NOT attempt to
    // recompute invoice totals here — that's an explicit later task.
    if (targetInvoiceId) {
      const inv = await turso.execute({
        sql: 'SELECT contract_id, status FROM invoices WHERE id = ?',
        args: [targetInvoiceId],
      });
      if (inv.rows.length === 0) return json({ error: 'target_invoice_id not found' }, 404);
      if (inv.rows[0][0] !== contractId) {
        return json({ error: 'target_invoice belongs to a different contract' }, 409);
      }
      if (inv.rows[0][1] !== 'draft') {
        return json({ error: `target_invoice is ${inv.rows[0][1]}, not draft` }, 409);
      }
    }

    // Classify the expense on the way in. This is the moment commercial
    // truth (the contract's passthrough_rule_json entered at intake)
    // first drives actual behavior: an over-cap charge lands as
    // needs_approval, an under-cap categorized charge lands as
    // auto_bill, etc.
    const rule = await getContractPassthroughRule(contractId);
    const monthToDate = category ? await getMonthToDateInCategory(contractId, category) : 0;
    const classification = classifyExpense({
      amount,
      category,
      monthToDateInCategory: monthToDate,
      rule,
    });

    const id = nanoid();
    await turso.execute({
      sql: `INSERT INTO pending_charges
            (id, contract_id, description, amount, source_type, source_id, billed_invoice_id,
             category, classification, needs_approval)
            VALUES (?, ?, ?, ?, 'passthrough', NULL, ?, ?, ?, ?)`,
      args: [
        id,
        contractId,
        description,
        amount,
        targetInvoiceId,
        category,
        classification.classification,
        classification.needs_approval ? 1 : 0,
      ],
    });

    await logActivity({
      clientId: contract.client_id,
      userId: locals.user!.id,
      action: 'created',
      entityType: 'pending_charge',
      entityId: id,
      summary: `${locals.user!.name} added expense "${description}" ($${amount.toFixed(2)}) to ${contract.title}${
        targetInvoiceId ? ' (pinned to invoice)' : ''
      } — classified ${classification.classification} (${classification.reason})`,
    });

    return json(
      {
        id,
        contract_id: contractId,
        description,
        amount,
        source_type: 'passthrough',
        billed_invoice_id: targetInvoiceId,
        category,
        classification: classification.classification,
        needs_approval: classification.needs_approval,
        classification_reason: classification.reason,
      },
      201
    );
  } catch (err: any) {
    logger.error('create expense error', err);
    return json({ error: err?.message ?? 'failed' }, 500);
  }
};

export const GET: APIRoute = async ({ locals, url }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const contractId = url.searchParams.get('contract_id');
    // Unbilled = billed_invoice_id IS NULL. Target-bound rows (with a
    // specific invoice id) are NOT "unbilled" from the billing engine's
    // perspective, but they also haven't been consumed into a line item
    // yet. For the initial admin list, treat both as "open" so Cody can
    // see what will hit the next or chosen invoice.
    const sql = contractId
      ? `SELECT pc.id, pc.contract_id, c.title AS contract_title, pc.description, pc.amount,
                pc.source_type, pc.billed_invoice_id, pc.created_at
         FROM pending_charges pc
         JOIN contracts c ON c.id = pc.contract_id
         WHERE pc.contract_id = ?
           AND (pc.billed_invoice_id IS NULL
                OR EXISTS (SELECT 1 FROM invoices i
                           WHERE i.id = pc.billed_invoice_id AND i.status = 'draft'))
         ORDER BY pc.created_at DESC`
      : `SELECT pc.id, pc.contract_id, c.title AS contract_title, pc.description, pc.amount,
                pc.source_type, pc.billed_invoice_id, pc.created_at
         FROM pending_charges pc
         JOIN contracts c ON c.id = pc.contract_id
         WHERE pc.billed_invoice_id IS NULL
            OR EXISTS (SELECT 1 FROM invoices i
                       WHERE i.id = pc.billed_invoice_id AND i.status = 'draft')
         ORDER BY pc.contract_id, pc.created_at DESC`;
    const args = contractId ? [contractId] : [];
    const result = await turso.execute({ sql, args });

    const rows = result.rows.map((r) => ({
      id: r[0] as string,
      contract_id: r[1] as string,
      contract_title: r[2] as string,
      description: r[3] as string,
      amount: Number(r[4]),
      source_type: r[5] as string,
      billed_invoice_id: r[6] as string | null,
      created_at: r[7] as string,
    }));
    return json({ expenses: rows });
  } catch (err: any) {
    logger.error('list expenses error', err);
    return json({ error: err?.message ?? 'failed' }, 500);
  }
};
