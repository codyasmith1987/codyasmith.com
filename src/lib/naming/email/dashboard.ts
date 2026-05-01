// Dashboard email: post-quiz personalized top-5 plus PDF attachment.
//
// Reweights the stored 100-ish candidate pool using the quiz response signal
// (selected names, density, brand kind, plus the original tonality input),
// generates lay-language flags per candidate, composes an HTML email, and
// sends via Brevo (matching the Listener's existing email-via-fetch pattern).
// PDF attachment is wired by the caller when the PDF module is available.

import { logger } from '../../logger';
import type { NamingStorage, PersistedCandidate } from '../storage';
import type { QuizResponse, TonalityVector, Typology } from '../types';
import { TONALITY_AXES } from '../types';

export interface DashboardCandidate {
  name: string;
  rationale: string;
  typology: Typology;
  reweightedScore: number;
  domain: {
    available: boolean | null;
    secondaryPriceUsd: number | null;
  };
  flags: string[];
  userSelected: boolean; // true if the user picked this in Q1
}

export interface DashboardPayload {
  runId: number;
  responseId: number;
  audience: string;
  density: QuizResponse['density'];
  brandKind: QuizResponse['brandKind'];
  email: string;
  topFive: DashboardCandidate[];
  totalCandidates: number;
}

interface EmailDeps {
  brevoApiKey?: string;
  fetchFn?: typeof fetch;
  pdfBuffer?: Buffer | null;
}

function readBrevoApiKey(): string {
  const env: Record<string, string | undefined> =
    (import.meta as { env?: Record<string, string | undefined> }).env ??
    (typeof process !== 'undefined' ? (process.env as Record<string, string | undefined>) : {});
  return (env.BREVO_API_KEY ?? '').trim();
}

// Reweight scoring by quiz signal. Pure function over the persisted pool.
// Q1 selections boost +2. Tonality alignment with the user's revealed
// preference (averaged tonality of Q1 picks) boosts +1 when within distance 2.
// brandKind alignment boosts typology by +0.5. density-adjusted distinctiveness
// nudges up names that are likelier to stand out in the user's competitive
// shape.
export function reweightCandidates(
  candidates: PersistedCandidate[],
  quiz: QuizResponse,
): DashboardCandidate[] {
  const selectedSet = new Set(quiz.selectedNames.map((n) => n.toLowerCase()));

  // Revealed-preference tonality: average of the user-picked candidates.
  // If picks are missing tonality data (rare in practice), fall back to
  // the neutral default.
  const picks = candidates.filter((c) => selectedSet.has(c.name.toLowerCase()));
  const revealedTonality = computeAverageTonality(picks);

  return candidates
    .filter((c) => c.typology) // skip persisted rows missing the new fields
    .map((c) => {
      const baseScore = c.score ?? 0;
      let reweighted = baseScore;

      const userSelected = selectedSet.has(c.name.toLowerCase());
      if (userSelected) reweighted += 2;

      // Tonality alignment with revealed preference (Euclidean distance check)
      if (revealedTonality && c.tonality) {
        const cTon = normalizeTonality(c.tonality);
        const distance = tonalityDistance(cTon, revealedTonality);
        if (distance <= 2.0) reweighted += 1;
      }

      // brandKind alignment by typology
      if (quiz.brandKind === 'premium' && (c.typology === 'abstract' || c.typology === 'suggestive')) {
        reweighted += 0.5;
      } else if (quiz.brandKind === 'mainstream' && (c.typology === 'suggestive' || c.typology === 'associative')) {
        reweighted += 0.5;
      } else if (quiz.brandKind === 'utilitarian' && (c.typology === 'descriptive' || c.typology === 'suggestive')) {
        reweighted += 0.5;
      }

      // Density-adjusted distinctiveness: in crowded markets, distinctive
      // typologies (abstract, associative) get a small boost. In open markets,
      // descriptive names are more viable so they get a small boost.
      if (quiz.density === 'crowded' && (c.typology === 'abstract' || c.typology === 'associative')) {
        reweighted += 0.5;
      } else if (quiz.density === 'open' && c.typology === 'descriptive') {
        reweighted += 0.5;
      }

      return {
        name: c.name,
        rationale: c.rationale ?? '',
        typology: c.typology as Typology,
        reweightedScore: Math.round(reweighted * 100) / 100,
        domain: {
          available: null, // filled by caller via availability join
          secondaryPriceUsd: c.secondaryPriceUsd,
        },
        flags: [],
        userSelected,
      };
    })
    .sort((a, b) => b.reweightedScore - a.reweightedScore);
}

function normalizeTonality(t: Record<string, number>): TonalityVector {
  return {
    serious_playful: t.serious_playful ?? 3,
    modern_classical: t.modern_classical ?? 3,
    descriptive_abstract: t.descriptive_abstract ?? 3,
    technical_emotional: t.technical_emotional ?? 3,
    conservative_bold: t.conservative_bold ?? 3,
  };
}

function tonalityDistance(a: TonalityVector, b: TonalityVector): number {
  let sumSq = 0;
  for (const axis of TONALITY_AXES) {
    const d = a[axis] - b[axis];
    sumSq += d * d;
  }
  return Math.sqrt(sumSq);
}

function computeAverageTonality(picks: PersistedCandidate[]): TonalityVector | null {
  if (picks.length === 0) return null;
  const sum: TonalityVector = {
    serious_playful: 0, modern_classical: 0, descriptive_abstract: 0,
    technical_emotional: 0, conservative_bold: 0,
  };
  let count = 0;
  for (const p of picks) {
    if (!p.tonality) continue;
    const n = normalizeTonality(p.tonality);
    for (const axis of TONALITY_AXES) sum[axis] += n[axis];
    count += 1;
  }
  if (count === 0) return null;
  for (const axis of TONALITY_AXES) sum[axis] = sum[axis] / count;
  return sum;
}

// Generate lay-language flags for a candidate. At most two flags per name.
// Triggers per the Phase 3 brief:
//  - Selected by user but reweighted score below median: easier alternatives
//  - Domain owned with price > $3k: acquisition cost flag
//  - Pronounceability low (computed from name): may get mispronounced
//  - Crowded category + descriptive typology: harder to stand out
export function generateFlags(
  candidate: DashboardCandidate,
  medianScore: number,
  density: QuizResponse['density'],
): string[] {
  const flags: string[] = [];

  if (candidate.userSelected && candidate.reweightedScore < medianScore) {
    flags.push('You picked this one, but a few alternatives in your shortlist score higher overall.');
  }

  if (candidate.domain.secondaryPriceUsd && candidate.domain.secondaryPriceUsd > 3000) {
    flags.push(
      `The .com is owned and runs about $${candidate.domain.secondaryPriceUsd.toLocaleString()} to acquire.`,
    );
  }

  // Heuristic pronounceability: count consonant clusters >= 4. Crude but
  // catches the actual mispronounceable names (xkcd-style strings).
  if (hasLongConsonantCluster(candidate.name)) {
    flags.push("This one's a tongue-twister; people may mispronounce it.");
  }

  if (density === 'crowded' && candidate.typology === 'descriptive') {
    flags.push("In a crowded space, descriptive names like this one are harder to make stick.");
  }

  return flags.slice(0, 2);
}

function hasLongConsonantCluster(name: string): boolean {
  const lower = name.toLowerCase().replace(/-/g, '');
  const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);
  let run = 0;
  let max = 0;
  for (const ch of lower) {
    if (VOWELS.has(ch)) {
      run = 0;
    } else {
      run += 1;
      if (run > max) max = run;
    }
  }
  return max >= 4;
}

// Compose the email body. Pure function over the dashboard payload.
export function buildEmailHtml(payload: DashboardPayload): string {
  const greeting = payload.audience.length > 0
    ? `For ${payload.audience.length > 80 ? payload.audience.slice(0, 80) + '...' : payload.audience} brands,`
    : 'For your brand,';

  const cards = payload.topFive.map((c) => {
    const availabilityLine = c.domain.available === true
      ? '<span style="color:#10b981;font-weight:600;">.com available</span>'
      : c.domain.secondaryPriceUsd && c.domain.secondaryPriceUsd > 0
        ? `<span style="color:#f59e0b;">.com owned, about $${c.domain.secondaryPriceUsd.toLocaleString()} to acquire</span>`
        : '<span style="color:#737373;">.com availability unknown</span>';

    const flagsHtml = c.flags.length > 0
      ? `<div style="margin-top:12px;padding-top:12px;border-top:1px solid #e5e5e5;">
           ${c.flags.map((f) => `<p style="font-size:13px;color:#737373;margin:4px 0;">- ${escapeHtml(f)}</p>`).join('')}
         </div>`
      : '';

    return `
      <div style="background:#fafafa;border:1px solid #e5e5e5;border-radius:12px;padding:20px;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;">
          <span style="font-size:22px;font-weight:600;color:#171717;font-family:Georgia,serif;">${escapeHtml(c.name)}</span>
          <span style="font-size:11px;color:#737373;text-transform:uppercase;letter-spacing:0.1em;">${escapeHtml(c.typology)}</span>
        </div>
        <p style="font-size:13px;color:#a3a3a3;margin:0 0 8px 0;">${availabilityLine}</p>
        <p style="font-size:14px;color:#525252;line-height:1.5;margin:0;">${escapeHtml(c.rationale)}</p>
        ${flagsHtml}
      </div>
    `;
  }).join('');

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;color:#333;padding:24px;">
      <p style="color:#737373;font-size:11px;text-transform:uppercase;letter-spacing:0.2em;margin-bottom:8px;">Naming preview report</p>
      <h1 style="font-family:Georgia,serif;font-size:28px;color:#171717;margin:0 0 16px 0;">${escapeHtml(greeting)}</h1>
      <p style="color:#525252;font-size:15px;line-height:1.5;margin:0 0 24px 0;">
        Here are the 5 names from your shortlist that match your answers best, with notes where worth flagging. The full report with all ${payload.totalCandidates} candidates and methodology is attached as a PDF.
      </p>

      ${cards}

      <div style="margin-top:32px;padding-top:24px;border-top:1px solid #e5e5e5;">
        <p style="color:#737373;font-size:13px;line-height:1.6;margin:0 0 8px 0;">
          Want to see how the system actually decides? <a href="https://codyasmith.com/naming/methodology" style="color:#f59e0b;">Read the methodology</a>.
        </p>
        <p style="color:#737373;font-size:13px;line-height:1.6;margin:0;">
          Reply to this email if you want a second pair of eyes on the choice. I help small businesses think through naming, branding, and positioning.
        </p>
      </div>

      <p style="color:#a3a3a3;font-size:11px;line-height:1.6;margin-top:32px;">
        Cody Smith<br /><a href="https://codyasmith.com" style="color:#f59e0b;">codyasmith.com</a>
      </p>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Build the dashboard payload from storage. Pure data layer; sending is
// separated out for testability.
export async function buildDashboardPayload(
  runId: number,
  responseId: number,
  storage: NamingStorage,
): Promise<DashboardPayload> {
  const run = await storage.getRun(runId);
  if (!run) throw new Error(`Naming run ${runId} not found`);
  const quiz = await storage.getQuizResponseForRun(runId);
  if (!quiz) throw new Error(`Quiz response not found for run ${runId}`);
  const candidates = await storage.getCandidatesForRun(runId);

  const reweighted = reweightCandidates(candidates, quiz);

  // Compute median score for flag-trigger comparisons.
  const sortedScores = [...reweighted].map((c) => c.reweightedScore).sort((a, b) => a - b);
  const median = sortedScores.length === 0
    ? 0
    : sortedScores[Math.floor(sortedScores.length / 2)];

  // Generate flags per candidate (using the median across the full pool).
  for (const c of reweighted) {
    c.flags = generateFlags(c, median, quiz.density);
  }

  // Take top 5.
  const topFive = reweighted.slice(0, 5);

  return {
    runId,
    responseId,
    audience: quiz.audience,
    density: quiz.density,
    brandKind: quiz.brandKind,
    email: quiz.email,
    topFive,
    totalCandidates: candidates.length,
  };
}

// Send the email via Brevo. Mirrors the Listener's pattern at unlock.ts.
// Optional PDF attachment is base64-encoded inline per Brevo's API.
export async function sendDashboardEmail(
  runId: number,
  responseId: number,
  storage: NamingStorage,
  deps: EmailDeps = {},
): Promise<void> {
  const apiKey = (deps.brevoApiKey ?? readBrevoApiKey()).trim();
  if (!apiKey) {
    logger.error('Naming dashboard email: BREVO_API_KEY not set');
    throw new Error('BREVO_API_KEY not set');
  }
  const fetchFn = deps.fetchFn ?? fetch;

  const payload = await buildDashboardPayload(runId, responseId, storage);
  const html = buildEmailHtml(payload);

  const attachments: Array<{ name: string; content: string }> = [];
  if (deps.pdfBuffer) {
    attachments.push({
      name: 'naming-report.pdf',
      content: deps.pdfBuffer.toString('base64'),
    });
  }

  const res = await fetchFn('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      sender: { name: 'Cody Smith', email: 'cody@codyasmith.com' },
      to: [{ email: payload.email }],
      subject: 'Your naming preview report',
      htmlContent: html,
      attachment: attachments.length > 0 ? attachments : undefined,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    logger.error(`Naming dashboard email Brevo error: ${res.status} ${errText}`);
    throw new Error(`Brevo send failed: ${res.status}`);
  }
}
