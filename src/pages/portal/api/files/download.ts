import type { APIRoute } from 'astro';
import { getFileById, getSignedDownloadUrl, ADMIN_ONLY_FILE_CATEGORIES } from '../../../../lib/storage';

export const prerender = false;

export const GET: APIRoute = async ({ locals, url }) => {
  const fileId = url.searchParams.get('id');
  if (!fileId) {
    return new Response('Missing file ID', { status: 400 });
  }

  const file = await getFileById(fileId);
  if (!file) {
    return new Response('File not found', { status: 404 });
  }

  // Auth check, defense in depth (middleware should catch this, but verify).
  if (!locals.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Clients can only download their own files.
  if (locals.user.role !== 'admin' && locals.user.client_id !== file.client_id) {
    return new Response('Forbidden', { status: 403 });
  }

  // Object-level draft gate: admin-only categories (e.g. internal_draft
  // descriptive reports) must never be downloadable by a client, even with a
  // direct file id. Matches the list-level exclusion in getFilesForClient.
  if (locals.user.role !== 'admin' && ADMIN_ONLY_FILE_CATEGORIES.includes(file.category)) {
    return new Response('Forbidden', { status: 403 });
  }

  const signedUrl = await getSignedDownloadUrl(file.s3_key);
  // Force no-referrer on the 302 specifically so the signed URL (which
  // embeds an HMAC signature in the query string) does not leak to S3
  // through Referer when the browser follows the redirect. See
  // security-audit-2026-05-12 SEC-017.
  return new Response(null, {
    status: 302,
    headers: {
      Location: signedUrl,
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'private, no-store',
    },
  });
};
