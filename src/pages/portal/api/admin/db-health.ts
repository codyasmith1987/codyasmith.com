// Read-only DB health + latency probe. Admin-only GET.
//
// Why this exists: the 2026-06-15 MVP upload 524'd repeatedly. The DO runtime
// logs showed two trivial UPDATEs taking 23s and one file taking 108s, with
// 15x variance across identical 10-file batches and NO errors — the writes
// succeed, they are just pathologically slow. That is a degraded/throttled
// remote Turso backend, not the ingest code (whose per-file round-trip counts
// were already minimized by the 2026-06-02 batch refactor). This endpoint runs
// IN the prod container — the exact network path the upload uses — and reports
// the live latency + the cheap-to-check structural hypotheses (DB size, hot-
// table indexes, journal mode) so the cause is measured, not guessed.
//
// Nothing here mutates data. The single write-path sample is a 0-row UPDATE
// (id matches nothing) run inside a write transaction: it exercises the
// BEGIN/COMMIT round-trip that the slow path actually pays, while changing no
// rows. Fully within the no-prod-writes rule.

import type { APIRoute } from 'astro';
import turso from '../../../../lib/turso';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

const stats = (xs: number[]) => {
  if (!xs.length) return { samples: xs, min: null, median: null, max: null };
  const s = [...xs].sort((a, b) => a - b);
  return { samples: xs, min: s[0], median: s[Math.floor(s.length / 2)], max: s[s.length - 1] };
};

const timed = async <T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: string }> => {
  const t0 = performance.now();
  try {
    const value = await fn();
    return { ms: Math.round(performance.now() - t0), value };
  } catch (e: any) {
    return { ms: Math.round(performance.now() - t0), error: e?.message || 'failed' };
  }
};

// Hot write tables in the ingest path. Slow inserts here are what blow the
// Cloudflare window; a missing index on a write-heavy table makes every insert
// pay an O(n) scan to maintain uniqueness/lookups.
const HOT_TABLES = [
  'csv_uploads', 'link_graph', 'sf_export_rows', 'crawl_urls',
  'keyword_rankings', 'accessibility_urls', 'content_urls', 'security_urls',
];

export const GET: APIRoute = async ({ locals }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const out: Record<string, any> = { ok: true };

  // 1) Read round-trip latency — trivial SELECT, repeated. Isolates pure
  // network + DB-read latency from any query cost.
  const reads: number[] = [];
  for (let i = 0; i < 8; i++) {
    const r = await timed(() => turso.execute('SELECT 1'));
    if (r.error) { out.read_latency_error = r.error; break; }
    reads.push(r.ms);
  }
  out.read_latency_ms = stats(reads);

  // 2) Write-path latency — a 0-row UPDATE inside a write transaction. Mutates
  // nothing; measures the BEGIN/COMMIT round-trip the slow path pays. This is
  // the number that actually matters for ingest.
  const writes: number[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await timed(() =>
      turso.batch(
        [{ sql: "UPDATE csv_uploads SET error = error WHERE id = '__db_health_noop_never_matches__'", args: [] }],
        'write',
      ),
    );
    if (r.error) { out.write_latency_error = r.error; break; }
    writes.push(r.ms);
  }
  out.write_path_latency_ms = stats(writes);

  // 3) DB size — a bloated DB makes every write slower (more pages to walk,
  // bigger indexes). page_count * page_size = on-disk bytes.
  const pc = await timed(() => turso.execute('PRAGMA page_count'));
  const ps = await timed(() => turso.execute('PRAGMA page_size'));
  const jm = await timed(() => turso.execute('PRAGMA journal_mode'));
  const pageCount = Number((pc.value as any)?.rows?.[0]?.[0] ?? 0);
  const pageSize = Number((ps.value as any)?.rows?.[0]?.[0] ?? 0);
  out.db = {
    page_count: pageCount || pc.error || null,
    page_size: pageSize || ps.error || null,
    size_mb: pageCount && pageSize ? +(pageCount * pageSize / (1024 * 1024)).toFixed(1) : null,
    journal_mode: (jm.value as any)?.rows?.[0]?.[0] ?? jm.error ?? null,
  };

  // 4) Hot-table row counts + their indexes. A large row count with NO usable
  // index on the write/dedup key is the classic "every insert scans the table"
  // slowdown that grows with the dataset.
  out.hot_tables = {};
  for (const t of HOT_TABLES) {
    const entry: any = {};
    const c = await timed(() => turso.execute(`SELECT COUNT(*) FROM ${t}`));
    entry.count = (c.value as any)?.rows?.[0]?.[0] ?? c.error ?? null;
    entry.count_ms = c.ms;
    const idx = await timed(() => turso.execute(`PRAGMA index_list(${t})`));
    entry.indexes = idx.error
      ? idx.error
      : ((idx.value as any)?.rows ?? []).map((r: any) => ({ name: r[1], unique: !!r[2], origin: r[3] }));
    out.hot_tables[t] = entry;
  }

  return json(out);
};
