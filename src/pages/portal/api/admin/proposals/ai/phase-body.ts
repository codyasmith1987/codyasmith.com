// Admin endpoint: draft a single rollout phase paragraph via Gemini.
//
// POST {
//   client_id,
//   phase_header,
//   phase_index, total_phases,
//   option_name?, option_pitch?,
//   build_description?,
//   web_management_in_scope?,
//   admin_hint?
// }
//
// Returns { ok, html, evidence, voice_violations[] }.

import type { APIRoute } from 'astro';
import turso from '../../../../../../lib/turso';
import { logger } from '../../../../../../lib/logger';
import { createProposalGeminiClient, DEFAULT_MODEL } from '../../../../../../lib/proposal-ai/gemini-client';
import { createProposalCacheClient } from '../../../../../../lib/proposal-ai/cache';
import { draftPhaseBody } from '../../../../../../lib/proposal-ai/build/draft-phase-body';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const clientId = (body?.client_id || '').toString().trim();
  const phaseHeader = (body?.phase_header || '').toString().trim();
  const phaseIndex = parseInt(body?.phase_index, 10);
  const totalPhases = parseInt(body?.total_phases, 10);
  if (!clientId) return json({ error: 'client_id is required' }, 400);
  if (!phaseHeader) return json({ error: 'phase_header is required' }, 400);
  if (!Number.isFinite(phaseIndex) || phaseIndex < 1) return json({ error: 'phase_index must be >= 1' }, 400);
  if (!Number.isFinite(totalPhases) || totalPhases < 1) return json({ error: 'total_phases must be >= 1' }, 400);

  const adminHint = body?.admin_hint ? String(body.admin_hint).slice(0, 800) : null;
  const optionName = body?.option_name ? String(body.option_name).slice(0, 200) : null;
  const optionPitch = body?.option_pitch ? String(body.option_pitch).slice(0, 600) : null;
  const buildDescription = body?.build_description ? String(body.build_description).slice(0, 600) : null;
  const webManagementInScope = !!body?.web_management_in_scope;

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
    logger.error('phase-body: GEMINI_API_KEY missing');
    return json({ error: 'Gemini is not configured' }, 503);
  }

  try {
    const result = await draftPhaseBody(
      {
        clientName,
        domain,
        phaseHeader,
        phaseIndex,
        totalPhases,
        optionName,
        optionPitch,
        buildDescription,
        webManagementInScope,
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
      return json({ error: 'Gemini quota exhausted. Type the phase manually.' }, 429);
    }
    logger.error('phase-body draft failed', err);
    return json({ error: err?.message || 'Draft failed' }, 500);
  }
};
