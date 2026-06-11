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
import { getInvoice, getInvoiceItems, addInvoiceItem, recalculateInvoiceTotals, updateInvoice } from '../../../../../../lib/invoices';
import { getAgreementByContractId } from '../../../../../../lib/agreements';
import { getContract } from '../../../../../../lib/contracts';
import { deriveRecurringLineItems, getUpcomingBillingPeriod } from '../../../../../../lib/billing';
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
    const contract = await getContract(invoice.contract_id);

    // Period precedence: the invoice's own period if set; else the SAME upcoming
    // anchored period the nightly engine would bill (generateInvoiceForContract
    // uses getUpcomingBillingPeriod) so a hand-built invoice and the engine talk
    // about the same cycle; else the current calendar month as a label of last
    // resort. The period is STAMPED onto the invoice below -- a NULL period would
    // slip past invoiceExistsForPeriod's equality dedupe (NULL = 'x' is never
    // true) and let the engine bill the same service again (triple audit
    // 2026-06-09).
    const period = (invoice.billing_period_start && invoice.billing_period_end)
      ? { start: invoice.billing_period_start, end: invoice.billing_period_end }
      : (contract?.billing_cadence === 'monthly' && contract.billing_day)
        ? getUpcomingBillingPeriod(contract.billing_day)
        : currentMonthPeriod();

    const lines = deriveRecurringLineItems(scheduleA, period);
    if (!lines || lines.length === 0) {
      return json({
        error: 'No signed Schedule A with an itemized service breakdown to build from. Finish and execute the contract agreement first, or add line items manually.',
      }, 422);
    }

    // Reconcile-or-halt, same rule as the nightly engine (billing.ts, Cody:
    // "never send a wrong invoice"): if the Schedule A lines do not sum to the
    // contract's recurring amount, the schedule has drifted -- refuse rather
    // than silently build a wrong-total invoice (triple audit 2026-06-09).
    if (contract?.recurring_amount) {
      const sum = lines.reduce((s, l) => s + l.unit_price * l.quantity, 0);
      if (Math.abs(sum - contract.recurring_amount) > 0.01) {
        return json({
          error: `The contract's Schedule A lines total $${sum.toFixed(2)}, which does not match the contract's recurring amount of $${Number(contract.recurring_amount).toFixed(2)}. Fix the contract or the agreement before building line items, or add them manually.`,
        }, 422);
      }
    }

    let sortOrder = 0;
    for (const l of lines) {
      await addInvoiceItem({ invoice_id: params.id!, sort_order: sortOrder++, ...l });
    }
    await recalculateInvoiceTotals(params.id!);

    // Stamp the itemized period so the nightly engine's per-period dedupe
    // (invoiceExistsForPeriod) sees this invoice and does not generate a second
    // one for the same cycle.
    if (!invoice.billing_period_start || !invoice.billing_period_end) {
      await updateInvoice(params.id!, { billing_period_start: period.start, billing_period_end: period.end });
    }

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
