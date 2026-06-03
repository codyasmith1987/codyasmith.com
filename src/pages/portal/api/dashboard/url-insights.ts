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
import {
  WCAG_BUCKETS,
  emptyAccessibility,
  buildAccessibilityByLevel,
  type AccessibilityInsights,
} from '../../../../lib/dashboard/accessibility-insights';
import {
  emptyStructuredData,
  topSchemaTypes,
  type StructuredDataInsights,
} from '../../../../lib/dashboard/structured-data-insights';
import {
  emptyContentQuality,
  readabilityBand,
  HARD_TO_READ_FLESCH_THRESHOLD,
  type ContentQualityInsights,
} from '../../../../lib/dashboard/content-quality-insights';
import { realUserPageRowFilters, realUserPageUrlExclusions } from '../../../../lib/csv/page-count-sql';
import { classifyUrl, isCrawlerBlockedHost } from '../../../../lib/url-classifier';

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
  has_accessibility_data: boolean;
  has_structured_data: boolean;
  has_content_quality: boolean;
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
  accessibility: AccessibilityInsights;
  structured_data: StructuredDataInsights;
  content_quality: ContentQualityInsights;
  // Explicit measured-vs-missing record for the three signal categories,
  // read from data_coverage (NOT re-derived from NULLs at read time). Lets the
  // client render a neutral "not measured" state distinct from a measured
  // "0 issues / all clear." `measured = 0` with `rows_total > 0` means the file
  // was provided but the analysis columns were blank (e.g. free Screaming Frog);
  // `rows_total = 0` means it was never provided. Either way the surface is the
  // same neutral "not measured" — `rows_total` preserves the internal distinction.
  category_coverage: {
    accessibility: CategoryCoverage;
    structured_data: CategoryCoverage;
    content_quality: CategoryCoverage;
  };
}

interface CategoryCoverage {
  measured: 0 | 1;
  rows_total: number;
  rows_measured: number;
}

// Absent coverage reads as "not measured" (never an inferred clean 0). The
// three signal categories (accessibility / structured_data / content_quality)
// gate on data_coverage.measured; file-present categories (crawl / images /
// redirects / links) keep month-presence gating.
function emptyCategoryCoverage(): CategoryCoverage {
  return { measured: 0, rows_total: 0, rows_measured: 0 };
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
    const response = await loadUrlInsights(turso, clientId);
    return json(response);
  } catch (err: any) {
    logger.error('url-insights endpoint failed', err);
    return json({ error: err?.message || 'Failed to load URL insights' }, 500);
  }
};

// Read seam: all DB work lives here so it can be exercised against an in-memory
// libsql client in tests (the GET handler calls it with the turso singleton).
// Mirrors the runAtomicIngest(db, ...) / backfillCoverage(db) seams.
export async function loadUrlInsights(
  db: typeof turso,
  clientId: string,
): Promise<UrlInsightsResponse> {
  {
    // Resolve the latest month present for each table; widgets fall
    // back to "no data" when a table is empty for this client.
    const crawlMonthRow = await db.execute({
      sql: 'SELECT MAX(month) FROM crawl_urls WHERE client_id = ?',
      args: [clientId],
    });
    const crawlMonth = (crawlMonthRow.rows[0]?.[0] as string | null) ?? null;
    const imageMonthRow = await db.execute({
      sql: 'SELECT MAX(month) FROM image_urls WHERE client_id = ?',
      args: [clientId],
    });
    const imageMonth = (imageMonthRow.rows[0]?.[0] as string | null) ?? null;
    const redirectMonthRow = await db.execute({
      sql: 'SELECT MAX(month) FROM redirect_chains WHERE client_id = ?',
      args: [clientId],
    });
    const redirectMonth = (redirectMonthRow.rows[0]?.[0] as string | null) ?? null;
    const linkMonthRow = await db.execute({
      sql: 'SELECT MAX(month) FROM link_graph WHERE client_id = ?',
      args: [clientId],
    });
    const linkMonth = (linkMonthRow.rows[0]?.[0] as string | null) ?? null;

    // Signal categories (accessibility / structured_data / content_quality)
    // gate on data_coverage.measured, NOT on table-row presence. A free
    // Screaming Frog export leaves rows present with blank analysis columns;
    // ingest records that as measured = 0 so this read layer never surfaces a
    // measured "0 / all clear" for data that was never actually measured. We
    // read the latest coverage row per category (the month it points at is the
    // month whose data the widget queries). Absent coverage == not measured.
    const coverageByCategory: Record<string, { measured: 0 | 1; rows_total: number; rows_measured: number; month: string }> = {};
    const coverageRows = await db.execute({
      sql: `SELECT dc.category, dc.month, dc.measured, dc.rows_total, dc.rows_measured
            FROM data_coverage dc
            WHERE dc.client_id = ?
              AND dc.category IN ('accessibility', 'structured_data', 'content_quality')
              AND dc.month = (
                SELECT MAX(d2.month) FROM data_coverage d2
                WHERE d2.client_id = dc.client_id AND d2.category = dc.category
              )`,
      args: [clientId],
    });
    for (const row of (coverageRows.rows as any[])) {
      coverageByCategory[String(row[0])] = {
        month: String(row[1]),
        measured: Number(row[2]) === 1 ? 1 : 0,
        rows_total: Number(row[3] ?? 0),
        rows_measured: Number(row[4] ?? 0),
      };
    }

    const accessibilityCov = coverageByCategory['accessibility'] ?? null;
    const structuredCov = coverageByCategory['structured_data'] ?? null;
    const contentCov = coverageByCategory['content_quality'] ?? null;

    // The widget runs (and real counts flow) only for a measured category.
    const accessibilityMonth = accessibilityCov?.measured === 1 ? accessibilityCov.month : null;
    const structuredMonth = structuredCov?.measured === 1 ? structuredCov.month : null;
    const contentMonth = contentCov?.measured === 1 ? contentCov.month : null;

    const category_coverage = {
      accessibility: accessibilityCov
        ? { measured: accessibilityCov.measured, rows_total: accessibilityCov.rows_total, rows_measured: accessibilityCov.rows_measured }
        : emptyCategoryCoverage(),
      structured_data: structuredCov
        ? { measured: structuredCov.measured, rows_total: structuredCov.rows_total, rows_measured: structuredCov.rows_measured }
        : emptyCategoryCoverage(),
      content_quality: contentCov
        ? { measured: contentCov.measured, rows_total: contentCov.rows_total, rows_measured: contentCov.rows_measured }
        : emptyCategoryCoverage(),
    };

    const response: UrlInsightsResponse = {
      has_crawl_data: !!crawlMonth,
      has_image_data: !!imageMonth,
      has_redirect_data: !!redirectMonth,
      has_link_data: !!linkMonth,
      has_accessibility_data: !!accessibilityMonth,
      has_structured_data: !!structuredMonth,
      has_content_quality: !!contentMonth,
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
      accessibility: emptyAccessibility(),
      structured_data: emptyStructuredData(),
      content_quality: emptyContentQuality(),
      category_coverage,
    };

    // Crawl-derived widgets only run when crawl_urls has data for
    // this client.
    if (crawlMonth) {
      // The single real-user-page definition (status 200 + HTML + indexable,
      // minus taxonomy/system/attachment/pagination URLs). The page-quality
      // widgets below MUST use this so they never count 404 cache-busted
      // assets, redirects, archives, or noindex URLs as "pages" — that was
      // the bug where F3 showed 8 "missing title" / 8 "thin content" pages
      // while the headline correctly said 5. It also keeps these widgets in
      // agreement with the "X of your Y pages" count (crawl-stats uses the
      // same filters). NOT applied to indexability_blocks (it is ABOUT
      // non-indexable URLs) or to the image/redirect/broken-link surfaces.
      const PAGE_FILTER = `${realUserPageRowFilters('')} ${realUserPageUrlExclusions('url')}`;

      // Real pages blocked from index: 200 + HTML + real-page URL shape, but
      // NON-indexable. Excludes EXPECTED CMS noindex (tag/category/author/
      // pagination archives, wp-system) so an intentional block is never
      // counted as a problem (M4). Cannot reuse PAGE_FILTER — that asserts
      // indexable, the opposite of what this widget is about.
      const BLOCKED_PAGE_FILTER = `AND status_code = 200 AND LOWER(IFNULL(content_type, '')) LIKE '%html%' ${realUserPageUrlExclusions('url')}`;

      // Title quality counts.
      const tqRow = await db.execute({
        sql: `SELECT
                SUM(CASE WHEN (title IS NULL OR title = '') THEN 1 ELSE 0 END) AS missing_n,
                SUM(CASE WHEN title_length > ? THEN 1 ELSE 0 END) AS long_n,
                SUM(CASE WHEN title_length > 0 AND title_length < ? THEN 1 ELSE 0 END) AS short_n
              FROM crawl_urls
              WHERE client_id = ? AND month = ?
                ${PAGE_FILTER}`,
        args: [TITLE_LONG, TITLE_SHORT, clientId, crawlMonth],
      });
      const tq = tqRow.rows[0] as any;
      response.title_quality.missing_count = Number(tq?.[0] || 0);
      response.title_quality.too_long_count = Number(tq?.[1] || 0);
      response.title_quality.too_short_count = Number(tq?.[2] || 0);

      const titleMissingSamples = await db.execute({
        sql: `SELECT url FROM crawl_urls
              WHERE client_id = ? AND month = ?
                ${PAGE_FILTER}
                AND (title IS NULL OR title = '')
              ORDER BY url LIMIT ?`,
        args: [clientId, crawlMonth, SAMPLE_LIMIT],
      });
      response.title_quality.sample_missing = (titleMissingSamples.rows as any[]).map(r => ({ url: String(r[0]) }));

      const titleLongSamples = await db.execute({
        sql: `SELECT url, title, title_length FROM crawl_urls
              WHERE client_id = ? AND month = ?
                ${PAGE_FILTER}
                AND title_length > ?
              ORDER BY title_length DESC LIMIT ?`,
        args: [clientId, crawlMonth, TITLE_LONG, SAMPLE_LIMIT],
      });
      response.title_quality.sample_too_long = (titleLongSamples.rows as any[]).map(r => ({
        url: String(r[0]), title: String(r[1] || ''), title_length: Number(r[2] || 0),
      }));

      const titleShortSamples = await db.execute({
        sql: `SELECT url, title, title_length FROM crawl_urls
              WHERE client_id = ? AND month = ?
                ${PAGE_FILTER}
                AND title_length > 0 AND title_length < ?
              ORDER BY title_length ASC LIMIT ?`,
        args: [clientId, crawlMonth, TITLE_SHORT, SAMPLE_LIMIT],
      });
      response.title_quality.sample_too_short = (titleShortSamples.rows as any[]).map(r => ({
        url: String(r[0]), title: String(r[1] || ''), title_length: Number(r[2] || 0),
      }));

      const titleDupes = await db.execute({
        sql: `SELECT title, COUNT(*) AS cnt, MIN(url) AS sample_url
              FROM crawl_urls
              WHERE client_id = ? AND month = ?
                ${PAGE_FILTER}
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
      const ibCount = await db.execute({
        sql: `SELECT COUNT(*) FROM crawl_urls
              WHERE client_id = ? AND month = ?
                ${BLOCKED_PAGE_FILTER}
                AND indexability IS NOT NULL AND indexability != 'Indexable'`,
        args: [clientId, crawlMonth],
      });
      response.indexability_blocks.total_blocked = Number((ibCount.rows[0] as any)?.[0] || 0);
      const ibByStatus = await db.execute({
        sql: `SELECT indexability_status, COUNT(*) FROM crawl_urls
              WHERE client_id = ? AND month = ?
                ${BLOCKED_PAGE_FILTER}
                AND indexability IS NOT NULL AND indexability != 'Indexable'
              GROUP BY indexability_status
              ORDER BY COUNT(*) DESC`,
        args: [clientId, crawlMonth],
      });
      for (const row of (ibByStatus.rows as any[])) {
        const k = row[0] ? String(row[0]) : '(unspecified)';
        response.indexability_blocks.by_status[k] = Number(row[1] || 0);
      }
      const ibSamples = await db.execute({
        sql: `SELECT url, indexability, indexability_status, status_code FROM crawl_urls
              WHERE client_id = ? AND month = ?
                ${BLOCKED_PAGE_FILTER}
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
      const tcCounts = await db.execute({
        sql: `SELECT
                SUM(CASE WHEN word_count < ? THEN 1 ELSE 0 END) AS under_200,
                SUM(CASE WHEN word_count < ? THEN 1 ELSE 0 END) AS under_100
              FROM crawl_urls
              WHERE client_id = ? AND month = ?
                ${PAGE_FILTER}
                AND word_count > 0`,
        args: [THIN_WORDS, VERY_THIN_WORDS, clientId, crawlMonth],
      });
      const tc = tcCounts.rows[0] as any;
      response.thin_content.under_200_count = Number(tc?.[0] || 0);
      response.thin_content.under_100_count = Number(tc?.[1] || 0);
      const tcSamples = await db.execute({
        sql: `SELECT url, word_count, title FROM crawl_urls
              WHERE client_id = ? AND month = ?
                ${PAGE_FILTER}
                AND word_count > 0 AND word_count < ?
              ORDER BY word_count ASC LIMIT ?`,
        args: [clientId, crawlMonth, THIN_WORDS, SAMPLE_LIMIT],
      });
      response.thin_content.samples = (tcSamples.rows as any[]).map(r => ({
        url: String(r[0]),
        word_count: Number(r[1] || 0),
        title: r[2] ? String(r[2]) : null,
      }));

      // Response time outliers.
      const rtCounts = await db.execute({
        sql: `SELECT
                SUM(CASE WHEN response_time_ms > ? THEN 1 ELSE 0 END) AS over_slow,
                SUM(CASE WHEN response_time_ms > ? THEN 1 ELSE 0 END) AS over_very_slow
              FROM crawl_urls
              WHERE client_id = ? AND month = ?
                ${PAGE_FILTER}
                AND response_time_ms IS NOT NULL`,
        args: [SLOW_MS, VERY_SLOW_MS, clientId, crawlMonth],
      });
      const rt = rtCounts.rows[0] as any;
      response.response_time.over_1500_count = Number(rt?.[0] || 0);
      response.response_time.over_3000_count = Number(rt?.[1] || 0);
      const rtSamples = await db.execute({
        sql: `SELECT url, response_time_ms, content_type, status_code FROM crawl_urls
              WHERE client_id = ? AND month = ?
                ${PAGE_FILTER}
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
      const orphanCountRow = await db.execute({
        sql: `SELECT COUNT(*) FROM crawl_urls
              WHERE client_id = ? AND month = ?
                ${PAGE_FILTER}
                AND inlinks_count = 0`,
        args: [clientId, crawlMonth],
      });
      response.orphan_pages.count = Number((orphanCountRow.rows[0] as any)?.[0] || 0);
      const orphanSamples = await db.execute({
        sql: `SELECT url, status_code, indexability, title FROM crawl_urls
              WHERE client_id = ? AND month = ?
                ${PAGE_FILTER}
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
      const depthCounts = await db.execute({
        sql: `SELECT
                SUM(CASE WHEN crawl_depth > ? THEN 1 ELSE 0 END) AS over_5,
                SUM(CASE WHEN crawl_depth > ? THEN 1 ELSE 0 END) AS over_10
              FROM crawl_urls
              WHERE client_id = ? AND month = ?
                ${PAGE_FILTER}
                AND crawl_depth IS NOT NULL`,
        args: [DEEP_CLICKS, VERY_DEEP_CLICKS, clientId, crawlMonth],
      });
      const dp = depthCounts.rows[0] as any;
      response.deep_pages.over_5_count = Number(dp?.[0] || 0);
      response.deep_pages.over_10_count = Number(dp?.[1] || 0);
      const dpSamples = await db.execute({
        sql: `SELECT url, crawl_depth, inlinks_count FROM crawl_urls
              WHERE client_id = ? AND month = ?
                ${PAGE_FILTER}
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
      const imgCounts = await db.execute({
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
      const imgSamples = await db.execute({
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
      const rcCounts = await db.execute({
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
      const loopSamples = await db.execute({
        sql: `SELECT source_url, hop_count FROM redirect_chains
              WHERE client_id = ? AND month = ? AND is_loop = 1
              ORDER BY hop_count DESC LIMIT ?`,
        args: [clientId, redirectMonth, SAMPLE_LIMIT],
      });
      response.redirect_chains.sample_loops = (loopSamples.rows as any[]).map(r => ({
        source_url: String(r[0]),
        hop_count: Number(r[1] || 0),
      }));
      const multiSamples = await db.execute({
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
      // One grouped query over the broken (4xx/5xx) destinations, then suppress
      // EXPECTED false positives in app code (the classifier helpers are the
      // single source of truth; SQL host-matching on destination_url would be
      // fragile). Broken-link rows are a small subset, so pulling them all is
      // cheap. Suppressed: Cloudflare /cdn-cgi/ + mailto/tel (URL-shape), and
      // any error to a crawler-blocked social/video host (youtube/linkedin/...).
      // Verified empirically: YouTube returns 404 to the crawler for a LIVE
      // @handle, so we suppress ANY 4xx/5xx from these hosts here (we are
      // already inside the >=400 broken set) rather than only bot-block codes
      // — a client's live social profiles must never read as broken. Genuinely
      // broken on-site resources (e.g. a 404 wp-content image) are NOT these
      // hosts and stay flagged. Suppressed links remain in link_graph for admin.
      const brokenRows = await db.execute({
        sql: `SELECT
                destination_url,
                MAX(status_code) AS status_code,
                COUNT(*) AS inbound_count,
                SUBSTR(GROUP_CONCAT(DISTINCT source_url), 1, 4000) AS sources_concat
              FROM link_graph
              WHERE client_id = ? AND month = ?
                AND status_code IS NOT NULL AND status_code >= 400
              GROUP BY destination_url
              ORDER BY inbound_count DESC, destination_url`,
        args: [clientId, linkMonth],
      });
      const kept = (brokenRows.rows as any[]).filter(r => {
        const dest = String(r[0]);
        if (classifyUrl(dest).is_expected) return false;
        let host = '';
        try { host = new URL(dest).hostname; } catch { /* relative/malformed: treat as on-site, keep */ }
        if (isCrawlerBlockedHost(host)) return false; // any 4xx/5xx from a crawler-blocked host is a block, not a dead link
        return true;
      });
      response.inbound_broken_links.broken_destination_count = kept.length;
      response.inbound_broken_links.total_inbound_links = kept.reduce((s, r) => s + Number(r[2] || 0), 0);
      response.inbound_broken_links.samples = kept.slice(0, SAMPLE_LIMIT).map(r => {
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

    // Accessibility (WCAG) widget. Per-URL violation counts from
    // accessibility_urls. by_level coalesces NULL buckets to 0 via the
    // pure helper so a partial export cannot miscount or throw.
    if (accessibilityMonth) {
      const aCounts = await db.execute({
        sql: `SELECT
                SUM(CASE WHEN all_violations > 0 THEN 1 ELSE 0 END) AS pages_with,
                COALESCE(SUM(all_violations), 0) AS total
              FROM accessibility_urls
              WHERE client_id = ? AND month = ?`,
        args: [clientId, accessibilityMonth],
      });
      const ac = aCounts.rows[0] as any;
      response.accessibility.pages_with_violations = Number(ac?.[0] || 0);
      response.accessibility.total_violations = Number(ac?.[1] || 0);

      // Per-bucket page counts: one SUM(CASE...) per WCAG column. The
      // column names come from the WCAG_BUCKETS constant (no user input),
      // so interpolating them is safe; clientId/month stay parameterized.
      const levelSelects = WCAG_BUCKETS
        .map(b => `SUM(CASE WHEN ${b.column} > 0 THEN 1 ELSE 0 END) AS ${b.column}`)
        .join(',\n                ');
      const levelRow = await db.execute({
        sql: `SELECT
                ${levelSelects}
              FROM accessibility_urls
              WHERE client_id = ? AND month = ?`,
        args: [clientId, accessibilityMonth],
      });
      const lr = levelRow.rows[0] as any;
      const countsByColumn: Record<string, number> = {};
      WCAG_BUCKETS.forEach((b, i) => { countsByColumn[b.column] = Number(lr?.[i] || 0); });
      response.accessibility.by_level = buildAccessibilityByLevel(countsByColumn);

      const aSamples = await db.execute({
        sql: `SELECT url, all_violations, status_code FROM accessibility_urls
              WHERE client_id = ? AND month = ?
                AND all_violations > 0
              ORDER BY all_violations DESC, url LIMIT ?`,
        args: [clientId, accessibilityMonth, SAMPLE_LIMIT],
      });
      response.accessibility.samples = (aSamples.rows as any[]).map(r => ({
        url: String(r[0]),
        all_violations: Number(r[1] || 0),
        status_code: r[2] != null ? Number(r[2]) : null,
      }));
    }

    // Structured-data (schema markup) widget. Per-URL error/warning
    // counts from structured_data_urls; top_types tallies the most
    // common schema types across the sampled pages.
    if (structuredMonth) {
      const sdCounts = await db.execute({
        sql: `SELECT
                SUM(CASE WHEN error_count > 0 THEN 1 ELSE 0 END) AS pages_err,
                SUM(CASE WHEN warning_count > 0 THEN 1 ELSE 0 END) AS pages_warn,
                COALESCE(SUM(error_count), 0) AS total_err,
                COALESCE(SUM(warning_count), 0) AS total_warn
              FROM structured_data_urls
              WHERE client_id = ? AND month = ?`,
        args: [clientId, structuredMonth],
      });
      const sd = sdCounts.rows[0] as any;
      response.structured_data.pages_with_errors = Number(sd?.[0] || 0);
      response.structured_data.pages_with_warnings = Number(sd?.[1] || 0);
      response.structured_data.total_errors = Number(sd?.[2] || 0);
      response.structured_data.total_warnings = Number(sd?.[3] || 0);

      // top_types: gather types_list across pages that declare any schema
      // type, then tally page-counts per type via the pure helper.
      const typeRows = await db.execute({
        sql: `SELECT types_list FROM structured_data_urls
              WHERE client_id = ? AND month = ?
                AND types_list IS NOT NULL AND types_list != ''`,
        args: [clientId, structuredMonth],
      });
      response.structured_data.top_types = topSchemaTypes(
        (typeRows.rows as any[]).map(r => (r[0] != null ? String(r[0]) : null)),
      );

      // samples: worst pages by error then warning count.
      const sdSamples = await db.execute({
        sql: `SELECT url, error_count, warning_count FROM structured_data_urls
              WHERE client_id = ? AND month = ?
                AND (error_count > 0 OR warning_count > 0)
              ORDER BY error_count DESC, warning_count DESC, url LIMIT ?`,
        args: [clientId, structuredMonth, SAMPLE_LIMIT],
      });
      response.structured_data.samples = (sdSamples.rows as any[]).map(r => ({
        url: String(r[0]),
        error_count: Number(r[1] || 0),
        warning_count: Number(r[2] || 0),
      }));
    }

    // Content-quality widget. Three independent signals from content_urls:
    // near-duplicate content, spelling/grammar errors, and (advisory)
    // readability via Flesch reading-ease. "Hard to read" uses STRICT
    // less-than the threshold; score 50 is "fairly difficult", not hard.
    if (contentMonth) {
      // Per-sub-metric NULL-awareness: a content_urls month can be measured
      // overall while one sub-metric column is entirely blank (the paid content
      // analysis populated some columns but not others). Each sub-metric is
      // "measured" only when at least one row carries a real (non-NULL) value
      // in its source column(s); a sub-metric with zero non-NULL rows is
      // measured:false (NOT a misleading clean 0). The displayed counts are
      // computed only over the non-NULL rows. The `_present` counts below count
      // rows with a real value (a literal 0 counts as measured); the issue
      // counts (`dupes`, `spellgram`, `hardread`) count rows that exceed the
      // threshold, only among the non-NULL rows.
      const cqCounts = await db.execute({
        sql: `SELECT
                SUM(CASE WHEN near_duplicate_count IS NOT NULL AND near_duplicate_count > 0 THEN 1 ELSE 0 END) AS dupes,
                SUM(CASE WHEN (spelling_errors IS NOT NULL AND spelling_errors > 0) OR (grammar_errors IS NOT NULL AND grammar_errors > 0) THEN 1 ELSE 0 END) AS spellgram,
                SUM(CASE WHEN flesch_reading_ease IS NOT NULL AND flesch_reading_ease < ? THEN 1 ELSE 0 END) AS hardread,
                SUM(CASE WHEN near_duplicate_count IS NOT NULL THEN 1 ELSE 0 END) AS dup_present,
                SUM(CASE WHEN spelling_errors IS NOT NULL OR grammar_errors IS NOT NULL THEN 1 ELSE 0 END) AS sg_present,
                SUM(CASE WHEN flesch_reading_ease IS NOT NULL THEN 1 ELSE 0 END) AS read_present
              FROM content_urls
              WHERE client_id = ? AND month = ?`,
        args: [HARD_TO_READ_FLESCH_THRESHOLD, clientId, contentMonth],
      });
      const cq = cqCounts.rows[0] as any;
      response.content_quality.near_duplicate_count = Number(cq?.[0] || 0);
      response.content_quality.spelling_grammar_count = Number(cq?.[1] || 0);
      response.content_quality.hard_to_read_count = Number(cq?.[2] || 0);
      response.content_quality.measured.near_duplicate = Number(cq?.[3] || 0) > 0;
      response.content_quality.measured.spelling_grammar = Number(cq?.[4] || 0) > 0;
      response.content_quality.measured.readability = Number(cq?.[5] || 0) > 0;

      // Near-duplicate samples: worst (most duplicates) first.
      const dupeSamples = await db.execute({
        sql: `SELECT url, near_duplicate_count, closest_near_duplicate_url FROM content_urls
              WHERE client_id = ? AND month = ?
                AND near_duplicate_count > 0
              ORDER BY near_duplicate_count DESC, url LIMIT ?`,
        args: [clientId, contentMonth, SAMPLE_LIMIT],
      });
      response.content_quality.near_duplicate_samples = (dupeSamples.rows as any[]).map(r => {
        const n = Number(r[1] || 0);
        const match = r[2] != null ? String(r[2]) : '';
        const detail = match
          ? `${n} near-duplicate${n !== 1 ? 's' : ''}, closest: ${match}`
          : `${n} near-duplicate${n !== 1 ? 's' : ''}`;
        return { url: String(r[0]), detail };
      });

      // Spelling/grammar samples: worst (most combined errors) first.
      const sgSamples = await db.execute({
        sql: `SELECT url, COALESCE(spelling_errors,0) AS sp, COALESCE(grammar_errors,0) AS gr FROM content_urls
              WHERE client_id = ? AND month = ?
                AND (COALESCE(spelling_errors,0) > 0 OR COALESCE(grammar_errors,0) > 0)
              ORDER BY (COALESCE(spelling_errors,0) + COALESCE(grammar_errors,0)) DESC, url LIMIT ?`,
        args: [clientId, contentMonth, SAMPLE_LIMIT],
      });
      response.content_quality.spelling_grammar_samples = (sgSamples.rows as any[]).map(r => {
        const sp = Number(r[1] || 0);
        const gr = Number(r[2] || 0);
        return { url: String(r[0]), detail: `${sp} spelling, ${gr} grammar` };
      });

      // Hard-to-read samples: lowest Flesch (densest) first. Detail carries
      // the neutral band label from the pure helper.
      const hrSamples = await db.execute({
        sql: `SELECT url, flesch_reading_ease FROM content_urls
              WHERE client_id = ? AND month = ?
                AND flesch_reading_ease IS NOT NULL AND flesch_reading_ease < ?
              ORDER BY flesch_reading_ease ASC, url LIMIT ?`,
        args: [clientId, contentMonth, HARD_TO_READ_FLESCH_THRESHOLD, SAMPLE_LIMIT],
      });
      response.content_quality.hard_to_read_samples = (hrSamples.rows as any[]).map(r => {
        const flesch = r[1] != null ? Number(r[1]) : null;
        const band = readabilityBand(flesch);
        return { url: String(r[0]), detail: band ? `reads ${band}` : 'low readability score' };
      });
    }

    return response;
  }
}
