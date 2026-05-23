// POST /portal/api/admin/test-fixtures/cody-test/reset
//
// Admin-only. Clears the cody-test fixture's transient state so Cody
// can run another end-to-end test pass without re-creating the client,
// user, or proposal rows.
//
// Wipes:
//   - proposal_drafts row for the cody-test proposal
//   - client_agreements rows for the cody-test client (cascades to
//     agreement_signers + agreement_signatures via FK ON DELETE CASCADE)
//   - client_metadata row for the cody-test client
//   - activity_log entries scoped to the cody-test client
//
// Preserves:
//   - clients row (cody-test client)
//   - users row (codyasmith@live.com)
//   - proposals row (cody-test) and its config
//   - any file rows uploaded; PDFs orphan in S3 (cleanup left to admin
//     /portal/files area if needed)

import type { APIRoute } from 'astro';
import { logger } from '../../../../../../lib/logger';
import turso from '../../../../../../lib/turso';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const CLIENT_SLUG = 'cody-test';
const PROPOSAL_SLUG = 'cody-test';

export const POST: APIRoute = async ({ locals }) => {
  const user = locals.user;
  if (!user || user.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const clientLookup = await turso.execute({
    sql: 'SELECT id FROM clients WHERE slug = ? LIMIT 1',
    args: [CLIENT_SLUG],
  });
  const clientRow = clientLookup.rows[0];
  if (!clientRow) return json({ error: 'cody-test client not seeded; migration 025 has not run' }, 404);
  const clientId = clientRow[0] as string;

  // Clear proposal_drafts for the cody-test proposal.
  await turso.execute({
    sql: 'DELETE FROM proposal_drafts WHERE client_id = ? AND slug = ?',
    args: [clientId, PROPOSAL_SLUG],
  });

  // Resetting agreements is interesting because we want everything
  // associated with the cody-test client wiped. ON DELETE CASCADE on
  // client_agreements -> agreement_signers and agreement_signatures
  // means deleting the agreements row also clears their child rows.
  await turso.execute({
    sql: 'DELETE FROM client_agreements WHERE client_id = ?',
    args: [clientId],
  });

  // Wipe client_metadata so the next test starts with a fresh intake.
  await turso.execute({
    sql: 'DELETE FROM client_metadata WHERE client_id = ?',
    args: [clientId],
  });

  // Wipe scoped activity log entries so the audit panel is clean for
  // the next test. (Activity log is not strictly required to clear,
  // but it keeps the verification panel readable across iterations.)
  await turso.execute({
    sql: 'DELETE FROM activity_log WHERE client_id = ?',
    args: [clientId],
  });

  logger.info(`cody-test fixture reset by admin ${user.email}`);

  return json({
    ok: true,
    message: 'cody-test fixture reset. Client, user, and proposal rows preserved.',
  });
};
