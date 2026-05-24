// Google Search Console CSV parsers.
//
// GSC exports come as a ZIP archive containing seven CSVs:
//
//   Pages.csv                — top landing pages (Top pages, Clicks, Impressions, CTR, Position)
//   Queries.csv              — top queries (Top queries, ..)
//   Countries.csv            — by country (Country, ..)
//   Devices.csv              — by device (Device, ..)
//   Search appearance.csv    — by search appearance (Search Appearance, ..)
//   Chart.csv                — time-series by day (Date, ..)
//   Filters.csv              — export metadata (Filter, Value)
//
// All five dimension files share the same column shape, so they
// land in one gsc_dimensions table with a dimension_type tag.
// Chart.csv has its own table for the time-series. Filters.csv
// captures metadata so the dashboard can show "Last 6 months, web
// search" alongside the numbers.
//
// Detection happens upstream in detector.ts via filename match.
// CTR comes in as a string like "4.59%" — parsed to a 0..1 float
// so the portal can render with its own formatter.

import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import turso from '../../turso';

function parseCtrPercent(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = String(raw).replace('%', '').trim();
  if (!s) return null;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

function parseInt0(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = String(raw).replace(/,/g, '').trim();
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function parseFloat0(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = String(raw).replace(/,/g, '').trim();
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Batch size for parallel INSERTs. Tuned to keep Turso happy without
// blowing the per-file ingest budget on a Cloudflare-fronted POST.
// 50 mirrors the crawl_internal parser, which has shipped fine for
// 5000+ row SF crawls.
const INSERT_BATCH = 50;

// Run INSERTs in parallel chunks. One Promise.all per chunk so a
// single failure rejects fast rather than the for-loop swallowing
// hundreds of round-trips one at a time.
async function bulkInsert(sql: string, allArgs: any[][]) {
  for (let i = 0; i < allArgs.length; i += INSERT_BATCH) {
    const chunk = allArgs.slice(i, i + INSERT_BATCH);
    await Promise.all(chunk.map(args => turso.execute({ sql, args })));
  }
}

// Dimension files all share the same shape. The first column header
// tells us the dimension type (Top pages vs Top queries vs Country
// vs Device vs Search Appearance). Pass the dimension_type in
// explicitly from the dispatcher so we don't have to re-derive it
// from the header.
async function parseDimensionFile(
  raw: string,
  clientId: string,
  month: string,
  uploadId: string,
  dimensionType: string,
): Promise<number> {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true });
  const sql = `INSERT INTO gsc_dimensions
                 (id, client_id, csv_upload_id, month, dimension_type, dimension_value,
                  clicks, impressions, ctr, position)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const inserts: any[][] = [];
  for (const row of result.data as any[]) {
    // First column varies by file (Top pages / Top queries / Country
    // / Device / Search Appearance) — grab whichever is present.
    const dimValue = row['Top pages'] || row['Top queries'] || row['Country']
                  || row['Device'] || row['Search Appearance']
                  || row['Page'] || row['Query']
                  || Object.values(row)[0];
    if (!dimValue) continue;
    inserts.push([
      nanoid(), clientId, uploadId, month, dimensionType, String(dimValue),
      parseInt0(row['Clicks']),
      parseInt0(row['Impressions']),
      parseCtrPercent(row['CTR']),
      parseFloat0(row['Position']),
    ]);
  }
  await bulkInsert(sql, inserts);
  return inserts.length;
}

export async function parseGscPages(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  return parseDimensionFile(raw, clientId, month, uploadId, 'page');
}
export async function parseGscQueries(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  return parseDimensionFile(raw, clientId, month, uploadId, 'query');
}
export async function parseGscCountries(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  return parseDimensionFile(raw, clientId, month, uploadId, 'country');
}
export async function parseGscDevices(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  return parseDimensionFile(raw, clientId, month, uploadId, 'device');
}
export async function parseGscSearchAppearance(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  return parseDimensionFile(raw, clientId, month, uploadId, 'search_appearance');
}

// Chart.csv — Date, Clicks, Impressions, CTR, Position. One row per
// day in the export window. Six months of daily data is ~180 rows;
// batched insert keeps the whole file under a second.
export async function parseGscChart(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true });
  const sql = `INSERT INTO gsc_chart
                 (id, client_id, csv_upload_id, month, date,
                  clicks, impressions, ctr, position)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const inserts: any[][] = [];
  for (const row of result.data as any[]) {
    const date = row['Date']?.toString().trim();
    if (!date) continue;
    inserts.push([
      nanoid(), clientId, uploadId, month, date,
      parseInt0(row['Clicks']),
      parseInt0(row['Impressions']),
      parseCtrPercent(row['CTR']),
      parseFloat0(row['Position']),
    ]);
  }
  await bulkInsert(sql, inserts);
  return inserts.length;
}

// Filters.csv — Filter, Value. Small metadata table.
export async function parseGscFilters(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true });
  let count = 0;
  for (const row of result.data as any[]) {
    const key = row['Filter']?.toString().trim();
    if (!key) continue;
    await turso.execute({
      sql: `INSERT INTO gsc_filters
              (id, client_id, csv_upload_id, month, filter_key, filter_value)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        nanoid(), clientId, uploadId, month, key,
        row['Value']?.toString().trim() || null,
      ],
    });
    count++;
  }
  return count;
}

// Top-level dispatcher used by the ingest pipeline.
export async function parseGsc(
  raw: string,
  clientId: string,
  month: string,
  uploadId: string,
  gscKind: string,
): Promise<number> {
  switch (gscKind) {
    case 'gsc_pages':             return parseGscPages(raw, clientId, month, uploadId);
    case 'gsc_queries':           return parseGscQueries(raw, clientId, month, uploadId);
    case 'gsc_countries':         return parseGscCountries(raw, clientId, month, uploadId);
    case 'gsc_devices':           return parseGscDevices(raw, clientId, month, uploadId);
    case 'gsc_search_appearance': return parseGscSearchAppearance(raw, clientId, month, uploadId);
    case 'gsc_chart':             return parseGscChart(raw, clientId, month, uploadId);
    case 'gsc_filters':           return parseGscFilters(raw, clientId, month, uploadId);
    default: return 0;
  }
}
