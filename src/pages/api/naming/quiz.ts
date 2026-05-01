// POST /api/naming/quiz
// Phase 3 quiz endpoint. Body validation, persistence to naming_quiz_responses,
// fire-and-forget dashboard email send, returns { ok: true }.
// Rate limit: 3 submissions per IP per day, separate from preview limits.

import type { APIRoute } from 'astro';
import { rateLimit as rateLimitFn } from '../../../lib/rate-limit';
import { logger } from '../../../lib/logger';
import { createStorage, type NamingStorage } from '../../../lib/naming/storage';
import { sendDashboardEmail } from '../../../lib/naming/email/dashboard';
import { generateNamingReportPdf } from '../../../lib/naming/pdf/report';
import turso from '../../../lib/turso';

export const prerender = false;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_LIMIT = 3;

const VALID_DENSITY = new Set(['crowded', 'moderate', 'open']);
const VALID_BRAND_KIND = new Set(['premium', 'mainstream', 'utilitarian']);
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface QuizDeps {
  rateLimit?: (key: string, max: number, windowMs: number) => Promise<boolean>;
  storage?: NamingStorage;
  sendEmail?: typeof sendDashboardEmail;
}

export interface QuizResult {
  status: number;
  body: { ok?: true; error?: string };
}

export async function handleQuiz(
  rawBody: unknown,
  ip: string,
  deps: QuizDeps = {},
): Promise<QuizResult> {
  if (!rawBody || typeof rawBody !== 'object') {
    return { status: 400, body: { error: 'Invalid request body' } };
  }
  const body = rawBody as Record<string, unknown>;

  // runId
  const runIdRaw = body.runId;
  let runId: number | null = null;
  if (typeof runIdRaw === 'string') {
    const n = parseInt(runIdRaw, 10);
    if (Number.isFinite(n) && n > 0) runId = n;
  } else if (typeof runIdRaw === 'number' && Number.isFinite(runIdRaw) && runIdRaw > 0) {
    runId = Math.floor(runIdRaw);
  }
  if (runId === null) {
    return { status: 400, body: { error: 'Missing or invalid runId' } };
  }

  // selectedNames: must be array of exactly 3 strings
  const selectedRaw = body.selectedNames;
  if (!Array.isArray(selectedRaw) || selectedRaw.length !== 3) {
    return { status: 400, body: { error: 'selectedNames must be an array of exactly 3 names' } };
  }
  const selectedNames: string[] = [];
  for (const s of selectedRaw) {
    if (typeof s !== 'string' || !s.trim()) {
      return { status: 400, body: { error: 'selectedNames entries must be non-empty strings' } };
    }
    selectedNames.push(s.trim());
  }
  if (new Set(selectedNames).size !== 3) {
    return { status: 400, body: { error: 'selectedNames must contain three distinct names' } };
  }

  // audience: text, min 10 chars, max 500
  const audienceRaw = body.audience;
  if (typeof audienceRaw !== 'string') {
    return { status: 400, body: { error: 'audience must be a string' } };
  }
  const audience = audienceRaw.trim();
  if (audience.length < 10) {
    return { status: 400, body: { error: 'audience must be at least 10 characters' } };
  }
  if (audience.length > 500) {
    return { status: 400, body: { error: 'audience must be 500 characters or fewer' } };
  }

  // density radio
  const density = body.density;
  if (typeof density !== 'string' || !VALID_DENSITY.has(density)) {
    return { status: 400, body: { error: 'density must be crowded, moderate, or open' } };
  }

  // brandKind radio
  const brandKind = body.brandKind;
  if (typeof brandKind !== 'string' || !VALID_BRAND_KIND.has(brandKind)) {
    return { status: 400, body: { error: 'brandKind must be premium, mainstream, or utilitarian' } };
  }

  // email
  const emailRaw = body.email;
  if (typeof emailRaw !== 'string') {
    return { status: 400, body: { error: 'email is required' } };
  }
  const email = emailRaw.trim();
  if (!EMAIL_REGEX.test(email)) {
    return { status: 400, body: { error: 'email format is invalid' } };
  }

  // IP guard + rate limit
  if (!ip || ip === 'unknown') {
    return { status: 400, body: { error: 'Could not verify your request' } };
  }
  const rl = deps.rateLimit ?? rateLimitFn;
  const ok = await rl(`naming-quiz:day:${ip}`, DAILY_LIMIT, DAY_MS);
  if (!ok) {
    return {
      status: 429,
      body: { error: "You've reached the daily quiz limit. Try again tomorrow." },
    };
  }

  const storage = deps.storage ?? createStorage(turso);

  // Persist quiz response
  let responseId: number;
  try {
    responseId = await storage.insertQuizResponse({
      runId,
      selectedNames,
      audience,
      density: density as 'crowded' | 'moderate' | 'open',
      brandKind: brandKind as 'premium' | 'mainstream' | 'utilitarian',
      email,
    });
  } catch (err) {
    logger.error('Naming quiz persist failed', err);
    return { status: 500, body: { error: 'Something went wrong. Try again in a minute.' } };
  }

  // Fire-and-forget: generate the PDF, then send the email with PDF attached.
  // Either step failing logs but does not block the user-facing response;
  // the persisted quiz response lets us recover and retry manually.
  const emailFn = deps.sendEmail ?? sendDashboardEmail;
  (async () => {
    try {
      const pdfBuffer = await generateNamingReportPdf(runId, responseId, { storage });
      await emailFn(runId, responseId, storage, { pdfBuffer });
    } catch (err) {
      logger.error('Naming quiz dashboard email or PDF generation failed', err);
    }
  })();

  return { status: 200, body: { ok: true } };
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const json = (s: unknown, status = 200) =>
    new Response(JSON.stringify(s), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const ip =
    clientAddress ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown';

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const result = await handleQuiz(body, ip);
  return json(result.body, result.status);
};
