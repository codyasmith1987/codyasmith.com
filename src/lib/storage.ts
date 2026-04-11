import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { nanoid } from 'nanoid';
import turso from './turso';

let _s3: S3Client | null = null;
function getS3(): S3Client {
  if (!_s3) {
    _s3 = new S3Client({
      endpoint: import.meta.env.DO_SPACES_ENDPOINT,
      region: import.meta.env.DO_SPACES_REGION || 'us-east-1',
      credentials: {
        accessKeyId: import.meta.env.DO_SPACES_KEY,
        secretAccessKey: import.meta.env.DO_SPACES_SECRET,
      },
      forcePathStyle: false,
    });
  }
  return _s3;
}

function getBucket(): string {
  return import.meta.env.DO_SPACES_BUCKET || '';
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

  const ext = originalName.split('.').pop() || 'bin';
  const filename = `${nanoid(12)}.${ext}`;
  const s3Key = `clients/${clientSlug}/${month}/${filename}`;

  await getS3().send(new PutObjectCommand({
    Bucket: getBucket(),
    Key: s3Key,
    Body: buffer,
    ContentType: mimeType,
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

export async function getFilesForClient(clientId: string): Promise<any[]> {
  const result = await turso.execute({
    sql: `SELECT id, filename, original_name, mime_type, size_bytes, category, month, created_at
          FROM files WHERE client_id = ? ORDER BY month DESC, created_at DESC`,
    args: [clientId],
  });
  return result.rows.map(row => ({
    id: row[0] as string,
    filename: row[1] as string,
    original_name: row[2] as string,
    mime_type: row[3] as string,
    size_bytes: row[4] as number,
    category: row[5] as string,
    month: row[6] as string,
    created_at: row[7] as string,
  }));
}

export async function getFileById(fileId: string): Promise<{
  id: string; client_id: string; s3_key: string; original_name: string; mime_type: string;
} | null> {
  const result = await turso.execute({
    sql: 'SELECT id, client_id, s3_key, original_name, mime_type FROM files WHERE id = ?',
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
  };
}

export async function getAllFilesAdmin(): Promise<any[]> {
  const result = await turso.execute(
    `SELECT f.id, f.original_name, f.mime_type, f.size_bytes, f.category, f.month, f.created_at, c.name as client_name, c.id as client_id
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
  }));
}
