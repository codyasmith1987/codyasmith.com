import type { APIRoute } from 'astro';
import { generateInvoicePdf } from '../../../../../../lib/pdf';
import { getInvoice } from '../../../../../../lib/invoices';
import { logger } from '../../../../../../lib/logger';

export const prerender = false;

export const GET: APIRoute = async ({ locals, params }) => {
  if (locals.user?.role !== 'admin') {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const invoice = await getInvoice(params.id!);
    if (!invoice) return new Response('Not found', { status: 404 });

    const pdf = await generateInvoicePdf(params.id!);
    return new Response(pdf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${invoice.invoice_number}.pdf"`,
      },
    });
  } catch (err) {
    logger.error('Generate PDF error', err);
    return new Response('Failed to generate PDF', { status: 500 });
  }
};
