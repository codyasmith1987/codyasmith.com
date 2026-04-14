import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import turso from '../../turso';
import type { ParseResult, StagedMetric } from '../types';

// v2: pure staging.
export function parseAccessibilityV2(raw: string): ParseResult {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true, dynamicTyping: true });
  const rows = result.data as any[];
  if (rows.length === 0) return { metrics: [] };

  let totalViolations = 0;
  let wcag20a = 0;
  let wcag20aa = 0;
  let wcag21aa = 0;
  for (const row of rows) {
    totalViolations += row['All Violations'] || 0;
    wcag20a += row['WCAG 2.0 A Violations'] || 0;
    wcag20aa += row['WCAG 2.0 AA Violations'] || 0;
    wcag21aa += row['WCAG 2.1 AA Violations'] || 0;
  }
  const metrics: StagedMetric[] = [
    { category: 'accessibility', metric_key: 'accessibility_total_violations', metric_value: totalViolations },
    { category: 'accessibility', metric_key: 'accessibility_wcag20a', metric_value: wcag20a },
    { category: 'accessibility', metric_key: 'accessibility_wcag20aa', metric_value: wcag20aa },
    { category: 'accessibility', metric_key: 'accessibility_wcag21aa', metric_value: wcag21aa },
    { category: 'accessibility', metric_key: 'accessibility_pages_audited', metric_value: rows.length },
  ];
  return { metrics };
}

// v1: legacy.
export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true, dynamicTyping: true });
  const rows = result.data as any[];

  if (rows.length === 0) return 0;

  // Aggregate WCAG violations across all pages
  let totalViolations = 0;
  let wcag20a = 0;
  let wcag20aa = 0;
  let wcag21aa = 0;

  for (const row of rows) {
    totalViolations += (row['All Violations'] || 0);
    wcag20a += (row['WCAG 2.0 A Violations'] || 0);
    wcag20aa += (row['WCAG 2.0 AA Violations'] || 0);
    wcag21aa += (row['WCAG 2.1 AA Violations'] || 0);
  }

  const metrics = [
    { key: 'accessibility_total_violations', value: totalViolations },
    { key: 'accessibility_wcag20a', value: wcag20a },
    { key: 'accessibility_wcag20aa', value: wcag20aa },
    { key: 'accessibility_wcag21aa', value: wcag21aa },
    { key: 'accessibility_pages_audited', value: rows.length },
  ];

  for (const m of metrics) {
    await turso.execute({
      sql: `INSERT OR REPLACE INTO metrics (id, client_id, month, category, metric_key, metric_value, source, csv_upload_id)
            VALUES (?, ?, ?, 'accessibility', ?, ?, 'csv_upload', ?)
            ON CONFLICT(client_id, month, category, metric_key)
            DO UPDATE SET metric_value = excluded.metric_value, csv_upload_id = excluded.csv_upload_id`,
      args: [nanoid(), clientId, month, m.key, m.value, uploadId],
    });
  }

  return rows.length;
}
