import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import turso from '../../turso';

// A cell counts as a real measured value only if it is a finite number.
// Free Screaming Frog exports the page rows but leaves the violation
// columns blank; with dynamicTyping those blanks arrive as null/'' and
// MUST NOT be coerced to 0 (that is the score-inflation bug). A literal
// "0" parses to the number 0 and IS a real measured-clean value.
function realNumber(cell: any): number | null {
  if (typeof cell === 'number' && Number.isFinite(cell)) return cell;
  return null;
}

export interface AccessibilityMetric { key: string; value: number; }

// PURE: parse raw -> aggregate metrics array. No DB calls. Returns an empty
// array when NOTHING real was measured (free-SF blank export), so the caller
// writes no misleading "0 violations / N pages audited" rows. When at least
// one real violation value is present, returns the 5 aggregate metrics with
// blank cells ignored (a genuine measured 0 stays 0).
export function buildAccessibilityMetrics(raw: string): AccessibilityMetric[] {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true, dynamicTyping: true });
  const rows = result.data as any[];

  if (rows.length === 0) return [];

  // Aggregate WCAG violations across all pages, ignoring blank cells.
  let totalViolations = 0;
  let wcag20a = 0;
  let wcag20aa = 0;
  let wcag21aa = 0;
  let anyMeasured = false;

  for (const row of rows) {
    const all = realNumber(row['All Violations']);
    const a = realNumber(row['WCAG 2.0 A Violations']);
    const aa = realNumber(row['WCAG 2.0 AA Violations']);
    const aaa21 = realNumber(row['WCAG 2.1 AA Violations']);

    if (all !== null) { totalViolations += all; anyMeasured = true; }
    if (a !== null) { wcag20a += a; anyMeasured = true; }
    if (aa !== null) { wcag20aa += aa; anyMeasured = true; }
    if (aaa21 !== null) { wcag21aa += aaa21; anyMeasured = true; }
  }

  // Nothing was actually measured: do not write misleading zeros.
  if (!anyMeasured) return [];

  return [
    { key: 'accessibility_total_violations', value: totalViolations },
    { key: 'accessibility_wcag20a', value: wcag20a },
    { key: 'accessibility_wcag20aa', value: wcag20aa },
    { key: 'accessibility_wcag21aa', value: wcag21aa },
    { key: 'accessibility_pages_audited', value: rows.length },
  ];
}

// Thin executor — back-compat for direct callers. Writes nothing when the
// file was present but unmeasured. Returns the page-row count seen.
export async function parse(raw: string, clientId: string, month: string, uploadId: string, siteId: string | null = null): Promise<number> {
  const result = Papa.parse(raw, { header: true, skipEmptyLines: true, dynamicTyping: true });
  const rowCount = (result.data as any[]).length;

  const metrics = buildAccessibilityMetrics(raw);

  for (const m of metrics) {
    await turso.execute({
      sql: `INSERT OR REPLACE INTO metrics (id, client_id, month, category, metric_key, metric_value, source, csv_upload_id, site_id)
            VALUES (?, ?, ?, 'accessibility', ?, ?, 'csv_upload', ?, ?)
            ON CONFLICT(client_id, month, category, metric_key, COALESCE(site_id, ''))
            DO UPDATE SET metric_value = excluded.metric_value, csv_upload_id = excluded.csv_upload_id`,
      args: [nanoid(), clientId, month, m.key, m.value, uploadId, siteId],
    });
  }

  return rowCount;
}
