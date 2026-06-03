// URL classifier for client-honest labeling.
//
// A crawler reports every URL on a site. A client thinks in terms of
// "pages" — content they intentionally published — and treats most
// other URLs as either invisible or "stuff the website does." The
// portal needs to:
//
//   1. Count pages the way clients name pages (handled in
//      crawl-stats.ts via the same patterns this module uses)
//   2. Still surface URLs with issues so nothing is hidden, but label
//      them honestly so an image URL is called an image, a tag
//      archive is called a tag archive, and only actual pages get
//      called pages
//
// This module is the single source of truth for "what kind of URL is
// this." Pattern set mirrors crawl-stats.ts deliberately so the page
// count Y in "X of your Y pages" and the per-URL classification in
// the popout always agree.
//
// Order of checks matters. URL-shape signals (path patterns) come
// first because they override content-type — a WP attachment page is
// HTML by content-type but should never be labeled "page." Then
// extension-based file-type detection. Then content-type. Then
// indexability flag for non-indexable HTML. Default to 'page' for
// indexable HTML that matched no exclusion.

export type UrlType =
  | 'page'
  | 'tag_archive'
  | 'category_archive'
  | 'author_archive'
  | 'date_archive'
  | 'pagination'
  | 'feed'
  | 'embed'
  | 'attachment'
  | 'wp_system'
  | 'cdn'
  | 'image'
  | 'pdf'
  | 'document'
  | 'comment_thread'
  | 'query_variant'
  | 'non_indexable'
  | 'redirect'
  | 'other';

export interface UrlClassification {
  type: UrlType;
  label: string;
  is_page: boolean;
  // True when an error/4xx on this URL is EXPECTED and benign, so it must not
  // be shown to a client as a broken link: Cloudflare email-protection
  // endpoints (/cdn-cgi/, routinely 4xx to crawlers) and non-fetchable schemes
  // (mailto:/tel:/javascript:/#). NOTE: this is URL-shape only. A
  // crawler-blocked external host (youtube/linkedin returning 403/999) is NOT
  // detectable from the string — use isCrawlerBlockedHost + isBotBlockStatus
  // against the destination host + status code for that case.
  is_expected: boolean;
}

// Plain-English labels. Lowercased except the leading word; meant to
// appear inline next to a URL ("Tag archive · /blog/tag/seo").
const TYPE_LABELS: Record<UrlType, string> = {
  page: 'Page',
  tag_archive: 'Tag archive',
  category_archive: 'Category archive',
  author_archive: 'Author archive',
  date_archive: 'Date archive',
  pagination: 'Pagination',
  feed: 'RSS feed',
  embed: 'Embed URL',
  attachment: 'Attachment',
  wp_system: 'WordPress system',
  cdn: 'CDN file',
  image: 'Image',
  pdf: 'PDF',
  document: 'Document',
  comment_thread: 'Comment thread',
  query_variant: 'URL variant',
  non_indexable: 'Non-indexable URL',
  redirect: 'Redirect',
  other: 'URL',
};

// Tail-of-path date archive: /YYYY/, /YYYY/MM/, /YYYY/MM/DD/
const DATE_ARCHIVE_RE = /\/\d{4}(\/\d{1,2})?(\/\d{1,2})?\/?$/;
// Pagination: /page/N/ anywhere in path
const PAGINATION_RE = /\/page\/\d+\/?$/i;
// Image / document extensions on the URL itself (path or query strip)
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|svg|avif|bmp|ico|tiff?)(?:$|[?#])/i;
const PDF_EXT_RE = /\.pdf(?:$|[?#])/i;
const DOC_EXT_RE = /\.(docx?|xlsx?|pptx?|csv|txt|rtf|odt|ods|odp)(?:$|[?#])/i;

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    // Relative URL or malformed — work with the raw string.
    return url.toLowerCase();
  }
}

function rawLower(url: string): string {
  return (url || '').toLowerCase();
}

export function classifyUrl(
  url: string,
  opts?: {
    contentType?: string | null;
    indexability?: string | null;
  },
): UrlClassification {
  if (!url) return { type: 'other', label: TYPE_LABELS.other, is_page: false, is_expected: false };

  // Non-fetchable schemes are not pages and not real broken links.
  if (/^(mailto|tel|javascript):/i.test(url) || url.trim() === '#') {
    return { type: 'other', label: 'Link', is_page: false, is_expected: true };
  }

  const path = pathOf(url);
  const lower = rawLower(url);
  const ct = (opts?.contentType || '').toLowerCase();
  const indexability = (opts?.indexability || '').toLowerCase();

  // 1. WordPress system + CDN paths. These are the bluntest exclusions
  // because no client lists /wp-content/ as a page.
  if (path.includes('/wp-content/') || path.includes('/wp-includes/')
      || path.includes('/wp-admin/') || path.includes('/wp-json/')) {
    return mk('wp_system');
  }
  if (path.includes('/cdn-cgi/')) return mk('cdn');

  // 2. CMS-auto-generated archive pages.
  if (path.includes('/tag/')) return mk('tag_archive');
  if (path.includes('/category/')) return mk('category_archive');
  if (path.includes('/author/')) return mk('author_archive');
  if (DATE_ARCHIVE_RE.test(path)) return mk('date_archive');

  // 3. Pagination + feeds + embeds + attachment HTML pages.
  if (PAGINATION_RE.test(path)) return mk('pagination');
  if (path.endsWith('/feed') || path.endsWith('/feed/') || path.includes('/feed/')) return mk('feed');
  if (path.endsWith('/embed') || path.endsWith('/embed/') || path.includes('/embed/')) return mk('embed');
  if (path.includes('/attachment/') || lower.includes('?attachment_id=') || lower.includes('?attachment=')) {
    return mk('attachment');
  }

  // 4. WordPress comment threads and raw query variants of canonical URLs.
  if (lower.includes('?replytocom=')) return mk('comment_thread');
  if (/[?&]p=\d/.test(lower) || /[?&]paged=\d/.test(lower)) return mk('query_variant');

  // 5. File-type detection from the URL itself. Honors extensions
  // even when the crawler row is missing content-type.
  if (IMAGE_EXT_RE.test(path)) return mk('image');
  if (PDF_EXT_RE.test(path)) return mk('pdf');
  if (DOC_EXT_RE.test(path)) return mk('document');

  // 6. Content-type fallback for cases where the URL has no extension
  // (clean URLs) but the crawler told us what was served.
  if (ct.startsWith('image/')) return mk('image');
  if (ct === 'application/pdf') return mk('pdf');
  if (ct.includes('msword') || ct.includes('officedocument') || ct.includes('opendocument')) {
    return mk('document');
  }

  // 7. HTML that the crawler flagged Non-Indexable (canonicalised
  // elsewhere, noindex, or blocked by robots.txt). It's a URL Google
  // explicitly ignores; calling it a page would mislead.
  if (indexability === 'non-indexable') return mk('non_indexable');

  // 8. Default: indexable HTML or unknown — treated as a page. This
  // covers the happy path: status 200, content-type text/html, no
  // utility-path match, indexable. The client would list this URL
  // when asked to list their pages.
  return mk('page');
}

function mk(type: UrlType): UrlClassification {
  // cdn = Cloudflare /cdn-cgi/ (email-protection etc.): present on every CF
  // site and routinely 4xx to crawlers, so an error there is expected/benign.
  return { type, label: TYPE_LABELS[type], is_page: type === 'page', is_expected: type === 'cdn' };
}

// External hosts that serve humans fine but block automated crawlers (return
// 403/429/503/999 to bots). A non-200 from one of these is almost always a
// bot block, not a dead link — so it must not be shown to a client as broken.
// Mirrors the social list in search.ts; kept here as the single source for the
// health/broken-link path.
export const CRAWLER_BLOCKING_DOMAINS = [
  'youtube.com', 'youtu.be', 'linkedin.com', 'facebook.com', 'instagram.com',
  'x.com', 'twitter.com', 'tiktok.com', 'pinterest.com',
];

export function isCrawlerBlockedHost(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  const h = hostname.replace(/^www\./, '').toLowerCase();
  return CRAWLER_BLOCKING_DOMAINS.some(d => h === d || h.endsWith('.' + d));
}

// Status codes a crawler-blocking host returns to bots (NOT a genuine 404 —
// a real youtube.com/watch?v=missing 404 is still worth flagging).
export function isBotBlockStatus(status: number | null | undefined): boolean {
  return status === 403 || status === 429 || status === 503 || status === 999;
}

// Convenience for code that needs the label for a known type without
// running the classifier (e.g., the popout renderer mapping over an
// already-classified URL list).
export function labelForType(type: UrlType): string {
  return TYPE_LABELS[type] || TYPE_LABELS.other;
}
