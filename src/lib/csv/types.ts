// Shared staging types for v2 parsers. Each parser returns a ParseResult
// made of pure plain-data rows; the ingest-v2 core handles period/import
// resolution and DB writes.

export interface StagedKeyword {
  keyword: string;
  position: number | null;
  search_volume: number | null;
  url: string | null;
  change_val: number | null;
  seo_difficulty: number | null;
}

export interface StagedIssue {
  issue_name: string;
  issue_type: string | null;
  priority: string | null;
  affected_urls: number | null;
  pct_of_total: number | null;
  description: string | null;
  how_to_fix: string | null;
}

export interface StagedMetric {
  category: string;
  metric_key: string;
  metric_value: number;
}

export interface ParseResult {
  keywords?: StagedKeyword[];
  issues?: StagedIssue[];
  metrics?: StagedMetric[];
}
