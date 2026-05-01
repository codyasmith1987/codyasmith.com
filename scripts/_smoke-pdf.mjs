#!/usr/bin/env node
// PDF generation smoke test for the Phase 3 naming report.
// Throwaway diagnostic — not wired into npm test. Builds synthetic
// fixtures, calls generateNamingReportPdf via a hand-rolled mock storage,
// writes the output to scripts/_smoke-pdf-output.pdf, and prints a few
// sanity checks (magic bytes, %%EOF marker, byte size, page count).

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { generateNamingReportPdf } from '../src/lib/naming/pdf/report.ts';

const NEUTRAL = {
  serious_playful: 3,
  modern_classical: 3,
  descriptive_abstract: 3,
  technical_emotional: 3,
  conservative_bold: 3,
};

const TYPOLOGIES = ['descriptive', 'suggestive', 'associative', 'abstract'];

function makeCandidates(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const t = TYPOLOGIES[i % TYPOLOGIES.length];
    const id = i + 1;
    out.push({
      id,
      runId: 1,
      name: `Sample${String.fromCharCode(65 + (i % 26))}${id}`,
      typology: t,
      rationale: `Sample rationale for candidate ${id}, position ${t}, written long enough to give the PDF body something realistic to wrap.`,
      tonality: NEUTRAL,
      score: Math.round((100 - i) * 100) / 100,
      excludedReason: null,
      // Mix of available, owned-cheap, owned-expensive, unknown across the pool.
      secondaryPriceUsd: i % 4 === 0 ? null : (i % 4 === 1 ? 500 : (i % 4 === 2 ? 4500 : null)),
    });
  }
  return out;
}

const candidates = makeCandidates(25);

const storage = {
  async getRun() {
    return { id: 1, seedTerm: 'consulting', createdAt: '2026-04-30' };
  },
  async getQuizResponseForRun() {
    return {
      runId: 1,
      selectedNames: [candidates[0].name, candidates[1].name, candidates[2].name],
      audience: 'Independent operators rebuilding their brand identity for a relaunch.',
      density: 'crowded',
      brandKind: 'premium',
      email: 'smoke@example.com',
    };
  },
  async getCandidatesForRun() {
    return candidates;
  },
  // Other NamingStorage methods are unused by the PDF path.
  async insertRun() { throw new Error('not used'); },
  async insertScoredCandidates() { throw new Error('not used'); },
  async insertAvailability() { throw new Error('not used'); },
  async insertQuizResponse() { throw new Error('not used'); },
  async getCache() { return null; },
  async setCache() { /* noop */ },
};

async function main() {
  console.log('Generating PDF with 25 synthetic candidates...');
  const t0 = Date.now();
  const buf = await generateNamingReportPdf(1, 99, { storage });
  const elapsed = Date.now() - t0;

  const outPath = 'scripts/_smoke-pdf-output.pdf';
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, buf);

  console.log(`Wrote ${outPath} (${buf.length} bytes, ${elapsed}ms)`);

  const head = buf.slice(0, 5).toString('utf8');
  const tailStr = buf.slice(buf.length - 64).toString('utf8');
  const headOk = head.startsWith('%PDF-');
  const eofOk = tailStr.includes('%%EOF');

  // Crude page count: every "/Type /Page" occurrence (not /Pages).
  const text = buf.toString('latin1');
  const pageMatches = text.match(/\/Type\s*\/Page(\b|[^s])/g) || [];

  console.log(`PDF header magic OK: ${headOk}`);
  console.log(`PDF %%EOF present: ${eofOk}`);
  console.log(`Approximate page count (heuristic): ${pageMatches.length}`);

  if (!headOk || !eofOk) {
    console.error('PDF appears malformed.');
    process.exit(1);
  }
  if (pageMatches.length < 4) {
    console.error(`Expected at least 4 pages (cover, framing, top-5, all-N, methodology). Got ~${pageMatches.length}.`);
    process.exit(1);
  }
  console.log('PDF smoke test passed.');
}

main().catch((err) => {
  console.error('PDF smoke crashed:', err);
  process.exit(1);
});
