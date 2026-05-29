// GET: list contracts (optionally filtered by client_id or status)
// POST: create a new contract

import type { APIRoute } from 'astro';
import {
  createContract, getAllContracts, getContractsByClient, getContractsByStatus,
  type ContractStatus,
} from '../../../../../lib/contracts';
import { logActivity } from '../../../../../lib/activity';
import { logger } from '../../../../../lib/logger';
import turso from '../../../../../lib/turso';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const clientId = url.searchParams.get('client_id');
    const status = url.searchParams.get('status') as ContractStatus | null;

    if (clientId) return json(await getContractsByClient(clientId));
    if (status) return json(await getContractsByStatus(status));
    return json(await getAllContracts());
  } catch (err) {
    logger.error('List contracts error', err);
    return json({ error: 'Failed to load contracts' }, 500);
  }
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const body = await request.json();
    const { client_id, title, description, type, total_value, start_date, end_date,
            billing_cadence, billing_day, recurring_amount, included_hours, overage_rate, payment_terms_days } = body;

    if (!client_id?.trim() || !title?.trim()) {
      return json({ error: 'client_id and title are required' }, 400);
    }

    // Guard against duplicating a contract the billing handoff already
    // created. When an agreement is signed, ensureBillingContractFromAgreement
    // auto-creates a contract and links it to the agreement. An admin who
    // then manually creates one here would orphan a second contract. Block
    // it unless the caller explicitly forces (legitimate standalone /
    // non-proposal contracts).
    if (!body.force) {
      const linked = await turso.execute({
        sql: `SELECT a.contract_id, a.title FROM client_agreements a
               WHERE a.client_id = ? AND a.contract_id IS NOT NULL LIMIT 1`,
        args: [client_id.trim()],
      });
      if (linked.rows.length > 0) {
        return json({
          error: 'This client already has a contract auto-created from a signed agreement. ' +
            'Manual creation would orphan a second contract. If this is an intentional separate ' +
            '(non-proposal) contract, resend with force: true.',
          existing_contract_id: linked.rows[0][0] as string,
        }, 409);
      }
    }

    const id = await createContract({
      client_id: client_id.trim(),
      title: title.trim(),
      description: description?.trim() || undefined,
      type: type || undefined,
      total_value: total_value != null ? Number(total_value) : undefined,
      start_date: start_date || undefined,
      end_date: end_date || undefined,
      billing_cadence: billing_cadence || undefined,
      billing_day: billing_day != null ? Number(billing_day) : undefined,
      recurring_amount: recurring_amount != null ? Number(recurring_amount) : undefined,
      included_hours: included_hours != null ? Number(included_hours) : undefined,
      overage_rate: overage_rate != null ? Number(overage_rate) : undefined,
      payment_terms_days: payment_terms_days != null ? Number(payment_terms_days) : undefined,
      created_by: locals.user!.id,
    });

    await logActivity({
      clientId: client_id.trim(),
      userId: locals.user!.id,
      action: 'created',
      entityType: 'contract',
      entityId: id,
      summary: `${locals.user!.name} created contract "${title.trim()}"`,
    });

    return json({ id }, 201);
  } catch (err) {
    logger.error('Create contract error', err);
    return json({ error: 'Failed to create contract' }, 500);
  }
};
