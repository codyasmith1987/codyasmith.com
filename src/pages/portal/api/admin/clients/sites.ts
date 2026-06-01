// Admin endpoints for the client_sites table. Handles four actions:
//
//   POST   { client_id, action: 'sync' }                         -> populate from uploaded data
//   POST   { client_id, action: 'set_primary', site_id }         -> set is_primary
//   POST   { client_id, action: 'toggle_managed', site_id }      -> flip is_managed
//   POST   { client_id, action: 'add', domain, label? }          -> add manual site
//   POST   { client_id, action: 'delete', site_id }              -> remove a site
//   GET    ?client_id=...                                        -> list sites
//
// One endpoint with action discriminator instead of five tiny files.

import type { APIRoute } from 'astro';
import {
  listClientSites,
  syncDetectedDomains,
  setPrimarySite,
  setSiteManaged,
  setSitePageCount,
  setSiteWentLive,
  setSiteMonthlyOverride,
  setSiteOnboardingOverride,
  addManualSite,
  deleteClientSite,
} from '../../../../../lib/client-sites';
import { logger } from '../../../../../lib/logger';
import { logActivity } from '../../../../../lib/activity';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);
  const clientId = (url.searchParams.get('client_id') || '').trim();
  if (!clientId) return json({ error: 'client_id is required' }, 400);
  try {
    const sites = await listClientSites(clientId);
    return json({ ok: true, sites });
  } catch (err: any) {
    logger.error('listClientSites failed', err);
    return json({ error: err?.message || 'Failed to list sites' }, 500);
  }
};

export const POST: APIRoute = async ({ locals, request }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  let body: any;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const clientId = (body?.client_id || '').toString().trim();
  const action = (body?.action || '').toString().trim();
  if (!clientId) return json({ error: 'client_id is required' }, 400);
  if (!action) return json({ error: 'action is required' }, 400);

  try {
    if (action === 'sync') {
      const inserted = await syncDetectedDomains(clientId);
      const sites = await listClientSites(clientId);
      return json({ ok: true, inserted, sites });
    }

    if (action === 'set_primary') {
      const siteId = (body?.site_id || '').toString().trim();
      if (!siteId) return json({ error: 'site_id is required' }, 400);
      const result = await setPrimarySite(clientId, siteId);
      if (!result.domain) return json({ error: 'Site not found' }, 404);
      await logActivity({
        clientId, userId: locals.user!.id, action: 'updated',
        entityType: 'client', entityId: clientId,
        summary: `${locals.user!.name} set primary site to ${result.domain}`,
      });
      const sites = await listClientSites(clientId);
      return json({ ok: true, primary_domain: result.domain, sites });
    }

    if (action === 'toggle_managed') {
      const siteId = (body?.site_id || '').toString().trim();
      const desired = body?.is_managed;
      if (!siteId) return json({ error: 'site_id is required' }, 400);
      const sites = await listClientSites(clientId);
      const target = sites.find(s => s.id === siteId);
      if (!target) return json({ error: 'Site not found' }, 404);
      const newValue = typeof desired === 'boolean' ? desired : !target.is_managed;
      await setSiteManaged(clientId, siteId, newValue);
      await logActivity({
        clientId, userId: locals.user!.id, action: 'updated',
        entityType: 'client', entityId: clientId,
        summary: `${locals.user!.name} set ${target.domain} is_managed=${newValue ? 1 : 0}`,
      });
      const next = await listClientSites(clientId);
      return json({ ok: true, sites: next });
    }

    if (action === 'add') {
      const domain = (body?.domain || '').toString();
      const label = body?.label ? String(body.label) : undefined;
      const id = await addManualSite(clientId, domain, { label });
      if (!id) return json({ error: 'Domain must look like example.com (no protocol, no path)' }, 400);
      await logActivity({
        clientId, userId: locals.user!.id, action: 'created',
        entityType: 'client', entityId: clientId,
        summary: `${locals.user!.name} added managed site ${domain}`,
      });
      const sites = await listClientSites(clientId);
      return json({ ok: true, site_id: id, sites });
    }

    if (action === 'set_page_count') {
      // Set or clear per-site page count. Drives the multi-site
      // pricing pipeline (each site routes to its own ecosystem by
      // its own page count). null/empty value clears so the pricing
      // pipeline falls back to the primary's ecosystem. 0 is not a
      // valid page count; use blank/null for unknown.
      const siteId = (body?.site_id || '').toString().trim();
      if (!siteId) return json({ error: 'site_id is required' }, 400);
      const raw = body?.page_count;
      const pageCount = raw === null || raw === undefined || raw === ''
        ? null
        : Number(raw);
      if (pageCount !== null && (!Number.isFinite(pageCount) || pageCount <= 0)) {
        return json({ error: 'page_count must be a positive number or blank' }, 400);
      }
      const sites = await listClientSites(clientId);
      const target = sites.find(s => s.id === siteId);
      if (!target) return json({ error: 'Site not found' }, 404);
      await setSitePageCount(clientId, siteId, pageCount);
      await logActivity({
        clientId, userId: locals.user!.id, action: 'updated',
        entityType: 'client', entityId: clientId,
        summary: pageCount === null
          ? `${locals.user!.name} cleared page count for ${target.domain}`
          : `${locals.user!.name} set ${target.domain} page count to ${pageCount}`,
      });
      const next = await listClientSites(clientId);
      return json({ ok: true, sites: next });
    }

    if (action === 'set_went_live') {
      // Mark a managed site live (or clear). Drives first-period
      // proration on the next invoice for that site. Per Cody's
      // operating rule: every site on this agreement bills on the
      // same monthly cadence; first invoice prorated from this
      // date to the next anchor day.
      const siteId = (body?.site_id || '').toString().trim();
      if (!siteId) return json({ error: 'site_id is required' }, 400);
      const raw = body?.went_live_at;
      const wentLiveAt = raw === null || raw === undefined || raw === ''
        ? null
        : String(raw);
      const sites = await listClientSites(clientId);
      const target = sites.find(s => s.id === siteId);
      if (!target) return json({ error: 'Site not found' }, 404);
      try {
        await setSiteWentLive(clientId, siteId, wentLiveAt);
      } catch (err: any) {
        return json({ error: err?.message || 'Invalid went_live_at' }, 400);
      }
      await logActivity({
        clientId, userId: locals.user!.id, action: 'updated',
        entityType: 'client', entityId: clientId,
        summary: wentLiveAt === null
          ? `${locals.user!.name} cleared go-live date for ${target.domain}`
          : `${locals.user!.name} marked ${target.domain} live on ${wentLiveAt}`,
      });
      const next = await listClientSites(clientId);
      return json({ ok: true, sites: next });
    }

    if (action === 'set_monthly_override' || action === 'set_onboarding_override') {
      // Per-site pricing override. null/empty value clears so the
      // site falls back to formula pricing. Any non-null number
      // (including 0) sets the exact per-site contribution and
      // bypasses the multi-site 0.90 multiplier for that site.
      // Use cases: pro-bono ($0), grandfathered legacy rates.
      const siteId = (body?.site_id || '').toString().trim();
      if (!siteId) return json({ error: 'site_id is required' }, 400);
      const field = action === 'set_monthly_override' ? 'monthly_override' : 'onboarding_override';
      const raw = body?.[field];
      const amount = raw === null || raw === undefined || raw === ''
        ? null
        : Number(raw);
      if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
        return json({ error: `${field} must be a non-negative number or null` }, 400);
      }
      const sites = await listClientSites(clientId);
      const target = sites.find(s => s.id === siteId);
      if (!target) return json({ error: 'Site not found' }, 404);
      try {
        if (action === 'set_monthly_override') {
          await setSiteMonthlyOverride(clientId, siteId, amount);
        } else {
          await setSiteOnboardingOverride(clientId, siteId, amount);
        }
      } catch (err: any) {
        return json({ error: err?.message || 'Invalid override' }, 400);
      }
      await logActivity({
        clientId, userId: locals.user!.id, action: 'updated',
        entityType: 'client', entityId: clientId,
        summary: amount === null
          ? `${locals.user!.name} cleared ${field} for ${target.domain}`
          : `${locals.user!.name} set ${target.domain} ${field} to $${amount.toFixed(2)}`,
      });
      const next = await listClientSites(clientId);
      return json({ ok: true, sites: next });
    }

    if (action === 'delete') {
      const siteId = (body?.site_id || '').toString().trim();
      if (!siteId) return json({ error: 'site_id is required' }, 400);
      const ok = await deleteClientSite(clientId, siteId);
      if (!ok) return json({ error: 'Site not found' }, 404);
      await logActivity({
        clientId, userId: locals.user!.id, action: 'deleted',
        entityType: 'client', entityId: clientId,
        summary: `${locals.user!.name} removed a managed site`,
      });
      const sites = await listClientSites(clientId);
      return json({ ok: true, sites });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (err: any) {
    logger.error(`client-sites ${action} failed`, err);
    return json({ error: err?.message || 'Action failed' }, 500);
  }
};
