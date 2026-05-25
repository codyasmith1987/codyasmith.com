// Cloudflare GraphQL Analytics API client.
//
// One small wrapper around fetch() for the two queries we care about
// in v1 of /portal/security:
//
//   - httpRequests1dGroups: daily traffic + threats aggregates
//     (requests, cached_requests, bytes, cached_bytes, threats,
//     pageViews).
//   - firewallEventsAdaptiveGroups: firewall actions per day
//     (block / challenge / managed_challenge / js_challenge / log /
//     rate_limit counts).
//
// Token scope expected: "Zone Analytics:Read" on the specific zone.
// If the token is broader it still works; if it's too narrow we get
// a 403 and surface that as a clear error.
//
// The sync endpoint composes these into per-day rows in
// cloudflare_traffic_daily / cloudflare_security_daily. Bot
// management + AI Crawl Control queries land in a v2 of this file.

const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';

export interface DailyTraffic {
  date: string;          // YYYY-MM-DD
  requests: number;
  cachedRequests: number;
  bytes: number;
  cachedBytes: number;
  threats: number;
  pageViews: number;
}

export interface DailySecurityEvents {
  date: string;
  total: number;
  block: number;
  challenge: number;
  managedChallenge: number;
  jsChallenge: number;
  log: number;
  rateLimit: number;
}

export interface CloudflareError {
  message: string;
  // Cloudflare returns array of errors on auth/permission failures.
  // We collapse to a single string for the API response.
  detail?: string;
}

async function callGraphQL(token: string, query: string, variables: any): Promise<any> {
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw {
      message: `Cloudflare API ${res.status}`,
      detail: JSON.stringify(json).slice(0, 500),
    } as CloudflareError;
  }
  if (json.errors && json.errors.length > 0) {
    throw {
      message: 'Cloudflare GraphQL returned errors',
      detail: json.errors.map((e: any) => e.message).join('; ').slice(0, 500),
    } as CloudflareError;
  }
  return json.data;
}

// Daily HTTP request aggregates. Returns one DailyTraffic per day
// in the window. Maxes out at ~60 days per call (CF's limit) which
// is enough for our typical 30-day reporting window plus a month
// of comparison period.
export async function fetchTrafficDaily(
  token: string,
  zoneId: string,
  sinceDate: string,    // YYYY-MM-DD inclusive
  untilDate: string,    // YYYY-MM-DD inclusive
): Promise<DailyTraffic[]> {
  // CF Free plan caps httpRequestsAdaptiveGroups queries at a 1-day
  // window. To get N days, loop N times in parallel. Each per-day
  // query returns a single aggregate row.
  // Schema constraints on Free plan: confirmed-working fields are
  // count (top-level), sum.edgeResponseBytes, sum.visits. Cached
  // metrics and threats aren't exposed here; threats live in the
  // firewall query, cache hit rate widgets need to handle 0.
  const dates = expandDateRange(sinceDate, untilDate);
  const perDayQuery = `
    query TrafficOneDay($zoneId: String!, $date: String!) {
      viewer {
        zones(filter: { zoneTag: $zoneId }) {
          httpRequestsAdaptiveGroups(
            limit: 1
            filter: { date_geq: $date, date_leq: $date }
          ) {
            count
            sum {
              edgeResponseBytes
              visits
            }
          }
        }
      }
    }
  `;
  const results = await Promise.all(dates.map(async date => {
    try {
      const data = await callGraphQL(token, perDayQuery, { zoneId, date });
      const groups = data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups || [];
      const g = groups[0] || {};
      return {
        date,
        requests: Number(g.count) || 0,
        cachedRequests: 0,
        bytes: Number(g.sum?.edgeResponseBytes) || 0,
        cachedBytes: 0,
        threats: 0,
        pageViews: Number(g.sum?.visits) || 0,
      };
    } catch (err) {
      // One bad day shouldn't kill the whole sync. Return a zero
      // row and let the rest accumulate.
      return {
        date, requests: 0, cachedRequests: 0,
        bytes: 0, cachedBytes: 0, threats: 0, pageViews: 0,
      };
    }
  }));
  return results;
}

// Generate every YYYY-MM-DD between two inclusive dates.
function expandDateRange(since: string, until: string): string[] {
  const out: string[] = [];
  const start = new Date(since + 'T00:00:00Z');
  const end = new Date(until + 'T00:00:00Z');
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Firewall events per day, broken out by action. CF's
// firewallEventsAdaptiveGroups is rolled up by datetimeHour so we
// fetch hourly buckets and aggregate to daily on our side. The
// hourly granularity also lets us inspect specific attack windows
// later (the April 19 brute force activity Cody references) without
// a separate query — the sync just stores the daily total for now.
export async function fetchSecurityDaily(
  token: string,
  zoneId: string,
  sinceISO: string,    // ISO 8601 datetime inclusive
  untilISO: string,    // ISO 8601 datetime inclusive
): Promise<DailySecurityEvents[]> {
  const query = `
    query Security($zoneId: String!, $since: Time!, $until: Time!) {
      viewer {
        zones(filter: { zoneTag: $zoneId }) {
          firewallEventsAdaptiveGroups(
            limit: 10000
            filter: { datetime_geq: $since, datetime_leq: $until }
            orderBy: [datetime_ASC]
          ) {
            count
            dimensions {
              date: datetime
              action
            }
          }
        }
      }
    }
  `;
  const data = await callGraphQL(token, query, { zoneId, since: sinceISO, until: untilISO });
  const rows = data?.viewer?.zones?.[0]?.firewallEventsAdaptiveGroups || [];

  // Aggregate by day-of-datetime + action. CF returns one row per
  // unique (datetime-bucket, action) tuple; collapse to per-day
  // counts with each action's tally as a separate field.
  const byDate: Record<string, DailySecurityEvents> = {};
  for (const r of rows) {
    const dt = r.dimensions?.date || '';
    const day = dt.slice(0, 10); // YYYY-MM-DD
    if (!day) continue;
    const action = String(r.dimensions?.action || '').toLowerCase();
    const count = Number(r.count) || 0;
    if (!byDate[day]) {
      byDate[day] = {
        date: day, total: 0,
        block: 0, challenge: 0, managedChallenge: 0,
        jsChallenge: 0, log: 0, rateLimit: 0,
      };
    }
    byDate[day].total += count;
    if (action === 'block') byDate[day].block += count;
    else if (action === 'challenge') byDate[day].challenge += count;
    else if (action === 'managed_challenge') byDate[day].managedChallenge += count;
    else if (action === 'jschallenge' || action === 'js_challenge') byDate[day].jsChallenge += count;
    else if (action === 'log') byDate[day].log += count;
    else if (action === 'rate_limit' || action === 'rate_limited') byDate[day].rateLimit += count;
  }
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

export interface CloudflareZone {
  id: string;
  name: string;        // e.g. "zipkithomes.com"
  account_id: string;
  account_name: string;
}

// List every zone the token can see. Used by the account-level
// auto-link flow: given an account-scoped token (Zone:Analytics:Read
// across the account), enumerate zones once, then resolve each
// client_sites row's hostname against the list to fill in zone IDs.
//
// Pagination: CF returns 50 zones per page by default. Capped at
// 1000 zones (20 pages); anyone exceeding that has a different
// problem than wiring analytics here.
export async function listZones(token: string): Promise<CloudflareZone[]> {
  const zones: CloudflareZone[] = [];
  const perPage = 50;
  const maxPages = 20;
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.cloudflare.com/client/v4/zones?page=${page}&per_page=${perPage}`;
    // 10s timeout per page so we fail fast instead of hanging the
    // whole endpoint when CF API is unresponsive.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err?.name === 'AbortError') {
        throw {
          message: `Cloudflare /zones page ${page} timed out after 10s`,
          detail: 'AbortController timeout fired',
        } as CloudflareError;
      }
      throw {
        message: `Cloudflare /zones page ${page} fetch failed`,
        detail: String(err?.message || err).slice(0, 500),
      } as CloudflareError;
    }
    clearTimeout(timeoutId);
    const body = await res.json();
    if (!res.ok || !body?.success) {
      throw {
        message: `Cloudflare zones API ${res.status}`,
        detail: JSON.stringify(body?.errors || body).slice(0, 500),
      } as CloudflareError;
    }
    for (const z of body.result || []) {
      zones.push({
        id: String(z.id || ''),
        name: String(z.name || ''),
        account_id: String(z.account?.id || ''),
        account_name: String(z.account?.name || ''),
      });
    }
    const totalCount = Number(body.result_info?.total_count || 0);
    if (page * perPage >= totalCount) break;
  }
  return zones;
}

// Smoke test: hit a tiny query to validate the token + zone work.
// Used by the settings UI to give immediate feedback when the admin
// pastes credentials.
export async function testCredentials(token: string, zoneId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const query = `
      query Test($zoneId: String!) {
        viewer {
          zones(filter: { zoneTag: $zoneId }) {
            zoneTag
          }
        }
      }
    `;
    const data = await callGraphQL(token, query, { zoneId });
    const zones = data?.viewer?.zones || [];
    if (zones.length === 0) {
      return { ok: false, error: 'Zone not found or token lacks access to this zone.' };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.detail || err?.message || 'Unknown error' };
  }
}
