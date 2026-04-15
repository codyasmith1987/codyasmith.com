// Slice 18h — Screaming Frog "Response Codes: All" CSV parser.
//
// Screaming Frog's response-code export lists every crawled URL
// with its HTTP status code. We don't store per-URL data (the
// issue_snapshots table is per-issue-name keyed) so this parser
// groups rows by status-code bucket and emits one StagedIssue per
// non-empty non-2xx bucket. Healthy 2xx rows are skipped — zero
// issues means no row, not a noisy zero-count row.
//
// The 4xx bucket's issue_name matches the exact string the
// narrator's broken-link sentence matcher in
// src/lib/client-narrator.ts looks for:
//
//   "Response Codes: Internal Client Error (4xx)"
//
// so a Screaming Frog upload will light up the narrator's
// "N broken links on your pages are leading visitors to dead
// ends" sentence with zero narrator code changes.

import Papa from 'papaparse';
import type { ParseResult, StagedIssue } from '../types';

type BucketKey = '1xx' | '3xx' | '4xx' | '5xx' | 'none';

interface BucketMeta {
  issue_name: string;
  priority: 'critical' | 'medium' | 'low';
  label: string;
}

const BUCKETS: Record<BucketKey, BucketMeta> = {
  '1xx': {
    issue_name: 'Response Codes: Informational (1xx)',
    priority: 'low',
    label: '1xx informational',
  },
  '3xx': {
    issue_name: 'Response Codes: Redirection (3xx)',
    priority: 'medium',
    label: '3xx redirect',
  },
  // EXACT match for the narrator's broken-link sentence template —
  // see src/lib/client-narrator.ts renderFactSentence 'health' case.
  '4xx': {
    issue_name: 'Response Codes: Internal Client Error (4xx)',
    priority: 'critical',
    label: '4xx client error',
  },
  '5xx': {
    issue_name: 'Response Codes: Server Error (5xx)',
    priority: 'critical',
    label: '5xx server error',
  },
  none: {
    issue_name: 'Response Codes: Blocked or Unknown (no response)',
    priority: 'medium',
    label: 'blocked / no response',
  },
};

function bucketForStatus(raw: unknown): BucketKey | 'healthy' | null {
  const s = (raw ?? '').toString().trim();
  if (!s) return 'none';
  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) return 'none';
  if (n === 0) return 'none';
  if (n >= 100 && n < 200) return '1xx';
  if (n >= 200 && n < 300) return 'healthy';
  if (n >= 300 && n < 400) return '3xx';
  if (n >= 400 && n < 500) return '4xx';
  if (n >= 500 && n < 600) return '5xx';
  return null;
}

export function parseScreamingFrogResponseCodesV2(raw: string): ParseResult {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true });
  const counts = new Map<BucketKey, number>();
  let total = 0;
  for (const row of result.data as any[]) {
    // Column is "Status Code" — Papa with header:true gives us the
    // raw header-cased keys. Screaming Frog occasionally ships with
    // a trailing space so we try both.
    const rawStatus = row['Status Code'] ?? row['Status Code '] ?? row['status code'];
    const bucket = bucketForStatus(rawStatus);
    if (bucket === null) continue; // unparseable, skip
    total += 1;
    if (bucket === 'healthy') continue; // 2xx — no issue row
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }

  const issues: StagedIssue[] = [];
  // Fixed iteration order so the emitted rows are deterministic
  // regardless of Map insertion order. Matches the severity cascade
  // the narrator walks when picking the most important issue.
  const orderedKeys: BucketKey[] = ['4xx', '5xx', '3xx', '1xx', 'none'];
  for (const key of orderedKeys) {
    const count = counts.get(key);
    if (!count) continue;
    const meta = BUCKETS[key];
    const pct = total > 0 ? Math.round((count / total) * 1000) / 10 : null;
    issues.push({
      issue_name: meta.issue_name,
      issue_type: 'response_code',
      priority: meta.priority,
      affected_urls: count,
      pct_of_total: pct,
      description: `${count} URL${count === 1 ? '' : 's'} returned a ${meta.label} status`,
      how_to_fix:
        "Investigate these URLs in Screaming Frog's Response Codes tab and fix or redirect as appropriate",
    });
  }

  return { issues };
}
