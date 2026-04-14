// Period locking — makes periods.locked_at real.
//
// The periods table was introduced in migration 012 with a
// locked_at column that until this slice was dead storage. Slice 16
// wires it up so:
//
//   - ingest-v2 refuses to mutate a locked period
//   - admins can lock / unlock explicitly
//   - admin queue surfaces every currently locked row
//
// Lock semantics:
//   locked_at IS NULL     → unlocked, writes allowed
//   locked_at IS NOT NULL → locked, the timestamp is when it was
//                           frozen. Stays locked until an admin
//                           explicitly unlocks.
//
// No auto-lock on age, no bulk unlock, no per-role override — every
// transition is a deliberate admin action. The activity_log captures
// who did it and when.

import turso from './turso';

export interface Period {
  id: string;
  client_id: string;
  period_type: string;
  period_start: string;
  period_end: string;
  locked_at: string | null;
  created_at: string;
}

export async function getPeriodById(id: string): Promise<Period | null> {
  const r = await turso.execute({
    sql: `SELECT id, client_id, period_type, period_start, period_end, locked_at, created_at
          FROM periods WHERE id = ?`,
    args: [id],
  });
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    id: row[0] as string,
    client_id: row[1] as string,
    period_type: row[2] as string,
    period_start: row[3] as string,
    period_end: row[4] as string,
    locked_at: (row[5] as string | null) ?? null,
    created_at: row[6] as string,
  };
}

// Cheap single-column read. Returns false for nonexistent periods
// so a missing period doesn't mask a different error upstream.
export async function isPeriodLocked(periodId: string): Promise<boolean> {
  const r = await turso.execute({
    sql: `SELECT locked_at FROM periods WHERE id = ?`,
    args: [periodId],
  });
  if (r.rows.length === 0) return false;
  return (r.rows[0][0] as string | null) != null;
}

export class PeriodLockConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeriodLockConflictError';
  }
}

// Locks a period. Throws PeriodLockConflictError if the period is
// already locked so the caller can return 409 without guessing the
// semantics. Throws a plain Error if the period does not exist.
export async function lockPeriod(
  periodId: string
): Promise<{ locked_at: string }> {
  const current = await getPeriodById(periodId);
  if (!current) throw new Error(`period ${periodId} not found`);
  if (current.locked_at !== null) {
    throw new PeriodLockConflictError(
      `period ${periodId} is already locked (locked_at=${current.locked_at})`
    );
  }
  const nowIso = new Date().toISOString().replace('T', ' ').replace('Z', '').split('.')[0];
  await turso.execute({
    sql: `UPDATE periods SET locked_at = ? WHERE id = ?`,
    args: [nowIso, periodId],
  });
  return { locked_at: nowIso };
}

export async function unlockPeriod(periodId: string): Promise<{ was_locked_at: string }> {
  const current = await getPeriodById(periodId);
  if (!current) throw new Error(`period ${periodId} not found`);
  if (current.locked_at === null) {
    throw new PeriodLockConflictError(
      `period ${periodId} is not locked`
    );
  }
  const was = current.locked_at;
  await turso.execute({
    sql: `UPDATE periods SET locked_at = NULL WHERE id = ?`,
    args: [periodId],
  });
  return { was_locked_at: was };
}

// Returns every currently locked period in reverse lock order.
// Used by admin-queue to surface the locked_periods section.
export async function getLockedPeriods(): Promise<
  Array<Period & { client_name: string }>
> {
  const r = await turso.execute({
    sql: `SELECT p.id, p.client_id, p.period_type, p.period_start, p.period_end,
                 p.locked_at, p.created_at, c.name
          FROM periods p
          JOIN clients c ON c.id = p.client_id
          WHERE p.locked_at IS NOT NULL
          ORDER BY p.locked_at DESC`,
  });
  return r.rows.map((row) => ({
    id: row[0] as string,
    client_id: row[1] as string,
    period_type: row[2] as string,
    period_start: row[3] as string,
    period_end: row[4] as string,
    locked_at: row[5] as string,
    created_at: row[6] as string,
    client_name: row[7] as string,
  }));
}
