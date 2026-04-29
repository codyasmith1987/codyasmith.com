import { nanoid } from 'nanoid';
import turso from './turso';
import { logger } from './logger';

interface RequestLogParams {
  path: string;
  method: string;
  referrer: string | null;
  userAgent: string | null;
  country: string | null;
  statusCode: number;
}

const ASSET_RE = /\.(css|js|svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?|ttf|eot|map|xml|txt|json)$/i;

export function shouldLog(pathname: string): boolean {
  if (pathname.startsWith('/portal')) return false;
  if (pathname.startsWith('/_astro/')) return false;
  if (pathname.startsWith('/_image')) return false;
  if (ASSET_RE.test(pathname)) return false;
  return true;
}

export async function logRequest(params: RequestLogParams): Promise<void> {
  try {
    await turso.execute({
      sql: `INSERT INTO request_log (id, path, method, referrer, user_agent, country, status_code)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        nanoid(),
        params.path,
        params.method,
        params.referrer,
        params.userAgent,
        params.country,
        params.statusCode,
      ],
    });
  } catch (err) {
    logger.error('Failed to log request', err);
  }
}
