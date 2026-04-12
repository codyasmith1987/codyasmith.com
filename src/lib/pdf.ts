// Invoice PDF generation using PDFKit

import { getInvoice, getInvoiceItems, getPaymentsByInvoice } from './invoices';
import { getContract } from './contracts';
import { getAllClients } from './auth';

export async function generateInvoicePdf(invoiceId: string): Promise<Buffer> {
  const invoice = await getInvoice(invoiceId);
  if (!invoice) throw new Error('Invoice not found');

  const items = await getInvoiceItems(invoiceId);
  const payments = await getPaymentsByInvoice(invoiceId);
  const contract = await getContract(invoice.contract_id);
  const clients = await getAllClients();
  const client = clients.find(c => c.id === invoice.client_id);

  const PDFDocument = (await import('pdfkit')).default;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 60 });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const gray = '#525252';
    const dark = '#171717';
    const light = '#a3a3a3';

    // Header
    doc.fontSize(18).fillColor(dark).text('Cody A Smith LLC', { align: 'left' });
    doc.fontSize(9).fillColor(gray).text('cody@codyasmith.com');
    doc.moveDown(1.5);

    // Invoice title + number
    doc.fontSize(24).fillColor(dark).text('Invoice', { align: 'left' });
    doc.fontSize(11).fillColor(gray).text(invoice.invoice_number);
    doc.moveDown(1);

    // Client + dates
    const topY = doc.y;
    doc.fontSize(10).fillColor(light).text('Bill to', 60, topY);
    doc.fontSize(11).fillColor(dark).text(client?.name || 'Client', 60, topY + 14);

    doc.fontSize(10).fillColor(light).text('Issued', 300, topY);
    doc.fontSize(11).fillColor(dark).text(invoice.issued_date || '-', 300, topY + 14);

    doc.fontSize(10).fillColor(light).text('Due', 420, topY);
    doc.fontSize(11).fillColor(dark).text(invoice.due_date || '-', 420, topY + 14);

    if (invoice.billing_period_start) {
      doc.fontSize(10).fillColor(light).text('Period', 300, topY + 34);
      doc.fontSize(10).fillColor(gray).text(`${invoice.billing_period_start} to ${invoice.billing_period_end}`, 300, topY + 48);
    }

    doc.y = topY + 70;
    doc.moveDown(1);

    // Line items table
    const tableTop = doc.y;
    const col = { desc: 60, qty: 340, rate: 400, amount: 480 };

    // Header row
    doc.fontSize(8).fillColor(light);
    doc.text('Description', col.desc, tableTop);
    doc.text('Qty', col.qty, tableTop, { width: 50, align: 'right' });
    doc.text('Rate', col.rate, tableTop, { width: 70, align: 'right' });
    doc.text('Amount', col.amount, tableTop, { width: 70, align: 'right' });

    doc.moveTo(60, tableTop + 14).lineTo(550, tableTop + 14).strokeColor('#e5e5e5').lineWidth(0.5).stroke();

    let y = tableTop + 22;
    doc.fontSize(10);
    for (const item of items) {
      doc.fillColor(dark).text(item.description, col.desc, y, { width: 270 });
      doc.fillColor(gray).text(String(item.quantity), col.qty, y, { width: 50, align: 'right' });
      doc.fillColor(gray).text(`$${item.unit_price.toFixed(2)}`, col.rate, y, { width: 70, align: 'right' });
      doc.fillColor(dark).text(`$${item.amount.toFixed(2)}`, col.amount, y, { width: 70, align: 'right' });
      y += 18;
    }

    // Totals
    y += 10;
    doc.moveTo(350, y).lineTo(550, y).strokeColor('#e5e5e5').lineWidth(0.5).stroke();
    y += 8;

    doc.fontSize(10).fillColor(gray).text('Subtotal', 350, y, { width: 120, align: 'right' });
    doc.fillColor(dark).text(`$${invoice.subtotal.toFixed(2)}`, col.amount, y, { width: 70, align: 'right' });
    y += 18;

    if (invoice.tax > 0) {
      doc.fillColor(gray).text('Tax', 350, y, { width: 120, align: 'right' });
      doc.fillColor(dark).text(`$${invoice.tax.toFixed(2)}`, col.amount, y, { width: 70, align: 'right' });
      y += 18;
    }

    doc.fontSize(12).fillColor(dark).font('Helvetica-Bold').text('Total', 350, y, { width: 120, align: 'right' });
    doc.text(`$${invoice.total.toFixed(2)}`, col.amount, y, { width: 70, align: 'right' });
    y += 22;

    doc.font('Helvetica');

    if (invoice.amount_paid > 0) {
      doc.fontSize(10).fillColor(gray).text('Amount paid', 350, y, { width: 120, align: 'right' });
      doc.fillColor('#059669').text(`$${invoice.amount_paid.toFixed(2)}`, col.amount, y, { width: 70, align: 'right' });
      y += 18;
    }

    const balance = invoice.total - invoice.amount_paid;
    if (balance > 0) {
      doc.fontSize(12).fillColor(dark).font('Helvetica-Bold').text('Balance due', 350, y, { width: 120, align: 'right' });
      doc.text(`$${balance.toFixed(2)}`, col.amount, y, { width: 70, align: 'right' });
      y += 22;
    }

    doc.font('Helvetica');

    // Status badge
    const statusLabel = invoice.status === 'paid' ? 'PAID' : invoice.status === 'partial' ? 'PARTIALLY PAID' : invoice.status.toUpperCase();
    doc.fontSize(10).fillColor(invoice.status === 'paid' ? '#059669' : invoice.status === 'overdue' ? '#dc2626' : gray).text(statusLabel, 60, y + 10);

    // Payment history
    if (payments.length > 0) {
      y += 40;
      doc.fontSize(8).fillColor(light).text('Payment History', 60, y);
      y += 14;
      doc.fontSize(9);
      for (const p of payments) {
        doc.fillColor(gray).text(`${p.paid_at.split('T')[0]}  $${p.amount.toFixed(2)}  ${p.payment_method || ''}  ${p.reference || ''}`, 60, y);
        y += 14;
      }
    }

    // Notes
    if (invoice.notes) {
      y += 20;
      doc.fontSize(8).fillColor(light).text('Notes', 60, y);
      doc.fontSize(9).fillColor(gray).text(invoice.notes, 60, y + 14, { width: 400 });
    }

    doc.end();
  });
}
