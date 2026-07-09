// Deterministic period-over-period delta math for monthly reports.
//
// Pure, DB-free, no Date.now(). This is the accuracy win that retires the
// manual validation pass: every month-over-month change in a generated
// report is computed here, once, the same way, instead of being typed by
// hand and re-checked. Counts, rates, and search position each have their
// own direction semantics (lower position is better). Missing-prior cases
// never fabricate a delta: a null prior yields a null percent, never a
// "+Infinity%" or "-100%".

export type Direction = 'improved' | 'worsened' | 'flat' | 'new' | 'none';
export type MetricKind = 'count' | 'rate' | 'position';

export interface Delta {
  prior: number | null;
  current: number | null;
  absoluteChange: number | null; // current - prior
  percentChange: number | null;  // (current - prior) / prior; null if prior is null/0
  direction: Direction;
  isNew: boolean;                // prior absent/zero-with-no-data, current present
}

const DEFAULT_FLAT = 0.005; // within +/-0.5% reads as flat

export function computeDelta(
  prior: number | null,
  current: number | null,
  opts: { metricKind?: MetricKind; flatThreshold?: number } = {},
): Delta {
  const metricKind = opts.metricKind ?? 'count';
  const flatThreshold = opts.flatThreshold ?? DEFAULT_FLAT;

  const hasPrior = prior !== null && prior !== undefined;
  const hasCurrent = current !== null && current !== undefined;
  // "new" means it appeared this period with actual activity. A current of
  // exactly 0 with no prior is not "new" (nothing happened), so it is not
  // labeled new.
  const isNew = !hasPrior && hasCurrent && current !== 0;

  const absoluteChange = hasPrior && hasCurrent ? current! - prior! : null;
  const percentChange = hasPrior && hasCurrent && prior !== 0
    ? (current! - prior!) / prior!
    : null;

  let direction: Direction;
  if (isNew) {
    direction = 'new';
  } else if (!hasPrior && !hasCurrent) {
    direction = 'none';
  } else if (metricKind === 'position') {
    // Lower position is better. Use the absolute change, since percent is
    // not meaningful for rank.
    if (absoluteChange === null) direction = 'none';
    else if (Math.abs(absoluteChange) < (opts.flatThreshold ?? 0.05)) direction = 'flat';
    else direction = absoluteChange < 0 ? 'improved' : 'worsened';
  } else if (percentChange !== null) {
    if (Math.abs(percentChange) < flatThreshold) direction = 'flat';
    else direction = percentChange > 0 ? 'improved' : 'worsened';
  } else if (absoluteChange !== null) {
    // Prior was 0, so percent is undefined, but the absolute move still
    // tells the direction (e.g. 0 -> 90 clicks is an increase, not "none").
    if (absoluteChange === 0) direction = 'flat';
    else direction = absoluteChange > 0 ? 'improved' : 'worsened';
  } else {
    direction = 'none';
  }

  return { prior: hasPrior ? prior! : null, current: hasCurrent ? current! : null, absoluteChange, percentChange, direction, isNew };
}

export interface WindowTotals {
  label: string;
  days: number;
  clicks: number | null;
  impressions: number | null;
}

export interface PerDay {
  clicksPerDay: number | null;
  impressionsPerDay: number | null;
}

export function perDay(w: WindowTotals): PerDay {
  return {
    clicksPerDay: w.days > 0 && w.clicks !== null ? w.clicks / w.days : null,
    impressionsPerDay: w.days > 0 && w.impressions !== null ? w.impressions / w.days : null,
  };
}

export interface DualDelta {
  absolute: Delta; // on raw period totals
  perDay: Delta;   // on day-normalized values (fair when windows differ in length)
}

// Compare two windows on a count metric, reporting both the raw period
// change and the per-day change. Windows often differ in length (a 31-day
// month vs a 28-day window), so the per-day figure is the honest one.
export function dualDelta(prior: WindowTotals, current: WindowTotals, metric: 'clicks' | 'impressions'): DualDelta {
  const absolute = computeDelta(prior[metric], current[metric], { metricKind: 'count' });
  const pPrior = perDay(prior)[`${metric}PerDay` as keyof PerDay];
  const pCurr = perDay(current)[`${metric}PerDay` as keyof PerDay];
  const perDayDelta = computeDelta(pPrior, pCurr, { metricKind: 'count' });
  return { absolute, perDay: perDayDelta };
}

export interface CtrDelta {
  priorPct: number | null;     // prior CTR as a percentage (0..100)
  currentPct: number | null;
  pointDelta: number | null;   // percentage-POINT change (currentPct - priorPct)
  relativePercent: number | null; // relative change of the underlying rate
}

// CTR is stored as a 0..1 fraction. Report it as a percentage, and express
// its change two ways: percentage points (the literal point move) and
// relative percent (how much the rate itself moved).
export function ctrDelta(priorCtr: number | null, currentCtr: number | null): CtrDelta {
  const hasPrior = priorCtr !== null && priorCtr !== undefined;
  const hasCurrent = currentCtr !== null && currentCtr !== undefined;
  const priorPct = hasPrior ? priorCtr! * 100 : null;
  const currentPct = hasCurrent ? currentCtr! * 100 : null;
  const pointDelta = hasPrior && hasCurrent ? currentPct! - priorPct! : null;
  const relativePercent = hasPrior && hasCurrent && priorCtr !== 0
    ? (currentCtr! - priorCtr!) / priorCtr!
    : null;
  return { priorPct, currentPct, pointDelta, relativePercent };
}

// Convenience: search position delta (lower is better).
export function positionDelta(prior: number | null, current: number | null): Delta {
  return computeDelta(prior, current, { metricKind: 'position' });
}

// The report bolds material moves. Default threshold is +/-25% per-day.
export function shouldBold(percentChange: number | null, threshold = 0.25): boolean {
  return percentChange !== null && Math.abs(percentChange) >= threshold;
}
