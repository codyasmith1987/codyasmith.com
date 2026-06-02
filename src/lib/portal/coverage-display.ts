// Read-layer display logic for the three signal categories (accessibility,
// structured_data, content_quality) on the portal health page.
//
// The portal stores, per (client, month, category), whether a measurement
// actually ran (data_coverage.measured) versus a category that was merely
// present-but-blank (a free Screaming Frog export ships the page list with the
// analysis columns empty) versus one never provided. url-insights surfaces
// that as a category_coverage block; this module turns one such block into the
// honest display state so the health page never shows a green "no issues
// flagged" all-clear for data that was never actually measured.
//
// Three states:
//   'measured'     — the measurement ran; render the widget (a real 0 reads as
//                    a clean measured result).
//   'not_measured' — the file was provided but the analysis columns were blank
//                    (rows_total > 0, measured = 0); render a neutral muted
//                    "not included in this crawl" line, NOT the all-clear.
//   'omit'         — never provided (rows_total = 0, measured = 0); render
//                    nothing, exactly as before this feature existed.
//
// health.astro's inline (browser-side) script cannot import this module (it
// runs under define:vars and is not bundled), so it mirrors the function below
// verbatim inside a matching DRIFT-LOCK block. A guard test reads both files
// and asserts they are byte-identical, so the two can never diverge.

export interface CategoryCoverage {
  measured?: 0 | 1;
  rows_total?: number;
  rows_measured?: number;
}

export type CoverageDisplayState = 'measured' | 'not_measured' | 'omit';

// DRIFT-LOCK:START — mirrored verbatim in src/pages/portal/health.astro
function coverageDisplayState(cov) {
  if (!cov) return 'omit';
  if (cov.measured === 1) return 'measured';
  if ((cov.rows_total || 0) > 0) return 'not_measured';
  return 'omit';
}
// Content-quality has three INDEPENDENT sub-metrics (near-duplicate,
// spelling/grammar, readability). A content export can be measured overall
// while one sub-metric column was never populated (the paid analysis filled
// some columns but not others). An unmeasured sub-metric must render as a
// neutral "not checked" dash, never a green 0, and the all-clear may only fire
// when ALL THREE sub-metrics were measured AND clean — otherwise the page
// would imply a passing result for a sub-metric that never ran.
function contentStatLine(measured, count, label, activeSeverity) {
  if (!measured) return { count: 'n/a', label: label + ' (not checked)', severity: 'none' };
  return { count: count, label: label, severity: count > 0 ? activeSeverity : 'ok' };
}
function contentStatLines(cq) {
  const m = (cq && cq.measured) || {};
  return [
    contentStatLine(!!m.near_duplicate, cq.near_duplicate_count, 'near-duplicate pages', 'medium'),
    contentStatLine(!!m.spelling_grammar, cq.spelling_grammar_count, 'pages with spelling/grammar', 'medium'),
    m.readability
      ? { count: cq.hard_to_read_count, label: 'dense for a general reader', severity: 'low' }
      : { count: 'n/a', label: 'dense for a general reader (not checked)', severity: 'none' },
  ];
}
function contentAllClear(cq) {
  const m = (cq && cq.measured) || {};
  if (!(m.near_duplicate && m.spelling_grammar && m.readability)) return false;
  return cq.near_duplicate_count === 0 && cq.spelling_grammar_count === 0 && cq.hard_to_read_count === 0;
}
// DRIFT-LOCK:END

export { coverageDisplayState, contentStatLines, contentAllClear };

// Client-facing copy for the neutral not-measured state. Frames the category
// as not part of this crawl — no tool names, no filenames, no developer
// jargon, and crucially nothing that reads as a clean/measured all-clear.
const NOT_MEASURED_COPY: Record<string, string> = {
  accessibility: "Accessibility wasn't part of this crawl, so there's nothing to report here yet.",
  structured_data: "Schema markup wasn't part of this crawl, so there's nothing to report here yet.",
  content_quality: "A content-quality review wasn't part of this crawl, so there's nothing to report here yet.",
};

export function notMeasuredCopy(category: string): string {
  return NOT_MEASURED_COPY[category]
    || "This wasn't part of the latest crawl, so there's nothing to report here yet.";
}
