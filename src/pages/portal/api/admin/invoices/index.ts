import type { APIRoute } from 'astro';
import {
  createInvoice, generateInvoiceNumber, getInvoicesByClient, getInvoicesByContract,
} from '../../../../../lib/invoices';
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

    const invoiceNumber = await generateInvoiceNumber();
    const id = await createInvoice({
      contract_id: contract_id.trim(),
      client_id: client_id.trim(),
      milestone_id: milestone_id || undefined,
      invoice_number: invoiceNumber,
      due_date: due_date || undefined,
      notes: notes?.trim() || undefined,
      created_by: locals.user!.id,
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
