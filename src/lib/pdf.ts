// Invoice PDF generation using PDFKit.
//
// Gold-standard layout (matches Cody's hand-made invoices): letterhead +
// footer from seller_profile; a Bill To block from the per-invoice
// bill_to_snapshot (frozen at send) or, on a draft, live from client_metadata;
// Services and Reimbursements sections, each grouped with its own subtotal; a
// TOTAL DUE bar; multi-paragraph Notes.
//
// Backward-safe: a legacy item with NULL name renders from description, a NULL
// category counts as Services, a NULL frequency shows no tag. Existing flat
// invoices render correctly (all Services, Reimbursements subtotal $0.00).

import { getInvoice, getInvoiceItems, getPaymentsByInvoice, splitSubtotals, type InvoiceItem } from './invoices';
import { getAllClients } from './auth';
import { getClientMetadata } from './agreements';
import { getSellerProfile } from './seller-profile';

const DARK = '#171717';
const GRAY = '#525252';
const LIGHT = '#a3a3a3';
const RULE = '#e5e5e5';
const AMBER = '#b45309'; // amber-700, legible on white (the portal accent, not the washed-out 400)
const BAND = '#f5f5f5';

function money(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function freqTag(frequency: string | null): string {
  if (!frequency) return '';
  return frequency.replace(/_/g, '-').toUpperCase();
}

interface BillTo { company: string; contact?: string; address?: string; email?: string; }

function resolveBillTo(invoice: any, clientName: string, meta: any): BillTo {
  if (invoice.bill_to_snapshot) {
    try {
      const s = JSON.parse(invoice.bill_to_snapshot);
      return {
        company: s.company || clientName,
        contact: s.contact || undefined,
        address: s.address || undefined,
        email: s.email || undefined,
      };
    } catch { /* fall through to the live record */ }
  }
  return {
    company: meta?.legal_entity_name || clientName,
    contact: meta?.primary_contact_name || undefined,
    address: meta?.notice_address || meta?.principal_address || undefined,
    email: meta?.primary_contact_email || undefined,
  };
}

export async function generateInvoicePdf(invoiceId: string): Promise<Buffer> {
  const invoice = await getInvoice(invoiceId);
  if (!invoice) throw new Error('Invoice not found');

  const items = await getInvoiceItems(invoiceId);
  const payments = await getPaymentsByInvoice(invoiceId);
  const clients = await getAllClients();
  const client = clients.find(c => c.id === invoice.client_id);
  const meta = await getClientMetadata(invoice.client_id).catch(() => null);
  const seller = await getSellerProfile();
  const billTo = resolveBillTo(invoice, client?.name || 'Client', meta);

  const cat = (i: InvoiceItem) => i.category || 'services';
  const isReimb = (i: InvoiceItem) => cat(i) === 'reimbursements';
  const isPastDue = (i: InvoiceItem) => cat(i) === 'past_due' || cat(i) === 'late_interest';
  const services = items.filter(i => !isReimb(i) && !isPastDue(i));
  const reimbursements = items.filter(isReimb);
  const pastDue = items.filter(isPastDue);
  const subs = splitSubtotals(items);
  // Compute the total from the live item subtotal + tax rather than the stored
  // invoice.total, so the PDF is correct even if a tax-only update left the
  // stored total stale. subs.total is the sum of item amounts (the subtotal).
  const taxAmount = Number(invoice.tax) || 0;
  const grandTotal = subs.total + taxAmount;

  const PDFDocument = (await import('pdfkit')).default;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 60 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const L = 60;
    const R = 552;
    const W = R - L;
    const amountW = 92;
    const amountX = R - amountW;
    const nameW = amountX - L - 14;

    const ensureSpace = (needed: number) => {
      if (doc.y + needed > 740) doc.addPage();
    };

    // ---- Letterhead ----
    doc.font('Helvetica-Bold').fontSize(16).fillColor(DARK).text(seller.display_name, L, 60);
    doc.font('Helvetica').fontSize(9).fillColor(GRAY);
    doc.text(seller.street, L);
    doc.text(seller.city_state_zip, L);
    doc.text(`${seller.email}  |  ${seller.phone}`, L);

    // ---- INVOICE meta (left) + BILL TO (right) ----
    doc.moveDown(1.2);
    const blockTop = doc.y;

    doc.font('Helvetica-Bold').fontSize(20).fillColor(DARK).text('INVOICE', L, blockTop);
    let iy = blockTop + 28;
    const metaRows: Array<[string, string]> = [
      ['Invoice #:', invoice.invoice_number],
      ['Date:', invoice.issued_date || '-'],
      ['Due:', invoice.terms_label || invoice.due_date || 'Upon Receipt'],
    ];
    if (invoice.billing_period_start && invoice.billing_period_end) {
      metaRows.push(['Period:', `${invoice.billing_period_start} to ${invoice.billing_period_end}`]);
    }
    doc.fontSize(9.5);
    for (const [k, v] of metaRows) {
      doc.font('Helvetica-Bold').fillColor(GRAY).text(k, L, iy, { continued: true });
      doc.font('Helvetica').fillColor(DARK).text(' ' + v);
      iy += 15;
    }

    const bx = 320;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(LIGHT).text('BILL TO', bx, blockTop);
    let by = blockTop + 14;
    const btLines = [billTo.contact, billTo.company, billTo.address, billTo.email].filter(Boolean) as string[];
    if (btLines.length === 0) btLines.push(client?.name || 'Client');
    doc.font('Helvetica').fontSize(10).fillColor(DARK);
    for (let n = 0; n < btLines.length; n++) {
      doc.font(n === 0 ? 'Helvetica-Bold' : 'Helvetica').fillColor(n === 0 ? DARK : GRAY)
        .text(btLines[n], bx, by, { width: R - bx });
      by = doc.y + 2;
    }

    doc.y = Math.max(iy, by) + 16;

    // Optional invoice title
    if (invoice.title) {
      ensureSpace(30);
      doc.font('Helvetica-Bold').fontSize(11).fillColor(DARK).text(invoice.title, L, doc.y);
      doc.moveDown(0.4);
    }

    // ---- A section: header band, item rows, subtotal ----
    const renderRow = (it: InvoiceItem) => {
      const name = it.name || it.description || '';
      const tag = freqTag(it.frequency);
      ensureSpace(34);
      const y = doc.y;
      // amount on the same baseline as the first line of the name
      doc.font('Helvetica').fontSize(10).fillColor(DARK)
        .text(money(it.amount), amountX, y, { width: amountW, align: 'right' });
      // name (bold) + optional amber frequency tag, continued inline
      doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK)
        .text(name, L + 4, y, { width: nameW, continued: !!tag });
      if (tag) {
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(AMBER).text('   ' + tag, { continued: false });
      }
      if (it.sub_description) {
        doc.font('Helvetica').fontSize(8.5).fillColor(GRAY).text(it.sub_description, L + 4, doc.y, { width: nameW });
      }
      doc.y = doc.y + 7;
    };

    const renderSection = (label: string, rows: InvoiceItem[], subtotal: number, alwaysShow: boolean) => {
      if (rows.length === 0 && !alwaysShow) return;
      ensureSpace(48);
      const y = doc.y + 6;
      doc.rect(L, y, W, 20).fill(BAND);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY).text(label, L + 8, y + 6.5);
      doc.text('Amount', amountX, y + 6.5, { width: amountW - 8, align: 'right' });
      doc.y = y + 28;

      for (const it of rows) renderRow(it);

      const ly = doc.y + 2;
      doc.moveTo(amountX - 60, ly).lineTo(R, ly).strokeColor(RULE).lineWidth(0.5).stroke();
      const sy = ly + 6;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY)
        .text(`${label} Subtotal`, L + 4, sy, { width: amountX - L - 12, align: 'right' });
      doc.font('Helvetica-Bold').fillColor(DARK).text(money(subtotal), amountX, sy, { width: amountW, align: 'right' });
      doc.y = sy + 22;
    };

    renderSection('Services', services, subs.services, true);
    renderSection('Reimbursements', reimbursements, subs.reimbursements, true);
    // Past due (carried-forward balance + late interest). Only shown when present,
    // so normal invoices are unchanged.
    renderSection('Past due', pastDue, subs.pastDue, false);

    // Subtotal + Tax rows, only when the invoice is taxed. The section subtotals
    // above show the untaxed split; this adds the grand subtotal and tax so the
    // TOTAL DUE bar (invoice.total = subtotal + tax) is never understated.
    if (taxAmount > 0) {
      ensureSpace(36);
      let ry = doc.y + 2;
      doc.font('Helvetica').fontSize(10).fillColor(GRAY).text('Subtotal', L + 4, ry, { width: amountX - L - 12, align: 'right' });
      doc.fillColor(DARK).text(money(subs.total), amountX, ry, { width: amountW, align: 'right' });
      ry = doc.y + 2;
      doc.fillColor(GRAY).text('Tax', L + 4, ry, { width: amountX - L - 12, align: 'right' });
      doc.fillColor(DARK).text(money(taxAmount), amountX, ry, { width: amountW, align: 'right' });
      doc.y = doc.y + 8;
    }

    // ---- TOTAL DUE bar ----
    ensureSpace(40);
    const ty = doc.y + 4;
    doc.rect(L, ty, W, 30).fill(AMBER);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff').text('TOTAL DUE', L + 12, ty + 8);
    doc.text(money(grandTotal), amountX - 40, ty + 8, { width: amountW + 28, align: 'right' });
    doc.y = ty + 40;

    // Payments / balance (portal-tracked; absent on a clean Upon-Receipt invoice)
    if (invoice.amount_paid > 0) {
      const py = doc.y;
      doc.font('Helvetica').fontSize(10).fillColor(GRAY).text('Amount paid', L + 4, py, { width: amountX - L - 12, align: 'right' });
      doc.fillColor('#059669').text(money(invoice.amount_paid), amountX, py, { width: amountW, align: 'right' });
      const balance = grandTotal - invoice.amount_paid;
      const byy = doc.y + 2;
      doc.font('Helvetica-Bold').fontSize(10).fillColor(DARK).text('Balance due', L + 4, byy, { width: amountX - L - 12, align: 'right' });
      doc.text(money(balance), amountX, byy, { width: amountW, align: 'right' });
      doc.y = doc.y + 14;
    }

    // ---- Notes (multi-paragraph) ----
    if (invoice.notes) {
      ensureSpace(40);
      doc.moveDown(0.8);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(LIGHT).text('Notes', L, doc.y);
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(9).fillColor(GRAY);
      for (const para of String(invoice.notes).split(/\n\s*\n/)) {
        const t = para.trim();
        if (!t) continue;
        doc.text(t, L, doc.y, { width: W });
        doc.moveDown(0.3);
      }
    }

    // ---- Payment history (if any) ----
    if (payments.length > 0) {
      ensureSpace(40);
      doc.moveDown(0.6);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(LIGHT).text('Payment history', L, doc.y);
      doc.moveDown(0.2);
      doc.font('Helvetica').fontSize(9).fillColor(GRAY);
      for (const p of payments) {
        doc.text(`${p.paid_at.split('T')[0]}   ${money(p.amount)}   ${p.payment_method || ''} ${p.reference || ''}`.trim(), L, doc.y);
      }
    }

    // ---- Footer ----
    // Flows after the content. Pinning to an absolute y past the bottom margin
    // makes PDFKit spill each line onto its own new page (caught in PDF review).
    doc.moveDown(2);
    if (doc.y > 720) doc.addPage();
    doc.font('Helvetica').fontSize(8.5).fillColor(LIGHT)
      .text(`${seller.display_name}  |  ${seller.email}  |  ${seller.phone}  |  Thank you for your business.`, L, doc.y, { width: W, align: 'center', lineBreak: false });
    doc.font('Helvetica').fontSize(7.5).fillColor(LIGHT)
      .text(seller.legal_footer, L, doc.y + 2, { width: W, align: 'center', lineBreak: false });

    doc.end();
  });
}
