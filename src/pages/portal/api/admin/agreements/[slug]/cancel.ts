// POST /portal/api/admin/agreements/[slug]/cancel
//
// Sets status to voided and records cancelled_at. Refuses if already
// finalized (executed agreements need to be superseded by a new
// agreement rather than voided in-place; that flow will land later).

import type { APIRoute } from 'astro';
import { logger } from '../../../../../../lib/logger';
import { logActivity } from '../../../../../../lib/activity';
import { getAgreementBySlug, markAgreementCancelled } from '../../../../../../lib/agreements';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request, params }) => {
  const user = locals.user;
  if (!user || user.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const slug = params.slug || '';
  const agreement = await getAgreementBySlug(slug);
  if (!agreement) return json({ error: 'Not found' }, 404);
  if (agreement.status === 'executed') return json({ error: 'Cannot cancel a fully executed agreement; supersede with a new one instead' }, 409);

  let body: any = {};
  try { body = await request.json(); } catch { /* empty body is fine */ }
  const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 500) : null;

  await markAgreementCancelled(agreement.id);

  try {
    await logActivity({
      clientId: agreement.client_id,
      userId: user.id,
      action: 'cancelled',
      entityType: 'agreement',
      entityId: agreement.id,
      summary: `Admin cancelled ${agreement.title}${reason ? `; reason=${reason}` : ''}`,
    });
  } catch (err) {
    logger.error('cancel activity log failed', err);
  }

  return json({ ok: true });
};
