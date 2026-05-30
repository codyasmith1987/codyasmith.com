// Notifications — in-app notification system for admin and client users

import { nanoid } from 'nanoid';
import turso from './turso';

// --- Query helpers ---

async function queryOne(sql: string, args: any[] = []): Promise<any | undefined> {
  const result = await turso.execute({ sql, args });
  if (result.rows.length === 0) return undefined;
  return Object.fromEntries(result.columns.map((col, i) => [col, result.rows[0][i]]));
}

async function queryAll(sql: string, args: any[] = []): Promise<any[]> {
  const result = await turso.execute({ sql, args });
  return result.rows.map(row =>
    Object.fromEntries(result.columns.map((col, i) => [col, row[i]]))
  );
}

// ============================================================
// Notifications
// ============================================================

export type NotificationType =
  | 'approval_requested'
  | 'approval_responded'
  | 'milestone_completed'
  | 'invoice_sent'
  | 'payment_received'
  | 'change_order_submitted'
  | 'change_order_approved'
  | 'task_completed'
  | 'data_update_requested'
  | 'general';

export interface Notification {
  id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  entity_type: string | null;
  entity_id: string | null;
  read: number;
  read_at: string | null;
  created_at: string;
}

export async function createNotification(data: {
  user_id: string;
  type: NotificationType;
  title: string;
  body?: string;
  entity_type?: string;
  entity_id?: string;
}): Promise<string> {
  const id = nanoid();
  await turso.execute({
    sql: `INSERT INTO notifications (id, user_id, type, title, body, entity_type, entity_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, data.user_id, data.type, data.title,
      data.body ?? null, data.entity_type ?? null, data.entity_id ?? null,
    ],
  });
  return id;
}

export async function getNotifications(userId: string, limit = 50): Promise<Notification[]> {
  return queryAll(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    [userId, limit]
  );
}

export async function getUnreadNotifications(userId: string): Promise<Notification[]> {
  return queryAll(
    'SELECT * FROM notifications WHERE user_id = ? AND read = 0 ORDER BY created_at DESC',
    [userId]
  );
}

export async function getUnreadCount(userId: string): Promise<number> {
  const row = await queryOne(
    'SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND read = 0',
    [userId]
  );
  return row?.cnt ?? 0;
}

export async function markAsRead(id: string, userId: string): Promise<void> {
  // Scope the update to the calling user so notifications belonging to
  // another account cannot be silently dismissed (IDOR mitigation).
  await turso.execute({
    sql: "UPDATE notifications SET read = 1, read_at = datetime('now') WHERE id = ? AND user_id = ?",
    args: [id, userId],
  });
}

export async function markAllAsRead(userId: string): Promise<void> {
  await turso.execute({
    sql: "UPDATE notifications SET read = 1, read_at = datetime('now') WHERE user_id = ? AND read = 0",
    args: [userId],
  });
}

export async function deleteNotification(id: string, userId: string): Promise<void> {
  // Scope to owner; protects against IDOR if a delete endpoint is ever exposed.
  await turso.execute({
    sql: 'DELETE FROM notifications WHERE id = ? AND user_id = ?',
    args: [id, userId],
  });
}
