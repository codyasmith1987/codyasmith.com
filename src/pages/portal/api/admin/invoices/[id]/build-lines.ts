// Admin endpoint: populate a manual invoice's line items from its contract's
// signed Schedule A -- the fix for the empty-$0-invoice trap (a hand-created
// invoice required a contract but never used it). Derives the always-itemized
// recurring SERVICE lines (one per Web Management site + the Marketing
// Consulting retainer) via the same pure deriveRecurringLineItems the nightly
// engine uses. Pass-through, overage, and reimbursements are deliberately NOT
// added here: those are period/state-dependent engine concerns and adding them
// on a manual click risks double-billing. The admin adds any of those with
// "+ Add item".

import type { APIRoute } from 'astro';
import { getInvoice, getInvoiceItems, addInvoiceItem, recalculateInvoiceTotals } from '../../../../../../lib/invoices';
import { getAgreementByContractId } from '../../../../../../lib/agreements';
import { deriveRecurringLineItems } from '../../../../../../lib/billing';
import { logActivity } from '../../../../../../lib/activity';
import { logger } from '../../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// First and last calendar day of the current UTC month, used only to label the
// derived lines' sub-description when the invoice has no billing period set.
function currentMonthPeriod(): { start: string; end: string } {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
  return { start, end };
}

export const POST: APIRoute = async ({ locals, params }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const invoice = await getInvoice(params.id!);
    if (!invoice) return json({ error: 'Not found' }, 404);
    if (!invoice.contract_id) return json({ error: 'This invoice is not linked to a contract.' }, 400);

    const existing = await getInvoiceItems(params.id!);
    if (existing.length > 0) {
      return json({ error: 'This invoice already has line items. Remove them first to rebuild from the contract.' }, 409);
    }

    const agreement = await getAgreementByContractId(invoice.contract_id);
    const scheduleA = agreement && agreement.status === 'executed' ? agreement.schedule_a : null;
    const period = (invoice.billing_period_start && invoice.billing_period_end)
      ? { start: invoice.billing_period_start, end: invoice.billing_period_end }
      : currentMonthPeriod();

    const lines = deriveRecurringLineItems(scheduleA, period);
    if (!lines || lines.length === 0) {
      return json({
        error: 'No signed Schedule A with an itemized service breakdown to build from. Finish and execute the contract agreement first, or add line items manually.',
      }, 422);
    }

    let sortOrder = 0;
    for (const l of lines) {
      await addInvoiceItem({ invoice_id: params.id!, sort_order: sortOrder++, ...l });
    }
    await recalculateInvoiceTotals(params.id!);

    await logActivity({
      clientId: invoice.client_id,
      userId: locals.user!.id,
      action: 'updated',
      entityType: 'invoice',
      entityId: params.id!,
      summary: `${locals.user!.name} built ${lines.length} line item${lines.length === 1 ? '' : 's'} from the contract on invoice ${invoice.invoice_number}`,
    });

    return json({ ok: true, count: lines.length });
  } catch (err) {
    logger.error('Build invoice lines error', err);
    return json({ error: 'Failed to build line items' }, 500);
  }
};
