// GET    /portal/api/admin/agreements/[slug]   Full agreement detail with audit trail.
// PATCH  /portal/api/admin/agreements/[slug]   Edit title, schedule_a, or personal_note.
//                                              Editing schedule_a notifies active signers.

import type { APIRoute } from 'astro';
import { logger } from '../../../../../lib/logger';
import { logActivity } from '../../../../../lib/activity';
import {
  getAgreementBySlug,
  getSignersForAgreement,
  getSignaturesForAgreement,
  getActiveSignatureForSigner,
  updateAgreementScheduleA,
  rollbackAgreementToPartial,
} from '../../../../../lib/agreements';
import { sendScheduleChangedEmail } from '../../../../../lib/contract-emails';
import turso from '../../../../../lib/turso';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, params }) => {
  const user = locals.user;
  if (!user || user.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const slug = params.slug || '';
  const agreement = await getAgreementBySlug(slug);
  if (!agreement) return json({ error: 'Not found' }, 404);

  const signers = await getSignersForAgreement(agreement.id);
  const signatures = await getSignaturesForAgreement(agreement.id, true);

  // Activity log for this agreement.
  const activity = await turso.execute({
    sql: `SELECT id, user_id, action, summary, metadata, created_at FROM activity_log WHERE entity_type = 'agreement' AND entity_id = ? ORDER BY created_at DESC LIMIT 200`,
    args: [agreement.id],
  });
  const activityEntries = activity.rows.map((r: any) => ({
    id: r[0],
    user_id: r[1],
    action: r[2],
    summary: r[3],
    metadata: r[4] ? JSON.parse(r[4]) : null,
    created_at: r[5],
  }));

  const clientRow = await turso.execute({
    sql: `SELECT id, name, slug FROM clients WHERE id = ? LIMIT 1`,
    args: [agreement.client_id],
  });
  const client = clientRow.rows[0] ? {
    id: clientRow.rows[0][0],
    name: clientRow.rows[0][1],
    slug: clientRow.rows[0][2],
  } : null;

  return json({
    agreement,
    client,
    signers,
    signatures,
    activity: activityEntries,
  });
};

export const PATCH: APIRoute = async ({ locals, request, params }) => {
  const user = locals.user;
  if (!user || user.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const slug = params.slug || '';
  const agreement = await getAgreementBySlug(slug);
  if (!agreement) return json({ error: 'Not found' }, 404);

  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'Invalid body' }, 400); }

  const changes: string[] = [];

  if (body.schedule_a !== undefined) {
    await updateAgreementScheduleA(agreement.id, body.schedule_a);
    changes.push('schedule_a');

    // Notify any currently-signed signers. The schedule_a edit will
    // cause hash mismatches on existing signatures; finalize is blocked
    // until those signers re-sign.
    const signers = await getSignersForAgreement(agreement.id);
    const baseUrl = (import.meta.env.PUBLIC_BASE_URL || 'https://codyasmith.com').replace(/\/$/, '');
    const agreementUrl = `${baseUrl}/portal/contracts/${agreement.slug}`;
    for (const signer of signers) {
      const active = await getActiveSignatureForSigner(agreement.id, signer.id);
      if (active) {
        try {
          await sendScheduleChangedEmail({
            recipient: signer,
            agreement,
            agreementUrl,
            changeSummary: body.change_summary || 'Cody edited Schedule A. Your signature is paused until you confirm the updated terms.',
          });
        } catch (err) {
          logger.error('schedule-changed email send failed', err);
        }
      }
    }
    // If finalized, roll back to partially_signed since the executed
    // PDF no longer reflects the current schedule.
    if (agreement.status === 'executed') {
      await rollbackAgreementToPartial(agreement.id);
      changes.push('rolled back from executed');
    }
  }

  if (body.personal_note !== undefined) {
    await turso.execute({
      sql: `UPDATE client_agreements SET personal_note = ? WHERE id = ?`,
      args: [body.personal_note ? String(body.personal_note).slice(0, 4000) : null, agreement.id],
    });
    changes.push('personal_note');
  }

  if (body.title !== undefined) {
    const newTitle = String(body.title).trim();
    if (newTitle) {
      await turso.execute({
        sql: `UPDATE client_agreements SET title = ? WHERE id = ?`,
        args: [newTitle, agreement.id],
      });
      changes.push('title');
    }
  }

  try {
    await logActivity({
      clientId: agreement.client_id,
      userId: user.id,
      action: 'schedule_a_edited',
      entityType: 'agreement',
      entityId: agreement.id,
      summary: `Admin edited agreement ${agreement.slug}: ${changes.join(', ')}`,
    });
  } catch (err) {
    logger.error('PATCH agreement activity log failed', err);
  }

  return json({ ok: true, changes });
};
