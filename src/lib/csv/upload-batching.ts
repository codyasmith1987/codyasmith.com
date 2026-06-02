// Pure, testable upload-batch planner for the admin CSV uploader.
//
// The browser uploader sends files to /portal/api/csv/upload in batches.
// Each batch is one POST that the server ingests; Cloudflare gives the
// origin ~100s to respond before returning a 524. A batch that carries
// too many DB rows produces hundreds of sequential turso.batch round-trips
// and blows that window.
//
// The trap that 524'd in the field: batching by file-COUNT and BYTES only.
// A Screaming Frog export folder is 150+ files, most tiny in BYTES but a
// few (success_(2xx)_inlinks 6799 rows, https_urls_inlinks 6367, the
// follow/self-referencing/index inlinks 3138 each) are row-DENSE. Ten of
// those fit easily under 8MB and the 10-file cap, yet add up to tens of
// thousands of rows in one request.
//
// Fix: also bound each batch by an estimated ROW count. We don't read the
// files here (this runs on file metadata only), so estimate rows from byte
// size with a conservative ~120-bytes-per-row floor. SF link rows run
// 150-400 bytes each, so /120 OVER-estimates row count, which makes
// batches come out SMALLER and SAFER. A file whose estimate alone exceeds
// a cap gets its own batch (nothing can be packed with it without busting
// the cap anyway).
//
// csv.astro's inline browser script can't import this TS module, so it
// carries a byte-identical copy of this algorithm under a DRIFT-LOCK guard
// test (run-upload-batching-tests.mjs, "DRIFT-LOCK" case).

export interface UploadFileMeta {
  name: string;
  size: number;
}

export interface UploadBatchCaps {
  maxFiles: number;
  maxBytes: number;
  maxRows: number;
}

// Conservative bytes-per-row floor. Lower number -> higher row estimate
// -> smaller, safer batches. SF link rows are well above 120 bytes.
export const BYTES_PER_ROW_FLOOR = 120;

export function estimateRows(size: number): number {
  return Math.ceil((size || 0) / BYTES_PER_ROW_FLOOR);
}

/**
 * Pack files into batches that stay under ALL THREE caps (maxFiles,
 * maxBytes, maxRows) simultaneously. A single file whose byte size or
 * estimated row count exceeds a cap is emitted as its own batch.
 *
 * Order-preserving, greedy: walks the input once, flushing the current
 * batch whenever the next file would push it past any cap.
 */
export function planUploadBatches<T extends UploadFileMeta>(
  files: T[],
  caps: UploadBatchCaps,
): T[][] {
  const { maxFiles, maxBytes, maxRows } = caps;
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  let currentRows = 0;

  const flush = () => {
    if (current.length > 0) {
      batches.push(current);
      current = [];
      currentBytes = 0;
      currentRows = 0;
    }
  };

  for (const f of files) {
    const bytes = f.size || 0;
    const rows = estimateRows(bytes);

    // A file that on its own busts any cap gets an isolated batch. It can't
    // be packed with anything, and packing it would make whatever it joins
    // bust the cap too.
    if (bytes > maxBytes || rows > maxRows) {
      flush();
      batches.push([f]);
      continue;
    }

    const wouldExceedBytes = currentBytes + bytes > maxBytes;
    const wouldExceedCount = current.length >= maxFiles;
    const wouldExceedRows = currentRows + rows > maxRows;
    if ((wouldExceedBytes || wouldExceedCount || wouldExceedRows) && current.length > 0) {
      flush();
    }

    current.push(f);
    currentBytes += bytes;
    currentRows += rows;
  }

  flush();
  return batches;
}
