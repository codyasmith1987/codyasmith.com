import type { APIRoute } from 'astro';
import {
  getInvoice, updateInvoice, deleteInvoice, getInvoiceItems,
  addInvoiceItem, updateInvoiceItem, deleteInvoiceItem,
} from '../../../../../lib/invoices';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';
import { onInvoiceSent } from '../../../../../lib/triggers';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, params }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const invoice = await getInvoice(params.id!);
    if (!invoice) return json({ error: 'Not found' }, 404);
    const items = await getInvoiceItems(params.id!);
    return json({ ...invoice, items });
  } catch (err) {
    logger.error('Get invoice error', err);
    return json({ error: 'Failed to load invoice' }, 500);
  }
};

export const PUT: APIRoute = async ({ locals, params, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const invoice = await getInvoice(params.id!);
    if (!invoice) return json({ error: 'Not found' }, 404);

    const body = await request.json();

    // Handle line item operations
    if (body.action === 'add_item') {
      const itemId = await addInvoiceItem({
        invoice_id: params.id!,
        description: body.description,
        name: body.name,
        sub_description: body.sub_description,
        frequency: body.frequency,
        category: body.category,
        quantity: body.quantity,
        unit_price: body.unit_price,
      });
      return json({ id: itemId });
    }

    if (body.action === 'update_item') {
      await updateInvoiceItem(body.item_id, {
        ...(body.description !== undefined && { description: body.description }),
        ...(body.name !== undefined && { name: body.name }),
        ...(body.sub_description !== undefined && { sub_description: body.sub_description }),
        ...(body.frequency !== undefined && { frequency: body.frequency }),
        ...(body.category !== undefined && { category: body.category }),
        ...(body.quantity !== undefined && { quantity: body.quantity }),
        ...(body.unit_price !== undefined && { unit_price: body.unit_price }),
        ...(body.sort_order !== undefined && { sort_order: body.sort_order }),
      });
      return json({ ok: true });
    }

    if (body.action === 'delete_item') {
      await deleteInvoiceItem(body.item_id);
      return json({ ok: true });
    }

    if (body.invoice_number !== undefined && !String(body.invoice_number).trim()) {
      return json({ error: 'Invoice number cannot be empty' }, 400);
    }

    // Standard invoice field updates
    await updateInvoice(params.id!, {
      ...(body.status !== undefined && { status: body.status }),
      ...(body.invoice_number !== undefined && { invoice_number: String(body.invoice_number).trim() }),
      ...(body.issued_date !== undefined && { issued_date: body.issued_date }),
      ...(body.due_date !== undefined && { due_date: body.due_date }),
      ...(body.tax !== undefined && { tax: body.tax }),
      ...(body.notes !== undefined && { notes: body.notes }),
      ...(body.client_visible !== undefined && { client_visible: body.client_visible ? 1 : 0 }),
      ...(body.title !== undefined && { title: body.title }),
      ...(body.terms_label !== undefined && { terms_label: body.terms_label }),
      ...(body.reminders_paused !== undefined && { reminders_paused: body.reminders_paused ? 1 : 0 }),
    });

    await logActivity({
      clientId: invoice.client_id,
      userId: locals.user!.id,
      action: 'updated',
      entityType: 'invoice',
      entityId: params.id!,
      summary: `${locals.user!.name} updated invoice ${invoice.invoice_number}`,
    });

    if (body.status === 'sent' && invoice.status !== 'sent') {
      await onInvoiceSent(params.id!);
    }

    return json({ ok: true });
  } catch (err: any) {
    logger.error('Update invoice error', err);
    const msg = String(err?.message || '');
    if (/already in use/i.test(msg)) return json({ error: msg }, 409);
    if (/cannot be empty/i.test(msg)) return json({ error: msg }, 400);
    return json({ error: 'Failed to update invoice' }, 500);
  }
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const invoice = await getInvoice(params.id!);
    if (!invoice) return json({ error: 'Not found' }, 404);

    await deleteInvoice(params.id!);

    await logActivity({
      clientId: invoice.client_id,
      userId: locals.user!.id,
      action: 'deleted',
      entityType: 'invoice',
      entityId: params.id!,
      summary: `${locals.user!.name} deleted invoice ${invoice.invoice_number}`,
    });

    return json({ ok: true });
  } catch (err) {
    logger.error('Delete invoice error', err);
    return json({ error: 'Failed to delete invoice' }, 500);
  }
};
