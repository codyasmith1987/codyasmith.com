// "Request a data update" usage + the twice-a-month cap.
//
// Each press of the request button on a live page logs one row. The cap is
// per client per calendar month (total across sources, not per source):
// twice a month is plenty, and it keeps the pings from piling up. The count
// lives in its own table (not the 1-hour portal_rate_limits window, whose
// cleanup would wipe a monthly tally) so it survives the month.

import turso from './turso';
import { nanoid } from 'nanoid';

export const MONTHLY_REQUEST_LIMIT = 2;

// Current calendar month as YYYY-MM (UTC). The cap resets at month start.
function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export interface RequestUsage {
  used: number;
  limit: number;
  remaining: number;
  month: string;
}

export async function getRequestUsage(clientId: string): Promise<RequestUsage> {
  const month = currentMonth();
  const res = await turso.execute({
    sql: 'SELECT COUNT(*) FROM data_update_requests WHERE client_id = ? AND month = ?',
    args: [clientId, month],
  });
  const used = Number(res.rows[0]?.[0] ?? 0);
  const remaining = Math.max(0, MONTHLY_REQUEST_LIMIT - used);
  return { used, limit: MONTHLY_REQUEST_LIMIT, remaining, month };
}

export async function recordRequest(args: { clientId: string; source: string; requestedByName: string }): Promise<void> {
  await turso.execute({
    sql: `INSERT INTO data_update_requests (id, client_id, source, month, requested_by_name)
          VALUES (?, ?, ?, ?, ?)`,
    args: [nanoid(), args.clientId, args.source, currentMonth(), args.requestedByName],
  });
}
