import turso from './turso';

let initialized = false;

async function ensureTables(): Promise<void> {
  if (initialized) return;

  await turso.batch([
    `CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand TEXT NOT NULL,
      domain TEXT,
      input_type TEXT NOT NULL,
      overall_score INTEGER,
      overall_label TEXT,
      mention_count INTEGER DEFAULT 0,
      summary TEXT,
      top_positive_phrases TEXT,
      top_negative_phrases TEXT,
      source_breakdown TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE IF NOT EXISTS mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      source_name TEXT,
      source_type TEXT,
      snippet TEXT,
      sentiment_score REAL,
      sentiment_label TEXT,
      key_phrases TEXT,
      query_type TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (scan_id) REFERENCES scans(id)
    )`,
    `CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id INTEGER NOT NULL,
      first_name TEXT NOT NULL,
      email TEXT NOT NULL,
      brand_searched TEXT,
      domain_searched TEXT,
      overall_score INTEGER,
      consent_given INTEGER NOT NULL DEFAULT 0,
      consent_timestamp TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (scan_id) REFERENCES scans(id)
    )`,
    `CREATE TABLE IF NOT EXISTS rate_limits (
      ip TEXT NOT NULL,
      scan_date TEXT NOT NULL,
      scan_count INTEGER DEFAULT 1,
      PRIMARY KEY (ip, scan_date)
    )`,
  ], 'write');

  initialized = true;
}

// --- Helpers ---

function rowToObj(columns: string[], row: any[]): any {
  const obj: any = {};
  columns.forEach((col, i) => { obj[col] = row[i]; });
  return obj;
}

async function queryOne(sql: string, args: any[] = []): Promise<any | undefined> {
  await ensureTables();
  const result = await turso.execute({ sql, args });
  if (result.rows.length === 0) return undefined;
  return Object.fromEntries(result.columns.map((col, i) => [col, result.rows[0][i]]));
}

async function queryAll(sql: string, args: any[] = []): Promise<any[]> {
  await ensureTables();
  const result = await turso.execute({ sql, args });
  return result.rows.map(row =>
    Object.fromEntries(result.columns.map((col, i) => [col, row[i]]))
  );
}

// --- Scans ---

export interface Scan {
  id: number;
  brand: string;
  domain: string | null;
  input_type: string;
  overall_score: number | null;
  overall_label: string | null;
  mention_count: number;
  summary: string | null;
  top_positive_phrases: string | null;
  top_negative_phrases: string | null;
  source_breakdown: string | null;
  created_at: string;
}

export async function createScan(brand: string, domain: string | null, inputType: string): Promise<number> {
  await ensureTables();
  const result = await turso.execute({
    sql: 'INSERT INTO scans (brand, domain, input_type) VALUES (?, ?, ?)',
    args: [brand, domain, inputType],
  });
  return Number(result.lastInsertRowid);
}

export async function updateScan(id: number, data: {
  overall_score: number;
  overall_label: string;
  mention_count: number;
  summary: string;
  top_positive_phrases: string;
  top_negative_phrases: string;
  source_breakdown: string;
}): Promise<void> {
  await ensureTables();
  await turso.execute({
    sql: `UPDATE scans SET overall_score=?, overall_label=?, mention_count=?, summary=?, top_positive_phrases=?, top_negative_phrases=?, source_breakdown=? WHERE id=?`,
    args: [data.overall_score, data.overall_label, data.mention_count, data.summary, data.top_positive_phrases, data.top_negative_phrases, data.source_breakdown, id],
  });
}

export async function getScan(id: number): Promise<Scan | undefined> {
  return queryOne('SELECT * FROM scans WHERE id = ?', [id]);
}

export async function getRecentScans(limit = 10): Promise<Scan[]> {
  return queryAll('SELECT * FROM scans WHERE overall_score IS NOT NULL ORDER BY created_at DESC LIMIT ?', [limit]);
}

// --- Mentions ---

export interface Mention {
  id: number;
  scan_id: number;
  url: string;
  source_name: string | null;
  source_type: string | null;
  snippet: string | null;
  sentiment_score: number | null;
  sentiment_label: string | null;
  key_phrases: string | null;
  query_type: string | null;
  created_at: string;
}

export async function insertMention(data: Omit<Mention, 'id' | 'created_at'>): Promise<number> {
  await ensureTables();
  const result = await turso.execute({
    sql: `INSERT INTO mentions (scan_id, url, source_name, source_type, snippet, sentiment_score, sentiment_label, key_phrases, query_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [data.scan_id, data.url, data.source_name ?? null, data.source_type ?? null, data.snippet ?? null, data.sentiment_score ?? null, data.sentiment_label ?? null, data.key_phrases ?? null, data.query_type ?? null],
  });
  return Number(result.lastInsertRowid);
}

export async function getMentions(scanId: number): Promise<Mention[]> {
  return queryAll('SELECT * FROM mentions WHERE scan_id = ? ORDER BY sentiment_score DESC', [scanId]);
}

// --- Leads ---

export async function insertLead(data: {
  scan_id: number;
  first_name: string;
  email: string;
  brand_searched: string;
  domain_searched: string | null;
  overall_score: number | null;
}): Promise<number> {
  await ensureTables();
  const result = await turso.execute({
    sql: `INSERT INTO leads (scan_id, first_name, email, brand_searched, domain_searched, overall_score, consent_given, consent_timestamp)
     VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'))`,
    args: [data.scan_id, data.first_name, data.email, data.brand_searched, data.domain_searched ?? null, data.overall_score ?? null],
  });
  return Number(result.lastInsertRowid);
}

// --- Rate Limiting ---

export async function checkRateLimit(ip: string): Promise<{ allowed: boolean; count: number }> {
  const today = new Date().toISOString().split('T')[0];
  const row = await queryOne('SELECT scan_count FROM rate_limits WHERE ip = ? AND scan_date = ?', [ip, today]);
  const count = row?.scan_count || 0;
  return { allowed: count < 3, count };
}

export async function incrementRateLimit(ip: string): Promise<void> {
  await ensureTables();
  const today = new Date().toISOString().split('T')[0];
  const existing = await queryOne('SELECT scan_count FROM rate_limits WHERE ip = ? AND scan_date = ?', [ip, today]);
  if (existing) {
    await turso.execute({
      sql: 'UPDATE rate_limits SET scan_count = scan_count + 1 WHERE ip = ? AND scan_date = ?',
      args: [ip, today],
    });
  } else {
    await turso.execute({
      sql: 'INSERT INTO rate_limits (ip, scan_date, scan_count) VALUES (?, ?, 1)',
      args: [ip, today],
    });
  }
}

// --- Global search budget ---

export async function getMonthlySearchCount(): Promise<number> {
  const firstOfMonth = new Date().toISOString().slice(0, 7) + '-01';
  const row = await queryOne("SELECT COUNT(*) as cnt FROM scans WHERE created_at >= ?", [firstOfMonth]);
  return (row?.cnt || 0) * 4;
}
