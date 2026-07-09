// Admin endpoint: list every snippet across the file registry + DB
// overrides. Powers the matrix editor at /portal/admin/proposals/snippets.
//
// GET → {
//   snippets: [
//     {
//       key, source: 'file' | 'db' | 'both',
//       intro_lines: string[],
//       what_i_see_paragraphs: string[],
//       what_i_recommend_paragraphs: string[],
//       updated_at?: string,
//       notes?: string
//     }
//   ]
// }
//
// File registry snippets are rendered with a sample context so the
// editor can show what the snippet actually produces. The render is
// shallow — only the three paragraph buckets are surfaced; rollout
// scenarios for Build are left out of v1.

import type { APIRoute } from 'astro';
import turso from '../../../../../../lib/turso';
import { SNIPPET_REGISTRY } from '../../../../../../lib/products/narrative-snippets';
import type { NarrativeSnippetSet, ProductContext } from '../../../../../../lib/products/types';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// Minimal context for previewing file-registry snippets. The keys
// reference fields snippet functions read; missing fields fall back
// to safe defaults so previews don't crash.
const PREVIEW_CTX: ProductContext = {
  productId: 'web-management',
  clientId: 'preview',
  variables: { client_name: '[Client name]', industry: '', urgency: 'tactical' },
  ecosystemId: 'B',
  otherProducts: [],
  engagementStrategy: null,
} as any;

function renderFileSnippet(key: string, fn: (ctx: ProductContext) => NarrativeSnippetSet) {
  try {
    const result = fn(PREVIEW_CTX);
    return {
      intro_lines: Array.isArray(result.intro_lines) ? result.intro_lines : [],
      what_i_see_paragraphs: Array.isArray(result.what_i_see_paragraphs) ? result.what_i_see_paragraphs : [],
      what_i_recommend_paragraphs: Array.isArray(result.what_i_recommend_paragraphs) ? result.what_i_recommend_paragraphs : [],
    };
  } catch {
    return { intro_lines: [], what_i_see_paragraphs: [], what_i_recommend_paragraphs: [] };
  }
}

function parseJsonArray(raw: any): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(String(raw));
    if (Array.isArray(parsed)) return parsed.map(s => String(s));
  } catch { /* ignore */ }
  return [];
}

export const GET: APIRoute = async ({ locals }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const fileKeys = new Set(Object.keys(SNIPPET_REGISTRY));

  // Pull all DB overrides. Per audit move 7: each row is now scoped
  // by (key, client_id). client_id = '*' = global. Editor renders one
  // card per (key, client_id) pair.
  let dbRows: any[] = [];
  try {
    const res = await turso.execute({
      sql: `SELECT key, client_id, intro_lines, what_i_see_paragraphs, what_i_recommend_paragraphs, updated_at, notes
            FROM snippet_overrides
            ORDER BY key, client_id`,
    });
    dbRows = res.rows as any[];
  } catch (err: any) {
    return json({ error: err?.message || 'Failed to load snippet overrides' }, 500);
  }

  // (key, client_id) -> entry. The same key can have multiple entries
  // (one global + one per scoped client).
  type DbEntry = {
    key: string;
    client_id: string;
    intro_lines: string[];
    what_i_see_paragraphs: string[];
    what_i_recommend_paragraphs: string[];
    updated_at: string | null;
    notes: string | null;
  };
  const dbEntries: DbEntry[] = dbRows.map(row => ({
    key: String(row[0]),
    client_id: row[1] ? String(row[1]) : '*',
    intro_lines: parseJsonArray(row[2]),
    what_i_see_paragraphs: parseJsonArray(row[3]),
    what_i_recommend_paragraphs: parseJsonArray(row[4]),
    updated_at: row[5] ? String(row[5]) : null,
    notes: row[6] ? String(row[6]) : null,
  }));
  const dbGlobalByKey = new Map<string, DbEntry>();
  for (const entry of dbEntries) {
    if (entry.client_id === '*') dbGlobalByKey.set(entry.key, entry);
  }

  const snippets: any[] = [];
  const seenFileKeys = new Set<string>();

  // Emit one row per DB entry. Global rows show alongside the
  // matching file baseline (if any) so the editor can flag overrides
  // visually; client-scoped rows show as separate cards.
  for (const entry of dbEntries) {
    const isGlobal = entry.client_id === '*';
    const inFile = fileKeys.has(entry.key);
    const source: 'file' | 'db' | 'both' = isGlobal && inFile ? 'both' : 'db';
    snippets.push({
      key: entry.key,
      client_id: entry.client_id,
      source,
      intro_lines: entry.intro_lines,
      what_i_see_paragraphs: entry.what_i_see_paragraphs,
      what_i_recommend_paragraphs: entry.what_i_recommend_paragraphs,
      updated_at: entry.updated_at,
      notes: entry.notes,
    });
    if (isGlobal) seenFileKeys.add(entry.key);
  }

  // File-baseline snippets without any DB row get rendered too so
  // admin sees the full registry.
  for (const key of [...fileKeys].sort()) {
    if (seenFileKeys.has(key)) continue;
    const content = renderFileSnippet(key, SNIPPET_REGISTRY[key]);
    snippets.push({
      key,
      client_id: '*',
      source: 'file' as const,
      intro_lines: content.intro_lines,
      what_i_see_paragraphs: content.what_i_see_paragraphs,
      what_i_recommend_paragraphs: content.what_i_recommend_paragraphs,
      updated_at: null,
      notes: null,
    });
  }

  // Stable sort: by key, then global before client-scoped.
  snippets.sort((a, b) => {
    if (a.key !== b.key) return a.key.localeCompare(b.key);
    if (a.client_id === '*' && b.client_id !== '*') return -1;
    if (b.client_id === '*' && a.client_id !== '*') return 1;
    return a.client_id.localeCompare(b.client_id);
  });

  return json({ snippets });
};
