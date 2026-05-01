// Phase 3 PDF report generator. Produces a multi-page PDF that the dashboard
// email attaches: cover, Position 1 framing, top-5 expanded, all-N grouped by
// typology, methodology section in lay language.
//
// Uses pdfkit (already in package.json from the portal's invoice generator at
// src/lib/pdf.ts). Layout conventions are independent: the portal invoice is
// the only existing pdfkit consumer; that one is internal-facing tabular,
// this one is public-facing reading material.

import type { NamingStorage, PersistedCandidate } from '../storage';
import type { DashboardCandidate, DashboardPayload } from '../email/dashboard';
import {
  buildDashboardPayload,
  reweightCandidates,
  generateFlags,
} from '../email/dashboard';
import type { QuizResponse, Typology } from '../types';

interface PdfDeps {
  storage: NamingStorage;
}

export async function generateNamingReportPdf(
  runId: number,
  responseId: number,
  deps: PdfDeps,
): Promise<Buffer> {
  const payload = await buildDashboardPayload(runId, responseId, deps.storage);
  const allCandidates = await deps.storage.getCandidatesForRun(runId);
  const quiz = await deps.storage.getQuizResponseForRun(runId);
  if (!quiz) throw new Error(`Quiz response not found for run ${runId}`);

  // Reweighted full pool for the all-N section
  const reweightedAll = reweightCandidates(allCandidates, quiz);
  const sortedScores = [...reweightedAll].map((c) => c.reweightedScore).sort((a, b) => a - b);
  const median = sortedScores.length === 0
    ? 0
    : sortedScores[Math.floor(sortedScores.length / 2)];
  for (const c of reweightedAll) {
    c.flags = generateFlags(c, median, quiz.density);
  }

  return renderPdf(payload, reweightedAll);
}

async function renderPdf(
  payload: DashboardPayload,
  allCandidates: DashboardCandidate[],
): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 60 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const dark = '#171717';
    const gray = '#525252';
    const light = '#a3a3a3';
    const accent = '#f59e0b';

    // ---------- COVER ----------
    doc.fontSize(11).fillColor(light).text('Naming preview report', { align: 'left' });
    doc.moveDown(0.3);
    const today = new Date().toISOString().slice(0, 10);
    doc.fontSize(9).fillColor(gray).text(today);
    doc.moveDown(4);

    doc.fontSize(28).fillColor(dark).text('Your naming report', { align: 'left' });
    doc.moveDown(0.5);
    doc.fontSize(14).fillColor(gray).text(payload.audience, { align: 'left' });
    doc.moveDown(2);

    doc.fontSize(11).fillColor(gray).text(`${payload.totalCandidates} candidates generated.`);
    doc.fontSize(11).fillColor(gray).text(`Top 5 personalized to your answers.`);
    doc.fontSize(11).fillColor(gray).text(`All candidates and methodology included.`);

    // ---------- POSITION 1 FRAMING ----------
    doc.addPage();
    doc.fontSize(20).fillColor(dark).text('What this report is, and what it is not');
    doc.moveDown(1);
    doc.fontSize(11).fillColor(gray);

    doc.text(
      'A name matters. It does not matter as much as the marketing literature implies. ' +
        'The research evidence puts name-attributable variance in commercial outcomes at ' +
        'somewhere between 3 and 10 percent in well-controlled studies, and probably less ' +
        'in real markets where advertising spend, distribution, product quality, and timing ' +
        'dominate. The naming industry routinely implies the number is closer to 30 to 50 ' +
        'percent. That gap is real, and it shapes how we built this tool.',
      { align: 'left', lineGap: 4 },
    );
    doc.moveDown(0.8);
    doc.text(
      'You will see 5 names below personalized to your answers. The system also generated ' +
        `${payload.totalCandidates} other candidates, included later in this report. We rate ` +
        'them on real signals (.com availability, pronounceability, length, typology, ' +
        'tonality fit), not on guarantees about commercial outcomes. Pick a name you can live ' +
        'with for years. The rest of the brand work matters more.',
      { align: 'left', lineGap: 4 },
    );

    // ---------- TOP 5 EXPANDED ----------
    doc.addPage();
    doc.fontSize(20).fillColor(dark).text('Your top 5');
    doc.moveDown(1);

    for (const c of payload.topFive) {
      // Name + typology
      doc.fontSize(18).fillColor(dark).text(c.name, { continued: true });
      doc.fillColor(light).fontSize(10).text(`  ${c.typology}`, { continued: false });
      doc.moveDown(0.3);

      // .com status
      doc.fontSize(10).fillColor(gray);
      if (c.domain.available === true) {
        doc.fillColor('#059669').text('.com available');
      } else if (c.domain.secondaryPriceUsd && c.domain.secondaryPriceUsd > 0) {
        doc.fillColor(accent).text(`.com owned, about $${c.domain.secondaryPriceUsd.toLocaleString()} to acquire`);
      } else {
        doc.fillColor(gray).text('.com availability unknown or owned');
      }
      doc.moveDown(0.4);

      // Rationale
      doc.fontSize(11).fillColor(gray).text(c.rationale, { align: 'left', lineGap: 2 });

      // Flags
      if (c.flags.length > 0) {
        doc.moveDown(0.4);
        doc.fontSize(10).fillColor(light).text('Worth flagging:');
        for (const f of c.flags) {
          doc.fontSize(10).fillColor(gray).text(`- ${f}`, { indent: 12, lineGap: 2 });
        }
      }
      doc.moveDown(1.2);
    }

    // ---------- ALL CANDIDATES BY TYPOLOGY ----------
    doc.addPage();
    doc.fontSize(20).fillColor(dark).text('All candidates');
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor(gray).text(
      'Grouped by typological position, sorted by reweighted score within each group.',
    );
    doc.moveDown(1);

    const TYPO_HEADERS: Record<Typology, string> = {
      descriptive: 'Descriptive',
      suggestive: 'Suggestive',
      associative: 'Associative or metaphoric',
      abstract: 'Abstract or coined',
    };

    const grouped: Record<Typology, DashboardCandidate[]> = {
      descriptive: [], suggestive: [], associative: [], abstract: [],
    };
    for (const c of allCandidates) grouped[c.typology].push(c);

    for (const t of ['descriptive', 'suggestive', 'associative', 'abstract'] as Typology[]) {
      const list = grouped[t];
      if (list.length === 0) continue;
      doc.fontSize(14).fillColor(dark).text(TYPO_HEADERS[t]);
      doc.fontSize(9).fillColor(light).text(`${list.length} candidates`);
      doc.moveDown(0.4);
      for (const c of list) {
        const cleanName = c.name;
        const status = c.domain.available === true
          ? '(.com available)'
          : c.domain.secondaryPriceUsd && c.domain.secondaryPriceUsd > 0
            ? `(.com owned, ~$${c.domain.secondaryPriceUsd.toLocaleString()})`
            : '(.com owned)';
        doc.fontSize(10).fillColor(dark).text(cleanName, { continued: true });
        doc.fillColor(light).text(`  ${status}`);
      }
      doc.moveDown(0.8);
    }

    // ---------- METHODOLOGY ----------
    doc.addPage();
    doc.fontSize(20).fillColor(dark).text('How this works');
    doc.moveDown(0.8);
    doc.fontSize(11).fillColor(gray);

    const methodSections: Array<[string, string]> = [
      [
        'Generation',
        'Each request runs four parallel calls to a generative model, one per typological position. Each call asks for around 25 candidates of one position with strict naming rules. The four batches merge into a single pool. The pool then runs through availability checks on .com and a six-dimension scoring rubric.',
      ],
      [
        'What we filter',
        'Names that fail length, character, or forbidden-suffix rules are dropped during validation. Names that own the .com but cost more than ten thousand dollars to acquire are excluded from the scored slider; they appear in this PDF as "owned" with a flag. The slider you saw is the top 25 of the validated pool by composite score.',
      ],
      [
        'What we did not optimize for',
        'AI search optimization, social handle availability, voice search compatibility, brand voice integration, and 50-language linguistic vetting are not in this report. The evidence base for those is either too thin to support strong claims (AI search) or only meaningful for global brand launches (linguistic vetting). For a small operator picking a domain name, those dimensions distract more than they help.',
      ],
      [
        'Binary versus soft',
        'Domain ownership is binary: you own the .com or you do not. Everything else is soft: pronounceability, memorability, tonality fit. We treat the binary feasibility constraint as a hard gate and report the soft factors with appropriate magnitude language. The naming industry habitually conflates these, and that conflation is what produces report outputs that promise more than the evidence supports.',
      ],
    ];

    for (const [title, body] of methodSections) {
      doc.fontSize(14).fillColor(dark).text(title);
      doc.moveDown(0.3);
      doc.fontSize(11).fillColor(gray).text(body, { align: 'left', lineGap: 3 });
      doc.moveDown(0.8);
    }

    doc.moveDown(1);
    doc.fontSize(10).fillColor(light).text(
      'The full methodology document, including the research the tool is built on, is published at codyasmith.com/naming/methodology.',
    );

    doc.end();
  });
}
