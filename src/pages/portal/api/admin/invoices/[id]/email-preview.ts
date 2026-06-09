// Admin email preview: render the exact client-facing invoice email for a
// chosen variant (ready / reminder / overdue) WITHOUT sending anything. Backs
// the "Preview email" link on the invoice detail page so the copy can be seen
// before it ever reaches a client. GET only, no DB writes, no Brevo call.

import type { APIRoute } from 'astro';
import { renderInvoicePreview } from '../../../../../../lib/invoice-emails';
import type { InvoiceEmailVariant } from '../../../../../../lib/invoice-email-templates';
import { escapeHtml } from '../../../../../../lib/email-safety';
import { logger } from '../../../../../../lib/logger';

export const prerender = false;

const VARIANTS: InvoiceEmailVariant[] = ['ready', 'reminder', 'overdue'];
const LABEL: Record<InvoiceEmailVariant, string> = {
  ready: 'Invoice ready',
  reminder: 'Reminder',
  overdue: 'Overdue notice',
};

export const GET: APIRoute = async ({ locals, params, url }) => {
  if (locals.user?.role !== 'admin') return new Response('Forbidden', { status: 403 });

  try {
    const id = params.id!;
    const vParam = url.searchParams.get('variant') || 'ready';
    const variant: InvoiceEmailVariant = (VARIANTS as string[]).includes(vParam) ? (vParam as InvoiceEmailVariant) : 'ready';

    const rendered = await renderInvoicePreview(id, variant);
    if (!rendered) return new Response('Invoice not found', { status: 404 });

    const tabs = VARIANTS.map((v) => {
      const active = v === variant;
      const style = active
        ? 'background:#1a1814;color:#faf7f2'
        : 'background:#e6ddd0;color:#1a1814';
      return `<a href="?variant=${v}" style="display:inline-block;padding:8px 14px;margin-right:6px;border-radius:8px;text-decoration:none;font:600 13px system-ui;${style}">${LABEL[v]}</a>`;
    }).join('');

    const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Email preview</title></head>
<body style="margin:0;background:#d9d2c7;padding:24px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
  <div style="max-width:680px;margin:0 auto">
    <p style="font:600 12px system-ui;letter-spacing:.08em;text-transform:uppercase;color:#6b6359;margin:0 0 10px">Preview only &middot; nothing is sent</p>
    <div style="margin-bottom:14px">${tabs}</div>
    <div style="background:#fff;border:1px solid #c9bfb0;border-radius:6px;padding:10px 14px;margin-bottom:14px;font:13px system-ui;color:#1a1814"><strong>Subject:</strong> ${escapeHtml(rendered.subject)}</div>
    <div style="background:#faf7f2;border:1px solid #c9bfb0;border-radius:10px;overflow:hidden">${rendered.html}</div>
  </div>
</body></html>`;

    return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' } });
  } catch (err) {
    logger.error('Invoice email preview error', err);
    return new Response('Failed to render preview', { status: 500 });
  }
};
