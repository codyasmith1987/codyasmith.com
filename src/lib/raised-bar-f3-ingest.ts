import { ingestCSV } from './csv/index';
import { getClientBySlug } from './auth';
import turso from './turso';

// Bundled F3 Properties Screaming Frog export. These files are in the
// repo/build, but they do not become portal data until this ingest code
// writes csv_uploads + child tables for the current Raised Bar client.
const CSV_BUNDLE = import.meta.glob('../data/raised-bar-f3-csvs/*.csv', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export const RAISED_BAR_F3_CLIENT_SLUG = 'raised-bar-group';
export const RAISED_BAR_F3_MONTH = '2026-05';

export interface RaisedBarF3IngestResult {
  file: string;
  format: string;
  rows: number;
  skipped?: boolean;
  error?: string;
}

export interface RaisedBarF3IngestSummary {
  total_files: number;
  offset: number;
  limit: number;
  processed: number;
  next_offset: number | null;
  skipped: number;
  succeeded: number;
  failed: number;
  by_format: Record<string, number>;
  client_id: string;
  client_name: string;
}

export function getRaisedBarF3BundleFileCount(): number {
  return Object.keys(CSV_BUNDLE).length;
}

export async function ingestRaisedBarF3CsvChunk(args: {
  offset?: number;
  limit?: number;
  force?: boolean;
} = {}): Promise<{ summary: RaisedBarF3IngestSummary; results: RaisedBarF3IngestResult[] }> {
  const offset = Math.max(0, Number.isFinite(args.offset) ? Math.floor(args.offset || 0) : 0);
  const limit = Math.max(1, Math.min(100, Number.isFinite(args.limit) ? Math.floor(args.limit || 40) : 40));
  const force = args.force === true;

  const client = await getClientBySlug(RAISED_BAR_F3_CLIENT_SLUG);
  if (!client) throw new Error(`Client '${RAISED_BAR_F3_CLIENT_SLUG}' not found; run migration 014 first`);

  const adminLookup = await turso.execute("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1");
  if (adminLookup.rows.length === 0) throw new Error('No admin user found');
  const adminUserId = adminLookup.rows[0][0] as string;

  const allEntries = Object.entries(CSV_BUNDLE).sort(([a], [b]) => a.localeCompare(b));
  const total = allEntries.length;
  const chunk = allEntries.slice(offset, offset + limit);
  const results: RaisedBarF3IngestResult[] = [];

  for (const [path, raw] of chunk) {
    const fileName = path.split('/').pop()!;

    // Idempotency: skip if a successful upload already exists for
    // this client + month + filename.
    const existing = await turso.execute({
      sql: 'SELECT id, error FROM csv_uploads WHERE client_id = ? AND month = ? AND original_name = ? AND (error IS NULL OR error = ?)',
      args: [client.id, RAISED_BAR_F3_MONTH, fileName, ''],
    });
    if (!force && existing.rows.length > 0) {
      results.push({ file: fileName, format: 'cached', rows: 0, skipped: true });
      continue;
    }

    try {
      const result = await ingestCSV(raw, client.id, RAISED_BAR_F3_MONTH, fileName, adminUserId);
      results.push({
        file: fileName,
        format: result.format,
        rows: result.rowCount,
        error: result.error,
      });
    } catch (err: any) {
      results.push({ file: fileName, format: 'error', rows: 0, error: err?.message || String(err) });
    }
  }

  const summary: RaisedBarF3IngestSummary = {
    total_files: total,
    offset,
    limit,
    processed: chunk.length,
    next_offset: offset + chunk.length < total ? offset + chunk.length : null,
    skipped: results.filter(r => r.skipped).length,
    succeeded: results.filter(r => !r.error && !r.skipped).length,
    failed: results.filter(r => !!r.error).length,
    by_format: results.reduce((acc, r) => {
      const key = r.skipped ? 'skipped' : (r.error ? `error:${r.format}` : r.format);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    client_id: client.id,
    client_name: client.name,
  };

  return { summary, results };
}
