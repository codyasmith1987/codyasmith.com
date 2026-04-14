// Google Search Console API client — the three endpoints we need.
//
// Hand-rolled against the REST surface to avoid pulling in
// googleapis. All methods accept the caller-provided access token
// so the connection management stays separate from the API calls.
//
// API docs:
//   https://developers.google.com/webmaster-tools/v1/searchanalytics/query
//   https://developers.google.com/webmaster-tools/v1/sites/list

const SITES_LIST_URL = 'https://www.googleapis.com/webmasters/v3/sites';

export interface GscSite {
  siteUrl: string;
  permissionLevel: string; // 'siteOwner' | 'siteFullUser' | 'siteRestrictedUser' | 'siteUnverifiedUser'
}

export interface GscClient {
  listSites(accessToken: string): Promise<GscSite[]>;
  querySearchAnalytics(
    accessToken: string,
    siteUrl: string,
    request: SearchAnalyticsRequest
  ): Promise<SearchAnalyticsResponse>;
}

export interface SearchAnalyticsRequest {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  dimensions?: Array<'query' | 'page' | 'country' | 'device' | 'searchAppearance' | 'date'>;
  rowLimit?: number;
  startRow?: number;
  searchType?: 'web' | 'image' | 'video';
}

export interface SearchAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchAnalyticsResponse {
  rows?: SearchAnalyticsRow[];
  responseAggregationType?: string;
}

// The real client. Exported as a default instance; the sync handler
// can swap this for a fake in tests.
export const realGscClient: GscClient = {
  async listSites(accessToken: string): Promise<GscSite[]> {
    const res = await fetch(SITES_LIST_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GSC sites.list ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = JSON.parse(text);
    if (!Array.isArray(json.siteEntry)) return [];
    return json.siteEntry.map((s: any) => ({
      siteUrl: s.siteUrl as string,
      permissionLevel: s.permissionLevel as string,
    }));
  },

  async querySearchAnalytics(
    accessToken: string,
    siteUrl: string,
    request: SearchAnalyticsRequest
  ): Promise<SearchAnalyticsResponse> {
    const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GSC searchAnalytics.query ${res.status}: ${text.slice(0, 200)}`);
    }
    return JSON.parse(text);
  },
};

// --- Pure mapper from GSC response to staged keyword snapshot rows ---

export interface StagedGscKeyword {
  keyword: string;
  url: string | null;
  position: number | null;
  search_volume: number | null;
  change_val: number | null;
  seo_difficulty: number | null;
}

// Converts a searchAnalytics response into the shape our
// keyword_snapshots table expects. The request must be configured
// with dimensions = ['query', 'page'] so rows[i].keys[0] = query and
// rows[i].keys[1] = page.
export function mapGscResponseToKeywords(
  response: SearchAnalyticsResponse
): StagedGscKeyword[] {
  const rows = response.rows ?? [];
  const out: StagedGscKeyword[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!Array.isArray(row.keys) || row.keys.length < 1) continue;
    const keyword = row.keys[0];
    const url = row.keys[1] ?? null;
    if (!keyword) continue;
    // Dedupe on (keyword, url) — GSC can return the same pair if
    // dimensions include both.
    const dedupeKey = `${keyword}\n${url ?? ''}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      keyword,
      url,
      position:
        typeof row.position === 'number' && Number.isFinite(row.position)
          ? Math.round(row.position)
          : null,
      search_volume: null,
      change_val: null,
      seo_difficulty: null,
    });
  }
  return out;
}

// Helper — maps 'YYYY-MM' to {startDate, endDate} YYYY-MM-DD pair
// covering the full calendar month.
export function monthToRange(month: string): { startDate: string; endDate: string } {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) throw new Error(`invalid month: ${month}`);
  const startDate = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const endDate = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { startDate, endDate };
}
