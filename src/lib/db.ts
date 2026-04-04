import initSqlJs, { type Database } from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const dataDir = join(__dirname, '..', '..', 'data');
const dbPath = join(dataDir, 'listener.db');

let db: Database;

async function getDb(): Promise<Database> {
  if (db) return db;
  const SQL = await initSqlJs();
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  db = existsSync(dbPath) ? new SQL.Database(readFileSync(dbPath)) : new SQL.Database();

  db.run(`CREATE TABLE IF NOT EXISTS scans (
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
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS mentions (
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
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS leads (
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
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS rate_limits (
    ip TEXT NOT NULL,
    scan_date TEXT NOT NULL,
    scan_count INTEGER DEFAULT 1,
    PRIMARY KEY (ip, scan_date)
  )`);

  save();
  return db;
}

function save() {
  if (!db) return;
  writeFileSync(dbPath, Buffer.from(db.export()));
}

function rowToObj(columns: string[], values: any[]): any {
  const obj: any = {};
  columns.forEach((col, i) => { obj[col] = values[i]; });
  return obj;
}

function queryOne(d: Database, sql: string, params: any[] = []): any | undefined {
  const stmt = d.prepare(sql);
  stmt.bind(params);
  let result: any;
  if (stmt.step()) result = rowToObj(stmt.getColumnNames(), stmt.get());
  stmt.free();
  return result;
}

function queryAll(d: Database, sql: string, params: any[] = []): any[] {
  const stmt = d.prepare(sql);
  stmt.bind(params);
  const results: any[] = [];
  while (stmt.step()) results.push(rowToObj(stmt.getColumnNames(), stmt.get()));
  stmt.free();
  return results;
}

function getLastId(d: Database): number {
  const stmt = d.prepare('SELECT last_insert_rowid() as id');
  stmt.step();
  const id = (stmt.get()[0] as number) || 0;
  stmt.free();
  return id;
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
  const d = await getDb();
  d.run('INSERT INTO scans (brand, domain, input_type) VALUES (?, ?, ?)', [brand, domain, inputType]);
  const id = getLastId(d);
  save();
  return id;
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
  const d = await getDb();
  d.run(
    `UPDATE scans SET overall_score=?, overall_label=?, mention_count=?, summary=?, top_positive_phrases=?, top_negative_phrases=?, source_breakdown=? WHERE id=?`,
    [data.overall_score, data.overall_label, data.mention_count, data.summary, data.top_positive_phrases, data.top_negative_phrases, data.source_breakdown, id]
  );
  save();
}

export async function getScan(id: number): Promise<Scan | undefined> {
  const d = await getDb();
  return queryOne(d, 'SELECT * FROM scans WHERE id = ?', [id]);
}

export async function getRecentScans(limit = 10): Promise<Scan[]> {
  const d = await getDb();
  return queryAll(d, 'SELECT * FROM scans WHERE overall_score IS NOT NULL ORDER BY created_at DESC LIMIT ?', [limit]);
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
  const d = await getDb();
  d.run(
    `INSERT INTO mentions (scan_id, url, source_name, source_type, snippet, sentiment_score, sentiment_label, key_phrases, query_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.scan_id, data.url, data.source_name ?? null, data.source_type ?? null, data.snippet ?? null, data.sentiment_score ?? null, data.sentiment_label ?? null, data.key_phrases ?? null, data.query_type ?? null]
  );
  const id = getLastId(d);
  save();
  return id;
}

export async function getMentions(scanId: number): Promise<Mention[]> {
  const d = await getDb();
  return queryAll(d, 'SELECT * FROM mentions WHERE scan_id = ? ORDER BY sentiment_score DESC', [scanId]);
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
  const d = await getDb();
  d.run(
    `INSERT INTO leads (scan_id, first_name, email, brand_searched, domain_searched, overall_score, consent_given, consent_timestamp)
     VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'))`,
    [data.scan_id, data.first_name, data.email, data.brand_searched, data.domain_searched ?? null, data.overall_score ?? null]
  );
  const id = getLastId(d);
  save();
  return id;
}

// --- Rate Limiting ---

export async function checkRateLimit(ip: string): Promise<{ allowed: boolean; count: number }> {
  const d = await getDb();
  const today = new Date().toISOString().split('T')[0];
  const row = queryOne(d, 'SELECT scan_count FROM rate_limits WHERE ip = ? AND scan_date = ?', [ip, today]);
  const count = row?.scan_count || 0;
  return { allowed: count < 3, count };
}

export async function incrementRateLimit(ip: string): Promise<void> {
  const d = await getDb();
  const today = new Date().toISOString().split('T')[0];
  const existing = queryOne(d, 'SELECT scan_count FROM rate_limits WHERE ip = ? AND scan_date = ?', [ip, today]);
  if (existing) {
    d.run('UPDATE rate_limits SET scan_count = scan_count + 1 WHERE ip = ? AND scan_date = ?', [ip, today]);
  } else {
    d.run('INSERT INTO rate_limits (ip, scan_date, scan_count) VALUES (?, ?, 1)', [ip, today]);
  }
  save();
}

// --- Global search budget ---

export async function getMonthlySearchCount(): Promise<number> {
  const d = await getDb();
  const firstOfMonth = new Date().toISOString().slice(0, 7) + '-01';
  const row = queryOne(d, "SELECT COUNT(*) as cnt FROM scans WHERE created_at >= ?", [firstOfMonth]);
  return (row?.cnt || 0) * 4; // 4 searches per scan
}
