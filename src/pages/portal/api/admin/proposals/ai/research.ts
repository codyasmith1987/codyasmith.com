// Admin endpoint: research a client via Gemini for proposal seeding.
//
// POST { client_id, domain?, force?: boolean }
//
// Looks up the client row for name + domain (the wizard may pass an
// override domain for ad-hoc lookups). Calls researchClient() with the
// production wiring (real Gemini client, real Serper, real scraper,
// real sitemap fetcher, Turso cache). Returns the structured research
// blob. The wizard renders each field next to its matching input with
// an Apply button.
//
// force=true bypasses the cache lookup but still writes a fresh entry
// on success. Use sparingly; default is cached.

import type { APIRoute } from 'astro';
import turso from '../../../../../../lib/turso';
import { logger } from '../../../../../../lib/logger';
import { createProposalGeminiClient, DEFAULT_MODEL } from '../../../../../../lib/proposal-ai/gemini-client';
import { createProposalCacheClient } from '../../../../../../lib/proposal-ai/cache';
import { researchClient } from '../../../../../../lib/proposal-ai/research/client-research';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const clientId = (body?.client_id || '').toString().trim();
  const overrideDomain = (body?.domain || '').toString().trim().toLowerCase();
  const force = body?.force === true;

  if (!clientId) return json({ error: 'client_id is required' }, 400);

  // Pull client name + stored domain. The domain column was added in
  // migration 028; existing client rows may have NULL until set.
  const row = await turso.execute({
    sql: 'SELECT name, slug, domain FROM clients WHERE id = ? LIMIT 1',
    args: [clientId],
  });
  if (row.rows.length === 0) return json({ error: 'Client not found' }, 404);
  const r = row.rows[0] as any;
  const clientName = String(r[0] || '').trim();
  const storedDomain = r[2] ? String(r[2]).trim().toLowerCase() : '';

  // No slug fallback: guessing `${slug}.com` researches whoever owns
  // that domain, not the client (AG Project got agproject.com pinned
  // as primary this way; the real site was agproject.io). A domain
  // must be stored on the client or passed explicitly.
  const domain = overrideDomain || storedDomain;
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return json({ error: 'A valid domain is required (set client.domain or supply override)' }, 400);
  }

  const geminiKey = (import.meta.env.GEMINI_API_KEY as string | undefined) || '';
  const serperKey = (import.meta.env.SERPER_API_KEY as string | undefined) || '';
  if (!geminiKey) {
    logger.error('proposal-ai research: GEMINI_API_KEY missing');
    return json({ error: 'Gemini is not configured' }, 503);
  }

  try {
    const cache = createProposalCacheClient();
    const gemini = createProposalGeminiClient(geminiKey, DEFAULT_MODEL);

    const result = await researchClient(
      { clientName, domain },
      {
        gemini,
        cache: force ? undefined : cache,
        serperApiKey: serperKey,
        model: DEFAULT_MODEL,
      },
    );

    // If force-refresh, write the new result into the cache so
    // subsequent reads see the refreshed entry.
    if (force) {
      try {
        const freshCache = createProposalCacheClient();
        // Deriving the same key requires the prompt version + model; the
        // orchestrator already wrote it on success when cache was passed.
        // For force-refresh, we re-run with cache enabled in a follow-up
        // call only if necessary; simpler: re-invoke the orchestrator
        // with cache passed in. researchClient is idempotent on the
        // model output (deterministic for same scraped input within
        // the same hour), so the second call just writes the entry.
        await researchClient(
          { clientName, domain },
          { gemini, cache: freshCache, serperApiKey: serperKey, model: DEFAULT_MODEL },
        );
      } catch (err) {
        logger.warn('proposal-ai research: cache rewrite on force failed', err);
      }
    }

    return json({ ok: true, domain, result }, 200);
  } catch (err: any) {
    if (/quota exhausted/i.test(err?.message || '')) {
      return json({ error: 'Lookup unavailable: Gemini quota exhausted. Fill manually for now.' }, 429);
    }
    logger.error('proposal-ai research failed', err);
    return json({ error: err?.message || 'Research failed' }, 500);
  }
};
