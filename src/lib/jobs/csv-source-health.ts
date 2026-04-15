// Slice 18g — CSV data-source health detector.
// Slice 18h — extended to include screaming_frog_issues once
// parseScreamingFrogResponseCodesV2 and its detector/dispatch/
// touchBindingsForClient path became real.
//
// Surfaces enabled non-Google data_source_bindings whose CSV
// heartbeat is missing, broken, or stale. Covers every source
// kind that has a real parser + import path in this repo:
//
//   - ubersuggest_position_tracking
//   - ubersuggest_keyword_research
//   - ubersuggest_site_audit
//   - screaming_frog_issues     (Slice 18h — response_codes_all)
//
// Priority order (one row per binding, highest-priority match wins):
//
//   1. last_import_failed — the most recent imports row for this
//      (client_id, kind's format set) has status='failed'. The
//      current data layer does not reflect a recent successful
//      CSV for this (client, kind) pair.
//   2. never_imported — no imports row exists at all AND
//      last_seen_at is null. Bound but nothing ever uploaded.
//   3. stale — most recent imports row is applied but
//      started_at is older than CSV_STALE_THRESHOLD_DAYS.
//
// Pending imports are silent here — the existing stale_pending
// admin-queue section already owns that signal. Disabled bindings
// (enabled = 0) and non-CSV bindings are filtered at the SELECT.
// last_seen_at is only a fallback; the imports.started_at for the
// most recent applied row is the effective heartbeat because
// ingest-v2 writes it transactionally while the touch happens
// best-effort post-commit and can silently fail.

import turso from '../turso';
import type { QueueSection, QueueRow } from '../admin-queue';

// CSV sources are ad-hoc uploads — there is no scheduler and no
// cadence documented in the repo. 45 days is the honest minimum
// that says "at least one monthly cycle plus buffer has passed
// without a fresh CSV." Matches Google's threshold so admins
// have one mental model. Dial in one place.
export const CSV_STALE_THRESHOLD_DAYS = 45;

export const CSV_SOURCE_KINDS = [
  'ubersuggest_position_tracking',
  'ubersuggest_keyword_research',
  'ubersuggest_site_audit',
  'screaming_frog_issues',
] as const;

export type CsvSourceKind = (typeof CSV_SOURCE_KINDS)[number];

// Strict inverse of csvFormatToDataSourceKind() in data-sources.ts.
// Tests reuse this via the export so the mapping has one source of
// truth. If a future slice adds a parser, both files must update.
export const CSV_KIND_FORMATS: Record<CsvSourceKind, readonly string[]> = {
  ubersuggest_position_tracking: ['position_tracking'],
  ubersuggest_keyword_research: ['keyword_research', 'keyword_suggestions'],
  ubersuggest_site_audit: [
    'issues_overview',
    'crawl_overview',
    'image_optimization',
    'site_audit',
    'accessibility',
  ],
  screaming_frog_issues: ['screaming_frog_response_codes'],
};

export type CsvBindingHealthReason =
  | 'last_import_failed'
  | 'never_imported'
  | 'stale';

interface BindingRow {
  id: string;
  client_id: string;
  source: CsvSourceKind;
  last_seen_at: string | null;
  client_name: string;
  contract_title: string;
}

interface LatestImportRow {
  status: string;
  error: string | null;
  started_at: string;
}

function daysBetween(now: number, iso: string): number {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return Number.POSITIVE_INFINITY;
  return Math.floor((now - then) / 86400000);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

async function latestImportForKind(
  clientId: string,
  kind: CsvSourceKind
): Promise<LatestImportRow | null> {
  const formats = CSV_KIND_FORMATS[kind];
  const placeholders = formats.map(() => '?').join(', ');
  const r = await turso.execute({
    sql: `SELECT status, error, started_at FROM imports
          WHERE client_id = ?
            AND source IN (${placeholders})
          ORDER BY started_at DESC
          LIMIT 1`,
    args: [clientId, ...formats],
  });
  if (r.rows.length === 0) return null;
  return {
    status: String(r.rows[0][0]),
    error: (r.rows[0][1] as string | null) ?? null,
    started_at: String(r.rows[0][2]),
  };
}

async function classifyBinding(
  b: BindingRow,
  now: number
): Promise<QueueRow | null> {
  const latest = await latestImportForKind(b.client_id, b.source);
  const where = `${b.client_name} · ${b.contract_title}`;

  // 1. last_import_failed — highest priority. If Cody's most
  // recent attempt failed, the current data layer does not
  // reflect this source and he needs to see the error.
  if (latest && latest.status === 'failed') {
    const err = truncate(latest.error ?? 'unknown error', 140);
    return {
      id: b.id,
      what: `${b.source} last import failed`,
      where,
      why: `last CSV attempt failed: ${err}`,
      action:
        'upload a fresh CSV on /portal/admin/contracts or investigate the parse error',
      link: '/portal/admin/contracts',
      meta: `last attempt: ${latest.started_at}`,
    };
  }

  // Pending imports are handled by the stale_pending section —
  // healthy here (silent). This also means a chain with latest='pending'
  // will NOT surface as stale, which is correct: the stuck import
  // is already the subject of a more specific row elsewhere.
  if (latest && latest.status === 'pending') return null;

  // 2. never_imported — no import row at all AND heartbeat null.
  // If last_seen_at is non-null with no import row that's a data
  // inconsistency (would require someone manually stamping the
  // binding without touching imports) — defensively treat as
  // healthy since the binding claims to have seen data.
  if (!latest) {
    if (!b.last_seen_at) {
      return {
        id: b.id,
        what: `${b.source} has never been imported`,
        where,
        why:
          'enabled but no CSV upload for this source has ever succeeded or failed',
        action: 'upload a fresh CSV on /portal/admin/contracts',
        link: '/portal/admin/contracts',
        meta: 'last import: never',
      };
    }
    return null;
  }

  // 3. stale — latest was applied but started_at is old. Prefer
  // imports.started_at over data_source_bindings.last_seen_at as
  // the effective heartbeat because ingest-v2 writes imports
  // transactionally while touch is best-effort post-commit.
  if (latest.status === 'applied') {
    const days = daysBetween(now, latest.started_at);
    if (days >= CSV_STALE_THRESHOLD_DAYS) {
      return {
        id: b.id,
        what: `${b.source} is stale`,
        where,
        why: `last successful CSV upload was ${days} days ago`,
        action: 'upload a fresh CSV on /portal/admin/contracts',
        link: '/portal/admin/contracts',
        meta: `last import: ${latest.started_at}`,
      };
    }
    return null;
  }

  // Any other status (defensively) is silent.
  return null;
}

export async function loadCsvSourceAttentionSection(): Promise<QueueSection> {
  const now = Date.now();
  const placeholders = CSV_SOURCE_KINDS.map(() => '?').join(', ');
  const rowsRaw = await turso.execute({
    sql: `SELECT dsb.id, dsb.client_id, dsb.source, dsb.last_seen_at,
                 c.name AS client_name, co.title AS contract_title
          FROM data_source_bindings dsb
          JOIN clients c ON c.id = dsb.client_id
          JOIN contracts co ON co.id = dsb.contract_id
          WHERE dsb.source IN (${placeholders})
            AND dsb.enabled = 1
          ORDER BY c.name, co.title, dsb.source`,
    args: [...CSV_SOURCE_KINDS],
  });
  const bindings: BindingRow[] = rowsRaw.rows.map((r) => ({
    id: r[0] as string,
    client_id: r[1] as string,
    source: r[2] as CsvSourceKind,
    last_seen_at: (r[3] as string | null) ?? null,
    client_name: r[4] as string,
    contract_title: r[5] as string,
  }));

  const rows: QueueRow[] = [];
  for (const b of bindings) {
    const row = await classifyBinding(b, now);
    if (row) rows.push(row);
  }

  return {
    key: 'csv_source_attention',
    label: 'CSV data sources needing attention',
    count: rows.length,
    rows,
  };
}
