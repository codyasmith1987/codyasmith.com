// Shared markdown + formatting primitives for the report assemblers.
//
// Extracted from performance-summary.ts so the Performance Summary and the
// Site Health Report share one definition (same anti-drift rationale as
// deltas.ts). Pure, DB-free, deterministic. No em/en dashes are ever
// emitted here.

import { computeDelta } from './deltas';

// Sanitize a cell value: a literal pipe or newline inside a value would add
// a phantom column and corrupt the row. Pipes are not meaningful in these
// values, so map them to a slash; collapse newlines to spaces.
export function escCell(s: string): string {
  return String(s).replace(/\|/g, '/').replace(/\r?\n/g, ' ');
}

export function table(headers: string[], rows: string[][]): string {
  const head = `| ${headers.map(escCell).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map(r => `| ${r.map(escCell).join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}`;
}

export function fmtInt(n: number | null): string {
  if (n === null || n === undefined) return '';
  return Math.round(n).toLocaleString('en-US');
}

export function fmtSignedPct(frac: number | null): string {
  if (frac === null || frac === undefined) return '';
  const sign = frac > 0 ? '+' : '';
  return `${sign}${(frac * 100).toFixed(1)}%`;
}

// A single-metric delta cell: "+12.3%", "new", "flat", or "" when no
// compare. Never fabricates a percent when prior is null/0.
export function deltaCell(prior: number | null, current: number | null): string {
  const d = computeDelta(prior, current, { metricKind: 'count' });
  if (d.direction === 'new') return 'new';
  if (d.direction === 'none') return '';
  if (d.direction === 'flat') return 'flat';
  if (d.percentChange !== null) return fmtSignedPct(d.percentChange);
  // prior 0, percent undefined: state the absolute move
  return d.absoluteChange !== null ? `${d.absoluteChange > 0 ? '+' : ''}${fmtInt(d.absoluteChange)}` : '';
}
