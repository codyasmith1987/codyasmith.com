// Module enforcement — makes contracts.modules_json drive real
// behavior at the middleware and nav layer.
//
// modules_json was introduced in migration 015 and captured by the
// wizard in slice 9, but until this file existed nothing READ it at
// request time. The result was "fake completeness": every checkbox
// the admin toggled in the intake did nothing. This module ends that.
//
// Contract:
//   - ModuleKey is a small closed enum — adding a module is a code
//     change, not a runtime config change, so mistyped keys can never
//     leak into the DB.
//   - A client's enabled set is the UNION of modules_json across
//     their active contracts. A client with one consulting contract
//     (no rankings) plus one web_management contract (has rankings)
//     sees rankings enabled.
//   - Parse failures and zero-contract fallbacks return DEFAULT_MODULES
//     so corrupted or new clients never get locked out.
//   - `dashboard` is always on. A contract explicitly disabling it is
//     honored for the NAV but not for the ROUTE guard — a client
//     without dashboard would be lockout-looped with nowhere to land.

import turso from './turso';
import { logger } from './logger';

export type ModuleKey = 'dashboard' | 'rankings' | 'health' | 'files' | 'invoices';

export const MODULE_KEYS: readonly ModuleKey[] = [
  'dashboard',
  'rankings',
  'health',
  'files',
  'invoices',
] as const;

// The fallback set used when a client has no contracts, all contracts
// fail to parse, or a caller omits modules at provisioning time.
// Matches the DEFAULT_MODULES constant in contracts.ts — kept in sync
// by hand because the two files are in different domains (DB vs
// route) and I don't want a circular import.
export const DEFAULT_MODULES: ReadonlySet<ModuleKey> = new Set(MODULE_KEYS);

// Path prefix → required module. Order matters — longer prefixes
// should be listed before shorter ones so partial matches resolve to
// the most specific module. `/portal/dashboard` itself is intentionally
// absent: dashboard is always on at the route guard layer (see
// `pathRequiresModule`).
const MODULE_ROUTE_MAP: Array<{ prefix: string; module: ModuleKey }> = [
  { prefix: '/portal/api/dashboard/keywords', module: 'rankings' },
  { prefix: '/portal/api/dashboard/issues', module: 'health' },
  { prefix: '/portal/api/files', module: 'files' },
  { prefix: '/portal/api/invoices', module: 'invoices' },
  { prefix: '/portal/keywords', module: 'rankings' },
  { prefix: '/portal/health', module: 'health' },
  { prefix: '/portal/files', module: 'files' },
  { prefix: '/portal/invoices', module: 'invoices' },
];

// Returns the ModuleKey that a given request path requires, or null
// if the path is not module-gated (dashboard, notifications, admin,
// login, API endpoints not in the map, etc.). Callers use null as
// "don't gate this path".
export function pathRequiresModule(pathname: string): ModuleKey | null {
  for (const { prefix, module } of MODULE_ROUTE_MAP) {
    if (pathname === prefix || pathname.startsWith(prefix + '/') || pathname.startsWith(prefix + '?')) {
      return module;
    }
  }
  return null;
}

// Returns true if the given path is allowed under the enabled set.
// Paths with no module requirement are always allowed. Dashboard is
// always allowed regardless of the enabled set (see note above).
export function isPathAllowed(pathname: string, enabled: ReadonlySet<ModuleKey>): boolean {
  if (pathname === '/portal/dashboard' || pathname.startsWith('/portal/dashboard/')) return true;
  const required = pathRequiresModule(pathname);
  if (!required) return true;
  return enabled.has(required);
}

// Parses a contracts.modules_json value into a validated set.
// Returns null on any structural failure so the caller can decide
// whether to fall back or log.
export function parseModulesJson(raw: string | null | undefined): Set<ModuleKey> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const out = new Set<ModuleKey>();
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      if ((MODULE_KEYS as readonly string[]).includes(item)) {
        out.add(item as ModuleKey);
      }
    }
    return out;
  } catch {
    return null;
  }
}

// Computes the union of modules_json across a client's active
// contracts. Falls back to DEFAULT_MODULES when:
//   - the client has zero active contracts
//   - every contract's modules_json parses to null or empty
//   - the DB call fails (logged but non-fatal)
//
// Admin users should never reach this function — they get the full
// set from the middleware layer directly. But if a caller passes in
// an admin's client_id anyway, the union logic is safe.
export async function getEnabledModulesForClient(
  clientId: string
): Promise<Set<ModuleKey>> {
  try {
    const r = await turso.execute({
      sql: `SELECT modules_json FROM contracts
            WHERE client_id = ? AND status = 'active'`,
      args: [clientId],
    });
    const union = new Set<ModuleKey>();
    let anyParsed = false;
    for (const row of r.rows) {
      const parsed = parseModulesJson(row[0] as string | null);
      if (parsed && parsed.size > 0) {
        anyParsed = true;
        for (const k of parsed) union.add(k);
      }
    }
    if (!anyParsed) {
      // Either no active contracts, or all of them had empty/bad
      // modules_json — fall back to default.
      return new Set(DEFAULT_MODULES);
    }
    return union;
  } catch (err) {
    logger.warn('getEnabledModulesForClient failed, falling back to DEFAULT_MODULES', {
      client_id: clientId,
      error: String((err as Error)?.message ?? err),
    });
    return new Set(DEFAULT_MODULES);
  }
}
