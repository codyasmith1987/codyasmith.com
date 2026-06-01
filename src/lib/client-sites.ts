// CRUD + auto-sync helpers for the client_sites table.
//
// client_sites holds one row per managed domain per client. The
// wizard chips read from it, Schedule A WM site rows iterate it,
// the proposal builder reads is_managed=1 for the WM site_count
// variable, and the research endpoint uses is_primary=1 to scope
// Serper queries.
//
// syncDetectedDomains() is the auto-population entry point: given
// the hostnames extracted from a client's uploaded data (crawl_urls,
// keyword_rankings), it inserts new rows for hostnames not yet
// tracked, leaves existing rows alone (so admin edits like
// is_managed=0 and label overrides persist across re-uploads).

import { nanoid } from 'nanoid';
import turso from './turso';
import { getClientDomainsFromData } from './client-domains';

export interface ClientSite {
  id: string;
  client_id: string;
  domain: string;
  is_primary: boolean;
  is_managed: boolean;
  label: string | null;
  sort_order: number;
  // Per-site page count. Routes the site's WM ecosystem in the
  // multi-site pricing pipeline (2026-05-24 locked formula). Null
  // when no crawl data has populated it and admin has not entered
  // it manually; the pricing pipeline falls back to the primary's
  // ecosystem when null.
  page_count: number | null;
  // Cloudflare integration fields. Token presence exposed as a
  // boolean only — never returns the token itself to anything
  // outside the admin API endpoints.
  cloudflare_zone_id: string | null;
  cloudflare_token_set: boolean;
  cloudflare_last_synced_at: string | null;
  // Per Cody operating rule (2026-05-26): when this site goes live
  // under management, this timestamp is the input the proration
  // calculator uses to compute the first-period invoice. Null = not
  // live yet (build in progress, takeover not started).
  went_live_at: string | null;
  // Per-site pricing overrides. NULL = use the formula. Any non-null
  // value (including 0) = use that exact amount as the per-site
  // contribution; the multi-site 0.90 multiplier is skipped for this
  // site because the override IS the price. Use cases: pro-bono ($0),
  // grandfathered legacy rates, per-site sweetheart deals. Client-
  // level discount_rate still applies uniformly per existing pricing
  // pipeline behavior.
  monthly_override: number | null;
  onboarding_override: number | null;
}

function rowToSite(row: any): ClientSite {
  return {
    id: row[0] as string,
    client_id: row[1] as string,
    domain: row[2] as string,
    is_primary: !!(row[3] as number),
    is_managed: !!(row[4] as number),
    label: (row[5] as string | null) ?? null,
    sort_order: (row[6] as number) ?? 0,
    page_count: (row[7] as number | null) ?? null,
    cloudflare_zone_id: (row[8] as string | null) ?? null,
    cloudflare_token_set: !!(row[9] as string | null),
    cloudflare_last_synced_at: (row[10] as string | null) ?? null,
    went_live_at: (row[11] as string | null) ?? null,
    monthly_override: (row[12] as number | null) ?? null,
    onboarding_override: (row[13] as number | null) ?? null,
  };
}

// `notes` column omitted from SELECT_COLS: prod's client_sites table
// was bootstrapped before migration 033 ran (older ensurePortalTables
// path), so the IF NOT EXISTS guard left the existing table without
// `notes`. Selecting it caused a 'no such column' parse error. The
// field is unused anywhere in the code, so dropping it from the
// model fixes the bug without losing functionality.
const SELECT_COLS = 'id, client_id, domain, is_primary, is_managed, label, sort_order, page_count, cloudflare_zone_id, cloudflare_api_token, cloudflare_last_synced_at, went_live_at, monthly_override, onboarding_override';

export async function listClientSites(clientId: string): Promise<ClientSite[]> {
  const result = await turso.execute({
    sql: `SELECT ${SELECT_COLS} FROM client_sites
          WHERE client_id = ?
          ORDER BY is_primary DESC, sort_order ASC, domain ASC`,
    args: [clientId],
  });
  return (result.rows as any[]).map(rowToSite);
}

export async function listManagedSites(clientId: string): Promise<ClientSite[]> {
  const all = await listClientSites(clientId);
  return all.filter(s => s.is_managed);
}

export async function getPrimarySite(clientId: string): Promise<ClientSite | null> {
  const result = await turso.execute({
    sql: `SELECT ${SELECT_COLS} FROM client_sites
          WHERE client_id = ? AND is_primary = 1
          LIMIT 1`,
    args: [clientId],
  });
  if (result.rows.length === 0) return null;
  return rowToSite(result.rows[0] as any);
}

async function listClientSiteSyncState(clientId: string): Promise<Array<{ domain: string; is_primary: boolean }>> {
  const result = await turso.execute({
    // Keep the auto-sync path schema-minimal. Backfill and post-ingest
    // only need domain/is_primary; selecting optional admin columns here
    // has repeatedly made a data sync fail because one historical prod
    // schema detail was off.
    sql: `SELECT domain, is_primary
          FROM client_sites
          WHERE client_id = ?
          ORDER BY is_primary DESC, sort_order ASC, domain ASC`,
    args: [clientId],
  });
  return (result.rows as any[]).map(row => ({
    domain: row[0] as string,
    is_primary: !!(row[1] as number),
  }));
}

// Auto-sync: for each detected hostname, INSERT OR IGNORE so existing
// admin edits (is_managed=0 toggles, custom labels) persist across
// re-uploads. Newly-detected hostnames land as is_managed=1 by
// default because their presence in uploaded data implies the admin
// is tracking them.
//
// Returns the number of new rows actually inserted.
export async function syncDetectedDomains(clientId: string): Promise<number> {
  const derived = await getClientDomainsFromData(clientId);
  if (derived.length === 0) return 0;

  // Check what already exists so we know which inserts will be new.
  const existing = await listClientSiteSyncState(clientId);
  const existingDomains = new Set(existing.map(s => s.domain));

  // If there's no primary yet AND no existing rows, the first
  // detected domain (highest URL count from crawl_urls) becomes the
  // primary. If existing rows are present and one is already
  // primary, leave that alone.
  const hasExistingPrimary = existing.some(s => s.is_primary);
  const existingPrimary = existing.find(s => s.is_primary)?.domain || null;
  const primaryCandidate = !hasExistingPrimary ? (derived[0]?.domain || null) : null;

  let inserted = 0;
  for (const d of derived) {
    if (existingDomains.has(d.domain)) continue;
    const isPrimary = primaryCandidate === d.domain ? 1 : 0;
    try {
      await turso.execute({
        sql: `INSERT OR IGNORE INTO client_sites
              (id, client_id, domain, is_primary, is_managed, label, sort_order)
              VALUES (?, ?, ?, ?, 1, ?, ?)`,
        args: [nanoid(), clientId, d.domain, isPrimary, d.domain, inserted],
      });
      inserted++;
    } catch {
      // Race or duplicate: just skip.
    }
  }

  // Backfill's core job: bind the client to its primary detected
  // site URL. Keep clients.domain in sync even when the site row
  // already existed, and repair historical rows that were inserted
  // without a primary flag.
  const primaryDomain = existingPrimary || primaryCandidate;
  if (primaryDomain) {
    if (!hasExistingPrimary && existingDomains.has(primaryDomain)) {
      await turso.execute({
        sql: 'UPDATE client_sites SET is_primary = 1 WHERE client_id = ? AND domain = ?',
        args: [clientId, primaryDomain],
      });
    }
    await turso.execute({
      sql: "UPDATE clients SET domain = ? WHERE id = ? AND (domain IS NULL OR domain = '')",
      args: [primaryDomain, clientId],
    });
  }

  return inserted;
}

// Set a site as primary. Clears is_primary on all other sites for
// the same client. Keeps clients.domain in sync as a cache of the
// primary domain.
export async function setPrimarySite(clientId: string, siteId: string): Promise<{ domain: string | null }> {
  // Look up the requested row to confirm it belongs to the client.
  const target = await turso.execute({
    sql: `SELECT ${SELECT_COLS} FROM client_sites
          WHERE id = ? AND client_id = ?
          LIMIT 1`,
    args: [siteId, clientId],
  });
  if (target.rows.length === 0) return { domain: null };
  const targetSite = rowToSite(target.rows[0] as any);

  await turso.batch([
    {
      sql: 'UPDATE client_sites SET is_primary = 0 WHERE client_id = ?',
      args: [clientId],
    },
    {
      sql: 'UPDATE client_sites SET is_primary = 1 WHERE id = ? AND client_id = ?',
      args: [siteId, clientId],
    },
    {
      sql: 'UPDATE clients SET domain = ? WHERE id = ?',
      args: [targetSite.domain, clientId],
    },
  ], 'write');
  return { domain: targetSite.domain };
}

export async function setSiteManaged(clientId: string, siteId: string, isManaged: boolean): Promise<void> {
  await turso.execute({
    sql: 'UPDATE client_sites SET is_managed = ? WHERE id = ? AND client_id = ?',
    args: [isManaged ? 1 : 0, siteId, clientId],
  });
}

// On contract execution, flip proposed-takeover domains to managed. For each
// domain: update the existing client_sites row to is_managed=1; if no row
// exists (a takeover site the portal never crawled), insert it as a managed
// site. Idempotent: re-running on an already-managed site is a no-op. Returns
// the count of rows newly flipped or inserted. Used by the contract-finalize
// flow so a taken-over site becomes managed the moment the engagement is live.
export async function markDomainsManaged(clientId: string, domains: string[]): Promise<number> {
  let changed = 0;
  for (const raw of domains) {
    const domain = (raw || '').trim().toLowerCase();
    if (!domain) continue;
    const res = await turso.execute({
      sql: 'UPDATE client_sites SET is_managed = 1 WHERE client_id = ? AND domain = ? AND is_managed = 0',
      args: [clientId, domain],
    });
    if (res.rowsAffected && res.rowsAffected > 0) { changed++; continue; }
    // No unmanaged row updated: either it's already managed (no-op) or the
    // row doesn't exist. Insert only when truly absent.
    const existing = await turso.execute({
      sql: 'SELECT id FROM client_sites WHERE client_id = ? AND domain = ? LIMIT 1',
      args: [clientId, domain],
    });
    if (existing.rows.length === 0) {
      const id = await addManualSite(clientId, domain, { isManaged: true });
      if (id) changed++;
    }
  }
  return changed;
}

// Admin or auto-derivation sets a site's page count. Routes the WM
// ecosystem for this site in the multi-site pricing pipeline.
// Passing null clears the value so the pricing pipeline falls back
// to the primary site's ecosystem for this site.
export async function setSitePageCount(clientId: string, siteId: string, pageCount: number | null): Promise<void> {
  const safe = pageCount === null || pageCount === undefined
    ? null
    : Math.floor(Number(pageCount));
  const normalized = safe !== null && Number.isFinite(safe) && safe > 0 ? safe : null;
  await turso.execute({
    sql: 'UPDATE client_sites SET page_count = ? WHERE id = ? AND client_id = ?',
    args: [normalized, siteId, clientId],
  });
}

// Auto-bind per-site page_count from uploaded crawl data. Groups
// canonical HTML page rows by hostname and writes the count to each
// matching client_sites row. Resource URLs (images, CSS, JS, PDFs)
// are deliberately excluded: page_count is a pricing input, not a
// "URLs encountered" metric.
export async function syncPerSitePageCounts(clientId: string): Promise<number> {
  let updated = 0;
  let counts: Array<{ hostname: string; count: number }>;
  try {
    const result = await turso.execute({
      sql: `SELECT hostname, COUNT(*) as cnt
            FROM crawl_urls
            WHERE client_id = ?
              AND lower(COALESCE(content_type, '')) LIKE 'text/html%'
            GROUP BY hostname`,
      args: [clientId],
    });
    counts = (result.rows as any[]).map(row => ({
      hostname: String(row[0] || ''),
      count: Number(row[1] || 0),
    })).filter(c => c.hostname);
  } catch {
    // crawl_urls table may not exist on stale databases; treat as empty.
    counts = [];
  }

  for (const c of counts) {
    const result = await turso.execute({
      sql: `UPDATE client_sites
            SET page_count = ?
            WHERE client_id = ?
              AND domain = ?
              AND (
                page_count IS NULL
                OR page_count = 0
                OR (
                  page_count > ?
                  AND page_count >= ? * 2
                )
              )`,
      args: [c.count, clientId, c.hostname, c.count, c.count],
    });
    if (result.rowsAffected && result.rowsAffected > 0) updated++;
  }

  return updated;
}

// Mark a site live (or clear the live timestamp). When the site is
// under management, the went_live_at date drives first-period
// proration on the next invoice. Accepts ISO date 'YYYY-MM-DD' or
// full ISO timestamp; stored as TEXT. Null clears.
//
// Per Cody operating rule (2026-05-26): all sites under one agreement
// converge to the same monthly billing cadence. went_live_at is the
// input the proration calculator uses to compute the first-period fee.
export async function setSiteWentLive(clientId: string, siteId: string, wentLiveAt: string | null): Promise<void> {
  if (wentLiveAt !== null && wentLiveAt !== undefined) {
    // Light validation: require ISO-ish prefix so we don't store junk
    if (!/^\d{4}-\d{2}-\d{2}/.test(wentLiveAt)) {
      throw new Error('went_live_at must be YYYY-MM-DD or full ISO datetime');
    }
  }
  await turso.execute({
    sql: 'UPDATE client_sites SET went_live_at = ? WHERE id = ? AND client_id = ?',
    args: [wentLiveAt ?? null, siteId, clientId],
  });
}

// Per-site pricing override setters. Pass null to clear (site falls
// back to formula pricing). Any non-null number (including 0) sets
// the override as that site's exact per-site contribution. Negatives
// rejected because a negative monthly is never the right answer for
// a pro-bono or grandfathered carve-out.
export async function setSiteMonthlyOverride(clientId: string, siteId: string, amount: number | null): Promise<void> {
  const safe = amount === null || amount === undefined
    ? null
    : (Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : null);
  if (amount !== null && amount !== undefined && safe === null) {
    throw new Error('monthly_override must be a non-negative number or null');
  }
  await turso.execute({
    sql: 'UPDATE client_sites SET monthly_override = ? WHERE id = ? AND client_id = ?',
    args: [safe, siteId, clientId],
  });
}

export async function setSiteOnboardingOverride(clientId: string, siteId: string, amount: number | null): Promise<void> {
  const safe = amount === null || amount === undefined
    ? null
    : (Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) / 100 : null);
  if (amount !== null && amount !== undefined && safe === null) {
    throw new Error('onboarding_override must be a non-negative number or null');
  }
  await turso.execute({
    sql: 'UPDATE client_sites SET onboarding_override = ? WHERE id = ? AND client_id = ?',
    args: [safe, siteId, clientId],
  });
}

export async function addManualSite(clientId: string, domain: string, opts: { label?: string; isManaged?: boolean } = {}): Promise<string | null> {
  const d = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return null;
  const id = nanoid();
  const label = (opts.label || d).slice(0, 200);
  const isManaged = opts.isManaged === false ? 0 : 1;
  try {
    await turso.execute({
      sql: `INSERT INTO client_sites
            (id, client_id, domain, is_primary, is_managed, label, sort_order)
            VALUES (?, ?, ?, 0, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM client_sites WHERE client_id = ?))`,
      args: [id, clientId, d, isManaged, label, clientId],
    });
    return id;
  } catch {
    return null;
  }
}

export async function deleteClientSite(clientId: string, siteId: string): Promise<boolean> {
  // Look up first to confirm it's not the only primary.
  const all = await listClientSites(clientId);
  const target = all.find(s => s.id === siteId);
  if (!target) return false;

  await turso.execute({
    sql: 'DELETE FROM client_sites WHERE id = ? AND client_id = ?',
    args: [siteId, clientId],
  });

  // If we just deleted the primary, promote the next site (if any)
  // and update clients.domain.
  if (target.is_primary) {
    const next = (await listClientSites(clientId))[0];
    if (next) {
      await setPrimarySite(clientId, next.id);
    } else {
      await turso.execute({
        sql: 'UPDATE clients SET domain = NULL WHERE id = ?',
        args: [clientId],
      });
    }
  }
  return true;
}
