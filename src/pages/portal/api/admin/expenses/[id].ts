import type { APIRoute } from 'astro';
import { updateClientExpense, deleteClientExpense } from '../../../../../lib/client-expenses';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const FREQ = new Set(['monthly', 'annual', 'one_time']);

export const PUT: APIRoute = async ({ locals, params, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);
  try {
    const body = await request.json();
    const data: Record<string, any> = {};
    if (body.name !== undefined) data.name = String(body.name).trim();
    if (body.amount !== undefined) {
      const amt = Number(body.amount);
      if (!Number.isFinite(amt) || amt < 0) return json({ error: 'Amount must be a non-negative number' }, 400);
      data.amount = amt;
    }
    if (body.frequency !== undefined) {
      if (!FREQ.has(body.frequency)) return json({ error: 'Bad frequency' }, 400);
      data.frequency = body.frequency;
    }
    if (body.active !== undefined) data.active = body.active ? 1 : 0;
    if (body.notes !== undefined) data.notes = body.notes ? String(body.notes).trim() : null;

    await updateClientExpense(params.id!, data);
    return json({ ok: true });
  } catch (err) {
    logger.error('Update client expense error', err);
    return json({ error: 'Failed to update expense' }, 500);
  }
};

export const DELETE: APIRoute = async ({ locals, params }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);
  try {
    await deleteClientExpense(params.id!);
    return json({ ok: true });
  } catch (err) {
    logger.error('Delete client expense error', err);
    return json({ error: 'Failed to delete expense' }, 500);
  }
};
