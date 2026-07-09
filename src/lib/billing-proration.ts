// First-period proration calculator.
//
// Cody's billing rule (2026-05-26): when a site goes live mid-cycle,
// its first invoice covers the partial period from go-live date to the
// engagement's next billing anchor day. Every site under the same
// agreement converges to one monthly cadence so there's one bill and
// one close date per agreement, not N per-site calendars.
//
// Formula:
//   first_period_days = days from goLiveDate (inclusive) to the next
//                       occurrence of anchorDay (exclusive). Wraps to
//                       the following month when goLiveDate.day >= anchorDay
//                       so the first period is never a full month.
//   days_in_anchor_period = days in the calendar month the anchor day
//                           falls inside (typically 28-31).
//   prorated_amount = monthlyFee * (first_period_days / days_in_anchor_period)
//
// Edge cases handled:
//   - anchorDay > days_in_target_month: clamp to last day of that month
//   - goLiveDate.day === anchorDay: full month period for the first cycle
//                                   (treat go-live ON anchor day as the
//                                   start of a full period)
//   - Rounded to cents.
//
// Pure function — no DB, no Date "now". Caller passes the go-live
// timestamp and the agreement's anchor day. Tested in
// tests/run-billing-proration-tests.mjs.

export interface ProrationResult {
  // Cents-rounded first-period fee. Could be more than one month if
  // go-live is more than 30 days before the next anchor day (the formula
  // handles month-wrap automatically).
  prorated_amount: number;
  // Days in the first period (go-live inclusive to next anchor exclusive).
  first_period_days: number;
  // Days in the calendar month the next anchor falls inside (28-31).
  days_in_anchor_period: number;
  // First full billing day after go-live (the anchor day). ISO date string.
  first_full_billing_date: string;
}

function daysInMonth(year: number, monthIdx0: number): number {
  // Day 0 of next month = last day of current month
  return new Date(year, monthIdx0 + 1, 0).getDate();
}

function clampDayInMonth(year: number, monthIdx0: number, day: number): number {
  const dim = daysInMonth(year, monthIdx0);
  return Math.min(day, dim);
}

function toIsoDate(year: number, monthIdx0: number, day: number): string {
  const mm = String(monthIdx0 + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

function parseIsoDateStrict(iso: string): { year: number; monthIdx0: number; day: number } {
  // Accept 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SS...' — only the date
  // portion matters for proration day math.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new Error(`Invalid ISO date for proration: ${iso}`);
  return { year: +m[1], monthIdx0: +m[2] - 1, day: +m[3] };
}

export function proratedFirstPeriod(args: {
  goLiveDate: string;         // ISO date 'YYYY-MM-DD' or with time
  monthlyFee: number;          // dollars
  anchorDay: number;           // 1-31
}): ProrationResult {
  if (!Number.isFinite(args.monthlyFee) || args.monthlyFee < 0) {
    throw new Error('monthlyFee must be a non-negative number');
  }
  if (!Number.isInteger(args.anchorDay) || args.anchorDay < 1 || args.anchorDay > 31) {
    throw new Error('anchorDay must be an integer between 1 and 31');
  }
  const { year, monthIdx0, day } = parseIsoDateStrict(args.goLiveDate);

  // Find the next billing anchor on or after the day AFTER go-live.
  // If go-live is BEFORE anchorDay this month, next anchor is this month.
  // If on or after, next anchor is next month. (Go-live ON the anchor day
  // is treated as the start of a full period; first period = 0 days no
  // proration; first invoice covers a full month.)
  let nextY = year;
  let nextM = monthIdx0;
  let nextD = clampDayInMonth(year, monthIdx0, args.anchorDay);
  if (day >= nextD) {
    // Roll to next month's clamped anchor
    nextM += 1;
    if (nextM > 11) { nextM = 0; nextY += 1; }
    nextD = clampDayInMonth(nextY, nextM, args.anchorDay);
  }

  // Days from go-live (inclusive) to next anchor (exclusive). Inclusive
  // of go-live day because the site is under management from that day;
  // exclusive of anchor day because anchor day is the start of the next
  // full period (next invoice).
  const goLiveJsDate = new Date(year, monthIdx0, day);
  const nextAnchorJsDate = new Date(nextY, nextM, nextD);
  const msPerDay = 24 * 60 * 60 * 1000;
  const first_period_days = Math.round((nextAnchorJsDate.getTime() - goLiveJsDate.getTime()) / msPerDay);

  // Period length = days in the month containing the next anchor.
  // (Could pick the month containing go-live; we pick anchor month so
  // the daily rate matches the upcoming full period.)
  const days_in_anchor_period = daysInMonth(nextY, nextM);

  // Proration. Round to cents.
  const raw = args.monthlyFee * (first_period_days / days_in_anchor_period);
  const prorated_amount = Math.round(raw * 100) / 100;

  return {
    prorated_amount,
    first_period_days,
    days_in_anchor_period,
    first_full_billing_date: toIsoDate(nextY, nextM, nextD),
  };
}
