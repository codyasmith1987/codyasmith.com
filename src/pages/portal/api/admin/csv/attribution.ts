// READ-ONLY diagnostic: enumerate a client's csv_uploads with RESOLVED
// site attribution + supersession status, plus per-upload hostname
// evidence drawn from crawl_urls. The point is to identify a
// mis-attributed (wrong-site) upload by the ACTUAL hostnames inside its
// data rather than guessing from the filename.
//
// Why this exists: on a multi-site client, uploading data without
// selecting the site in the picker stores csv_uploads.site_id = NULL,
// which the whole portal interprets as "the primary site". So a
// secondary site's export silently lands under the primary. Worse, if a
// same-named primary upload already existed for that month/format, the
// live-unique sweep marks the older one `error = 'Superseded by newer
// upload'` and deletes its child rows -- silent data loss. This endpoint
// surfaces (a) which live uploads are mis-attributed (evidence hostname
// != attributed site), and (b) every superseded row, as the candidate
// set for a wrongly-clobbered primary upload.
//
// GET ?client_id=...   admin-only. Writes nothing.

import type { APIRoute } from 'astro';
import turso from '../../../../../lib/turso';
import { logger } from '../../../../../lib/logger';
import { listClientSites } from '../../../../../lib/client-sites';

export const prerender = false;

const SUPERSEDED_MARKER = 'Superseded by newer upload';

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

const normHost = (h: string) => (h || '').trim().toLowerCase().replace(/^www\./, '');

function statusOf(error: string | null): string {
  if (error == null) return 'live';
  if (error === SUPERSEDED_MARKER) return 'superseded';
  if (error.startsWith('Reparsed')) return 'reparsed';
  return 'errored';
}

export const GET: APIRoute = async ({ locals, url }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);
  const clientId = (url.searchParams.get('client_id') || '').trim();
  if (!clientId) return json({ error: 'client_id is required' }, 400);

  try {
    // 1. Sites: site_id -> domain, normalized domain -> site_id, the primary.
    const sites = await listClientSites(clientId);
    const siteById = new Map<string, { domain: string; is_primary: boolean; is_managed: boolean }>();
    const siteIdByDomain = new Map<string, string>();
    for (const s of sites) {
      siteById.set(s.id, { domain: s.domain, is_primary: s.is_primary, is_managed: s.is_managed });
      siteIdByDomain.set(normHost(s.domain), s.id);
    }
    const primary = sites.find(s => s.is_primary) || null;
    const primarySiteId = primary?.id || null;
    const primaryDomain = primary?.domain || null;

    const labelOf = (siteId: string | null): string => {
      if (siteId == null) return primaryDomain ? `${primaryDomain} (primary / NULL)` : 'primary (NULL)';
      const s = siteById.get(siteId);
      return s ? `${s.domain}${s.is_primary ? ' (primary)' : ''}` : `<unknown site_id ${siteId}>`;
    };
    // The site_id a NULL row resolves to for matching purposes.
    const effectiveSiteId = (siteId: string | null): string | null => siteId ?? primarySiteId;

    // 2. All uploads for the client.
    const upRes = await turso.execute({
      sql: `SELECT id, site_id, original_name, detected_format, month, row_count, error, created_at, processed_at
            FROM csv_uploads WHERE client_id = ?
            ORDER BY created_at DESC, original_name ASC`,
      args: [clientId],
    });

    // 3. Per-upload hostname evidence from crawl_urls (the strongest content
    //    signal: a crawl upload's rows carry the real hostname they came from).
    const evidence = new Map<string, Array<{ hostname: string; urls: number }>>();
    try {
      const evRes = await turso.execute({
        sql: `SELECT csv_upload_id AS uid, hostname AS host, COUNT(*) AS n
              FROM crawl_urls WHERE client_id = ?
              GROUP BY csv_upload_id, hostname`,
        args: [clientId],
      });
      for (const r of evRes.rows as any[]) {
        const uid = String(r.uid);
        const host = normHost(String(r.host ?? ''));
        const n = Number(r.n) || 0;
        if (!uid || !host) continue;
        const arr = evidence.get(uid) || [];
        arr.push({ hostname: host, urls: n });
        evidence.set(uid, arr);
      }
    } catch {
      // crawl_urls may not exist on a stale schema; evidence stays empty.
    }
    for (const arr of evidence.values()) arr.sort((a, b) => b.urls - a.urls);

    // 4. Build the per-upload view + classify.
    const uploads = (upRes.rows as any[]).map(r => {
      const id = String(r.id);
      const siteId = r.site_id == null ? null : String(r.site_id);
      const ev = evidence.get(id) || [];
      const dominant = ev.length ? ev[0].hostname : null;
      const evidenceSiteId = dominant ? (siteIdByDomain.get(dominant) ?? null) : null;
      const attributedSiteId = effectiveSiteId(siteId);
      const status = statusOf(r.error == null ? null : String(r.error));
      const mismatch = !!(status === 'live' && dominant && evidenceSiteId && attributedSiteId && evidenceSiteId !== attributedSiteId);
      return {
        id,
        site_id: siteId,
        attributed_to: labelOf(siteId),
        original_name: String(r.original_name ?? ''),
        detected_format: String(r.detected_format ?? ''),
        month: r.month == null ? null : String(r.month),
        row_count: Number(r.row_count) || 0,
        status,
        error: r.error == null ? null : String(r.error),
        created_at: r.created_at == null ? null : String(r.created_at),
        evidence_hostnames: ev,
        evidence_says: dominant ? `${dominant}${evidenceSiteId ? '' : ' (not a tracked site)'}` : null,
        mismatch,
      };
    });

    // 5. Turnkey buckets for assessment.
    // Suspects: LIVE uploads whose data hostname belongs to a different site
    // than the one they're attributed to (the active wrong attributions).
    const suspects = uploads.filter(u => u.mismatch);

    // Superseded rows: candidate set for a primary upload that an MVP
    // mis-upload clobbered. Paired with any current live upload sharing the
    // same (month, format, original_name) so the "who replaced it" is visible.
    const liveByKey = new Map<string, typeof uploads[number]>();
    for (const u of uploads) {
      if (u.status === 'live') liveByKey.set(`${u.month}|${u.detected_format}|${u.original_name}`, u);
    }
    const superseded = uploads
      .filter(u => u.status === 'superseded')
      .map(u => {
        const liveTwin = liveByKey.get(`${u.month}|${u.detected_format}|${u.original_name}`);
        return {
          id: u.id,
          original_name: u.original_name,
          detected_format: u.detected_format,
          month: u.month,
          created_at: u.created_at,
          now_live_twin: liveTwin
            ? { id: liveTwin.id, attributed_to: liveTwin.attributed_to, evidence_says: liveTwin.evidence_says }
            : null,
        };
      });

    // LIVE NULL/primary uploads with no crawl evidence (GA4/GSC/keyword/etc.):
    // cannot be auto-disambiguated by content, so they need manual confirmation
    // of which site they belong to.
    const needs_manual_confirmation = uploads.filter(
      u => u.status === 'live' && u.site_id == null && u.evidence_hostnames.length === 0,
    ).map(u => ({ id: u.id, original_name: u.original_name, detected_format: u.detected_format, month: u.month, row_count: u.row_count }));

    // Counts.
    const byStatus: Record<string, number> = {};
    for (const u of uploads) byStatus[u.status] = (byStatus[u.status] || 0) + 1;
    const liveBySite: Record<string, number> = {};
    for (const u of uploads) if (u.status === 'live') liveBySite[u.attributed_to] = (liveBySite[u.attributed_to] || 0) + 1;

    return json({
      ok: true,
      client_id: clientId,
      sites: sites.map(s => ({ id: s.id, domain: s.domain, is_primary: s.is_primary, is_managed: s.is_managed, page_count: s.page_count })),
      primary_site_id: primarySiteId,
      counts: { total_uploads: uploads.length, by_status: byStatus, live_by_attributed_site: liveBySite },
      suspects,
      superseded,
      needs_manual_confirmation,
      uploads,
    });
  } catch (err: any) {
    logger.error('csv attribution diagnostic error', err);
    return json({ error: err?.message || 'attribution diagnostic failed' }, 500);
  }
};
