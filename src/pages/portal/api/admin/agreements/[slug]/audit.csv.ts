// GET /portal/api/admin/agreements/[slug]/audit.csv
//
// Streams the agreement's audit trail as CSV: every signature + every
// activity_log entry, with all UETA metadata. Used in the admin
// audit-trail panel "Export CSV" button and available for any party
// who later requests the formal paper trail.

import type { APIRoute } from 'astro';
import {
  getAgreementBySlug,
  getSignersForAgreement,
  getSignaturesForAgreement,
} from '../../../../../../lib/agreements';
import turso from '../../../../../../lib/turso';

export const prerender = false;

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes('"') || s.includes(',') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export const GET: APIRoute = async ({ locals, params }) => {
  const user = locals.user;
  if (!user || user.role !== 'admin') return new Response('Forbidden', { status: 403 });

  const slug = params.slug || '';
  const agreement = await getAgreementBySlug(slug);
  if (!agreement) return new Response('Not found', { status: 404 });

  const signers = await getSignersForAgreement(agreement.id);
  const signatures = await getSignaturesForAgreement(agreement.id, true);
  const signersById: Record<string, any> = {};
  for (const s of signers) signersById[s.id] = s;

  const activity = await turso.execute({
    sql: `SELECT id, user_id, action, summary, metadata, created_at FROM activity_log WHERE entity_type = 'agreement' AND entity_id = ? ORDER BY created_at ASC`,
    args: [agreement.id],
  });

  const lines: string[] = [];
  lines.push(['kind', 'id', 'event', 'occurred_at', 'who', 'who_email', 'signature_value', 'consent_at', 'intent_at', 'document_hash', 'ip_address', 'user_agent', 'session_id', 'revoked_at', 'revoke_reason', 'summary'].join(','));
  for (const sig of signatures) {
    lines.push([
      'signature',
      sig.id,
      'signed',
      sig.signed_at,
      signersById[sig.signer_id]?.name_snapshot || '',
      signersById[sig.signer_id]?.email_snapshot || '',
      sig.signature_value,
      sig.consent_at,
      sig.intent_at,
      sig.document_hash,
      sig.ip_address || '',
      sig.user_agent || '',
      sig.session_id || '',
      sig.revoked_at || '',
      sig.revoke_reason || '',
      '',
    ].map(csvEscape).join(','));
  }
  for (const row of activity.rows as any[]) {
    lines.push([
      'activity',
      row[0],
      row[2],
      row[5],
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      row[3] || '',
    ].map(csvEscape).join(','));
  }

  const csv = lines.join('\n');
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${agreement.slug}-audit.csv"`,
    },
  });
};
