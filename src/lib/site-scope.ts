// Per-site scoping for multi-site clients (multi-site Phase 1b). One shared
// resolver + SQL fragment so the health issues panel, the per-URL findings,
// and the trends series all scope the SAME way and can never disagree.
//
// Semantics (set in PR #315): a client with fewer than 2 managed sites is
// never scoped (undefined scope; every query byte-identical to before).
// A multi-site client defaults to the PRIMARY site; ?site=<domain> switches.
// Upload attribution: csv_uploads.site_id, where NULL means the primary site
// (true for all historical rows). Every per-URL/data child table carries
// csv_upload_id, so one uniform subquery scopes them all.

import { listManagedSites } from './client-sites';

export interface SiteScope {
  id: string;
  domain: string;
  isPrimary: boolean;
  /** All managed sites, for the UI's chips. */
  sites: Array<{ domain: string; is_primary: boolean }>;
}

// Resolve the active site scope for a client. Returns undefined for
// single-site clients (no scoping, no chips). Throws no errors: an unknown
// requested domain falls back to the primary rather than 500ing a dashboard.
export async function resolveSiteScope(clientId: string, requestedDomain?: string | null): Promise<SiteScope | undefined> {
  const sites = await listManagedSites(clientId);
  if (sites.length < 2) return undefined;
  const wanted = (requestedDomain || '').trim().toLowerCase();
  const match = (wanted && sites.find(s => s.domain.toLowerCase() === wanted))
    || sites.find(s => s.is_primary)
    || sites[0];
  return {
    id: match.id,
    domain: match.domain,
    isPrimary: !!match.is_primary,
    sites: sites.map(s => ({ domain: s.domain, is_primary: !!s.is_primary })),
  };
}

// The uniform upload-attribution fragment: appended to a WHERE tail (starts
// with AND), restricting rows to uploads attributed to the scoped site. NULL
// site_id counts as the primary site. Empty when unscoped, so the unscoped
// SQL stays byte-identical to the pre-Phase-1b queries. `col` lets a JOIN
// query qualify the column (e.g. 'siu.csv_upload_id') to avoid ambiguity.
export function uploadScopeFragment(clientId: string, scope?: SiteScope, col = 'csv_upload_id'): { frag: string; args: any[] } {
  if (!scope) return { frag: '', args: [] };
  return {
    frag: ` AND ${col} IN (SELECT id FROM csv_uploads WHERE client_id = ? AND (site_id = ? OR (site_id IS NULL AND ?)))`,
    args: [clientId, scope.id, scope.isPrimary ? 1 : 0],
  };
}
