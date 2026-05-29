// Pure window slicing for the GSC daily time-series.
//
// The Performance Summary compares date-range windows that do NOT align
// with the upload's month partition (a 30-day "month two" search window,
// a pre-engagement baseline, weekly trajectory buckets). All slicing is
// done here in pure code over the daily rows, by ISO date-string compare,
// rather than in SQL, because the upload month bucket is not the report
// window and the daily-row date format must be validated first.

export interface GscDailyRow {
  date: string | null;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
}

export interface WindowSpec {
  label: string;
  start: string;        // inclusive ISO date YYYY-MM-DD
  endExclusive: string; // exclusive ISO date YYYY-MM-DD
}

export interface WindowAgg {
  label: string;
  days: number;                    // count of daily rows present in range (honest per-day denominator)
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;              // sumClicks / sumImpressions (not the mean of daily CTRs)
  weightedPosition: number | null; // impression-weighted mean position
  first: string | null;
  last: string | null;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

// Every non-null date must be ISO YYYY-MM-DD for string-range slicing to be
// correct. If any are not, the caller must abort the arc rather than emit
// garbage windows.
export function datesAreIso(rows: GscDailyRow[]): boolean {
  return rows.every(r => r.date === null || ISO_RE.test(r.date));
}

export function aggregateWindow(rows: GscDailyRow[], spec: WindowSpec): WindowAgg {
  const sel = rows.filter(r => r.date !== null && r.date >= spec.start && r.date < spec.endExclusive);
  if (sel.length === 0) {
    return { label: spec.label, days: 0, clicks: null, impressions: null, ctr: null, weightedPosition: null, first: null, last: null };
  }
  let clicks = 0;
  let impressions = 0;
  let weightedPosNum = 0; // sum(position * impressions)
  let weightedPosDen = 0; // sum(impressions) over rows with a position
  let posSum = 0;         // fallback unweighted
  let posCount = 0;
  for (const r of sel) {
    clicks += r.clicks ?? 0;
    impressions += r.impressions ?? 0;
    if (r.position !== null) {
      posSum += r.position;
      posCount += 1;
      if (r.impressions !== null && r.impressions > 0) {
        weightedPosNum += r.position * r.impressions;
        weightedPosDen += r.impressions;
      }
    }
  }
  const ctr = impressions > 0 ? clicks / impressions : null;
  const weightedPosition = weightedPosDen > 0
    ? weightedPosNum / weightedPosDen
    : (posCount > 0 ? posSum / posCount : null);
  const dates = sel.map(r => r.date!).sort();
  return {
    label: spec.label,
    days: sel.length,
    clicks,
    impressions,
    ctr,
    weightedPosition,
    first: dates[0],
    last: dates[dates.length - 1],
  };
}

// Add N days to an ISO date string. Pure (no Date.now); constructs from the
// explicit parts so it is timezone-stable.
function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

// Best contiguous 7-day clicks window anchored on each present date within
// [rangeStart, rangeEndExclusive). Returns null if no rows fall in range.
export function peakWeek(rows: GscDailyRow[], rangeStart: string, rangeEndExclusive: string): WindowAgg | null {
  const inRange = rows.filter(r => r.date !== null && r.date >= rangeStart && r.date < rangeEndExclusive);
  if (inRange.length === 0) return null;
  let best: WindowAgg | null = null;
  for (const r of inRange) {
    const start = r.date!;
    const end = addDaysIso(start, 7);
    // Clamp the 7-day candidate to the range so an anchor near the end does
    // not sum dates outside [rangeStart, rangeEndExclusive).
    const clampedEnd = end < rangeEndExclusive ? end : rangeEndExclusive;
    const agg = aggregateWindow(rows, { label: `Week of ${start}`, start, endExclusive: clampedEnd });
    if (agg.clicks !== null && (best === null || (agg.clicks ?? 0) > (best.clicks ?? 0))) {
      best = agg;
    }
  }
  return best;
}

// Trailing weekly buckets, Monday-anchored, most-recent first. Used for the
// GSC weekly trajectory table.
export function weeklyBuckets(rows: GscDailyRow[], weeks: number): WindowAgg[] {
  const dated = rows.filter(r => r.date !== null).map(r => r.date!) as string[];
  if (dated.length === 0) return [];
  const last = dated.sort()[dated.length - 1];
  // Monday of the week containing `last`.
  const [y, m, d] = last.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0=Sun..6=Sat
  const offsetToMonday = (dow + 6) % 7; // days since Monday
  const lastMonday = addDaysIso(last, -offsetToMonday);
  const out: WindowAgg[] = [];
  for (let i = 0; i < weeks; i++) {
    const start = addDaysIso(lastMonday, -7 * i);
    const end = addDaysIso(start, 7);
    const agg = aggregateWindow(rows, { label: `Week of ${start}`, start, endExclusive: end });
    if (agg.days > 0) out.push(agg);
  }
  return out;
}
