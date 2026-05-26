// Admin endpoint: draft a 1-2 sentence pitch for a Build option.
//
// POST {
//   client_id,
//   option_name,
//   other_option_name?, other_option_pitch?,
//   build_description?, inferred_industry?,
//   admin_hint?
// }
//
// Returns { ok, sentence, evidence, voice_violations[] }.

import type { APIRoute } from 'astro';
import turso from '../../../../../../lib/turso';
import { logger } from '../../../../../../lib/logger';
import { createProposalGeminiClient, DEFAULT_MODEL } from '../../../../../../lib/proposal-ai/gemini-client';
import { createProposalCacheClient } from '../../../../../../lib/proposal-ai/cache';
import { draftOptionPitch } from '../../../../../../lib/proposal-ai/build/draft-option-pitch';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const clientId = (body?.client_id || '').toString().trim();
  const optionName = (body?.option_name || '').toString().trim();
  if (!clientId) return json({ error: 'client_id is required' }, 400);
  if (!optionName) return json({ error: 'option_name is required' }, 400);

  const adminHint = body?.admin_hint ? String(body.admin_hint).slice(0, 500) : null;
  const otherOptionName = body?.other_option_name ? String(body.other_option_name).slice(0, 200) : null;
  const otherOptionPitch = body?.other_option_pitch ? String(body.other_option_pitch).slice(0, 600) : null;
  const buildDescription = body?.build_description ? String(body.build_description).slice(0, 600) : null;
  const inferredIndustry = body?.inferred_industry ? String(body.inferred_industry).slice(0, 64) : null;

  const row = await turso.execute({
    sql: 'SELECT name, slug, domain FROM clients WHERE id = ? LIMIT 1',
    args: [clientId],
  });
  if (row.rows.length === 0) return json({ error: 'Client not found' }, 404);
  const r = row.rows[0] as any;
  const clientName = String(r[0] || '').trim();
  const clientSlug = String(r[1] || '').trim();
  const storedDomain = r[2] ? String(r[2]).trim().toLowerCase() : '';
  const domain = storedDomain || `${clientSlug}.com`;

  const geminiKey = (import.meta.env.GEMINI_API_KEY as string | undefined) || '';
  if (!geminiKey) {
    logger.error('option-pitch: GEMINI_API_KEY missing');
    return json({ error: 'Gemini is not configured' }, 503);
  }

  try {
    const result = await draftOptionPitch(
      {
        clientName,
        domain,
        optionName,
        otherOptionName,
        otherOptionPitch,
        buildDescription,
        inferredIndustry,
        adminHint,
      },
      {
        gemini: createProposalGeminiClient(geminiKey, DEFAULT_MODEL),
        cache: createProposalCacheClient(),
        model: DEFAULT_MODEL,
      },
    );
    return json({ ok: true, ...result });
  } catch (err: any) {
    if (/quota exhausted/i.test(err?.message || '')) {
      return json({ error: 'Gemini quota exhausted. Type the pitch manually.' }, 429);
    }
    logger.error('option-pitch draft failed', err);
    return json({ error: err?.message || 'Draft failed' }, 500);
  }
};
