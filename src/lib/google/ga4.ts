// Google Analytics 4 Data API client — minimum surface for totals.
//
// One endpoint, one request shape, one response shape. We do not
// depend on the googleapis package; the HTTP we need is a single
// POST. Docs: https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport
//
// Why no dimensions: dimensional breakdowns (source/medium, channel
// grouping, landing page) multiply row count and have no home in
// the current product schema. Slice 18b writes TOTALS ONLY — one
// metric_snapshots row per metric per month. Cody can add
// dimensional queries as a later slice once the product has a
// place to render them.

import type { TrafficMetricKey } from '../traffic-metrics';

// Map from GA4 API metric names to our metric_key convention. Any
// future GA4 metric we add must be aliased here rather than used
// raw in the DB.
export const GA4_METRIC_MAP: ReadonlyArray<{ apiName: string; metricKey: TrafficMetricKey }> = [
  { apiName: 'sessions', metricKey: 'sessions' },
  { apiName: 'totalUsers', metricKey: 'users' },
  { apiName: 'screenPageViews', metricKey: 'page_views' },
  { apiName: 'engagedSessions', metricKey: 'engaged_sessions' },
  { apiName: 'engagementRate', metricKey: 'engagement_rate' },
];

export interface Ga4RunReportRequest {
  dateRanges: Array<{ startDate: string; endDate: string }>;
  metrics: Array<{ name: string }>;
  // Intentionally no dimensions — totals only.
}

export interface Ga4MetricValue {
  value: string;
}

export interface Ga4Row {
  dimensionValues?: Ga4MetricValue[];
  metricValues: Ga4MetricValue[];
}

export interface Ga4RunReportResponse {
  rows?: Ga4Row[];
  metricHeaders?: Array<{ name: string; type: string }>;
  rowCount?: number;
}

export interface Ga4Client {
  runReport(
    accessToken: string,
    propertyId: string,
    request: Ga4RunReportRequest
  ): Promise<Ga4RunReportResponse>;
}

// Builds the canonical request body for a totals-only pull. The
// metric order matches GA4_METRIC_MAP so the response row's
// metricValues[i] lines up with GA4_METRIC_MAP[i].metricKey.
export function buildGa4ReportRequest(
  startDate: string,
  endDate: string
): Ga4RunReportRequest {
  return {
    dateRanges: [{ startDate, endDate }],
    metrics: GA4_METRIC_MAP.map((m) => ({ name: m.apiName })),
  };
}

export const realGa4Client: Ga4Client = {
  async runReport(
    accessToken: string,
    propertyId: string,
    request: Ga4RunReportRequest
  ): Promise<Ga4RunReportResponse> {
    // property can be stored as a bare number or already prefixed.
    const propertyPath = propertyId.startsWith('properties/')
      ? propertyId
      : `properties/${propertyId}`;
    const url = `https://analyticsdata.googleapis.com/v1beta/${propertyPath}:runReport`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GA4 runReport ${res.status}: ${text.slice(0, 300)}`);
    }
    return JSON.parse(text);
  },
};

// --- Pure mapper from GA4 response → staged metric rows ---

export interface StagedGa4Metric {
  metric_key: TrafficMetricKey;
  metric_value: number;
}

// The API returns one row when we don't pass dimensions. Extract
// its metricValues[] array and line it up against GA4_METRIC_MAP.
// Empty response = zero metrics (not an error).
export function mapGa4ResponseToMetrics(
  response: Ga4RunReportResponse
): StagedGa4Metric[] {
  const rows = response.rows ?? [];
  if (rows.length === 0) return [];
  // Totals-only query → exactly one row. Anything more is a server
  // contract break; take the first and ignore the rest.
  const row = rows[0];
  const values = row.metricValues ?? [];
  const out: StagedGa4Metric[] = [];
  for (let i = 0; i < GA4_METRIC_MAP.length; i++) {
    const raw = values[i]?.value;
    if (raw == null) continue;
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) continue;
    out.push({
      metric_key: GA4_METRIC_MAP[i].metricKey,
      metric_value: numeric,
    });
  }
  return out;
}
