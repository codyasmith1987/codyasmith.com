// Filename-based auto-tagging for client document uploads.
//
// Cody's end-of-month report files follow a regular convention, e.g.
//   ZKH-Performance-Summary-May9-Jun8-2026.docx
//   MVP-Site-Health-Report-MAY-2026-v2.docx
//   ZKH-MVP-MONTH-TWO-PERFORMANCE-SUMMARY-MAY-2026.docx
//   ZKH-California-Market-Entry-Advisory-April-2026.docx
//
// This module turns a filename into a best-guess { siteId, category, month }.
// The guess is a DEFAULT the admin can override in the upload UI — it is never
// authoritative. Pure (no I/O) so it is trivially unit-testable against the
// real filename corpus; the upload route passes the client's managed sites in.

export interface AutoTagSite {
  id: string;
  domain: string;
  /** Optional human label, e.g. "ZipKit Homes". Powers initials derivation. */
  label?: string | null;
  /** Optional explicit comma-separated short codes, e.g. "ZKH,ZipKit". */
  aliases?: string | null;
  is_primary?: boolean;
}

export interface AutoTagResult {
  /** Detected managed site, or null for engagement-level / ambiguous (matches
   *  more than one site, e.g. a combined "ZKH-MVP" report). */
  siteId: string | null;
  siteDomain: string | null;
  /** Detected file category key (see storage.FILE_CATEGORY_LABELS), or null. */
  category: string | null;
  /** Detected reporting period as YYYY-MM, or null. */
  month: string | null;
  /** Sites whose alias/label/domain matched the filename (for transparency). */
  matchedDomains: string[];
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

// Report-type detection. Order matters: more specific phrases first so
// "site health" wins before a bare "health" and "strategic recommendation"
// before a bare "strategic". Each entry maps a normalized substring to a
// category key from storage.FILE_CATEGORY_LABELS.
const CATEGORY_RULES: Array<{ needle: string; category: string }> = [
  { needle: 'performance summary', category: 'performance_summary' },
  { needle: 'site health', category: 'site_health_report' },
  { needle: 'strategic recommendation', category: 'strategic_recommendation' },
  { needle: 'strategic rec', category: 'strategic_recommendation' },
  { needle: 'advisory', category: 'advisory' },
  { needle: 'market entry', category: 'advisory' },
  { needle: 'swot', category: 'research' },
  { needle: 'analysis', category: 'research' },
  { needle: 'audit', category: 'research' },
  { needle: 'research', category: 'research' },
];

/** Strip the extension and a trailing version suffix like " (1)" or "-v2". */
function baseName(filename: string): string {
  const noPath = filename.split('/').pop()!.split('\\').pop()!;
  const noExt = noPath.replace(/\.[a-z0-9]{1,8}$/i, '');
  return noExt.replace(/[\s_-]*(\(\d+\)|v\d+)$/i, '').trim();
}

/** A filename normalized to lowercase with separators collapsed to spaces. */
function normalize(s: string): string {
  return s.replace(/[._\-/\\]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Initials of a multi-word / camelCase string: "ZipKit Homes" -> "ZKH". */
function initials(s: string): string {
  const words = s
    .replace(/\.[a-z]{2,}$/i, '') // drop a tld if a raw domain slipped in
    .replace(/([a-z])([A-Z])/g, '$1 $2') // split camelCase
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (words.length < 2) return '';
  return words.map(w => w[0]).join('').toLowerCase();
}

/** Domain root without tld: "mountainvalleyprefab.com" -> "mountainvalleyprefab". */
function domainRoot(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '').split('.')[0] || '';
}

// Build the set of lowercased tokens that should identify a given site in a
// filename: explicit aliases, the domain root, the full domain, the label, and
// initials derived from both label and domain root.
function siteTokens(site: AutoTagSite): Set<string> {
  const tokens = new Set<string>();
  const add = (t: string | undefined | null) => {
    const v = (t || '').trim().toLowerCase();
    if (v) tokens.add(v);
  };
  for (const a of (site.aliases || '').split(',')) add(a);
  add(domainRoot(site.domain));
  add(site.domain.toLowerCase().replace(/^www\./, ''));
  add(site.label || undefined);
  add(initials(site.label || ''));
  add(initials(domainRoot(site.domain)));
  return tokens;
}

function detectSite(normName: string, sites: AutoTagSite[]): { ids: string[]; domains: string[] } {
  // Word-boundary match so "mvp" matches "mvp site health" but "zkh" does not
  // match inside an unrelated word. Aliases/initials are short, so guard them.
  const haystack = ` ${normName} `;
  const ids: string[] = [];
  const domains: string[] = [];
  for (const site of sites) {
    let hit = false;
    for (const tok of siteTokens(site)) {
      if (!tok) continue;
      if (haystack.includes(` ${tok} `) || haystack.includes(` ${tok}-`) ||
          // domain root can appear glued to other chars (e.g. a folder name)
          (tok.length >= 5 && normName.includes(tok))) {
        hit = true;
        break;
      }
    }
    if (hit) { ids.push(site.id); domains.push(site.domain); }
  }
  return { ids, domains };
}

function detectCategory(normName: string): string | null {
  for (const rule of CATEGORY_RULES) {
    if (normName.includes(rule.needle)) return rule.category;
  }
  return null;
}

// Pick the reporting month as YYYY-MM. Strategy: find the LAST month-name in
// the filename (cycles like "May9-Jun8-2026" report on the closing month) and
// pair it with the 4-digit year present in the name.
function detectMonth(normName: string): string | null {
  // Use the LAST year occurrence so it pairs with the last month-name. Cycle
  // and comparison filenames ("...2025-vs-2026", "May9-Jun8-2026") report on
  // the closing period; taking the first year would misdate those.
  const yearMatches = [...normName.matchAll(/\b(20\d{2})\b/g)];
  if (yearMatches.length === 0) return null;
  const year = yearMatches[yearMatches.length - 1][1];
  const tokens = normName.split(' ');
  let lastMonth = 0;
  for (const t of tokens) {
    // A token may be "jun8" or "may9" — strip trailing digits before lookup.
    const word = t.replace(/\d+$/, '');
    if (MONTHS[word]) lastMonth = MONTHS[word];
  }
  if (!lastMonth) return null;
  return `${year}-${String(lastMonth).padStart(2, '0')}`;
}

export function detectFileTags(filename: string, sites: AutoTagSite[]): AutoTagResult {
  const normName = normalize(baseName(filename));
  const site = detectSite(normName, sites);
  // Exactly one site matched -> attribute to it. Zero or many (e.g. a combined
  // "ZKH-MVP" report) -> engagement-level (null), admin can refine.
  const single = site.ids.length === 1;
  return {
    siteId: single ? site.ids[0] : null,
    siteDomain: single ? site.domains[0] : null,
    category: detectCategory(normName),
    month: detectMonth(normName),
    matchedDomains: site.domains,
  };
}
