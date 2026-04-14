// GSC sync handler — pulls query+page+position rows for one
// data_source_binding and writes them into keyword_snapshots under
// source='gsc'.
//
// Mirrors the CSV ingest-v2 write path so the same guarantees hold:
//   - period_lock guard (slice 16)
//   - import row recorded for audit trail
//   - DELETE + INSERT wrapped in one transaction
//   - touchBindingsForClient on successful commit (slice 9)
//
// The GSC API client is injectable so tests can drive this function
// with a fixture response instead of a real HTTP call.

import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import turso from '../turso';
import { getBindingById, touchBindingsForClient, type DataSourceBinding } from '../data-sources';
import { isPeriodLocked, getPeriodById } from '../periods';
import { getConnectionById, getValidAccessToken } from './connections';
import {
  realGscClient,
  mapGscResponseToKeywords,
  monthToRange,
  type GscClient,
  type StagedGscKeyword,
} from './gsc';
import {
  realGa4Client,
  buildGa4ReportRequest,
  mapGa4ResponseToMetrics,
  type Ga4Client,
  type StagedGa4Metric,
} from './ga4';
import {
  TRAFFIC_CATEGORY,
  TRAFFIC_SOURCE_GA4,
} from '../traffic-metrics';
import { logger } from '../logger';

export interface GscSyncResult {
  status: 'applied' | 'failed';
  binding_id: string;
  period_id: string | null;
  import_id: string | null;
  row_count: number;
  error?: string;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

async function ensurePeriod(clientId: string, month: string): Promise<string> {
  const [y, m] = month.split('-').map(Number);
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const end = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  const existing = await turso.execute({
    sql: "SELECT id FROM periods WHERE client_id = ? AND period_type = 'month' AND period_start = ?",
    args: [clientId, start],
  });
  if (existing.rows.length > 0) return existing.rows[0][0] as string;
  const id = nanoid();
  await turso.execute({
    sql: `INSERT INTO periods (id, client_id, period_type, period_start, period_end)
          VALUES (?, ?, 'month', ?, ?)`,
    args: [id, clientId, start, end],
  });
  return id;
}

function parseBindingConfig(
  binding: DataSourceBinding
): { connection_id: string; property: string } | null {
  if (!binding.config_json) return null;
  try {
    const parsed = JSON.parse(binding.config_json);
    if (!parsed || typeof parsed !== 'object') return null;
    const connectionId = parsed.connection_id;
    const property = parsed.property;
    if (typeof connectionId !== 'string' || !connectionId) return null;
    if (typeof property !== 'string' || !property) return null;
    return { connection_id: connectionId, property };
  } catch {
    return null;
  }
}

export async function syncGscForBinding(
  bindingId: string,
  month: string,
  uploadedBy: string,
  client: GscClient = realGscClient
): Promise<GscSyncResult> {
  const binding = await getBindingById(bindingId);
  if (!binding) {
    return {
      status: 'failed',
      binding_id: bindingId,
      period_id: null,
      import_id: null,
      row_count: 0,
      error: 'binding not found',
    };
  }
  if (binding.source !== 'gsc') {
    return {
      status: 'failed',
      binding_id: bindingId,
      period_id: null,
      import_id: null,
      row_count: 0,
      error: `binding source is '${binding.source}', expected 'gsc'`,
    };
  }
  const config = parseBindingConfig(binding);
  if (!config) {
    return {
      status: 'failed',
      binding_id: bindingId,
      period_id: null,
      import_id: null,
      row_count: 0,
      error: 'binding has no connection_id + property — connect a Google account and pick a property first',
    };
  }
  if (Number(binding.enabled) !== 1) {
    return {
      status: 'failed',
      binding_id: bindingId,
      period_id: null,
      import_id: null,
      row_count: 0,
      error: 'binding is disabled',
    };
  }

  const periodId = await ensurePeriod(binding.client_id, month);

  // Lock guard — same rule as CSV ingest-v2 (slice 16).
  if (await isPeriodLocked(periodId)) {
    const period = await getPeriodById(periodId);
    const errorMsg = `period ${period?.period_start ?? periodId} is locked since ${period?.locked_at ?? 'unknown'}`;
    const importId = nanoid();
    const contentHash = sha256Hex(`${config.property}|${month}|locked`);
    await turso.execute({
      sql: `INSERT INTO imports
            (id, client_id, period_id, source, original_name, content_hash, status, row_count, uploaded_by, error, finished_at)
            VALUES (?, ?, ?, 'gsc', ?, ?, 'failed', 0, ?, ?, datetime('now'))`,
      args: [
        importId,
        binding.client_id,
        periodId,
        `gsc-sync ${month}`,
        contentHash,
        uploadedBy,
        errorMsg,
      ],
    });
    return {
      status: 'failed',
      binding_id: bindingId,
      period_id: periodId,
      import_id: importId,
      row_count: 0,
      error: errorMsg,
    };
  }

  // Resolve a valid access token. Failure here is honest — the
  // connection might be missing, the refresh token revoked, or the
  // OAuth env not configured.
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(config.connection_id);
  } catch (err) {
    return {
      status: 'failed',
      binding_id: bindingId,
      period_id: periodId,
      import_id: null,
      row_count: 0,
      error: `token refresh failed: ${String((err as Error)?.message ?? err)}`,
    };
  }

  // Call the API.
  const { startDate, endDate } = monthToRange(month);
  let response;
  try {
    response = await client.querySearchAnalytics(accessToken, config.property, {
      startDate,
      endDate,
      dimensions: ['query', 'page'],
      rowLimit: 1000,
    });
  } catch (err) {
    return {
      status: 'failed',
      binding_id: bindingId,
      period_id: periodId,
      import_id: null,
      row_count: 0,
      error: `GSC query failed: ${String((err as Error)?.message ?? err)}`,
    };
  }

  const staged: StagedGscKeyword[] = mapGscResponseToKeywords(response);

  // Content hash over the response summary — for audit + idempotency.
  const contentHash = sha256Hex(
    `${config.property}|${startDate}|${endDate}|${staged.length}|${JSON.stringify(staged).slice(0, 4096)}`
  );

  // Create the pending import row.
  const importId = nanoid();
  await turso.execute({
    sql: `INSERT INTO imports
          (id, client_id, period_id, source, original_name, content_hash, status, row_count, uploaded_by)
          VALUES (?, ?, ?, 'gsc', ?, ?, 'pending', 0, ?)`,
    args: [
      importId,
      binding.client_id,
      periodId,
      `gsc-sync ${month}`,
      contentHash,
      uploadedBy,
    ],
  });

  // Transactional replace.
  const tx = await turso.transaction('write');
  try {
    await tx.execute({
      sql: `DELETE FROM keyword_snapshots
            WHERE client_id = ? AND period_id = ? AND source = 'gsc'`,
      args: [binding.client_id, periodId],
    });
    for (const row of staged) {
      await tx.execute({
        sql: `INSERT INTO keyword_snapshots
              (id, client_id, period_id, import_id, source, keyword, position, search_volume, url, change_val, seo_difficulty)
              VALUES (?, ?, ?, ?, 'gsc', ?, ?, ?, ?, ?, ?)`,
        args: [
          nanoid(),
          binding.client_id,
          periodId,
          importId,
          row.keyword,
          row.position,
          row.search_volume,
          row.url,
          row.change_val,
          row.seo_difficulty,
        ],
      });
    }
    await tx.execute({
      sql: `UPDATE imports SET status = 'applied', row_count = ?, finished_at = datetime('now') WHERE id = ?`,
      args: [staged.length, importId],
    });
    await tx.commit();
  } catch (err: any) {
    await tx.rollback();
    const errorMsg = String(err?.message ?? err);
    await turso.execute({
      sql: `UPDATE imports SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?`,
      args: [errorMsg, importId],
    });
    return {
      status: 'failed',
      binding_id: bindingId,
      period_id: periodId,
      import_id: importId,
      row_count: 0,
      error: errorMsg,
    };
  }

  // Post-commit heartbeat stamp (slice 9 rule).
  try {
    await touchBindingsForClient(binding.client_id, 'gsc');
  } catch (err) {
    logger.warn('touchBindingsForClient failed after successful GSC sync', {
      error: String((err as Error)?.message ?? err),
      client_id: binding.client_id,
    });
  }

  return {
    status: 'applied',
    binding_id: bindingId,
    period_id: periodId,
    import_id: importId,
    row_count: staged.length,
  };
}

// ============================================================
// GA4 sync (Slice 18b)
// ============================================================
//
// Mirrors syncGscForBinding but writes into metric_snapshots under
// source='ga4' + category='traffic'. See src/lib/traffic-metrics.ts
// for the naming convention. Honors the same slice-16 period lock
// guard and slice-9 heartbeat stamp rules as every other write path.

export interface Ga4SyncResult {
  status: 'applied' | 'failed';
  binding_id: string;
  period_id: string | null;
  import_id: string | null;
  row_count: number;
  error?: string;
}

export async function syncGa4ForBinding(
  bindingId: string,
  month: string,
  uploadedBy: string,
  client: Ga4Client = realGa4Client
): Promise<Ga4SyncResult> {
  const binding = await getBindingById(bindingId);
  if (!binding) {
    return {
      status: 'failed',
      binding_id: bindingId,
      period_id: null,
      import_id: null,
      row_count: 0,
      error: 'binding not found',
    };
  }
  if (binding.source !== 'ga4') {
    return {
      status: 'failed',
      binding_id: bindingId,
      period_id: null,
      import_id: null,
      row_count: 0,
      error: `binding source is '${binding.source}', expected 'ga4'`,
    };
  }
  const config = parseBindingConfig(binding);
  if (!config) {
    return {
      status: 'failed',
      binding_id: bindingId,
      period_id: null,
      import_id: null,
      row_count: 0,
      error:
        'binding has no connection_id + property — connect a Google account and paste a GA4 property ID first',
    };
  }
  if (Number(binding.enabled) !== 1) {
    return {
      status: 'failed',
      binding_id: bindingId,
      period_id: null,
      import_id: null,
      row_count: 0,
      error: 'binding is disabled',
    };
  }

  const periodId = await ensurePeriod(binding.client_id, month);

  // Slice 16 lock guard — identical semantics to GSC.
  if (await isPeriodLocked(periodId)) {
    const period = await getPeriodById(periodId);
    const errorMsg = `period ${period?.period_start ?? periodId} is locked since ${period?.locked_at ?? 'unknown'}`;
    const importId = nanoid();
    const contentHash = sha256Hex(`${config.property}|${month}|locked|ga4`);
    await turso.execute({
      sql: `INSERT INTO imports
            (id, client_id, period_id, source, original_name, content_hash, status, row_count, uploaded_by, error, finished_at)
            VALUES (?, ?, ?, 'ga4', ?, ?, 'failed', 0, ?, ?, datetime('now'))`,
      args: [
        importId,
        binding.client_id,
        periodId,
        `ga4-sync ${month}`,
        contentHash,
        uploadedBy,
        errorMsg,
      ],
    });
    return {
      status: 'failed',
      binding_id: bindingId,
      period_id: periodId,
      import_id: importId,
      row_count: 0,
      error: errorMsg,
    };
  }

  // Access token.
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(config.connection_id);
  } catch (err) {
    return {
      status: 'failed',
      binding_id: bindingId,
      period_id: periodId,
      import_id: null,
      row_count: 0,
      error: `token refresh failed: ${String((err as Error)?.message ?? err)}`,
    };
  }

  // GA4 API call.
  const { startDate, endDate } = monthToRange(month);
  let response;
  try {
    response = await client.runReport(
      accessToken,
      config.property,
      buildGa4ReportRequest(startDate, endDate)
    );
  } catch (err) {
    return {
      status: 'failed',
      binding_id: bindingId,
      period_id: periodId,
      import_id: null,
      row_count: 0,
      error: `GA4 runReport failed: ${String((err as Error)?.message ?? err)}`,
    };
  }

  const staged: StagedGa4Metric[] = mapGa4ResponseToMetrics(response);

  const contentHash = sha256Hex(
    `${config.property}|${startDate}|${endDate}|${JSON.stringify(staged)}`
  );

  const importId = nanoid();
  await turso.execute({
    sql: `INSERT INTO imports
          (id, client_id, period_id, source, original_name, content_hash, status, row_count, uploaded_by)
          VALUES (?, ?, ?, 'ga4', ?, ?, 'pending', 0, ?)`,
    args: [
      importId,
      binding.client_id,
      periodId,
      `ga4-sync ${month}`,
      contentHash,
      uploadedBy,
    ],
  });

  // Transactional replace — same shape as every other ingest path.
  // DELETEs existing (client, period, source='ga4') rows so a re-
  // sync always reflects the latest GA4 state, never stacks.
  const tx = await turso.transaction('write');
  try {
    await tx.execute({
      sql: `DELETE FROM metric_snapshots
            WHERE client_id = ? AND period_id = ? AND source = ?`,
      args: [binding.client_id, periodId, TRAFFIC_SOURCE_GA4],
    });
    for (const row of staged) {
      await tx.execute({
        sql: `INSERT INTO metric_snapshots
              (id, client_id, period_id, import_id, category, metric_key, metric_value, source)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          nanoid(),
          binding.client_id,
          periodId,
          importId,
          TRAFFIC_CATEGORY,
          row.metric_key,
          row.metric_value,
          TRAFFIC_SOURCE_GA4,
        ],
      });
    }
    await tx.execute({
      sql: `UPDATE imports SET status = 'applied', row_count = ?, finished_at = datetime('now') WHERE id = ?`,
      args: [staged.length, importId],
    });
    await tx.commit();
  } catch (err: any) {
    await tx.rollback();
    const errorMsg = String(err?.message ?? err);
    await turso.execute({
      sql: `UPDATE imports SET status = 'failed', error = ?, finished_at = datetime('now') WHERE id = ?`,
      args: [errorMsg, importId],
    });
    return {
      status: 'failed',
      binding_id: bindingId,
      period_id: periodId,
      import_id: importId,
      row_count: 0,
      error: errorMsg,
    };
  }

  try {
    await touchBindingsForClient(binding.client_id, 'ga4');
  } catch (err) {
    logger.warn('touchBindingsForClient failed after successful GA4 sync', {
      error: String((err as Error)?.message ?? err),
      client_id: binding.client_id,
    });
  }

  return {
    status: 'applied',
    binding_id: bindingId,
    period_id: periodId,
    import_id: importId,
    row_count: staged.length,
  };
}
