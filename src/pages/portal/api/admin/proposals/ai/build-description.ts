// Admin endpoint: draft a one-sentence Build description via Gemini.
//
// POST { client_id, build_size, admin_hint?, inferred_industry?, inferred_urgency? }
//
// build_size is required: 'small' | 'mid' | 'large'.
// admin_hint is whatever the admin already typed into the build
// description field (used as a steer, not a hard input).
// inferred_industry / inferred_urgency come from the wizard's
// narrative-variables state (or from a previous research call).
//
// Returns { sentence, evidence, voice_violations[] }. The wizard
// surfaces violations inline; admin still decides whether to apply.

import type { APIRoute } from 'astro';
import turso from '../../../../../../lib/turso';
import { logger } from '../../../../../../lib/logger';
import { createProposalGeminiClient, DEFAULT_MODEL } from '../../../../../../lib/proposal-ai/gemini-client';
import { createProposalCacheClient } from '../../../../../../lib/proposal-ai/cache';
import { draftBuildDescription } from '../../../../../../lib/proposal-ai/build/draft-description';
import { listClientSites } from '../../../../../../lib/client-sites';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const VALID_SIZES = new Set(['small', 'mid', 'large']);

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const clientId = (body?.client_id || '').toString().trim();
  const buildSize = (body?.build_size || '').toString().trim();
  if (!clientId) return json({ error: 'client_id is required' }, 400);
  if (!VALID_SIZES.has(buildSize)) {
    return json({ error: 'build_size must be small, mid, or large' }, 400);
  }

  const adminHint = body?.admin_hint ? String(body.admin_hint).slice(0, 500) : null;
  const inferredIndustry = body?.inferred_industry ? String(body.inferred_industry).slice(0, 64) : null;
  const inferredUrgency = body?.inferred_urgency ? String(body.inferred_urgency).slice(0, 64) : null;

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
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return json({ error: 'A valid domain is required (set client.domain first)' }, 400);
  }

  let currentSites: Array<{ domain: string; label: string | null; is_primary: boolean; is_managed: boolean; page_count: number | null }> = [];
  try {
    currentSites = (await listClientSites(clientId)).map(s => ({
      domain: s.domain,
      label: s.label,
      is_primary: s.is_primary,
      is_managed: s.is_managed,
      page_count: s.page_count,
    }));
  } catch (err) {
    logger.warn('build-description: failed to load current sites', err);
  }

  const geminiKey = (import.meta.env.GEMINI_API_KEY as string | undefined) || '';
  if (!geminiKey) {
    logger.error('build-description: GEMINI_API_KEY missing');
    return json({ error: 'Gemini is not configured' }, 503);
  }

  try {
    const result = await draftBuildDescription(
      {
        clientName,
        domain,
        buildSize: buildSize as 'small' | 'mid' | 'large',
        inferredIndustry,
        inferredUrgency,
        adminHint,
        currentSites,
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
      return json({ error: 'Gemini quota exhausted. Type the description manually.' }, 429);
    }
    logger.error('build-description draft failed', err);
    return json({ error: err?.message || 'Draft failed' }, 500);
  }
};
