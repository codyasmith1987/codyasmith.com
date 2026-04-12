// Activity logging — audit trail for all portal actions

import { nanoid } from 'nanoid';
import turso from './turso';
import { logger } from './logger';

export interface ActivityParams {
  clientId?: string | null;
  userId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

export async function logActivity(params: ActivityParams): Promise<void> {
  try {
    await turso.execute({
      sql: `INSERT INTO activity_log (id, client_id, user_id, action, entity_type, entity_id, summary, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        nanoid(),
        params.clientId ?? null,
        params.userId ?? null,
        params.action,
        params.entityType,
        params.entityId,
        params.summary,
        params.metadata ? JSON.stringify(params.metadata) : null,
      ],
    });
  } catch (err) {
    // Activity logging should never break the operation it's logging
    logger.error('Failed to log activity', err);
  }
}

export async function getRecentActivity(options: {
  clientId?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{
  entries: Array<{
    id: string;
    client_id: string | null;
    user_id: string | null;
    user_name: string | null;
    action: string;
    entity_type: string;
    entity_id: string;
    summary: string;
    metadata: string | null;
    created_at: string;
  }>;
  total: number;
}> {
  const limit = options.limit || 50;
  const offset = options.offset || 0;

  const where = options.clientId
    ? 'WHERE a.client_id = ?'
    : '';
  const args = options.clientId
    ? [options.clientId, limit, offset]
    : [limit, offset];

  const countArgs = options.clientId ? [options.clientId] : [];

  const [result, countResult] = await Promise.all([
    turso.execute({
      sql: `SELECT a.id, a.client_id, a.user_id, u.name as user_name, a.action, a.entity_type, a.entity_id, a.summary, a.metadata, a.created_at
            FROM activity_log a
            LEFT JOIN users u ON u.id = a.user_id
            ${where}
            ORDER BY a.created_at DESC
            LIMIT ? OFFSET ?`,
      args,
    }),
    turso.execute({
      sql: `SELECT COUNT(*) FROM activity_log a ${where}`,
      args: countArgs,
    }),
  ]);

  return {
    entries: result.rows.map(row => ({
      id: row[0] as string,
      client_id: row[1] as string | null,
      user_id: row[2] as string | null,
      user_name: row[3] as string | null,
      action: row[4] as string,
      entity_type: row[5] as string,
      entity_id: row[6] as string,
      summary: row[7] as string,
      metadata: row[8] as string | null,
      created_at: row[9] as string,
    })),
    total: countResult.rows[0][0] as number,
  };
}
