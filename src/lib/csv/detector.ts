import Papa from 'papaparse';

export type CsvFormat =
  | 'position_tracking'
  | 'issues_overview'
  | 'crawl_overview'
  | 'crawl_internal'
  | 'redirects'
  | 'images'
  | 'image_optimization'
  | 'keyword_research'
  | 'keyword_suggestions'
  | 'site_audit'
  | 'accessibility'
  | 'content_urls'
  | 'security_urls'
  | 'structured_data_urls'
  | 'issue_urls'
  // 'unknown' is still emitted by detectFormat for files that don't
  // match a signature; the ingest pipeline routes those to the raw
  // fallback and updates the upload row to 'unknown_stored' so
  // anything visible in the DB is post-routing.
  | 'unknown_stored'
  | 'unknown';

interface FormatSignature {
  format: CsvFormat;
  requiredColumns: string[];
}

const SIGNATURES: FormatSignature[] = [
  {
    format: 'position_tracking',
    requiredColumns: ['position', 'keyword', 'search volume', 'url', 'location'],
  },
  {
    format: 'issues_overview',
    requiredColumns: ['issue name', 'issue type', 'issue priority', 'urls', '% of total'],
  },
  {
    format: 'image_optimization',
    requiredColumns: ['original size', 'lossless size', 'percent improvement'],
  },
  {
    format: 'keyword_research',
    requiredColumns: ['keywords', 'volume', 'position', 'est. visits', 'ranking url'],
  },
  {
    format: 'keyword_suggestions',
    requiredColumns: ['keyword', 'search intent', 'search volume', 'cpc', 'seo difficulty'],
  },
  {
    format: 'accessibility',
    requiredColumns: ['address', 'wcag 2.0 a violations'],
  },
  {
    // Screaming Frog Internal HTML export. Per-URL crawl data: one
    // row per crawled page. Detect by the SF-specific combination of
    // Address + Status Code + Indexability + Title 1 (the four
    // columns that are always present in the Internal HTML export
    // and not present together in any other SF report we parse).
    format: 'crawl_internal',
    requiredColumns: ['address', 'status code', 'indexability', 'title 1'],
  },
  {
    // Screaming Frog Redirects bulk export. Has the chain-specific
    // column set: Chain Type + Number of Redirects + Source + Final
    // Address.
    format: 'redirects',
    requiredColumns: ['chain type', 'number of redirects', 'source', 'final address'],
  },
  {
    // Screaming Frog Images bulk export (images_all.csv). Detect by
    // the image-specific column combination: Address + Content Type
    // + Size (Bytes) + IMG Inlinks + Dimensions.
    format: 'images',
    requiredColumns: ['address', 'content type', 'size (bytes)', 'img inlinks', 'dimensions'],
  },
  {
    // Screaming Frog content_all.csv. Per-URL readability data.
    // The flesch + word/sentence count combination is unique to this
    // export among the per-URL SF reports we parse.
    format: 'content_urls',
    requiredColumns: ['address', 'word count', 'sentence count', 'flesch reading ease score'],
  },
  {
    // Screaming Frog security_all.csv. Per-URL HTTP + security
    // posture. HTTP Version is unique to this report among the
    // address-headed SF exports.
    format: 'security_urls',
    requiredColumns: ['address', 'content type', 'status code', 'http version', 'indexability'],
  },
  {
    // Screaming Frog structured_data_all.csv. Per-URL schema markup
    // quality. Rich Result Errors + Total Types is the unique
    // fingerprint.
    format: 'structured_data_urls',
    requiredColumns: ['address', 'errors', 'warnings', 'rich result errors', 'total types'],
  },
];

export function detectFormat(raw: string, filename: string): { format: CsvFormat; headers: string[] } {
  // Check for crawl_overview: starts with metadata like "Site Crawled,"
  const firstLine = raw.split('\n')[0].trim().toLowerCase();
  if (firstLine.startsWith('site crawled') || firstLine.startsWith('"site crawled')) {
    return { format: 'crawl_overview', headers: [] };
  }

  // Per-issue URL exports from Screaming Frog. The filename matches a
  // known per-issue CSV (h1_missing.csv, page_titles_below_30_characters.csv,
  // etc.); each file lists the URLs that have that issue, with the URL
  // in the first column "Address." Caught BEFORE the site_audit
  // fallback so these route to the dedicated issue-urls parser that
  // populates site_issue_urls (and therefore the per-issue pop-out on
  // the health page).
  const normalizedName = filename.toLowerCase().replace(/^.*[\\/]/, '');
  // Match on the known map (imported lazily to avoid a circular
  // dependency on the parser). The shape is { filename: issue_name }.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ISSUE_CSV_FILENAME_MAP } = require('./parsers/issue-urls');
  if (ISSUE_CSV_FILENAME_MAP[normalizedName]) {
    return { format: 'issue_urls', headers: [] };
  }

  // Try to parse first few rows to get headers
  const preview = Papa.parse(raw, { preview: 3, header: false, skipEmptyLines: true });
  if (!preview.data || preview.data.length === 0 || (preview.errors && preview.errors.length > 0 && preview.data.length < 2)) {
    return { format: 'unknown', headers: [] };
  }

  const headers = (preview.data[0] as string[]).map(h => h?.trim().toLowerCase() || '');

  // Check each signature
  for (const sig of SIGNATURES) {
    const allMatch = sig.requiredColumns.every(req =>
      headers.some(h => h === req)
    );
    if (allMatch) {
      return { format: sig.format, headers };
    }
  }

  // Heuristic for site audit sub-reports: first column is "url"
  if (headers[0] === 'url') {
    return { format: 'site_audit', headers };
  }

  // Screaming Frog / audit sub-reports: have "source" + "destination" columns
  if (headers.includes('source') && headers.includes('destination')) {
    return { format: 'site_audit', headers };
  }

  // Screaming Frog link reports: have "type", "source", "anchor", etc.
  if (headers.includes('type') && headers.includes('source') && headers.includes('status code')) {
    return { format: 'site_audit', headers };
  }

  // Check filename hints for site audit
  const lowerName = filename.toLowerCase();
  if (lowerName.includes('broken_link') || lowerName.includes('low_word') ||
      lowerName.includes('no_meta') || lowerName.includes('title_tag') ||
      lowerName.includes('response_code') || lowerName.includes('images_') ||
      lowerName.includes('_inlinks') || lowerName.includes('outlinks') ||
      lowerName.includes('anchor_text')) {
    return { format: 'site_audit', headers };
  }

  return { format: 'unknown', headers };
}
