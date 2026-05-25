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

  // Pull all DB overrides.
  let dbRows: any[] = [];
  try {
    const res = await turso.execute({
      sql: `SELECT key, intro_lines, what_i_see_paragraphs, what_i_recommend_paragraphs, updated_at, notes
            FROM snippet_overrides
            ORDER BY key`,
    });
    dbRows = res.rows as any[];
  } catch (err: any) {
    return json({ error: err?.message || 'Failed to load snippet overrides' }, 500);
  }

  const dbByKey = new Map<string, any>();
  for (const row of dbRows) {
    dbByKey.set(String(row[0]), {
      intro_lines: parseJsonArray(row[1]),
      what_i_see_paragraphs: parseJsonArray(row[2]),
      what_i_recommend_paragraphs: parseJsonArray(row[3]),
      updated_at: row[4] ? String(row[4]) : null,
      notes: row[5] ? String(row[5]) : null,
    });
  }

  const allKeys = new Set<string>([...fileKeys, ...dbByKey.keys()]);
  const snippets = [];

  for (const key of [...allKeys].sort()) {
    const inFile = fileKeys.has(key);
    const inDb = dbByKey.has(key);
    const dbEntry = dbByKey.get(key);
    let source: 'file' | 'db' | 'both' = inFile && inDb ? 'both' : inFile ? 'file' : 'db';

    // DB takes precedence at compose time, so the editor shows the
    // DB version when both exist. File version is implicit fallback.
    const content = inDb ? dbEntry : renderFileSnippet(key, SNIPPET_REGISTRY[key]);

    snippets.push({
      key,
      source,
      intro_lines: content.intro_lines,
      what_i_see_paragraphs: content.what_i_see_paragraphs,
      what_i_recommend_paragraphs: content.what_i_recommend_paragraphs,
      updated_at: dbEntry?.updated_at || null,
      notes: dbEntry?.notes || null,
    });
  }

  return json({ snippets });
};
