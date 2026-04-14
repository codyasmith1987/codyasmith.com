// Contract-declared rules: passthrough expense classification and
// reminder tick ladder. Both are stored as JSON on the contracts row
// (migration 017) and drive the expense and billing engines.
//
// Pure functions only. The DB I/O helpers at the bottom read the
// contract row and return a typed rule object. Everything else is
// input/output over plain values so tests can exercise the logic
// without a database.

import turso from './turso';

// ---------- PassthroughRule ----------

export interface PassthroughCategory {
  name: string;
  monthly_cap: number | null; // null means unlimited
  auto_bill_under_cap: boolean;
  flag_over_cap: boolean;
}

export type PassthroughDefaultAction = 'manual_review' | 'auto_bill' | 'block';

export interface PassthroughRule {
  categories: PassthroughCategory[];
  default_action: PassthroughDefaultAction;
}

export const DEFAULT_PASSTHROUGH_RULE: PassthroughRule = {
  categories: [],
  default_action: 'manual_review',
};

// Parses untrusted input into a PassthroughRule. Returns null on any
// structural failure so the route handler can 400 the request cleanly.
// Accepts `null`/`undefined` as "no rule" (returns null, caller treats
// as "leave column null").
export function parsePassthroughRule(raw: unknown): PassthroughRule | null | 'absent' {
  if (raw == null) return 'absent';
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const defaultAction = r.default_action;
  if (
    defaultAction !== 'manual_review' &&
    defaultAction !== 'auto_bill' &&
    defaultAction !== 'block'
  ) {
    return null;
  }

  if (!Array.isArray(r.categories)) return null;
  const seenNames = new Set<string>();
  const categories: PassthroughCategory[] = [];
  for (const c of r.categories) {
    if (!c || typeof c !== 'object') return null;
    const cat = c as Record<string, unknown>;
    if (typeof cat.name !== 'string') return null;
    const name = cat.name.trim();
    if (name.length === 0 || name.length > 64) return null;
    if (seenNames.has(name)) return null;
    seenNames.add(name);

    let monthlyCap: number | null = null;
    if (cat.monthly_cap !== null && cat.monthly_cap !== undefined) {
      const n = Number(cat.monthly_cap);
      if (!Number.isFinite(n) || n < 0) return null;
      monthlyCap = n;
    }

    if (typeof cat.auto_bill_under_cap !== 'boolean') return null;
    if (typeof cat.flag_over_cap !== 'boolean') return null;

    categories.push({
      name,
      monthly_cap: monthlyCap,
      auto_bill_under_cap: cat.auto_bill_under_cap,
      flag_over_cap: cat.flag_over_cap,
    });
  }

  return { categories, default_action: defaultAction as PassthroughDefaultAction };
}

export type ExpenseClassification =
  | 'auto_bill'
  | 'needs_approval'
  | 'manual_review'
  | 'blocked';

export interface ClassifyExpenseResult {
  classification: ExpenseClassification;
  needs_approval: boolean;
  reason: string;
}

// Pure classifier. Takes the inputs the caller has already assembled
// (category, amount, month-to-date already classified in that category)
// and returns the classification plus a short human reason the test
// and the admin UI can display.
export function classifyExpense(params: {
  amount: number;
  category: string | null | undefined;
  monthToDateInCategory: number;
  rule: PassthroughRule | null;
}): ClassifyExpenseResult {
  const { amount, monthToDateInCategory } = params;
  const rule = params.rule ?? DEFAULT_PASSTHROUGH_RULE;
  const category = params.category?.trim() || null;

  if (!category) {
    return {
      classification: rule.default_action,
      needs_approval: rule.default_action === 'manual_review' || rule.default_action === 'block',
      reason: 'no category → default action',
    };
  }

  const cat = rule.categories.find((c) => c.name === category);
  if (!cat) {
    return {
      classification: rule.default_action,
      needs_approval: rule.default_action === 'manual_review' || rule.default_action === 'block',
      reason: `category "${category}" not in rule → default action`,
    };
  }

  const wouldBe = monthToDateInCategory + amount;
  const overCap = cat.monthly_cap !== null && wouldBe > cat.monthly_cap;

  if (overCap) {
    if (cat.flag_over_cap) {
      return {
        classification: 'needs_approval',
        needs_approval: true,
        reason: `category "${category}" cap $${cat.monthly_cap} would be exceeded (MTD $${monthToDateInCategory.toFixed(2)} + $${amount.toFixed(2)} = $${wouldBe.toFixed(2)})`,
      };
    }
    // Over cap but not flagged — still auto-bill
    return {
      classification: cat.auto_bill_under_cap ? 'auto_bill' : 'manual_review',
      needs_approval: false,
      reason: `category "${category}" over cap but not flagged`,
    };
  }

  if (cat.auto_bill_under_cap) {
    return {
      classification: 'auto_bill',
      needs_approval: false,
      reason: `category "${category}" within cap, auto-bill`,
    };
  }

  return {
    classification: 'manual_review',
    needs_approval: false,
    reason: `category "${category}" within cap but manual-only`,
  };
}

// ---------- ReminderRule ----------

export interface ReminderRule {
  before_due_days: number[]; // descending is canonical on read
  after_due_days: number[]; // ascending is canonical on read
  escalation_after_days?: number;
  digest?: 'none' | 'weekly';
}

// Same fallback the old sendDueReminders used: single 3-day-before
// reminder plus soft-escalate at 3 and 7 days past due.
export const DEFAULT_REMINDER_RULE: ReminderRule = {
  before_due_days: [3],
  after_due_days: [3, 7],
};

export function parseReminderRule(raw: unknown): ReminderRule | null | 'absent' {
  if (raw == null) return 'absent';
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const validDayArray = (v: unknown): number[] | null => {
    if (!Array.isArray(v)) return null;
    const out: number[] = [];
    for (const item of v) {
      const n = Number(item);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 365) return null;
      if (!out.includes(n)) out.push(n);
    }
    return out;
  };

  const before = validDayArray(r.before_due_days);
  const after = validDayArray(r.after_due_days);
  if (before === null || after === null) return null;

  let escalation: number | undefined;
  if (r.escalation_after_days !== undefined && r.escalation_after_days !== null) {
    const n = Number(r.escalation_after_days);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 365) return null;
    escalation = n;
  }

  let digest: 'none' | 'weekly' | undefined;
  if (r.digest !== undefined && r.digest !== null) {
    if (r.digest !== 'none' && r.digest !== 'weekly') return null;
    digest = r.digest;
  }

  return {
    before_due_days: [...before].sort((a, b) => b - a),
    after_due_days: [...after].sort((a, b) => a - b),
    ...(escalation !== undefined ? { escalation_after_days: escalation } : {}),
    ...(digest !== undefined ? { digest } : {}),
  };
}

// Given a due date, "now", and the set of ticks already sent for this
// invoice, returns the tick key to fire next (or null if nothing is
// due). Deterministic; one tick per call — the caller runs the
// reminder job on a schedule and picks up subsequent ticks over time.
//
// Tick naming: 'before:<N>' for N days before due, 'after:<N>' for N
// days past due. Stored as strings in reminder_ticks_sent_json.
export function nextReminderTick(params: {
  dueDate: string; // 'YYYY-MM-DD'
  now: Date;
  rule: ReminderRule;
  sentTicks: string[];
}): string | null {
  const [y, m, d] = params.dueDate.split('-').map(Number);
  if (!y || !m || !d) return null;
  const dueMs = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  const todayMs = Date.UTC(
    params.now.getUTCFullYear(),
    params.now.getUTCMonth(),
    params.now.getUTCDate(),
    0,
    0,
    0,
    0
  );
  const daysUntil = Math.floor((dueMs - todayMs) / 86400000);
  const sentSet = new Set(params.sentTicks);

  // Unified semantic: fire the unfired tick for the most recent
  // "phase" we're currently in. Phases ladder toward the due date on
  // the before side and away from it on the after side, so the
  // directions differ.
  if (daysUntil >= 0) {
    // Before due: iterate ASCENDING and return the first unfired tick
    // whose window contains daysUntil. Ascending order means we hit
    // the tightest-fitting tick first (e.g. at daysUntil=0 with nothing
    // sent, fire before:1 rather than catch-up-claiming before:7).
    const beforeAsc = [...params.rule.before_due_days].sort((a, b) => a - b);
    for (const tick of beforeAsc) {
      if (daysUntil <= tick && !sentSet.has(`before:${tick}`)) {
        return `before:${tick}`;
      }
    }
    return null;
  }

  // After due: iterate DESCENDING and return the first unfired tick
  // we've crossed. Descending order means we hit the "most honest"
  // tick about how late we are (e.g. at daysPast=5 with nothing sent,
  // fire after:3 rather than claiming after:1 is the news).
  const daysPast = -daysUntil;
  const afterDesc = [...params.rule.after_due_days].sort((a, b) => b - a);
  for (const tick of afterDesc) {
    if (daysPast >= tick && !sentSet.has(`after:${tick}`)) {
      return `after:${tick}`;
    }
  }
  return null;
}

// ---------- DB I/O helpers ----------

async function getRuleJson(
  contractId: string,
  column: 'passthrough_rule_json' | 'reminder_rule_json'
): Promise<string | null> {
  const r = await turso.execute({
    sql: `SELECT ${column} FROM contracts WHERE id = ?`,
    args: [contractId],
  });
  if (r.rows.length === 0) return null;
  return (r.rows[0][0] as string | null) ?? null;
}

export async function getContractPassthroughRule(
  contractId: string
): Promise<PassthroughRule | null> {
  const json = await getRuleJson(contractId, 'passthrough_rule_json');
  if (!json) return null;
  try {
    const parsed = parsePassthroughRule(JSON.parse(json));
    if (parsed === null || parsed === 'absent') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function getContractReminderRule(
  contractId: string
): Promise<ReminderRule | null> {
  const json = await getRuleJson(contractId, 'reminder_rule_json');
  if (!json) return null;
  try {
    const parsed = parseReminderRule(JSON.parse(json));
    if (parsed === null || parsed === 'absent') return null;
    return parsed;
  } catch {
    return null;
  }
}

// Month-to-date sum of auto_bill-classified pending_charges for a
// (contract, category) pair that have not been billed yet. Used by
// the expense POST handler as input to classifyExpense so over-cap
// checks use real state rather than the caller's optimistic guess.
export async function getMonthToDateInCategory(
  contractId: string,
  category: string
): Promise<number> {
  const r = await turso.execute({
    sql: `SELECT COALESCE(SUM(amount), 0) FROM pending_charges
          WHERE contract_id = ?
            AND category = ?
            AND classification = 'auto_bill'
            AND billed_invoice_id IS NULL`,
    args: [contractId, category],
  });
  return Number(r.rows[0][0] ?? 0);
}
