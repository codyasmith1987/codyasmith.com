// Universal Screaming Frog export parser. Catches any CSV-shaped file that
// matches no specific signature and row-explodes it into sf_export_rows:
// one row per CSV row, keyed by report_type (from the filename), with the
// most common URL column hoisted and the FULL row preserved as raw_json.
//
// This is the queryable replacement for the old unknown_stored fallback (raw
// text in raw_csv_data, NOT queryable). Self-dedups by (client, month,
// report_type) so a re-upload replaces its rows while sibling reports in the
// same crawl batch coexist — hence sf_generic is omitted from FORMAT_SOURCES
// (same reasoning as issue_urls / links / raw-csv).

import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import turso from '../../turso';
import { bulkInsert } from './_bulk-insert';

// report_type from a filename: strip directory path, any ZIP-entry prefix
// ("archive.zip:foo.csv"), the .csv extension, lowercase. Mirrors the
// normalization the detector uses so the type is stable across upload methods.
export function reportTypeForFilename(filename: string): string {
  return filename
    .replace(/^.*[\\/]/, '')   // strip directory path
    .replace(/^.*\.zip:/i, '') // strip ZIP-entry prefix
    .replace(/\.csv$/i, '')    // strip extension
    .trim()
    .toLowerCase();
}

// Bare filename (no path / zip prefix) for the source_file column.
function baseName(filename: string): string {
  return filename.replace(/^.*[\\/]/, '').replace(/^.*\.zip:/i, '').trim();
}

// Hoist the most common URL-bearing column for easy joins. Everything is kept
// in raw_json regardless, so an unrecognized URL column is never data loss.
function hoistUrl(row: Record<string, any>): string | null {
  for (const k of Object.keys(row)) {
    const lk = k.trim().toLowerCase();
    if (lk === 'address' || lk === 'url' || lk === 'source') {
      const v = row[k];
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
  }
  return null;
}

export async function parse(
  raw: string,
  clientId: string,
  month: string,
  uploadId: string,
  filename: string,
): Promise<number> {
  return parseSfGenericWithDb(raw, clientId, month, uploadId, filename, turso);
}

// Test-injectable variant. parse() uses the prod singleton; tests inject an
// in-memory client to avoid touching the remote DB.
export async function parseSfGenericWithDb(
  raw: string,
  clientId: string,
  month: string,
  uploadId: string,
  filename: string,
  db: typeof turso,
): Promise<number> {
  const reportType = reportTypeForFilename(filename);
  const source = baseName(filename);

  const result = Papa.parse(raw, { header: true, skipEmptyLines: true });

  // Self-dedup by (client, month, report_type): re-uploading the same report
  // replaces its rows; sibling report types coexist.
  await db.execute({
    sql: `DELETE FROM sf_export_rows WHERE client_id = ? AND month = ? AND report_type = ?`,
    args: [clientId, month, reportType],
  });

  const inserts: any[][] = [];
  let idx = 0;
  for (const row of (result.data as any[]) || []) {
    const obj = row as Record<string, any>;
    const keys = Object.keys(obj);
    if (keys.length === 0) continue;
    // Skip rows that are entirely blank (trailing newline artifacts etc.).
    if (!keys.some(k => obj[k] != null && String(obj[k]).trim() !== '')) continue;

    inserts.push([
      nanoid(), clientId, uploadId, month, reportType, source, idx, hoistUrl(obj), JSON.stringify(obj),
    ]);
    idx++;
  }

  const sql = `INSERT INTO sf_export_rows
                 (id, client_id, csv_upload_id, month, report_type, source_file, row_index, url, raw_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  await bulkInsert(sql, inserts, db);

  return inserts.length;
}
