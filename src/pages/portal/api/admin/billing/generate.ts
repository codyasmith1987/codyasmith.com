import type { APIRoute } from 'astro';
import { generateRecurringInvoices } from '../../../../../lib/billing';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  try {
    const result = await generateRecurringInvoices(locals.user!.id);
    // generateRecurringInvoices auto-emails each generated invoice to the client
    // (PR #295), so surface emailed/email_failed -- otherwise this admin action
    // silently sends real client email with no feedback.
    return json({
      generated: result.generated.length,
      skipped: result.skipped.length,
      emailed: result.emailed,
      email_failed: result.email_failed,
      invoice_ids: result.generated,
    });
  } catch (err) {
    logger.error('Generate invoices error', err);
    return json({ error: 'Failed to generate invoices' }, 500);
  }
};
