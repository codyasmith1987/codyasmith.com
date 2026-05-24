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
