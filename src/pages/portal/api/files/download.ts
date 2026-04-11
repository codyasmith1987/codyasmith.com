import type { APIRoute } from 'astro';
import { getFileById, getSignedDownloadUrl } from '../../../../lib/storage';

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

  // Auth check — defense in depth (middleware should catch this, but verify)
  if (!locals.user) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Clients can only download their own files
  if (locals.user.role !== 'admin' && locals.user.client_id !== file.client_id) {
    return new Response('Forbidden', { status: 403 });
  }

  const signedUrl = await getSignedDownloadUrl(file.s3_key);
  return Response.redirect(signedUrl, 302);
};
