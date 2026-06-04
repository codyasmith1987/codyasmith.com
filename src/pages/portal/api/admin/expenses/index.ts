import type { APIRoute } from 'astro';
import { getClientExpenses, addClientExpense } from '../../../../../lib/client-expenses';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const FREQ = new Set(['monthly', 'annual', 'one_time']);

export const GET: APIRoute = async ({ locals, url }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);
  const clientId = url.searchParams.get('client_id');
  if (!clientId) return json({ error: 'client_id required' }, 400);
  try {
    return json(await getClientExpenses(clientId));
  } catch (err) {
    logger.error('List client expenses error', err);
    return json({ error: 'Failed to load expenses' }, 500);
  }
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);
  try {
    const { client_id, name, amount, frequency, notes } = await request.json();
    if (!client_id?.trim() || !name?.trim()) return json({ error: 'Client and name are required' }, 400);
    if (!FREQ.has(frequency)) return json({ error: 'Frequency must be monthly, annual, or one_time' }, 400);
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) return json({ error: 'Amount must be a non-negative number' }, 400);

    const id = await addClientExpense({
      client_id: client_id.trim(),
      name: name.trim(),
      amount: amt,
      frequency,
      notes: notes?.trim() || null,
      created_by: locals.user!.id,
    });

    await logActivity({
      clientId: client_id.trim(),
      userId: locals.user!.id,
      action: 'created',
      entityType: 'client_expense',
      entityId: id,
      summary: `${locals.user!.name} added recurring expense "${name.trim()}"`,
    });

    return json({ id }, 201);
  } catch (err) {
    logger.error('Add client expense error', err);
    return json({ error: 'Failed to add expense' }, 500);
  }
};
