// Google Analytics 4 CSV parsers.
//
// GA4 exports have a consistent header shape:
//
//   # ----------------------------------------
//   # <Report name>
//   # Account: <Account>
//   # Property: <Property> - GA4
//   # ----------------------------------------
//
// Followed by one or more "blocks" — each block has its own column
// header line and zero or more data rows. Multi-block files (Reports
// snapshot, Tech overview) use blank lines + `# Start date:` markers
// to separate blocks. Single-table files (Traffic acquisition,
// Pages and screens, Demographic details) have one block after the
// header.
//
// Detection happens upstream in detector.ts via filename match
// (Reports_snapshot, Traffic_acquisition, Pages_and_screens or
// Landing_page, Tech_overview, Demographic_details). The dispatch
// here picks the right block reader per file type and writes to the
// matching ga4_* table.
//
// Field name normalization: GA4 column headers vary (e.g., "Average
// engagement time per active user" vs "Average engagement time per
// session"). The parsers match by leading substring (case-insensitive)
// rather than exact equality, so minor column-order changes between
// GA4 versions don't break ingestion.

import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import turso from '../../turso';

interface Block {
  startDate: string | null;
  endDate: string | null;
  headers: string[];
  rows: string[][];
}

// AI referral source patterns — used by the dashboard endpoint, kept
// here so the regex stays next to the data it's derived from.
export const AI_REFERRAL_PATTERNS = [
  /^chatgpt\.com\b/i,
  /^perplexity\b/i,
  /^claude\.ai\b/i,
  /^copilot(\.|\b)/i,
  /^gemini\b/i,
];

// Split a GA4 file into blocks. Each block begins after a
// `# Start date:` comment line and ends at the next one (or EOF).
// The first non-comment, non-empty line in each block is the column
// header; subsequent non-empty non-comment lines are data rows.
function splitIntoBlocks(raw: string): Block[] {
  const lines = raw.split(/\r?\n/);
  const blocks: Block[] = [];
  let current: Block | null = null;
  let pendingStart: string | null = null;
  let pendingEnd: string | null = null;
  let inHeader = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Date markers carry into the next block's metadata.
    const startMatch = trimmed.match(/^#\s*Start date:\s*(\d+)/i);
    if (startMatch) {
      pendingStart = startMatch[1];
      // Close the active block before starting a new one.
      if (current && current.headers.length > 0) {
        blocks.push(current);
      }
      current = null;
      inHeader = false;
      continue;
    }
    const endMatch = trimmed.match(/^#\s*End date:\s*(\d+)/i);
    if (endMatch) {
      pendingEnd = endMatch[1];
      continue;
    }
    // Skip all other comment lines + blank lines.
    if (trimmed.startsWith('#') || trimmed === '') continue;

    // First non-comment line after a Start date marker → block header.
    if (!current) {
      const parsedHeader = Papa.parse(line, { header: false });
      const headerRow = (parsedHeader.data[0] as string[]) || [];
      current = {
        startDate: pendingStart,
        endDate: pendingEnd,
        headers: headerRow.map(h => (h || '').trim()),
        rows: [],
      };
      inHeader = true;
      continue;
    }

    // Data rows after the header.
    const parsedRow = Papa.parse(line, { header: false });
    const dataRow = (parsedRow.data[0] as string[]) || [];
    current.rows.push(dataRow);
  }
  if (current && current.headers.length > 0) {
    blocks.push(current);
  }
  return blocks;
}

// Header-index lookup tolerant of trailing modifiers GA4 adds on
// some exports ("Sessions" vs "Sessions per active user").
function headerIndex(headers: string[], wanted: string): number {
  const w = wanted.toLowerCase().trim();
  for (let i = 0; i < headers.length; i++) {
    if ((headers[i] || '').toLowerCase().trim() === w) return i;
  }
  return -1;
}

function intCell(row: string[], idx: number): number | null {
  if (idx < 0 || idx >= row.length) return null;
  const s = (row[idx] || '').toString().replace(/,/g, '').trim();
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function floatCell(row: string[], idx: number): number | null {
  if (idx < 0 || idx >= row.length) return null;
  const s = (row[idx] || '').toString().replace(/,/g, '').trim();
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function textCell(row: string[], idx: number): string | null {
  if (idx < 0 || idx >= row.length) return null;
  const s = (row[idx] || '').toString().trim();
  return s || null;
}

// --------- Reports snapshot ---------
//
// Five blocks total:
//   1. Topline (Active users, New users, Average engagement time per active user, Sessions)
//   2. Session source / medium (Sessions, Key events, Total revenue)
//   3. First user source / medium (Active users)
//   4. Session source / medium (Sessions only — duplicate of block 2 with fewer columns, skipped)
//   5. Session Google Ads campaign (Sessions)
//
// Match by header signature, not block order, so the parser keeps
// working if GA4 changes the export order in a future version.
export async function parseReportsSnapshot(
  raw: string,
  clientId: string,
  month: string,
  uploadId: string,
): Promise<number> {
  const blocks = splitIntoBlocks(raw);
  let rowCount = 0;

  for (const block of blocks) {
    const h = block.headers.map(s => s.toLowerCase());

    // Topline: starts with Active users.
    if (h[0] === 'active users' && h.includes('sessions')) {
      const iActive = headerIndex(block.headers, 'Active users');
      const iNew = headerIndex(block.headers, 'New users');
      const iAvgTime = block.headers.findIndex(s => s.toLowerCase().startsWith('average engagement time per active user'));
      const iSessions = headerIndex(block.headers, 'Sessions');
      for (const row of block.rows) {
        await turso.execute({
          sql: `INSERT INTO ga4_topline
                  (id, client_id, csv_upload_id, month, start_date, end_date,
                   active_users, new_users, sessions, avg_engagement_time_per_active_user)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            nanoid(), clientId, uploadId, month,
            block.startDate, block.endDate,
            intCell(row, iActive), intCell(row, iNew), intCell(row, iSessions),
            floatCell(row, iAvgTime),
          ],
        });
        rowCount++;
      }
      continue;
    }

    // Session source/medium with key events: 4-column block.
    if (h[0] === 'session source / medium' && h.includes('key events')) {
      const iSm = 0;
      const iSessions = headerIndex(block.headers, 'Sessions');
      const iKeyEvents = headerIndex(block.headers, 'Key events');
      const iRev = headerIndex(block.headers, 'Total revenue');
      for (const row of block.rows) {
        const sm = textCell(row, iSm);
        if (!sm) continue;
        await turso.execute({
          sql: `INSERT INTO ga4_source_medium
                  (id, client_id, csv_upload_id, month, kind, source_medium,
                   sessions, key_events, total_revenue)
                VALUES (?, ?, ?, ?, 'session', ?, ?, ?, ?)`,
          args: [
            nanoid(), clientId, uploadId, month,
            sm, intCell(row, iSessions), intCell(row, iKeyEvents), floatCell(row, iRev),
          ],
        });
        rowCount++;
      }
      continue;
    }

    // First user source/medium: source_medium + active_users only.
    if (h[0] === 'first user source / medium' && h.includes('active users')) {
      const iSm = 0;
      const iActive = headerIndex(block.headers, 'Active users');
      for (const row of block.rows) {
        const sm = textCell(row, iSm);
        if (!sm) continue;
        await turso.execute({
          sql: `INSERT INTO ga4_source_medium
                  (id, client_id, csv_upload_id, month, kind, source_medium, active_users)
                VALUES (?, ?, ?, ?, 'first_user', ?, ?)`,
          args: [nanoid(), clientId, uploadId, month, sm, intCell(row, iActive)],
        });
        rowCount++;
      }
      continue;
    }

    // Google Ads campaigns: 2-column block.
    if (h[0] === 'session google ads campaign') {
      const iCamp = 0;
      const iSessions = headerIndex(block.headers, 'Sessions');
      for (const row of block.rows) {
        const camp = textCell(row, iCamp);
        if (!camp) continue;
        await turso.execute({
          sql: `INSERT INTO ga4_campaigns
                  (id, client_id, csv_upload_id, month, campaign_name, sessions)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [nanoid(), clientId, uploadId, month, camp, intCell(row, iSessions)],
        });
        rowCount++;
      }
      continue;
    }

    // Session source/medium (sessions only — block 4). Skipped to
    // avoid duplicating block 2's rows with less data.
  }

  return rowCount;
}

// --------- Traffic acquisition ---------
//
// Single block. The first column is "Session primary channel group"
// (or close variants on different GA4 versions); subsequent columns
// are the canonical traffic-acquisition metrics.
export async function parseTrafficAcquisition(
  raw: string,
  clientId: string,
  month: string,
  uploadId: string,
): Promise<number> {
  const blocks = splitIntoBlocks(raw);
  let rowCount = 0;
  for (const block of blocks) {
    if (block.headers.length < 2) continue;
    const iChannel = 0;
    const iSessions = headerIndex(block.headers, 'Sessions');
    const iEngaged = headerIndex(block.headers, 'Engaged sessions');
    const iEngRate = headerIndex(block.headers, 'Engagement rate');
    const iAvgTime = block.headers.findIndex(s => s.toLowerCase().startsWith('average engagement time per session'));
    const iEventsPerSession = block.headers.findIndex(s => s.toLowerCase().startsWith('events per session'));
    const iEventCount = headerIndex(block.headers, 'Event count');
    const iKeyEvents = headerIndex(block.headers, 'Key events');
    const iKeyEventRate = block.headers.findIndex(s => s.toLowerCase().startsWith('session key event rate'));
    const iRev = headerIndex(block.headers, 'Total revenue');

    for (const row of block.rows) {
      const channel = textCell(row, iChannel);
      if (!channel) continue;
      await turso.execute({
        sql: `INSERT INTO ga4_channels
                (id, client_id, csv_upload_id, month, channel,
                 sessions, engaged_sessions, engagement_rate,
                 avg_engagement_time_per_session, events_per_session,
                 event_count, key_events, session_key_event_rate, total_revenue)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          nanoid(), clientId, uploadId, month, channel,
          intCell(row, iSessions), intCell(row, iEngaged), floatCell(row, iEngRate),
          floatCell(row, iAvgTime), floatCell(row, iEventsPerSession),
          intCell(row, iEventCount), intCell(row, iKeyEvents),
          floatCell(row, iKeyEventRate), floatCell(row, iRev),
        ],
      });
      rowCount++;
    }
  }
  return rowCount;
}

// --------- Pages and screens (or Landing page) ---------
//
// GA4 emits the first column either as "Page path and screen class"
// or "Landing page" depending on which dimension was selected before
// export. Both files end up in ga4_pages with page_path holding the
// path. The metric columns are otherwise identical.
export async function parsePages(
  raw: string,
  clientId: string,
  month: string,
  uploadId: string,
): Promise<number> {
  const blocks = splitIntoBlocks(raw);
  let rowCount = 0;
  for (const block of blocks) {
    if (block.headers.length < 2) continue;
    const iPath = 0;
    const iViews = headerIndex(block.headers, 'Views');
    const iActive = headerIndex(block.headers, 'Active users');
    const iViewsPer = block.headers.findIndex(s => s.toLowerCase().startsWith('views per active user'));
    const iAvgTime = block.headers.findIndex(s => s.toLowerCase().startsWith('average engagement time per active user'));
    const iEventCount = headerIndex(block.headers, 'Event count');
    const iKeyEvents = headerIndex(block.headers, 'Key events');
    const iRev = headerIndex(block.headers, 'Total revenue');

    for (const row of block.rows) {
      const path = textCell(row, iPath);
      if (!path) continue;
      await turso.execute({
        sql: `INSERT INTO ga4_pages
                (id, client_id, csv_upload_id, month, page_path,
                 views, active_users, views_per_active_user,
                 avg_engagement_time_per_active_user, event_count,
                 key_events, total_revenue)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          nanoid(), clientId, uploadId, month, path,
          intCell(row, iViews), intCell(row, iActive), floatCell(row, iViewsPer),
          floatCell(row, iAvgTime), intCell(row, iEventCount),
          intCell(row, iKeyEvents), floatCell(row, iRev),
        ],
      });
      rowCount++;
    }
  }
  return rowCount;
}

// --------- Tech overview ---------
//
// Three blocks:
//   1. Platform → Active users (just "Web" usually; we still store it)
//   2. Operating system → Active users (iOS, Android, Windows, Mac, Linux, Chrome OS)
//   3. Platform / device category → Active users (web / mobile, web / desktop, etc.)
//
// Each block's first column tells us its kind.
export async function parseTechOverview(
  raw: string,
  clientId: string,
  month: string,
  uploadId: string,
): Promise<number> {
  const blocks = splitIntoBlocks(raw);
  let rowCount = 0;
  for (const block of blocks) {
    if (block.headers.length < 2) continue;
    const firstCol = (block.headers[0] || '').toLowerCase();
    let kind: string | null = null;
    if (firstCol === 'platform') kind = 'platform';
    else if (firstCol === 'operating system') kind = 'os';
    else if (firstCol === 'platform / device category') kind = 'device_category';
    if (!kind) continue;

    const iActive = headerIndex(block.headers, 'Active users');
    for (const row of block.rows) {
      const label = textCell(row, 0);
      if (!label) continue;
      // Platform column comes through as ["Web"] (array literal in
      // string form). Normalize for display.
      const cleanLabel = label.replace(/^\["?/, '').replace(/"?\]$/, '');
      await turso.execute({
        sql: `INSERT INTO ga4_tech
                (id, client_id, csv_upload_id, month, kind, label, active_users)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [nanoid(), clientId, uploadId, month, kind, cleanLabel, intCell(row, iActive)],
      });
      rowCount++;
    }
  }
  return rowCount;
}

// --------- Demographic details: Country ---------
export async function parseDemographicCountry(
  raw: string,
  clientId: string,
  month: string,
  uploadId: string,
): Promise<number> {
  const blocks = splitIntoBlocks(raw);
  let rowCount = 0;
  for (const block of blocks) {
    if (block.headers.length < 2) continue;
    const iCountry = 0;
    const iActive = headerIndex(block.headers, 'Active users');
    const iNew = headerIndex(block.headers, 'New users');
    const iEngaged = headerIndex(block.headers, 'Engaged sessions');
    const iEngRate = headerIndex(block.headers, 'Engagement rate');
    const iAvgTime = block.headers.findIndex(s => s.toLowerCase().startsWith('average engagement time per active user'));
    const iEventCount = headerIndex(block.headers, 'Event count');
    const iKeyEvents = headerIndex(block.headers, 'Key events');
    const iRev = headerIndex(block.headers, 'Total revenue');

    for (const row of block.rows) {
      const country = textCell(row, iCountry);
      if (!country) continue;
      await turso.execute({
        sql: `INSERT INTO ga4_geography
                (id, client_id, csv_upload_id, month, country,
                 active_users, new_users, engaged_sessions, engagement_rate,
                 avg_engagement_time_per_active_user, event_count, key_events, total_revenue)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          nanoid(), clientId, uploadId, month, country,
          intCell(row, iActive), intCell(row, iNew), intCell(row, iEngaged),
          floatCell(row, iEngRate), floatCell(row, iAvgTime),
          intCell(row, iEventCount), intCell(row, iKeyEvents), floatCell(row, iRev),
        ],
      });
      rowCount++;
    }
  }
  return rowCount;
}

// --------- Top-level dispatcher ---------
//
// Picks the right parser by GA4 file type tag (passed down from
// detector.ts). The ingest layer in csv/index.ts handles the
// detection; this just routes.
export async function parseGa4(
  raw: string,
  clientId: string,
  month: string,
  uploadId: string,
  ga4Kind: string,
): Promise<number> {
  switch (ga4Kind) {
    case 'ga4_reports_snapshot':   return parseReportsSnapshot(raw, clientId, month, uploadId);
    case 'ga4_traffic_acquisition': return parseTrafficAcquisition(raw, clientId, month, uploadId);
    case 'ga4_pages':              return parsePages(raw, clientId, month, uploadId);
    case 'ga4_tech':               return parseTechOverview(raw, clientId, month, uploadId);
    case 'ga4_geography':          return parseDemographicCountry(raw, clientId, month, uploadId);
    default: return 0;
  }
}
