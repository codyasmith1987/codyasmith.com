import type { APIRoute } from 'astro';
import {
  getInvoice, updateInvoice, deleteInvoice, getInvoiceItems,
  addInvoiceItem, updateInvoiceItem, deleteInvoiceItem, recalculateInvoiceTotals,
} from '../../../../../lib/invoices';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';
import { onInvoiceSent } from '../../../../../lib/triggers';
import { isValidEmail } from '../../../../../lib/email-safety';

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

    // Validate the per-invoice extra recipient (dual audit 2026-06-05): a typo'd
    // address saved silently is dropped at send time, so that person never gets
    // the invoice. A non-empty value must be a plain email; empty clears.
    //
    // BUT only validate a value the admin is actually CHANGING (2026-06-09). The
    // Save button re-submits this field on every save, so a legacy/bad value left
    // in the field would otherwise 400 an unrelated save (e.g. just marking the
    // invoice paid) and brick the invoice. The send path already drops invalid
    // CCs (email.ts), so the sole purpose of this check is to warn the admin when
    // they ENTER a new bad address; an unchanged value (or clearing it) passes.
    if (body.extra_recipient_email !== undefined) {
      const v = String(body.extra_recipient_email).trim();
      const prev = String(invoice.extra_recipient_email || '').trim();
      if (v && v !== prev && !isValidEmail(v)) {
        return json({ error: 'Extra recipient is not a valid email address (use a plain address like name@example.com)' }, 400);
      }
    }

    // Terminal-status guard (whole-system audit 2026-06-05): never let an admin
    // save move an invoice OUT of a terminal status (carried_forward/cancelled).
    // A carried_forward invoice's balance lives on the invoice it rolled into;
    // resurrecting it to draft/sent would double-count that balance. A plain Save
    // (status unchanged) and non-status edits still go through; only an actual
    // status CHANGE away from terminal is rejected.
    if (body.status !== undefined) {
      const current = await getInvoice(params.id!);
      if (current && (current.status === 'carried_forward' || current.status === 'cancelled') && body.status !== current.status) {
        return json({ error: `This invoice is ${String(current.status).replace('_', ' ')} (a closed/terminal state) and its status cannot be changed here.` }, 409);
      }
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
      ...(body.extra_recipient_email !== undefined && { extra_recipient_email: (String(body.extra_recipient_email).trim() || null) }),
    });

    // Tax is stored on the invoice but the total is subtotal + tax. Setting tax
    // alone (no item change) would leave the stored total stale, so recompute.
    if (body.tax !== undefined) {
      await recalculateInvoiceTotals(params.id!);
    }

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
