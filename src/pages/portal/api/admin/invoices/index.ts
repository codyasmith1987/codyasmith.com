import type { APIRoute } from 'astro';
import {
  createInvoiceWithGeneratedNumber, getInvoicesByClient, getInvoicesByContract,
} from '../../../../../lib/invoices';
import { getContract } from '../../../../../lib/contracts';
import { manualBuildPeriod } from '../../../../../lib/billing';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const clientId = url.searchParams.get('client_id');
    const contractId = url.searchParams.get('contract_id');

    if (clientId) return json(await getInvoicesByClient(clientId));
    if (contractId) return json(await getInvoicesByContract(contractId));
    return json({ error: 'client_id or contract_id required' }, 400);
  } catch (err) {
    logger.error('List invoices error', err);
    return json({ error: 'Failed to load invoices' }, 500);
  }
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const { contract_id, client_id, milestone_id, due_date, notes } = await request.json();

    if (!contract_id?.trim() || !client_id?.trim()) {
      return json({ error: 'contract_id and client_id are required' }, 400);
    }

    // Stamp the service period for a monthly contract at creation (chat-wide
    // audit 2026-06-11): a NULL-period hand-created invoice is invisible to the
    // recurring engine's per-period dedupe, so the nightly generator would bill
    // the same cycle again for an auto-billed client. manualBuildPeriod picks
    // the cycle in progress (or the engine's upcoming cycle inside its 7-day
    // issue window). The period is visible + editable on the invoice page, and
    // clearing it there marks a genuine one-off.
    let period: { start: string; end: string } | null = null;
    try {
      const contract = await getContract(contract_id.trim());
      if (contract?.billing_cadence === 'monthly' && contract.billing_day) {
        period = manualBuildPeriod(contract.billing_day);
      }
    } catch (err) {
      logger.error('period stamp lookup failed (invoice still created)', err);
    }

    const { id, invoice_number: invoiceNumber } = await createInvoiceWithGeneratedNumber({
      contract_id: contract_id.trim(),
      client_id: client_id.trim(),
      milestone_id: milestone_id || undefined,
      due_date: due_date || undefined,
      notes: notes?.trim() || undefined,
      created_by: locals.user!.id,
      billing_period_start: period?.start,
      billing_period_end: period?.end,
    });

    await logActivity({
      clientId: client_id.trim(),
      userId: locals.user!.id,
      action: 'created',
      entityType: 'invoice',
      entityId: id,
      summary: `${locals.user!.name} created invoice ${invoiceNumber}`,
    });

    return json({ id, invoice_number: invoiceNumber }, 201);
  } catch (err) {
    logger.error('Create invoice error', err);
    return json({ error: 'Failed to create invoice' }, 500);
  }
};
