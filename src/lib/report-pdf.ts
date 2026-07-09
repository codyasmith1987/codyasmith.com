// Monthly report PDF generation.
//
// Markdown string -> PDF Buffer, using the same PDFKit buffer pattern as
// pdf.ts. Unlike contract-pdf.ts (which joins table cells with plain text
// and degrades on wide tables), this renderer lays tables out as a real
// grid with computed column widths, right-aligned numeric columns, and
// page-break handling, because a Performance Summary is mostly wide tables.
// HTML comment lines (the <!-- CODY --> placeholders) are dropped from the
// rendered PDF; they are authoring guidance, not client content.

export interface ReportPdfInput {
  title: string;
  subtitle?: string;
  draft?: boolean;
  bodyMarkdown: string;
}

const PAGE_W = 612;       // LETTER
const PAGE_H = 792;
const MARGIN = 54;
const CONTENT_W = PAGE_W - MARGIN * 2;

const DARK = '#171717';
const GRAY = '#525252';
const LIGHT = '#a3a3a3';
const RULE = '#e5e5e5';
const DRAFTRED = '#b00020';

export async function generateReportPdf(input: ReportPdfInput): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: MARGIN });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header band
    doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK).text('Cody A Smith LLC', MARGIN, MARGIN);
    doc.font('Helvetica').fontSize(9).fillColor(GRAY).text('cody@codyasmith.com');
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(20).fillColor(DARK).text(input.title);
    if (input.subtitle) {
      doc.moveDown(0.2);
      doc.font('Helvetica').fontSize(10).fillColor(GRAY).text(input.subtitle);
    }
    if (input.draft) {
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(DRAFTRED)
        .text('DRAFT. Descriptive substrate only; thesis and interpretation pending.');
    }
    doc.moveDown(0.8);
    doc.fillColor(DARK);

    renderMarkdown(doc, input.bodyMarkdown);
    doc.end();
  });
}

function ensureSpace(doc: any, needed: number): void {
  if (doc.y + needed > PAGE_H - MARGIN) {
    doc.addPage();
    doc.y = MARGIN;
  }
}

function renderMarkdown(doc: any, markdown: string): void {
  const lines = markdown.split('\n');
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    // Strip single-line authoring comments (the <!-- CODY --> placeholders).
    // The generated body only ever emits single-line, terminated comments.
    // A line that is only a comment is skipped with no blank gap. An
    // unterminated "<!--" is left as visible text (loud) rather than
    // silently swallowing the rest of the document.
    const line = raw.replace(/<!--.*?-->/g, '').trimEnd();
    if (line.trim() === '' && /<!--.*?-->/.test(raw)) { i++; continue; }

    // Table block: contiguous lines that start and end with '|'.
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const block: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        block.push(lines[i].trim());
        i++;
      }
      renderTable(doc, block);
      continue;
    }

    if (line.trim() === '') { doc.moveDown(0.4); i++; continue; }

    if (line.startsWith('## ')) {
      ensureSpace(doc, 28);
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(14).fillColor(DARK).text(line.slice(3), { width: CONTENT_W });
      doc.moveDown(0.2);
      i++; continue;
    }
    if (line.startsWith('### ')) {
      ensureSpace(doc, 22);
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#222').text(line.slice(4), { width: CONTENT_W });
      doc.moveDown(0.15);
      i++; continue;
    }
    if (line.startsWith('# ')) {
      ensureSpace(doc, 30);
      doc.font('Helvetica-Bold').fontSize(17).fillColor(DARK).text(line.slice(2), { width: CONTENT_W });
      doc.moveDown(0.3);
      i++; continue;
    }
    if (line.startsWith('- ')) {
      ensureSpace(doc, 16);
      writeInline(doc, `•  ${line.slice(2)}`, 10, MARGIN + 12, CONTENT_W - 12);
      i++; continue;
    }

    // Paragraph
    ensureSpace(doc, 16);
    writeInline(doc, line, 10, MARGIN, CONTENT_W);
    i++;
  }
}

// Inline **bold** runs in a single paragraph at x with width.
function writeInline(doc: any, text: string, size: number, x: number, width: number): void {
  const segments = text.split(/(\*\*[^*]+\*\*)/g).filter(s => s !== '');
  doc.fontSize(size).fillColor(GRAY);
  doc.x = x;
  segments.forEach((seg, idx) => {
    const isLast = idx === segments.length - 1;
    if (seg.startsWith('**') && seg.endsWith('**')) {
      doc.font('Helvetica-Bold').fillColor(DARK).text(seg.slice(2, -2), { width, continued: !isLast });
    } else {
      doc.font('Helvetica').fillColor(GRAY).text(seg, { width, continued: !isLast });
    }
  });
}

function stripBold(s: string): { text: string; bold: boolean } {
  if (s.startsWith('**') && s.endsWith('**') && s.length > 4) return { text: s.slice(2, -2), bold: true };
  return { text: s, bold: false };
}

function isNumericCell(s: string): boolean {
  const t = stripBold(s).text.trim();
  if (t === '' || t === 'new' || t === 'flat') return true; // align with numeric column
  return /^[+-]?[$]?[\d,]+(\.\d+)?%?$/.test(t) || /per day/.test(t) || /percentage points/.test(t) || /positions$/.test(t);
}

function renderTable(doc: any, block: string[]): void {
  // Parse cells; drop the separator row (| --- | --- |).
  const rows = block
    .map(l => l.slice(1, -1).split('|').map(c => c.trim()))
    .filter(cells => !cells.every(c => /^-+$/.test(c)));
  if (rows.length === 0) return;
  const header = rows[0];
  const body = rows.slice(1);
  const nCols = header.length;

  // Column widths: first column gets more room (labels), the rest share.
  const firstW = Math.min(CONTENT_W * 0.34, CONTENT_W - (nCols - 1) * 46);
  const restW = nCols > 1 ? (CONTENT_W - firstW) / (nCols - 1) : 0;
  const xFor = (c: number) => MARGIN + (c === 0 ? 0 : firstW + (c - 1) * restW);
  const wFor = (c: number) => (c === 0 ? firstW : restW) - 6;

  // Determine numeric columns from the body (right-align those).
  const numericCol: boolean[] = header.map((_, c) =>
    c > 0 && body.length > 0 && body.every(r => c >= r.length || isNumericCell(r[c])));

  const rowH = (cells: string[]): number => {
    doc.fontSize(8.5);
    let max = 14;
    cells.forEach((cell, c) => {
      const { text } = stripBold(cell);
      const h = doc.heightOfString(text || ' ', { width: wFor(c) });
      if (h + 6 > max) max = h + 6;
    });
    return max;
  };

  const drawRow = (cells: string[], bold: boolean, y: number): number => {
    const h = rowH(cells);
    doc.fontSize(8.5);
    cells.forEach((cell, c) => {
      const sb = stripBold(cell);
      doc.font(bold || sb.bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(bold || sb.bold ? DARK : GRAY);
      doc.text(sb.text || '', xFor(c), y, { width: wFor(c), align: numericCol[c] ? 'right' : 'left' });
    });
    return h;
  };

  doc.moveDown(0.2);
  ensureSpace(doc, 40);
  let y = doc.y;
  // Header
  const hH = drawRow(header, true, y);
  y += hH;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).strokeColor(RULE).lineWidth(0.5).stroke();
  y += 4;
  // Body with page breaks
  for (const r of body) {
    const cells = r.length < nCols ? r.concat(Array(nCols - r.length).fill('')) : r.slice(0, nCols);
    const h = rowH(cells);
    if (y + h > PAGE_H - MARGIN) {
      doc.addPage();
      y = MARGIN;
      const hH2 = drawRow(header, true, y);
      y += hH2;
      doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_W, y).strokeColor(RULE).lineWidth(0.5).stroke();
      y += 4;
    }
    drawRow(cells, false, y);
    y += h;
  }
  doc.y = y;
  doc.moveDown(0.4);
  doc.fillColor(DARK).font('Helvetica');
}
