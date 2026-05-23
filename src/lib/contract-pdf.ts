// Contract PDF generation via PDFKit.
//
// Renders the agreed-upon contract body (markdown, placeholders already
// resolved) plus a Schedule A page (from the structured JSON) into a
// single PDF Buffer. The output is deterministic given identical input,
// which matters for the document_hash audit trail: re-rendering against
// the same template + schedule_a + client_metadata produces the same
// bytes, so a downstream cross-check can confirm the signed document
// has not changed.

import type { ScheduleA } from './contract-schedule';
import type { ContractTemplate } from './contract-templates';
import type { RenderContext, PracticeInfo } from './contract-render';

export interface ContractPdfInput {
  template: ContractTemplate;
  context: RenderContext;
  // The resolved markdown body. Placeholders already substituted,
  // internal blocks already stripped.
  resolvedBodyMarkdown: string;
  scheduleA: ScheduleA;
  signers: Array<{ name: string; role: string; signature?: string; signed_at?: string }>;
  practice: PracticeInfo;
}

export async function generateContractPdf(input: ContractPdfInput): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 72 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header band
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text('Cody A Smith LLC');
    doc.font('Helvetica').fontSize(9).fillColor('#555').text(input.practice.address);
    doc.moveDown(0.2);
    doc.text('cody@codyasmith.com');
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(22).fillColor('#111').text(input.template.title);
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(10).fillColor('#666').text(`Effective Date: ${input.scheduleA.effective_date || '__________'}`);
    doc.moveDown(1);

    // Body sections
    renderMarkdownBody(doc, input.resolvedBodyMarkdown);

    // Schedule A on its own page
    doc.addPage();
    renderScheduleAPage(doc, input.scheduleA);

    // Signature audit footer on its own page
    doc.addPage();
    renderSignatureSummary(doc, input);

    doc.end();
  });
}

// Markdown → PDFKit ops. Supports the subset the contract uses:
// `## N. Heading`, `### N.M Sub-heading`, `**bold**`, `*italic*`,
// `- bullet`, tables (rendered as definition lists), and paragraphs.
function renderMarkdownBody(doc: any, markdown: string): void {
  const lines = markdown.split('\n');
  let i = 0;
  let inTable = false;
  let tableRows: string[][] = [];

  const flushTable = () => {
    if (!inTable || tableRows.length === 0) {
      inTable = false;
      tableRows = [];
      return;
    }
    // Skip the separator row (the | --- | --- | line).
    const dataRows = tableRows.filter(r => !r.every(c => /^-+$/.test(c.trim())));
    if (dataRows.length === 0) {
      inTable = false;
      tableRows = [];
      return;
    }
    const [header, ...body] = dataRows;
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#111');
    if (header) doc.text(header.join('  |  '));
    doc.font('Helvetica').fontSize(10).fillColor('#222');
    for (const row of body) {
      doc.text(row.join('  |  '));
    }
    doc.moveDown(0.5);
    inTable = false;
    tableRows = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimEnd();

    // Table row
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      inTable = true;
      const cells = trimmed.slice(1, -1).split('|').map(c => c.trim());
      tableRows.push(cells);
      i++;
      continue;
    } else if (inTable) {
      flushTable();
    }

    // Blank line
    if (trimmed === '') {
      doc.moveDown(0.4);
      i++;
      continue;
    }

    // Headings
    if (trimmed.startsWith('## ')) {
      doc.moveDown(0.6);
      doc.font('Helvetica-Bold').fontSize(15).fillColor('#111').text(trimmed.slice(3));
      doc.moveDown(0.3);
      i++;
      continue;
    }
    if (trimmed.startsWith('### ')) {
      doc.moveDown(0.4);
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#222').text(trimmed.slice(4));
      doc.moveDown(0.2);
      i++;
      continue;
    }
    if (trimmed.startsWith('# ')) {
      doc.font('Helvetica-Bold').fontSize(20).fillColor('#111').text(trimmed.slice(2));
      doc.moveDown(0.4);
      i++;
      continue;
    }

    // Horizontal rule
    if (trimmed === '---') {
      doc.moveDown(0.4);
      const y = doc.y;
      doc.strokeColor('#ccc').lineWidth(0.5).moveTo(72, y).lineTo(540, y).stroke();
      doc.moveDown(0.4);
      i++;
      continue;
    }

    // List item
    if (trimmed.startsWith('- ')) {
      writeInlineFormatted(doc, '•  ' + trimmed.slice(2), { fontSize: 10, indent: 18 });
      i++;
      continue;
    }

    // Default paragraph
    writeInlineFormatted(doc, trimmed, { fontSize: 10 });
    i++;
  }

  if (inTable) flushTable();
}

// Render a paragraph with bold (**...**) and italic (*...*) runs. Plain
// segments fall back to Helvetica regular.
function writeInlineFormatted(doc: any, text: string, opts: { fontSize: number; indent?: number }): void {
  const segments = splitFormattedRuns(text);
  doc.fontSize(opts.fontSize).fillColor('#222');
  const lineOptions: any = opts.indent ? { indent: opts.indent } : {};
  if (segments.length === 1 && segments[0].style === 'plain') {
    doc.font('Helvetica').text(segments[0].text, lineOptions);
    return;
  }
  // Multi-segment: use continued runs.
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.style === 'bold') doc.font('Helvetica-Bold');
    else if (seg.style === 'italic') doc.font('Helvetica-Oblique');
    else if (seg.style === 'bolditalic') doc.font('Helvetica-BoldOblique');
    else doc.font('Helvetica');
    const isLast = i === segments.length - 1;
    doc.text(seg.text, { ...lineOptions, continued: !isLast });
  }
}

interface Run { style: 'plain' | 'bold' | 'italic' | 'bolditalic'; text: string; }

function splitFormattedRuns(text: string): Run[] {
  const runs: Run[] = [];
  let i = 0;
  while (i < text.length) {
    // Bold
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        runs.push({ style: 'bold', text: text.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }
    // Italic (single *)
    if (text[i] === '*' && text[i + 1] !== '*') {
      const end = text.indexOf('*', i + 1);
      if (end !== -1 && text[end + 1] !== '*') {
        runs.push({ style: 'italic', text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // Plain run until the next * or end of string
    const nextStar = text.indexOf('*', i);
    const slice = nextStar === -1 ? text.slice(i) : text.slice(i, nextStar);
    if (slice.length > 0) {
      runs.push({ style: 'plain', text: slice });
    }
    i = nextStar === -1 ? text.length : nextStar;
    if (i < text.length && text[i] === '*' && runs[runs.length - 1]?.text.endsWith('*')) {
      i++; // safety against runaway loops
    }
  }
  return runs.length === 0 ? [{ style: 'plain', text }] : runs;
}

function renderScheduleAPage(doc: any, s: ScheduleA): void {
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#111').text('Schedule A — Engagement Specifics');
  doc.moveDown(0.4);
  doc.font('Helvetica').fontSize(10).fillColor('#555').text('Schedule A is completed per Client and incorporated into the agreement by reference.');
  doc.moveDown(0.7);

  section(doc, 'A.1 Effective Date', s.effective_date || '__________');

  const c = s.designated_contacts?.client || {};
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#111').text('A.2 Designated contacts and notice addresses');
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(10).fillColor('#222');
  doc.text(`Practice: Cody Alan Smith, Member, Cody A Smith LLC, 604 Morningside Circle, Cedar City, UT 84720. cody@codyasmith.com. 435-868-7133.`);
  doc.moveDown(0.2);
  doc.text(`Client: ${c.name || '__________'}, ${c.title || '__________'}, ${c.address || '__________'}, ${c.email || '__________'}, ${c.phone || '__________'}.`);
  doc.moveDown(0.6);

  doc.font('Helvetica-Bold').fontSize(12).fillColor('#111').text('A.3 Products purchased');
  doc.font('Helvetica').fontSize(10).fillColor('#222');
  const pp = s.products_purchased;
  doc.list([
    `Web Management: ${pp.web_management ? 'Yes' : 'No'}`,
    `Marketing Consulting: ${pp.marketing_consulting ? 'Yes' : 'No'}`,
    `Build work: ${pp.build ? 'Yes (separate Build Statement of Work)' : 'No'}`,
    `Other Statement of Work: ${pp.other_sow ? 'Yes' : 'No'}`,
  ]);
  doc.moveDown(0.5);

  if (pp.web_management && s.web_management) {
    const wm = s.web_management;
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111').text('A.4 Web Management specifics');
    doc.font('Helvetica').fontSize(10).fillColor('#222');
    const wmItems = [
      `Tier: ${wm.tier_name}`,
      `Sites managed: ${wm.sites.map(x => x.domain + (x.description ? ` (${x.description})` : '')).join('; ')}`,
      `Per-site count: ${wm.site_count}`,
      `Monthly fee (single-site base): $${wm.monthly_base.toLocaleString('en-US')}`,
      `Monthly fee total (with multi-site formula): $${wm.monthly_total.toLocaleString('en-US')}`,
      `Included hours per month (total across sites): ${wm.included_hours}`,
      `Pre-approved overage buffer: 2 hours per month`,
      `Onboarding fee: $${wm.onboarding_fee.toLocaleString('en-US')}`,
      `Update cadence: ${wm.update_cadence}`,
      `Response time: ${wm.response_time}`,
      `Quarterly staff training: ${wm.quarterly_training_sessions ? `${wm.quarterly_training_sessions} sessions per quarter` : 'not included'}`,
    ];
    doc.list(wmItems);
    doc.moveDown(0.5);
  }

  if (pp.marketing_consulting && s.marketing_consulting) {
    const mc = s.marketing_consulting;
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111').text('A.5 Marketing Consulting specifics');
    doc.font('Helvetica').fontSize(10).fillColor('#222');
    doc.list([
      `Tier: ${mc.tier_name}`,
      `Monthly retainer: $${mc.monthly_retainer.toLocaleString('en-US')}`,
      `Initial audit fee: $${mc.initial_audit_fee.toLocaleString('en-US')}`,
      `Strategy call frequency: ${mc.strategy_call_frequency}`,
      `Deep advisories per cycle: ${mc.deep_advisories_per_cycle}`,
      `Performance reporting cadence: ${mc.performance_reporting_cadence}`,
      `Hiring guidance: ${mc.hiring_guidance ? 'included' : 'not included'}`,
    ]);
    doc.moveDown(0.5);
  }

  doc.font('Helvetica-Bold').fontSize(12).fillColor('#111').text('A.6 Hours and rates');
  doc.font('Helvetica').fontSize(10).fillColor('#222');
  const hr = s.hours_and_rates;
  doc.list([
    `Web Management included hours per month: ${hr.included_hours ?? '__'}`,
    `Pre-approved overage buffer: ${hr.overage_buffer} hours per month`,
    `Overage rate beyond buffer (standard): $${hr.overage_rate}/hr`,
    `Rush rate (section 5.5): $${hr.rush_rate}/hr, two-hour minimum`,
    `Emergency rate (section 5.5): $${hr.emergency_rate}/hr, two-hour minimum`,
  ]);
  doc.moveDown(0.5);

  doc.font('Helvetica-Bold').fontSize(12).fillColor('#111').text('A.7 Day-one access list');
  doc.font('Helvetica').fontSize(10).fillColor('#222');
  if (s.day_one_access.required_by) {
    doc.text(`The Client provides administrator-level access to the following systems by ${s.day_one_access.required_by}:`);
  } else {
    doc.text('The Client provides administrator-level access to the following systems on the Effective Date:');
  }
  if (s.day_one_access.items.length > 0) {
    doc.list(s.day_one_access.items.map(it => `${it.system}: ${it.provider}`));
  } else {
    doc.font('Helvetica-Oblique').text('To be completed at intake.');
    doc.font('Helvetica');
  }
  doc.moveDown(0.5);

  doc.font('Helvetica-Bold').fontSize(12).fillColor('#111').text('A.8 Pass-through items at signing');
  doc.font('Helvetica').fontSize(10).fillColor('#222');
  if (s.pass_through_items.length > 0) {
    doc.list(s.pass_through_items.map(p => `${p.name} — $${p.annual_cost.toLocaleString('en-US')} (${p.billing_note})`));
  } else {
    doc.text('None at signing.');
  }
  doc.moveDown(0.5);

  if (pp.build) {
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111').text('A.9 Build Statement of Work');
    doc.font('Helvetica').fontSize(10).fillColor('#222');
    doc.text('A separate, signed Build Statement of Work specifies the scope, deliverables, pages, design, launch criteria, build fee, and payment schedule for any from-scratch build work under this agreement.');
    if (s.build_sow_ref) {
      doc.moveDown(0.2);
      doc.font('Helvetica-Oblique').text(s.build_sow_ref);
      doc.font('Helvetica');
    }
    doc.moveDown(0.5);
  }

  if (pp.other_sow) {
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111').text('A.10 Other Statement of Work');
    doc.font('Helvetica').fontSize(10).fillColor('#222');
    doc.text('A separate, signed Statement of Work specifies the scope, deliverables, fee, and timeline for any non-build execution work under section 3.2.');
    if (s.other_sow_ref) {
      doc.moveDown(0.2);
      doc.font('Helvetica-Oblique').text(s.other_sow_ref);
      doc.font('Helvetica');
    }
    doc.moveDown(0.5);
  }

  doc.font('Helvetica-Bold').fontSize(12).fillColor('#111').text('A.11 Excluded work');
  doc.font('Helvetica').fontSize(10).fillColor('#222');
  doc.list([
    'Full site redesign, custom theme or plugin development, advanced coding',
    'Paid media management, campaign management, ad buying, email marketing automation, social media management, photography, video production',
    'Building large volumes of net-new pages or extensive copywriting projects',
    'Third-party subscription fees, premium plugins, paid connectors, hosting upgrades beyond agreed scope, domain renewals (handled as pass-through under section 5.6)',
    'Legal, accessibility, privacy, or regulatory compliance certification (see section 16)',
    'Guaranteed uptime, rankings, lead volume, or attribution accuracy (see section 11)',
    'Correction of problems caused by undocumented third-party systems, legacy custom code, or hidden vendor dependencies discovered after work begins',
  ]);
}

function renderSignatureSummary(doc: any, input: ContractPdfInput): void {
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#111').text('Signature record');
  doc.moveDown(0.4);
  doc.font('Helvetica').fontSize(10).fillColor('#555').text('Signatures captured electronically in the codyasmith.com portal in accordance with the Electronic Signatures in Global and National Commerce Act (ESIGN) and the Utah Uniform Electronic Transactions Act (Utah Code Title 46 Chapter 4).');
  doc.moveDown(0.7);

  doc.font('Helvetica-Bold').fontSize(12).fillColor('#111').text('Cody A Smith LLC');
  doc.font('Helvetica').fontSize(10).fillColor('#222');
  doc.text(`Name: ${input.practice.signer_name}`);
  doc.text(`Title: ${input.practice.signer_title}`);
  doc.moveDown(0.6);

  for (const s of input.signers) {
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111').text(s.name);
    doc.font('Helvetica').fontSize(10).fillColor('#222');
    doc.text(`Role: ${s.role}`);
    if (s.signature) doc.text(`Signed as: ${s.signature}`);
    if (s.signed_at) doc.text(`Signed on: ${s.signed_at}`);
    doc.moveDown(0.5);
  }
}

function section(doc: any, heading: string, body: string): void {
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#111').text(heading);
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(10).fillColor('#222').text(body);
  doc.moveDown(0.5);
}
