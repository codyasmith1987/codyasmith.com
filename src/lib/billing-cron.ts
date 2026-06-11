// The daily billing cycle, in one place so the machine cron and the admin
// "Run billing now" control share identical behavior (no drift). It marks
// overdue invoices, generates + auto-emails the upcoming recurring invoices,
// sends due reminders, and sends overdue notices, alerting the admin on any
// failure. Each step is independently wrapped so one failure never skips the
// rest. Idempotent (period dedup, status guards, cadence guards).

import turso from './turso';
import { logger } from './logger';
import { markOverdueInvoices, generateRecurringInvoices, sendDueReminders, sendOverdueNotices, alertStalePaymentPending } from './billing';
import { onAutomatedFailure } from './triggers';

export async function runDailyBilling(): Promise<Record<string, unknown>> {
  // generateRecurringInvoices stamps created_by (FK to users); run as the
  // earliest admin (a system actor).
  const adminRow = await turso.execute("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1");
  const systemUserId = (adminRow.rows[0]?.[0] as string | undefined) || undefined;

  const result: Record<string, unknown> = { ok: true, ran_at: new Date().toISOString() };

  try {
    result.overdue_marked = await markOverdueInvoices();
  } catch (err: any) {
    logger.error('billing: markOverdueInvoices failed', err);
    result.overdue_error = err?.message || 'failed';
    await onAutomatedFailure('markOverdueInvoices', err?.message || 'failed');
  }

  if (systemUserId) {
    try {
      const gen = await generateRecurringInvoices(systemUserId);
      result.invoices_generated = gen.generated.length;
      result.invoices_skipped = gen.skipped.length;
      result.invoices_emailed = gen.emailed;
      result.invoices_email_failed = gen.email_failed;
      if (gen.email_failed > 0) await onAutomatedFailure('generateRecurringInvoices', `${gen.email_failed} generated invoice email(s) failed to send (Brevo rejected or errored).`);
    } catch (err: any) {
      logger.error('billing: generateRecurringInvoices failed', err);
      result.invoices_error = err?.message || 'failed';
      await onAutomatedFailure('generateRecurringInvoices', err?.message || 'failed');
    }
  } else {
    result.invoices_skipped_reason = 'no admin user found for created_by';
  }

  try {
    const r = await sendDueReminders();
    result.reminders_sent = r.sent;
    result.reminders_failed = r.failed;
    if (r.failed > 0) await onAutomatedFailure('sendDueReminders', `${r.failed} due-reminder email(s) failed to send (Brevo rejected or errored).`);
  } catch (err: any) {
    logger.error('billing: sendDueReminders failed', err);
    result.reminders_error = err?.message || 'failed';
    await onAutomatedFailure('sendDueReminders', err?.message || 'failed');
  }

  // Overdue notices run AFTER markOverdueInvoices so a freshly-overdue invoice
  // is eligible the same run it crosses due+7.
  try {
    const r = await sendOverdueNotices();
    result.overdue_notices_sent = r.sent;
    result.overdue_notices_failed = r.failed;
    if (r.failed > 0) await onAutomatedFailure('sendOverdueNotices', `${r.failed} overdue-notice email(s) failed to send (Brevo rejected or errored).`);
  } catch (err: any) {
    logger.error('billing: sendOverdueNotices failed', err);
    result.overdue_notices_error = err?.message || 'failed';
    await onAutomatedFailure('sendOverdueNotices', err?.message || 'failed');
  }

  // Stale payment_pending check (admin-only alert, no client email): a
  // "check is in the mail" invoice that is still unpaid well past its due
  // date gets flagged to the admin, since payment_pending is excluded from
  // all client-facing dunning and would otherwise age silently forever.
  try {
    const r = await alertStalePaymentPending();
    result.stale_pending_flagged = r.flagged;
  } catch (err: any) {
    logger.error('billing: alertStalePaymentPending failed', err);
    result.stale_pending_error = err?.message || 'failed';
    await onAutomatedFailure('alertStalePaymentPending', err?.message || 'failed');
  }

  logger.info(`runDailyBilling ran: ${JSON.stringify(result)}`);
  return result;
}
