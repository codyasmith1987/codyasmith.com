// POST /portal/api/admin/test-fixtures/cody-test/reset
//
// Admin-only. Clears the cody-test fixture's transient state so Cody
// can run another end-to-end test pass without re-creating the client,
// user, or proposal rows.
//
// Wipes:
//   - proposal_drafts row for the cody-test proposal
//   - accepted/finalized state on the preserved cody-test proposal row
//   - client_agreements rows for the cody-test client (cascades to
//     agreement_signers + agreement_signatures via FK ON DELETE CASCADE)
//   - client_metadata row for the cody-test client
//   - activity_log entries scoped to the cody-test client
//   - the full contract side: contracts, projects, milestones, tasks,
//     task_artifacts, invoices, invoice_items, payments, approvals,
//     change_orders, pending_charges (FK-safe child-first order)
//   - ingested data (csv_uploads + every CSV child table)
//   - files (DB rows + best-effort S3 delete), including issued reports
//   - notifications for the cody-test client's users
//   - data_update_requests (resets the twice-a-month request chip)
//
// Preserves:
//   - clients row (cody-test client)
//   - users row (codyasmith@live.com)
//   - proposals row (cody-test) and its config

import type { APIRoute } from 'astro';
import { logger } from '../../../../../../lib/logger';
import turso from '../../../../../../lib/turso';
import { deleteFileFromStorage } from '../../../../../../lib/storage';
import { CSV_CHILD_TABLES } from '../../../../../../lib/csv-child-tables';

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

  // Keep the proposal row itself, but reset any accepted/finalized state
  // from a prior rehearsal. Otherwise a fresh Cody Test run can start
  // from a stale "accepted" proposal even after drafts/agreements were
  // cleared.
  await turso.execute({
    sql: `UPDATE proposals
             SET status = 'published',
                 finalized_at = NULL
           WHERE client_id = ?
             AND slug = ?`,
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

  // Tear down the full contract side, child rows first so we never trip a
  // foreign key. Everything filters to the cody-test client via subqueries.
  await turso.batch([
    { sql: `DELETE FROM task_artifacts WHERE task_id IN (
              SELECT t.id FROM tasks t JOIN milestones m ON t.milestone_id = m.id
              JOIN projects p ON m.project_id = p.id WHERE p.client_id = ?)`, args: [clientId] },
    { sql: `DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE client_id = ?)`, args: [clientId] },
    { sql: `DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE client_id = ?)`, args: [clientId] },
    { sql: `DELETE FROM pending_charges WHERE contract_id IN (SELECT id FROM contracts WHERE client_id = ?)`, args: [clientId] },
    { sql: `DELETE FROM change_orders WHERE contract_id IN (SELECT id FROM contracts WHERE client_id = ?)`, args: [clientId] },
    { sql: `DELETE FROM approvals WHERE contract_id IN (SELECT id FROM contracts WHERE client_id = ?)`, args: [clientId] },
    { sql: `DELETE FROM tasks WHERE milestone_id IN (
              SELECT m.id FROM milestones m JOIN projects p ON m.project_id = p.id WHERE p.client_id = ?)`, args: [clientId] },
    { sql: `DELETE FROM milestones WHERE project_id IN (SELECT id FROM projects WHERE client_id = ?)`, args: [clientId] },
    { sql: `DELETE FROM invoices WHERE client_id = ?`, args: [clientId] },
    { sql: `DELETE FROM projects WHERE client_id = ?`, args: [clientId] },
    { sql: `DELETE FROM contracts WHERE client_id = ?`, args: [clientId] },
  ], 'write');

  // Sweep ingested data so the dashboards and live pages start empty.
  for (const table of CSV_CHILD_TABLES) {
    await turso.execute({ sql: `DELETE FROM ${table} WHERE client_id = ?`, args: [clientId] });
  }
  await turso.execute({ sql: 'DELETE FROM csv_uploads WHERE client_id = ?', args: [clientId] });

  // Delete files: best-effort S3 object delete (deleteFileFromStorage
  // removes the DB row first, so the row clears even if S3 is unreachable),
  // then a sweep for any stragglers.
  const fileRows = await turso.execute({
    sql: 'SELECT id, s3_key FROM files WHERE client_id = ?',
    args: [clientId],
  });
  for (const row of fileRows.rows) {
    try {
      await deleteFileFromStorage(row[1] as string, row[0] as string);
    } catch (err) {
      logger.warn(`cody-test reset: S3 delete failed for file ${row[0]}, DB row cleared`);
    }
  }
  await turso.execute({ sql: 'DELETE FROM files WHERE client_id = ?', args: [clientId] });

  // Clear notifications for the client's users and the request-update log.
  await turso.execute({
    sql: 'DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE client_id = ?)',
    args: [clientId],
  });
  await turso.execute({ sql: 'DELETE FROM data_update_requests WHERE client_id = ?', args: [clientId] });

  logger.info(`cody-test fixture reset by admin ${user.email}`);

  return json({
    ok: true,
    message: 'cody-test fixture reset. Client, user, and proposal rows preserved; contracts, files, ingested data, notifications, and request log cleared.',
  });
};
