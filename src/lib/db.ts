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

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  if (existsSync(dbPath)) {
    const buffer = readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      page_title TEXT,
      sentiment_score REAL NOT NULL,
      sentiment_label TEXT NOT NULL,
      confidence REAL,
      summary TEXT,
      key_phrases TEXT,
      raw_text TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  save();
  return db;
}

function save() {
  if (!db) return;
  const data = db.export();
  writeFileSync(dbPath, Buffer.from(data));
}

export interface Analysis {
  id: number;
  url: string;
  page_title: string | null;
  sentiment_score: number;
  sentiment_label: string;
  confidence: number | null;
  summary: string | null;
  key_phrases: string | null;
  raw_text: string | null;
  created_at: string;
}

function rowToAnalysis(columns: string[], values: any[]): Analysis {
  const obj: any = {};
  columns.forEach((col, i) => { obj[col] = values[i]; });
  return obj as Analysis;
}

export async function insertAnalysis(data: Omit<Analysis, 'id' | 'created_at'>): Promise<Analysis> {
  const d = await getDb();
  d.run(
    `INSERT INTO analyses (url, page_title, sentiment_score, sentiment_label, confidence, summary, key_phrases, raw_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.url, data.page_title ?? null, data.sentiment_score, data.sentiment_label, data.confidence ?? null, data.summary ?? null, data.key_phrases ?? null, data.raw_text ?? null]
  );
  save();

  // Get the id of the inserted row
  const idStmt = d.prepare('SELECT last_insert_rowid() as id');
  idStmt.step();
  const id = (idStmt.get()[0] as number) || 1;
  idStmt.free();

  return {
    id,
    url: data.url,
    page_title: data.page_title,
    sentiment_score: data.sentiment_score,
    sentiment_label: data.sentiment_label,
    confidence: data.confidence,
    summary: data.summary,
    key_phrases: data.key_phrases,
    raw_text: data.raw_text,
    created_at: new Date().toISOString(),
  };
}

export async function getAnalysisById(id: number): Promise<Analysis | undefined> {
  const d = await getDb();
  const stmt = d.prepare('SELECT * FROM analyses WHERE id = ?');
  stmt.bind([id]);
  if (stmt.step()) {
    const columns = stmt.getColumnNames();
    const values = stmt.get();
    stmt.free();
    return rowToAnalysis(columns, values);
  }
  stmt.free();
  return undefined;
}

export async function getAnalyses(limit = 50, offset = 0): Promise<Analysis[]> {
  const d = await getDb();
  const stmt = d.prepare('SELECT * FROM analyses ORDER BY created_at DESC LIMIT ? OFFSET ?');
  stmt.bind([limit, offset]);
  const results: Analysis[] = [];
  while (stmt.step()) {
    const columns = stmt.getColumnNames();
    const values = stmt.get();
    results.push(rowToAnalysis(columns, values));
  }
  stmt.free();
  return results;
}

export async function getAnalysisCount(): Promise<number> {
  const d = await getDb();
  const result = d.exec('SELECT COUNT(*) as count FROM analyses');
  return (result[0]?.values[0]?.[0] as number) || 0;
}
