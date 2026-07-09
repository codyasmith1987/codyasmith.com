// Admin endpoint: upsert a snippet override into snippet_overrides.
//
// POST {
//   key: string,            // product_combo::ecosystem::urgency
//   intro_lines: string[],
//   what_i_see_paragraphs: string[],
//   what_i_recommend_paragraphs: string[],
//   notes?: string
// }
//
// Validates the key shape, voice-lints each paragraph before saving,
// rejects with violations array if any rule breaks. Invalidates the
// in-process snippet cache so the new content surfaces on the next
// compose without a redeploy.

import type { APIRoute } from 'astro';
import { nanoid } from 'nanoid';
import turso from '../../../../../../lib/turso';
import { logActivity } from '../../../../../../lib/activity';
import { invalidateSnippetOverrideCache } from '../../../../../../lib/products/narrative-snippets';
import { lintSnippet } from '../../../../../../lib/proposal-ai/voice-lint';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const KEY_RE = /^[a-z0-9+\-]+::([ABC]|\*)::(tactical|growth|maintenance|\*)$/;

function sanitizeArray(input: any): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map(s => String(s ?? '').trim())
    .filter(s => s.length > 0);
}

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any = {};
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const key = body?.key ? String(body.key).trim() : '';
  if (!key || !KEY_RE.test(key)) {
    return json({
      error: 'Key must match the format product_combo::ecosystem::urgency (e.g., "web-management::B::tactical"). Ecosystem is A/B/C or *; urgency is tactical/growth/maintenance or *.',
    }, 400);
  }

  // Per audit move 7: optional client_id scopes the snippet to one
  // client. Empty / missing / '*' = global (the historical default).
  // Validate that the client exists when a specific id is given so we
  // don't silently store orphan-scoped snippets.
  const rawClientId = (body?.client_id ?? '').toString().trim();
  let clientId = '*';
  if (rawClientId && rawClientId !== '*') {
    const clientRow = await turso.execute({
      sql: 'SELECT id FROM clients WHERE id = ? LIMIT 1',
      args: [rawClientId],
    });
    if (clientRow.rows.length === 0) {
      return json({ error: `Unknown client_id: ${rawClientId}` }, 400);
    }
    clientId = rawClientId;
  }

  const intro_lines = sanitizeArray(body.intro_lines);
  const what_i_see_paragraphs = sanitizeArray(body.what_i_see_paragraphs);
  const what_i_recommend_paragraphs = sanitizeArray(body.what_i_recommend_paragraphs);
  const notes = body.notes ? String(body.notes).slice(0, 1000) : null;

  // At least one bucket must have content. An empty snippet doesn't
  // override anything useful.
  const totalLen = intro_lines.length + what_i_see_paragraphs.length + what_i_recommend_paragraphs.length;
  if (totalLen === 0) {
    return json({ error: 'At least one paragraph or line is required.' }, 400);
  }

  // Voice-lint every line. Reject as a batch with all violations so the
  // admin sees the full set at once instead of fixing one at a time.
  const allViolations: Array<{ bucket: string; index: number; violations: Array<{ rule: string; matched: string }>; text: string }> = [];
  const lintBucket = (bucket: string, items: string[]) => {
    items.forEach((text, idx) => {
      const result = lintSnippet(text);
      if (!result.ok) {
        allViolations.push({
          bucket,
          index: idx,
          violations: result.violations,
          text: text.slice(0, 200),
        });
      }
    });
  };
  lintBucket('intro_lines', intro_lines);
  lintBucket('what_i_see_paragraphs', what_i_see_paragraphs);
  lintBucket('what_i_recommend_paragraphs', what_i_recommend_paragraphs);
  if (allViolations.length > 0) {
    return json({
      error: 'Voice-lint violations. Fix and re-save.',
      violations: allViolations,
    }, 400);
  }

  try {
    await turso.execute({
      sql: `INSERT INTO snippet_overrides
              (id, key, client_id, intro_lines, what_i_see_paragraphs, what_i_recommend_paragraphs,
               notes, created_by, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(key, client_id) DO UPDATE SET
              intro_lines = excluded.intro_lines,
              what_i_see_paragraphs = excluded.what_i_see_paragraphs,
              what_i_recommend_paragraphs = excluded.what_i_recommend_paragraphs,
              notes = excluded.notes,
              updated_at = excluded.updated_at`,
      args: [
        nanoid(),
        key,
        clientId,
        JSON.stringify(intro_lines),
        JSON.stringify(what_i_see_paragraphs),
        JSON.stringify(what_i_recommend_paragraphs),
        notes,
        locals.user!.id,
      ],
    });
  } catch (err: any) {
    return json({ error: err?.message || 'Save failed' }, 500);
  }

  // Force the composer to reload overrides on the next compose.
  invalidateSnippetOverrideCache();

  const scopeNote = clientId === '*' ? 'global' : `client ${clientId}`;
  await logActivity({
    userId: locals.user!.id,
    action: 'saved',
    entityType: 'snippet_override',
    entityId: `${key}::${clientId}`,
    summary: `${locals.user!.name} saved snippet override "${key}" (${scopeNote}; ${totalLen} total lines/paragraphs)`,
  });

  return json({ ok: true, key, client_id: clientId });
};

export const DELETE: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);
  let body: any = {};
  try { body = await request.json(); } catch { /* empty */ }
  const key = body?.key ? String(body.key).trim() : '';
  if (!key) return json({ error: 'key is required' }, 400);
  // Per audit move 7: delete is scoped to (key, client_id). Without
  // an explicit client_id we default to global ('*') so the legacy
  // delete call (no client_id) still targets the global snippet.
  const rawClientId = (body?.client_id ?? '').toString().trim();
  const clientId = (rawClientId && rawClientId !== '*') ? rawClientId : '*';

  await turso.execute({
    sql: `DELETE FROM snippet_overrides WHERE key = ? AND client_id = ?`,
    args: [key, clientId],
  });
  invalidateSnippetOverrideCache();
  const scopeNote = clientId === '*' ? 'global' : `client ${clientId}`;
  await logActivity({
    userId: locals.user!.id,
    action: 'deleted',
    entityType: 'snippet_override',
    entityId: `${key}::${clientId}`,
    summary: `${locals.user!.name} deleted snippet override "${key}" (${scopeNote})`,
  });
  return json({ ok: true });
};
