import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import turso from '../../turso';
import type { ParseResult, StagedMetric } from '../types';

// v2: pure staging.
export function parseImageOptimizationV2(raw: string): ParseResult {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true });
  const rows = result.data as any[];
  let totalImages = 0;
  let totalImprovement = 0;
  for (const row of rows) {
    const pct = parseFloat(row['Percent Improvement']?.toString().replace('%', '') || '0');
    if (!isNaN(pct)) {
      totalImprovement += pct;
      totalImages++;
    }
  }
  const avgImprovement = totalImages > 0 ? totalImprovement / totalImages : 0;
  const metrics: StagedMetric[] = [
    { category: 'health', metric_key: 'total_images_audited', metric_value: totalImages },
    { category: 'health', metric_key: 'avg_image_improvement_pct', metric_value: Math.round(avgImprovement * 100) / 100 },
  ];
  return { metrics };
}

// v1: legacy.
export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true });
  const rows = result.data as any[];

  let totalImages = 0;
  let totalImprovement = 0;

  for (const row of rows) {
    const pct = parseFloat(row['Percent Improvement']?.toString().replace('%', '') || '0');
    if (!isNaN(pct)) {
      totalImprovement += pct;
      totalImages++;
    }
  }

  const avgImprovement = totalImages > 0 ? totalImprovement / totalImages : 0;

  // Store aggregate metrics
  const metricsToStore = [
    { key: 'total_images_audited', value: totalImages },
    { key: 'avg_image_improvement_pct', value: Math.round(avgImprovement * 100) / 100 },
  ];

  for (const m of metricsToStore) {
    await turso.execute({
      sql: `INSERT OR REPLACE INTO metrics (id, client_id, month, category, metric_key, metric_value, source, csv_upload_id)
            VALUES (?, ?, ?, 'health', ?, ?, 'csv_upload', ?)
            ON CONFLICT(client_id, month, category, metric_key)
            DO UPDATE SET metric_value = excluded.metric_value, csv_upload_id = excluded.csv_upload_id`,
      args: [nanoid(), clientId, month, m.key, m.value, uploadId],
    });
  }

  return totalImages;
}
