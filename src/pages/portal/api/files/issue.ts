// POST /portal/api/files/issue
//
// Admin-only. Deliberately issues a prescriptive deliverable (a strategic
// recommendation or a research report) to the client. Issuing is the
// delivery event: it flips the file from draft (admin-only) to visible on
// the client's documents hub, notifies the client in-portal, and emails
// them. Not auto-on-upload — Cody decides when a draft is ready to send.

import type { APIRoute } from 'astro';
import { getFileById, markFileIssued, ISSUABLE_FILE_CATEGORIES, fileCategoryLabel } from '../../../../lib/storage';
import { onDocumentIssued } from '../../../../lib/triggers';
import { logActivity } from '../../../../lib/activity';
import { logger } from '../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const { file_id } = await request.json();
    if (!file_id) return json({ error: 'file_id is required' }, 400);

    const file = await getFileById(file_id);
    if (!file) return json({ error: 'File not found' }, 404);

    if (!ISSUABLE_FILE_CATEGORIES.includes(file.category)) {
      return json({ error: `Only ${ISSUABLE_FILE_CATEGORIES.map(fileCategoryLabel).join(' and ')} can be sent to a client.` }, 400);
    }

    const { transitioned, issued_at } = await markFileIssued(file.id);

    // Only notify + email on the first issue, not on a re-click.
    if (transitioned) {
      await onDocumentIssued({
        clientId: file.client_id,
        fileId: file.id,
        fileName: file.original_name,
        category: file.category,
      });
      await logActivity({
        clientId: file.client_id,
        userId: locals.user!.id,
        action: 'issued',
        entityType: 'file',
        entityId: file.id,
        summary: `${locals.user!.name} issued "${file.original_name}" to the client`,
      });
    }

    return json({ ok: true, issued_at, alreadyIssued: !transitioned });
  } catch (err: any) {
    logger.error('File issue error', err);
    return json({ error: 'Issue failed' }, 500);
  }
};
