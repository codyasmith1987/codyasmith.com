// Parser for Screaming Frog's content_all.csv export.
//
// Per-URL readability and near-duplicate detection data. Columns
// include Address, Word Count, Sentence Count, Average Words Per
// Sentence, Flesch Reading Ease Score, Readability, Closest Near
// Duplicate Match, No. Near Duplicates, Closest Semantically Similar
// Address, Semantic Similarity Score, No. Semantically Similar,
// Semantic Relevance Score, Spelling Errors, Grammar Errors,
// Language.
//
// Pure builder: buildContentUrlsStatements returns INSERT statements
// without executing them (for the atomic-ingest path, Task 8).
// Back-compat executor: parse() calls the builder and runs via
// turso.batch so direct callers still work.

import { nanoid } from 'nanoid';
import turso from '../../turso';
import {
  parseCsvHeaderAndRows, findIdx, safeText, safeInt, safeFloat,
  extractHostname, rowToJson,
} from './_url-parser-helpers';

// PURE: parse raw -> array of INSERT statements. No DB calls. Exported
// for the atomic-ingest path (Task 8) and the thin parse() executor below.
export function buildContentUrlsStatements(
  raw: string, clientId: string, month: string, uploadId: string,
): Array<{ sql: string; args: any[] }> {
  const parsed = parseCsvHeaderAndRows(raw);
  if (!parsed) return [];
  const { headers, rows } = parsed;

  const idx = {
    address: findIdx(headers, 'address'),
    wordCount: findIdx(headers, 'word count'),
    sentenceCount: findIdx(headers, 'sentence count'),
    avgWords: findIdx(headers, 'average words per sentence'),
    flesch: findIdx(headers, 'flesch reading ease score'),
    readability: findIdx(headers, 'readability'),
    nearDupUrl: findIdx(headers, 'closest near duplicate match'),
    nearDupCount: findIdx(headers, 'no. near duplicates'),
    semSimUrl: findIdx(headers, 'closest semantically similar address'),
    semSimScore: findIdx(headers, 'semantic similarity score'),
    semRelevance: findIdx(headers, 'semantic relevance score'),
    spelling: findIdx(headers, 'spelling errors'),
    grammar: findIdx(headers, 'grammar errors'),
    language: findIdx(headers, 'language'),
  };
  if (idx.address < 0) return [];

  const seen = new Set<string>();
  const inserts: any[][] = [];

  for (const row of rows) {
    const url = safeText(row[idx.address], 2000);
    if (!url) continue;
    const hostname = extractHostname(url);
    if (!hostname) continue;
    const dedupKey = url.toLowerCase();
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    inserts.push([
      nanoid(), clientId, uploadId, month, url, hostname,
      idx.wordCount >= 0 ? safeInt(row[idx.wordCount]) : null,
      idx.sentenceCount >= 0 ? safeInt(row[idx.sentenceCount]) : null,
      idx.avgWords >= 0 ? safeFloat(row[idx.avgWords]) : null,
      idx.flesch >= 0 ? safeFloat(row[idx.flesch]) : null,
      idx.readability >= 0 ? safeText(row[idx.readability], 64) : null,
      idx.nearDupUrl >= 0 ? safeText(row[idx.nearDupUrl], 2000) : null,
      idx.nearDupCount >= 0 ? safeInt(row[idx.nearDupCount]) : null,
      idx.semSimUrl >= 0 ? safeText(row[idx.semSimUrl], 2000) : null,
      idx.semSimScore >= 0 ? safeFloat(row[idx.semSimScore]) : null,
      idx.semRelevance >= 0 ? safeFloat(row[idx.semRelevance]) : null,
      idx.spelling >= 0 ? safeInt(row[idx.spelling]) : null,
      idx.grammar >= 0 ? safeInt(row[idx.grammar]) : null,
      idx.language >= 0 ? safeText(row[idx.language], 32) : null,
      rowToJson(headers, row),
    ]);
  }

  const sql = `INSERT INTO content_urls
    (id, client_id, csv_upload_id, month, url, hostname,
     word_count, sentence_count, avg_words_per_sentence, flesch_reading_ease, readability_grade,
     closest_near_duplicate_url, near_duplicate_count,
     closest_semantic_similar_url, semantic_similarity_score, semantic_relevance_score,
     spelling_errors, grammar_errors, language, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  return inserts.map(args => ({ sql, args }));
}

// Thin executor — back-compat for direct callers.
export async function parse(raw: string, clientId: string, month: string, uploadId: string): Promise<number> {
  const stmts = buildContentUrlsStatements(raw, clientId, month, uploadId);
  for (let i = 0; i < stmts.length; i += 450) {
    await turso.batch(stmts.slice(i, i + 450), 'write');
  }
  return stmts.length;
}
