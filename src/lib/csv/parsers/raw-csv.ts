// Fallback parser for CSVs the portal accepts but cannot yet
// type-parse. Stores raw text + detected headers in raw_csv_data so
// no data is denied at upload time. A later slice can add a typed
// parser for a specific filename pattern and retroactively process
// every stored row without re-upload.
//
// Headers are extracted via a small preview parse (5 rows) so the
// admin upload UI can show "this looked like a CSV with columns X,
// Y, Z" even when we don't know what to do with it yet. The full
// raw text is stored verbatim — bounded by the upload route's
// 10MB/file limit, which is well within SQLite TEXT column limits.

import Papa from 'papaparse';
import { nanoid } from 'nanoid';
import turso from '../../turso';

export async function parse(
  raw: string,
  clientId: string,
  month: string,
  uploadId: string,
  filename: string,
): Promise<number> {
  // Approximate row count from line count — accurate enough for the
  // admin upload UI's "X rows stored, not yet visualized" badge
  // without parsing the entire CSV.
  const lineCount = (raw.match(/\n/g) || []).length;
  const rowCount = Math.max(0, lineCount); // header subtraction is approximate

  // Header preview. If the file is malformed (no quotes balanced,
  // etc.) the preview parser returns empty; we still store the raw
  // text so future tooling can salvage it.
  let headers: string[] = [];
  try {
    const preview = Papa.parse(raw, { preview: 1, header: false, skipEmptyLines: true });
    if (preview.data && preview.data.length > 0) {
      headers = (preview.data[0] as string[]).map(h => (h || '').toString());
    }
  } catch {
    // Swallow — we still want to store the raw text.
  }

  await turso.execute({
    sql: `INSERT INTO raw_csv_data
            (id, client_id, csv_upload_id, month, filename, headers, row_count, raw_text)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      nanoid(),
      clientId,
      uploadId,
      month,
      filename,
      JSON.stringify(headers),
      rowCount,
      raw,
    ],
  });

  return rowCount;
}
