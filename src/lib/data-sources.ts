// Data source bindings — the contract's declared feeds.
//
// A DataSourceBinding is one (contract, source) pair that the system
// expects to see data flowing through. Binding rows live their whole
// life attached to a single contract; when a contract is cancelled or
// deleted the bindings go with it. last_seen_at is the automation
// heartbeat: CSV ingestion (and later API connectors) call touchBinding()
// on success, and the admin queue reads it to surface silent source
// failures.
//
// The kinds enumerated here are deliberately small. Adding a new source
// is a code change, not a config change, so mis-typed kinds never leak
// into the DB.

import { nanoid } from 'nanoid';
import turso from './turso';

export type DataSourceKind =
  | 'ubersuggest_position_tracking'
  | 'ubersuggest_keyword_research'
  | 'ubersuggest_site_audit'
  | 'screaming_frog_issues'
  | 'gsc'
  | 'ga4';

export const DATA_SOURCE_KINDS: readonly DataSourceKind[] = [
  'ubersuggest_position_tracking',
  'ubersuggest_keyword_research',
  'ubersuggest_site_audit',
  'screaming_frog_issues',
  'gsc',
  'ga4',
] as const;

// Maps a CSV parser format (the detector.ts CsvFormat union) to the
// DataSourceKind it belongs to. Several Ubersuggest sub-formats
// collapse onto one kind: a binding is the "is this feed alive?"
// heartbeat, not a per-parser record. The granular parser name is
// already preserved in imports.source — bindings only care that
// Ubersuggest site audit (covering issues_overview, crawl_overview,
// image_optimization, site_audit, accessibility) is flowing at all.
//
// Returns null for formats that have no binding kind (unlikely, but
// future parsers might not correspond to a declared feed).
export function csvFormatToDataSourceKind(format: string): DataSourceKind | null {
  switch (format) {
    case 'position_tracking':
      return 'ubersuggest_position_tracking';
    case 'keyword_research':
    case 'keyword_suggestions':
      return 'ubersuggest_keyword_research';
    case 'issues_overview':
    case 'crawl_overview':
    case 'image_optimization':
    case 'site_audit':
    case 'accessibility':
      return 'ubersuggest_site_audit';
    default:
      return null;
  }
}

export interface DataSourceBinding {
  id: string;
  client_id: string;
  contract_id: string;
  source: DataSourceKind;
  enabled: number; // SQLite INTEGER, 0 or 1
  config_json: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export interface DataSourceInput {
  source: DataSourceKind;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

// Parses an arbitrary untrusted payload into a typed DataSourceInput[].
// Returns null if the shape is wrong at any level so the caller can
// 400 the request without writing garbage to the DB.
export function parseDataSourceInput(raw: unknown): DataSourceInput[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: DataSourceInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const s = (item as { source?: unknown }).source;
    if (typeof s !== 'string') return null;
    if (!DATA_SOURCE_KINDS.includes(s as DataSourceKind)) return null;
    if (seen.has(s)) return null; // reject duplicates
    seen.add(s);
    const enabledRaw = (item as { enabled?: unknown }).enabled;
    const configRaw = (item as { config?: unknown }).config;
    out.push({
      source: s as DataSourceKind,
      enabled: enabledRaw === true,
      config:
        configRaw && typeof configRaw === 'object' && !Array.isArray(configRaw)
          ? (configRaw as Record<string, unknown>)
          : undefined,
    });
  }
  return out;
}

// Used by provisionContract() inside its transaction. Takes an open
// transaction, not the global db, because we want every binding row
// to atomically land with the contract or nothing to land at all.
export async function seedBindingsInTx(
  tx: { execute: (q: { sql: string; args: any[] }) => Promise<unknown> },
  params: {
    client_id: string;
    contract_id: string;
    data_sources: DataSourceInput[];
  }
): Promise<string[]> {
  const ids: string[] = [];
  for (const d of params.data_sources) {
    const id = nanoid();
    ids.push(id);
    await tx.execute({
      sql: `INSERT INTO data_source_bindings
            (id, client_id, contract_id, source, enabled, config_json)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        params.client_id,
        params.contract_id,
        d.source,
        d.enabled ? 1 : 0,
        d.config ? JSON.stringify(d.config) : null,
      ],
    });
  }
  return ids;
}

async function queryAll(sql: string, args: any[] = []): Promise<DataSourceBinding[]> {
  const r = await turso.execute({ sql, args });
  return r.rows.map((row) =>
    Object.fromEntries(r.columns.map((col, i) => [col, row[i]]))
  ) as DataSourceBinding[];
}

export async function getBindingsForContract(
  contractId: string
): Promise<DataSourceBinding[]> {
  return queryAll(
    'SELECT * FROM data_source_bindings WHERE contract_id = ? ORDER BY source',
    [contractId]
  );
}

// Slice 18 — single-binding lookup used by the GSC sync handler to
// resolve a data_source_bindings row directly by id.
export async function getBindingById(id: string): Promise<DataSourceBinding | null> {
  const rows = await queryAll(
    'SELECT * FROM data_source_bindings WHERE id = ?',
    [id]
  );
  return rows[0] ?? null;
}

export async function getBindingsForClient(
  clientId: string
): Promise<DataSourceBinding[]> {
  return queryAll(
    'SELECT * FROM data_source_bindings WHERE client_id = ? ORDER BY contract_id, source',
    [clientId]
  );
}

export async function getEnabledBindingsForSource(
  source: DataSourceKind
): Promise<DataSourceBinding[]> {
  return queryAll(
    'SELECT * FROM data_source_bindings WHERE source = ? AND enabled = 1 ORDER BY client_id',
    [source]
  );
}

// Called by CSV ingest-v2 (and later by API connectors) when an import
// successfully commits. Matches by (contract_id, source). No-op if the
// binding does not exist — ingest code should prefer matching an
// explicit binding but must not fail when a client is ingesting a
// source that was never declared in their contract.
export async function touchBinding(
  contractId: string,
  source: DataSourceKind
): Promise<void> {
  await turso.execute({
    sql: `UPDATE data_source_bindings
          SET last_seen_at = datetime('now')
          WHERE contract_id = ? AND source = ?`,
    args: [contractId, source],
  });
}

// Client-level variant. Used by ingest-v2 because imports belong to a
// client, not a specific contract — if a client has two active
// contracts that both declare the same source (e.g. two retainers,
// one per site), both bindings are alive when the feed lands.
// Updates every matching row and returns the count of rows touched
// so callers can tell when a binding simply did not exist.
export async function touchBindingsForClient(
  clientId: string,
  source: DataSourceKind
): Promise<number> {
  const r = await turso.execute({
    sql: `UPDATE data_source_bindings
          SET last_seen_at = datetime('now')
          WHERE client_id = ? AND source = ?`,
    args: [clientId, source],
  });
  return Number((r as { rowsAffected?: number | bigint }).rowsAffected ?? 0);
}

export async function setBindingEnabled(
  id: string,
  enabled: boolean
): Promise<void> {
  await turso.execute({
    sql: 'UPDATE data_source_bindings SET enabled = ? WHERE id = ?',
    args: [enabled ? 1 : 0, id],
  });
}

export async function deleteBinding(id: string): Promise<void> {
  await turso.execute({
    sql: 'DELETE FROM data_source_bindings WHERE id = ?',
    args: [id],
  });
}
