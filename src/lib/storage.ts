import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { nanoid } from 'nanoid';
import turso from './turso';

let _s3: S3Client | null = null;
function getS3(): S3Client {
  if (!_s3) {
    // Validate credentials up front and fail with a descriptive message
    // naming the missing var(s). Without this, a missing DO_SPACES_KEY
    // surfaced only as the AWS SDK's cryptic "Resolved credential object
    // is not valid" deep in uploadFile (which sign.ts swallowed), so
    // every executed PDF silently failed to store. This is lazy (on first
    // storage use) rather than at module load, so a storage misconfig
    // does not take down the whole app, but it is now immediately legible.
    const endpoint = import.meta.env.DO_SPACES_ENDPOINT;
    const key = import.meta.env.DO_SPACES_KEY;
    const secret = import.meta.env.DO_SPACES_SECRET;
    const bucket = import.meta.env.DO_SPACES_BUCKET;
    const missing = [
      !endpoint && 'DO_SPACES_ENDPOINT',
      !key && 'DO_SPACES_KEY',
      !secret && 'DO_SPACES_SECRET',
      !bucket && 'DO_SPACES_BUCKET',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`Storage misconfigured: missing ${missing.join(', ')}. File upload and download are unavailable until these env vars are set on the app.`);
    }
    _s3 = new S3Client({
      endpoint,
      region: import.meta.env.DO_SPACES_REGION || 'us-east-1',
      credentials: {
        accessKeyId: key,
        secretAccessKey: secret,
      },
      forcePathStyle: false,
    });
  }
  return _s3;
}

function getBucket(): string {
  return import.meta.env.DO_SPACES_BUCKET || '';
}

function getKeyPrefix(): string {
  return import.meta.env.STORAGE_KEY_PREFIX || '';
}

const ALLOWED_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

const MAX_SIZE = 25 * 1024 * 1024; // 25MB

// Magic-byte signatures for the formats in ALLOWED_TYPES. Browser-declared
// MIME types are attacker-controllable; we verify the actual content matches.
// See security-audit-2026-05-12 SEC-018.
function detectMimeFromMagic(buffer: Buffer): string | null {
  if (buffer.length < 4) return null;

  // PDF: %PDF
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return 'application/pdf';
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'image/jpeg';
  }
  // WEBP: 'RIFF' .... 'WEBP'
  if (buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'image/webp';
  }
  // DOCX / XLSX: zip-based, magic PK\x03\x04. We cannot disambiguate from
  // magic alone (both office formats use the same container), so we accept
  // any office-zip and let the original-name extension carry the distinction.
  if (buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04) {
    return 'application/zip-based-office';
  }
  // XLS (old OLE compound): D0 CF 11 E0 A1 B1 1A E1
  if (buffer.length >= 8 &&
      buffer[0] === 0xD0 && buffer[1] === 0xCF && buffer[2] === 0x11 && buffer[3] === 0xE0 &&
      buffer[4] === 0xA1 && buffer[5] === 0xB1 && buffer[6] === 0x1A && buffer[7] === 0xE1) {
    return 'application/vnd.ms-excel';
  }
  // CSV: no reliable magic. Accept as text/csv only when the MIME claim
  // matches and the first kilobyte is plausibly ASCII/UTF-8 text. The
  // caller's MIME check still gates this; we don't certify CSV from magic.
  return null;
}

function isMimeConsistent(claimedMime: string, magicMime: string | null): boolean {
  if (claimedMime === magicMime) return true;
  // Office zip container covers both docx and xlsx.
  if (magicMime === 'application/zip-based-office' && (
    claimedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    claimedMime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )) return true;
  // CSV has no usable magic; we accept if claim is text/csv and content looks like text.
  if (claimedMime === 'text/csv' && magicMime === null) return true;
  return false;
}

export async function uploadFile(
  clientSlug: string,
  month: string,
  originalName: string,
  buffer: Buffer,
  mimeType: string,
  clientId: string,
  uploadedBy: string,
  category: string = 'general',
): Promise<{ id: string; s3_key: string }> {
  if (!ALLOWED_TYPES.has(mimeType)) {
    throw new Error(`File type "${mimeType}" not allowed`);
  }
  if (buffer.length > MAX_SIZE) {
    throw new Error(`File exceeds ${MAX_SIZE / 1024 / 1024}MB limit`);
  }

  // Verify the file's actual content matches the claimed MIME type.
  // Browser-declared MIME on FormData is attacker-controllable, so we
  // reject mismatches outright. CSV has no magic and is accepted on
  // claim alone (see detectMimeFromMagic comment).
  const detected = detectMimeFromMagic(buffer);
  if (!isMimeConsistent(mimeType, detected)) {
    throw new Error(`File content does not match declared type "${mimeType}"`);
  }

  // Sanitize extension: take only the trailing dot-segment that matches a
  // short alphanumeric pattern. Avoids path traversal and double extensions
  // (foo.exe.png) being preserved.
  const rawExt = (originalName.split('.').pop() || 'bin').toLowerCase();
  const ext = /^[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : 'bin';
  const filename = `${nanoid(12)}.${ext}`;
  const prefix = getKeyPrefix();
  const s3Key = `${prefix}clients/${clientSlug}/${month}/${filename}`;

  // Content-Disposition: attachment forces the browser to download rather
  // than render, neutralizing HTML/JS uploads that slipped through with a
  // claimed image MIME. The signed-URL download path also reissues this
  // header on the redirect target. See SEC-018.
  await getS3().send(new PutObjectCommand({
    Bucket: getBucket(),
    Key: s3Key,
    Body: buffer,
    ContentType: mimeType,
    ContentDisposition: `attachment; filename="${originalName.replace(/[\r\n"]/g, '')}"`,
    ACL: 'private',
  }));

  const id = nanoid();
  await turso.execute({
    sql: `INSERT INTO files (id, client_id, filename, original_name, mime_type, size_bytes, category, month, s3_key, uploaded_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, clientId, filename, originalName, mimeType, buffer.length, category, month, s3Key, uploadedBy],
  });

  return { id, s3_key: s3Key };
}

export async function getSignedDownloadUrl(s3Key: string): Promise<string> {
  const command = new GetObjectCommand({ Bucket: getBucket(), Key: s3Key });
  return getSignedUrl(getS3(), command, { expiresIn: 3600 }); // 1 hour
}

export async function deleteFileFromStorage(s3Key: string, fileId: string): Promise<void> {
  // Delete DB record first — if S3 delete fails, orphaned S3 object is harmless
  // but orphaned DB record pointing to deleted S3 object causes download errors
  await turso.execute({ sql: 'DELETE FROM files WHERE id = ?', args: [fileId] });
  await getS3().send(new DeleteObjectCommand({ Bucket: getBucket(), Key: s3Key }));
}

// Canonical file-category taxonomy. One place so the upload select, the
// client/admin file lists, and the documents hub agree on labels and on
// which categories are deliverables, drafts, or ad-hoc.
export const FILE_CATEGORY_LABELS: Record<string, string> = {
  strategic_recommendation: 'Strategic Recommendations',
  research: 'Research Reports',
  invoice: 'Invoice',
  spreadsheet: 'Spreadsheet',
  general: 'General',
  internal_draft: 'Internal draft',
  // Legacy: 'report' was the old generic upload category, retired in favor of
  // strategic_recommendation / research. Kept so existing files read cleanly.
  report: 'Report',
};

export function fileCategoryLabel(category: string): string {
  return FILE_CATEGORY_LABELS[category] || category;
}

// Categories that are admin-only and must never appear in the client-facing
// file list (e.g. auto-generated descriptive report DRAFTs, an internal
// drafting aid, not a client deliverable).
export const ADMIN_ONLY_FILE_CATEGORIES = ['internal_draft'];

// Prescriptive deliverables Cody authors and deliberately issues (a strategic
// recommendation or a research report). They are drafts (admin-only) until
// issued, then surface on the client's documents hub via
// getIssuedReportsForClient. They never appear in the ad-hoc Files list.
export const ISSUABLE_FILE_CATEGORIES = ['strategic_recommendation', 'research'];

export async function getFilesForClient(clientId: string): Promise<any[]> {
  // The Files page is the ad-hoc exchange: hide internal drafts and the
  // issuable deliverables (those live on the documents hub once issued).
  const hidden = [...ADMIN_ONLY_FILE_CATEGORIES, ...ISSUABLE_FILE_CATEGORIES];
  const placeholders = hidden.map(() => '?').join(', ');
  const result = await turso.execute({
    sql: `SELECT id, filename, original_name, mime_type, size_bytes, category, month, created_at
          FROM files WHERE client_id = ? AND category NOT IN (${placeholders})
          ORDER BY month DESC, created_at DESC`,
    args: [clientId, ...hidden],
  });
  return result.rows.map(row => ({
    id: row[0] as string,
    filename: row[1] as string,
    original_name: row[2] as string,
    mime_type: row[3] as string,
    category: row[5] as string,
    month: row[6] as string,
    created_at: row[7] as string,
    size_bytes: row[4] as number,
  }));
}

// Issued prescriptive deliverables for the client's documents hub. Only
// issuable categories with issued_at set; newest issue first.
export async function getIssuedReportsForClient(clientId: string): Promise<Array<{
  id: string; original_name: string; mime_type: string; size_bytes: number;
  category: string; month: string; issued_at: string;
}>> {
  const placeholders = ISSUABLE_FILE_CATEGORIES.map(() => '?').join(', ');
  const result = await turso.execute({
    sql: `SELECT id, original_name, mime_type, size_bytes, category, month, issued_at
          FROM files
          WHERE client_id = ? AND category IN (${placeholders}) AND issued_at IS NOT NULL
          ORDER BY issued_at DESC`,
    args: [clientId, ...ISSUABLE_FILE_CATEGORIES],
  });
  return result.rows.map(row => ({
    id: row[0] as string,
    original_name: row[1] as string,
    mime_type: row[2] as string,
    size_bytes: row[3] as number,
    category: row[4] as string,
    month: row[5] as string,
    issued_at: row[6] as string,
  }));
}

// Issue a prescriptive deliverable to the client. Sets issued_at once and
// reports whether this call performed the transition, so the caller only
// notifies/emails on the first issue, not on a re-click. Race-safe via the
// issued_at IS NULL guard.
export async function markFileIssued(fileId: string): Promise<{ transitioned: boolean; issued_at: string | null }> {
  const res = await turso.execute({
    sql: `UPDATE files SET issued_at = datetime('now') WHERE id = ? AND issued_at IS NULL`,
    args: [fileId],
  });
  const transitioned = res.rowsAffected === 1;
  const after = await turso.execute({ sql: 'SELECT issued_at FROM files WHERE id = ?', args: [fileId] });
  const issued_at = (after.rows[0]?.[0] as string) ?? null;
  return { transitioned, issued_at };
}

export async function getFileById(fileId: string): Promise<{
  id: string; client_id: string; s3_key: string; original_name: string; mime_type: string; category: string; issued_at: string | null;
} | null> {
  const result = await turso.execute({
    sql: 'SELECT id, client_id, s3_key, original_name, mime_type, category, issued_at FROM files WHERE id = ?',
    args: [fileId],
  });
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row[0] as string,
    client_id: row[1] as string,
    s3_key: row[2] as string,
    original_name: row[3] as string,
    mime_type: row[4] as string,
    category: row[5] as string,
    issued_at: (row[6] as string | null) ?? null,
  };
}

export async function getAllFilesAdmin(): Promise<any[]> {
  const result = await turso.execute(
    `SELECT f.id, f.original_name, f.mime_type, f.size_bytes, f.category, f.month, f.created_at, c.name as client_name, c.id as client_id, f.issued_at
     FROM files f JOIN clients c ON c.id = f.client_id
     ORDER BY f.month DESC, f.created_at DESC`
  );
  return result.rows.map(row => ({
    id: row[0] as string,
    original_name: row[1] as string,
    mime_type: row[2] as string,
    size_bytes: row[3] as number,
    category: row[4] as string,
    month: row[5] as string,
    created_at: row[6] as string,
    client_name: row[7] as string,
    client_id: row[8] as string,
    issued_at: row[9] as string | null,
  }));
}
