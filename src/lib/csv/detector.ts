import Papa from 'papaparse';

export type CsvFormat =
  | 'position_tracking'
  | 'issues_overview'
  | 'crawl_overview'
  | 'image_optimization'
  | 'keyword_research'
  | 'keyword_suggestions'
  | 'site_audit'
  | 'accessibility'
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
];

export function detectFormat(raw: string, filename: string): { format: CsvFormat; headers: string[] } {
  // Check for crawl_overview: starts with metadata like "Site Crawled,"
  const firstLine = raw.split('\n')[0].trim().toLowerCase();
  if (firstLine.startsWith('site crawled') || firstLine.startsWith('"site crawled')) {
    return { format: 'crawl_overview', headers: [] };
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
