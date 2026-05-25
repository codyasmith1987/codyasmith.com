// Per-URL audit insights for the client portal. Reads from the new
// per-URL tables (crawl_urls, image_urls, redirect_chains) and
// returns aggregate counts + sample URL lists for each category.
//
// One endpoint, one response, so /portal/health makes a single
// extra fetch on top of the existing issues request. Sample lists
// are bounded so the response stays small.

import type { APIRoute } from 'astro';
import turso from '../../../../lib/turso';
import { logger } from '../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Limits per sample list. Keep small; the client only displays the
// top N anyway.
const SAMPLE_LIMIT = 25;

// Thresholds (kept here so client and server agree on what counts).
const TITLE_LONG = 60;
const TITLE_SHORT = 30;
const IMAGE_OVERSIZED = 100 * 1024;       // 100 KB
const IMAGE_VERY_OVERSIZED = 500 * 1024;  // 500 KB
const THIN_WORDS = 200;
const VERY_THIN_WORDS = 100;
const SLOW_MS = 1500;
const VERY_SLOW_MS = 3000;
const DEEP_CLICKS = 5;
const VERY_DEEP_CLICKS = 10;

interface UrlInsightsResponse {
  has_crawl_data: boolean;
  has_image_data: boolean;
  has_redirect_data: boolean;
  has_link_data: boolean;
  title_quality: {
    missing_count: number;
    too_long_count: number;
    too_short_count: number;
    duplicate_count: number;
    sample_missing: Array<{ url: string }>;
    sample_too_long: Array<{ url: string; title: string; title_length: number }>;
    sample_too_short: Array<{ url: string; title: string; title_length: number }>;
    sample_duplicates: Array<{ title: string; count: number; sample_url: string }>;
  };
  oversized_images: {
    over_100kb_count: number;
    over_500kb_count: number;
    samples: Array<{ url: string; size_bytes: number; dimensions: string | null; inlinks_count: number | null }>;
  };
  indexability_blocks: {
    total_blocked: number;
    by_status: Record<string, number>;
    samples: Array<{ url: string; indexability: string; indexability_status: string | null; status_code: number | null }>;
  };
  thin_content: {
    under_200_count: number;
    under_100_count: number;
    samples: Array<{ url: string; word_count: number; title: string | null }>;
  };
  response_time: {
    over_1500_count: number;
    over_3000_count: number;
    samples: Array<{ url: string; response_time_ms: number; content_type: string | null; status_code: number | null }>;
  };
  redirect_chains: {
    loop_count: number;
    multi_hop_count: number;
    sample_loops: Array<{ source_url: string; hop_count: number }>;
    sample_multi_hop: Array<{ source_url: string; final_url: string | null; hop_count: number; final_status_code: number | null }>;
  };
  orphan_pages: {
    count: number;
    samples: Array<{ url: string; status_code: number | null; indexability: string | null; title: string | null }>;
  };
  deep_pages: {
    over_5_count: number;
    over_10_count: number;
    samples: Array<{ url: string; crawl_depth: number; inlinks_count: number | null }>;
  };
  inbound_broken_links: {
    // Distinct destination URLs returning 4xx/5xx that other pages
    // currently link to.
    broken_destination_count: number;
    // Total link-graph rows pointing at those broken destinations.
    total_inbound_links: number;
    samples: Array<{
      destination_url: string;
      status_code: number;
      inbound_count: number;
      sample_source_urls: string[]; // top 5 source pages, capped
    }>;
  };
}

export const GET: APIRoute = async ({ locals, url }) => {
  // Admin can request any client; clients are scoped to their own.
  const requestedClientId = (url.searchParams.get('client_id') || '').trim();
  const user = locals.user;
  if (!user) return json({ error: 'Unauthorized' }, 401);

  let clientId: string;
  if (user.role === 'admin') {
    if (!requestedClientId) return json({ error: 'client_id is required' }, 400);
    clientId = requestedClientId;
  } else {
    if (!user.client_id) return json({ error: 'No client assigned' }, 403);
    clientId = user.client_id;
    if (requestedClientId && requestedClientId !== clientId) {
      return json({ error: 'Forbidden' }, 403);
    }
  }

  try {
    // Resolve the latest month present for each table; widgets fall
    // back to "no data" when a table is empty for this client.
    const crawlMonthRow = await turso.execute({
      sql: 'SELECT MAX(month) FROM crawl_urls WHERE client_id = ?',
      args: [clientId],
    });
    const crawlMonth = (crawlMonthRow.rows[0]?.[0] as string | null) ?? null;
    const imageMonthRow = await turso.execute({
      sql: 'SELECT MAX(month) FROM image_urls WHERE client_id = ?',
      args: [clientId],
    });
    const imageMonth = (imageMonthRow.rows[0]?.[0] as string | null) ?? null;
    const redirectMonthRow = await turso.execute({
      sql: 'SELECT MAX(month) FROM redirect_chains WHERE client_id = ?',
      args: [clientId],
    });
    const redirectMonth = (redirectMonthRow.rows[0]?.[0] as string | null) ?? null;
    const linkMonthRow = await turso.execute({
      sql: 'SELECT MAX(month) FROM link_graph WHERE client_id = ?',
      args: [clientId],
    });
    const linkMonth = (linkMonthRow.rows[0]?.[0] as string | null) ?? null;

    const response: UrlInsightsResponse = {
      has_crawl_data: !!crawlMonth,
      has_image_data: !!imageMonth,
      has_redirect_data: !!redirectMonth,
      has_link_data: !!linkMonth,
      title_quality: {
        missing_count: 0, too_long_count: 0, too_short_count: 0, duplicate_count: 0,
        sample_missing: [], sample_too_long: [], sample_too_short: [], sample_duplicates: [],
      },
      oversized_images: { over_100kb_count: 0, over_500kb_count: 0, samples: [] },
      indexability_blocks: { total_blocked: 0, by_status: {}, samples: [] },
      thin_content: { under_200_count: 0, under_100_count: 0, samples: [] },
      response_time: { over_1500_count: 0, over_3000_count: 0, samples: [] },
      redirect_chains: { loop_count: 0, multi_hop_count: 0, sample_loops: [], sample_multi_hop: [] },
      orphan_pages: { count: 0, samples: [] },
      deep_pages: { over_5_count: 0, over_10_count: 0, samples: [] },
      inbound_broken_links: { broken_destination_count: 0, total_inbound_links: 0, samples: [] },
    };

    // Crawl-derived widgets only run when crawl_urls has data for
    // this client.
    if (crawlMonth) {
      // Title quality counts.
      const tqRow = await turso.execute({
        sql: `SELECT
                SUM(CASE WHEN (title IS NULL OR title = '') THEN 1 ELSE 0 END) AS missing_n,
                SUM(CASE WHEN title_length > ? THEN 1 ELSE 0 END) AS long_n,
                SUM(CASE WHEN title_length > 0 AND title_length < ? THEN 1 ELSE 0 END) AS short_n
              FROM crawl_urls
              WHERE client_id = ? AND month = ?
                AND content_type LIKE 'text/html%'`,
        args: [TITLE_LONG, TITLE_SHORT, clientId, crawlMonth],
      });
      const tq = tqRow.rows[0] as any;
      response.title_quality.missing_count = Number(tq?.[0] || 0);
      response.title_quality.too_long_count = Number(tq?.[1] || 0);
      response.title_quality.too_short_count = Number(tq?.[2] || 0);

      const titleMissingSamples = await turso.execute({
        sql: `SELECT url FROM crawl_urls
              WHERE client_id = ? AND month = ?
                AND content_type LIKE 'text/html%'
                AND (title IS NULL OR title = '')
              ORDER BY url LIMIT ?`,
        args: [clientId, crawlMonth, SAMPLE_LIMIT],
      });
      response.title_quality.sample_missing = (titleMissingSamples.rows as any[]).map(r => ({ url: String(r[0]) }));

      const titleLongSamples = await turso.execute({
        sql: `SELECT url, title, title_length FROM crawl_urls
              WHERE client_id = ? AND month = ?
                AND content_type LIKE 'text/html%'
                AND title_length > ?
              ORDER BY title_length DESC LIMIT ?`,
        args: [clientId, crawlMonth, TITLE_LONG, SAMPLE_LIMIT],
      });
      response.title_quality.sample_too_long = (titleLongSamples.rows as any[]).map(r => ({
        url: String(r[0]), title: String(r[1] || ''), title_length: Number(r[2] || 0),
      }));

      const titleShortSamples = await turso.execute({
        sql: `SELECT url, title, title_length FROM crawl_urls
              WHERE client_id = ? AND month = ?
                AND content_type LIKE 'text/html%'
                AND title_length > 0 AND title_length < ?
              ORDER BY title_length ASC LIMIT ?`,
        args: [clientId, crawlMonth, TITLE_SHORT, SAMPLE_LIMIT],
      });
      response.title_quality.sample_too_short = (titleShortSamples.rows as any[]).map(r => ({
        url: String(r[0]), title: String(r[1] || ''), title_length: Number(r[2] || 0),
      }));

      const titleDupes = await turso.execute({
        sql: `SELECT title, COUNT(*) AS cnt, MIN(url) AS sample_url
              FROM crawl_urls
              WHERE client_id = ? AND month = ?
                AND content_type LIKE 'text/html%'
                AND title IS NOT NULL AND title != ''
              GROUP BY title
              HAVING COUNT(*) > 1
              ORDER BY cnt DESC LIMIT ?`,
        args: [clientId, crawlMonth, SAMPLE_LIMIT],
      });
      response.title_quality.sample_duplicates = (titleDupes.rows as any[]).map(r => ({
        title: String(r[0]), count: Number(r[1] || 0), sample_url: String(r[2]),
      }));
      response.title_quality.duplicate_count = response.title_quality.sample_duplicates
        .reduce((s, d) => s + d.count, 0);

      // Indexability blocks.
      const ibCount = await turso.execute({
        sql: `SELECT COUNT(*) FROM crawl_urls
              WHERE client_id = ? AND month = ?
                AND indexability IS NOT NULL AND indexability != 'Indexable'`,
        args: [clientId, crawlMonth],
      });
      response.indexability_blocks.total_blocked = Number((ibCount.rows[0] as any)?.[0] || 0);
      const ibByStatus = await turso.execute({
        sql: `SELECT indexability_status, COUNT(*) FROM crawl_urls
              WHERE client_id = ? AND month = ?
                AND indexability IS NOT NULL AND indexability != 'Indexable'
              GROUP BY indexability_status
              ORDER BY COUNT(*) DESC`,
        args: [clientId, crawlMonth],
      });
      for (const row of (ibByStatus.rows as any[])) {
        const k = row[0] ? String(row[0]) : '(unspecified)';
        response.indexability_blocks.by_status[k] = Number(row[1] || 0);
      }
      const ibSamples = await turso.execute({
        sql: `SELECT url, indexability, indexability_status, status_code FROM crawl_urls
              WHERE client_id = ? AND month = ?
                AND indexability IS NOT NULL AND indexability != 'Indexable'
              ORDER BY url LIMIT ?`,
        args: [clientId, crawlMonth, SAMPLE_LIMIT],
      });
      response.indexability_blocks.samples = (ibSamples.rows as any[]).map(r => ({
        url: String(r[0]),
        indexability: String(r[1] || ''),
        indexability_status: r[2] ? String(r[2]) : null,
        status_code: r[3] != null ? Number(r[3]) : null,
      }));

      // Thin content.
      const tcCounts = await turso.execute({
        sql: `SELECT
                SUM(CASE WHEN word_count < ? THEN 1 ELSE 0 END) AS under_200,
                SUM(CASE WHEN word_count < ? THEN 1 ELSE 0 END) AS under_100
              FROM crawl_urls
              WHERE client_id = ? AND month = ?
                AND content_type LIKE 'text/html%'
                AND word_count IS NOT NULL`,
        args: [THIN_WORDS, VERY_THIN_WORDS, clientId, crawlMonth],
      });
      const tc = tcCounts.rows[0] as any;
      response.thin_content.under_200_count = Number(tc?.[0] || 0);
      response.thin_content.under_100_count = Number(tc?.[1] || 0);
      const tcSamples = await turso.execute({
        sql: `SELECT url, word_count, title FROM crawl_urls
              WHERE client_id = ? AND month = ?
                AND content_type LIKE 'text/html%'
                AND word_count IS NOT NULL AND word_count < ?
              ORDER BY word_count ASC LIMIT ?`,
        args: [clientId, crawlMonth, THIN_WORDS, SAMPLE_LIMIT],
      });
      response.thin_content.samples = (tcSamples.rows as any[]).map(r => ({
        url: String(r[0]),
        word_count: Number(r[1] || 0),
        title: r[2] ? String(r[2]) : null,
      }));

      // Response time outliers.
      const rtCounts = await turso.execute({
        sql: `SELECT
                SUM(CASE WHEN response_time_ms > ? THEN 1 ELSE 0 END) AS over_slow,
                SUM(CASE WHEN response_time_ms > ? THEN 1 ELSE 0 END) AS over_very_slow
              FROM crawl_urls
              WHERE client_id = ? AND month = ?
                AND response_time_ms IS NOT NULL`,
        args: [SLOW_MS, VERY_SLOW_MS, clientId, crawlMonth],
      });
      const rt = rtCounts.rows[0] as any;
      response.response_time.over_1500_count = Number(rt?.[0] || 0);
      response.response_time.over_3000_count = Number(rt?.[1] || 0);
      const rtSamples = await turso.execute({
        sql: `SELECT url, response_time_ms, content_type, status_code FROM crawl_urls
              WHERE client_id = ? AND month = ?
                AND response_time_ms IS NOT NULL AND response_time_ms > ?
              ORDER BY response_time_ms DESC LIMIT ?`,
        args: [clientId, crawlMonth, SLOW_MS, SAMPLE_LIMIT],
      });
      response.response_time.samples = (rtSamples.rows as any[]).map(r => ({
        url: String(r[0]),
        response_time_ms: Number(r[1] || 0),
        content_type: r[2] ? String(r[2]) : null,
        status_code: r[3] != null ? Number(r[3]) : null,
      }));

      // Orphan pages (inlinks_count = 0).
      const orphanCountRow = await turso.execute({
        sql: `SELECT COUNT(*) FROM crawl_urls
              WHERE client_id = ? AND month = ?
                AND content_type LIKE 'text/html%'
                AND inlinks_count = 0`,
        args: [clientId, crawlMonth],
      });
      response.orphan_pages.count = Number((orphanCountRow.rows[0] as any)?.[0] || 0);
      const orphanSamples = await turso.execute({
        sql: `SELECT url, status_code, indexability, title FROM crawl_urls
              WHERE client_id = ? AND month = ?
                AND content_type LIKE 'text/html%'
                AND inlinks_count = 0
              ORDER BY url LIMIT ?`,
        args: [clientId, crawlMonth, SAMPLE_LIMIT],
      });
      response.orphan_pages.samples = (orphanSamples.rows as any[]).map(r => ({
        url: String(r[0]),
        status_code: r[1] != null ? Number(r[1]) : null,
        indexability: r[2] ? String(r[2]) : null,
        title: r[3] ? String(r[3]) : null,
      }));

      // Deep pages (crawl_depth > N).
      const depthCounts = await turso.execute({
        sql: `SELECT
                SUM(CASE WHEN crawl_depth > ? THEN 1 ELSE 0 END) AS over_5,
                SUM(CASE WHEN crawl_depth > ? THEN 1 ELSE 0 END) AS over_10
              FROM crawl_urls
              WHERE client_id = ? AND month = ?
                AND content_type LIKE 'text/html%'
                AND crawl_depth IS NOT NULL`,
        args: [DEEP_CLICKS, VERY_DEEP_CLICKS, clientId, crawlMonth],
      });
      const dp = depthCounts.rows[0] as any;
      response.deep_pages.over_5_count = Number(dp?.[0] || 0);
      response.deep_pages.over_10_count = Number(dp?.[1] || 0);
      const dpSamples = await turso.execute({
        sql: `SELECT url, crawl_depth, inlinks_count FROM crawl_urls
              WHERE client_id = ? AND month = ?
                AND content_type LIKE 'text/html%'
                AND crawl_depth IS NOT NULL AND crawl_depth > ?
              ORDER BY crawl_depth DESC LIMIT ?`,
        args: [clientId, crawlMonth, DEEP_CLICKS, SAMPLE_LIMIT],
      });
      response.deep_pages.samples = (dpSamples.rows as any[]).map(r => ({
        url: String(r[0]),
        crawl_depth: Number(r[1] || 0),
        inlinks_count: r[2] != null ? Number(r[2]) : null,
      }));
    }

    // Image-derived widget.
    if (imageMonth) {
      const imgCounts = await turso.execute({
        sql: `SELECT
                SUM(CASE WHEN size_bytes > ? THEN 1 ELSE 0 END) AS over_100,
                SUM(CASE WHEN size_bytes > ? THEN 1 ELSE 0 END) AS over_500
              FROM image_urls
              WHERE client_id = ? AND month = ?
                AND size_bytes IS NOT NULL`,
        args: [IMAGE_OVERSIZED, IMAGE_VERY_OVERSIZED, clientId, imageMonth],
      });
      const ic = imgCounts.rows[0] as any;
      response.oversized_images.over_100kb_count = Number(ic?.[0] || 0);
      response.oversized_images.over_500kb_count = Number(ic?.[1] || 0);
      const imgSamples = await turso.execute({
        sql: `SELECT url, size_bytes, dimensions, inlinks_count FROM image_urls
              WHERE client_id = ? AND month = ?
                AND size_bytes IS NOT NULL AND size_bytes > ?
              ORDER BY size_bytes DESC LIMIT ?`,
        args: [clientId, imageMonth, IMAGE_OVERSIZED, SAMPLE_LIMIT],
      });
      response.oversized_images.samples = (imgSamples.rows as any[]).map(r => ({
        url: String(r[0]),
        size_bytes: Number(r[1] || 0),
        dimensions: r[2] ? String(r[2]) : null,
        inlinks_count: r[3] != null ? Number(r[3]) : null,
      }));
    }

    // Redirect chain widget.
    if (redirectMonth) {
      const rcCounts = await turso.execute({
        sql: `SELECT
                SUM(CASE WHEN is_loop = 1 THEN 1 ELSE 0 END) AS loops,
                SUM(CASE WHEN hop_count >= 2 THEN 1 ELSE 0 END) AS multi
              FROM redirect_chains
              WHERE client_id = ? AND month = ?`,
        args: [clientId, redirectMonth],
      });
      const rc = rcCounts.rows[0] as any;
      response.redirect_chains.loop_count = Number(rc?.[0] || 0);
      response.redirect_chains.multi_hop_count = Number(rc?.[1] || 0);
      const loopSamples = await turso.execute({
        sql: `SELECT source_url, hop_count FROM redirect_chains
              WHERE client_id = ? AND month = ? AND is_loop = 1
              ORDER BY hop_count DESC LIMIT ?`,
        args: [clientId, redirectMonth, SAMPLE_LIMIT],
      });
      response.redirect_chains.sample_loops = (loopSamples.rows as any[]).map(r => ({
        source_url: String(r[0]),
        hop_count: Number(r[1] || 0),
      }));
      const multiSamples = await turso.execute({
        sql: `SELECT source_url, final_url, hop_count, final_status_code FROM redirect_chains
              WHERE client_id = ? AND month = ? AND is_loop = 0 AND hop_count >= 2
              ORDER BY hop_count DESC LIMIT ?`,
        args: [clientId, redirectMonth, SAMPLE_LIMIT],
      });
      response.redirect_chains.sample_multi_hop = (multiSamples.rows as any[]).map(r => ({
        source_url: String(r[0]),
        final_url: r[1] ? String(r[1]) : null,
        hop_count: Number(r[2] || 0),
        final_status_code: r[3] != null ? Number(r[3]) : null,
      }));
    }

    // Inbound broken links: which destination URLs return 4xx/5xx, and
    // which pages on this site currently link to them. Each row is one
    // broken destination + a top-N sample of source pages, so the
    // client can render "fix this link on these pages."
    if (linkMonth) {
      const brokenCounts = await turso.execute({
        sql: `SELECT
                COUNT(DISTINCT destination_url) AS broken_destinations,
                COUNT(*) AS total_inbound
              FROM link_graph
              WHERE client_id = ? AND month = ?
                AND status_code IS NOT NULL AND status_code >= 400`,
        args: [clientId, linkMonth],
      });
      const bc = brokenCounts.rows[0] as any;
      response.inbound_broken_links.broken_destination_count = Number(bc?.[0] || 0);
      response.inbound_broken_links.total_inbound_links = Number(bc?.[1] || 0);

      // Top destinations + capped concatenated source list. GROUP_CONCAT
      // truncated by SUBSTR to keep the payload bounded if a destination
      // has thousands of inbound links.
      const topBroken = await turso.execute({
        sql: `SELECT
                destination_url,
                MAX(status_code) AS status_code,
                COUNT(*) AS inbound_count,
                SUBSTR(GROUP_CONCAT(DISTINCT source_url), 1, 4000) AS sources_concat
              FROM link_graph
              WHERE client_id = ? AND month = ?
                AND status_code IS NOT NULL AND status_code >= 400
              GROUP BY destination_url
              ORDER BY inbound_count DESC, destination_url
              LIMIT ?`,
        args: [clientId, linkMonth, SAMPLE_LIMIT],
      });
      response.inbound_broken_links.samples = (topBroken.rows as any[]).map(r => {
        const sources = (r[3] ? String(r[3]) : '')
          .split(',')
          .map(s => s.trim())
          .filter(Boolean)
          .slice(0, 5);
        return {
          destination_url: String(r[0]),
          status_code: Number(r[1] || 0),
          inbound_count: Number(r[2] || 0),
          sample_source_urls: sources,
        };
      });
    }

    return json(response);
  } catch (err: any) {
    logger.error('url-insights endpoint failed', err);
    return json({ error: err?.message || 'Failed to load URL insights' }, 500);
  }
};
