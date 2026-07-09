// One-shot admin endpoint: create billable contracts for agreements that
// were EXECUTED before the billing handoff shipped and so have no Contract
// + at-signing invoice (status='executed', contract_id IS NULL). Those
// agreements generate zero revenue in the system until backfilled.
//
// Idempotent: ensureBillingContractFromAgreement compare-and-sets
// agreement.contract_id, so re-running cannot create a second contract.
//
// GET (default)            -> DRY RUN: report the stranded agreements, make
//                             no changes.
// GET ?apply=true          -> create a billable contract for each, AND raise
//                             the at-signing invoice.
// GET ?apply=true&skipInvoice=true -> create the contract but SKIP the
//                             at-signing invoice. Use this when payment for
//                             those engagements was already collected
//                             outside the system (the usual case for
//                             pre-handoff agreements), to avoid re-billing.

import type { APIRoute } from 'astro';
import { listAllAgreements } from '../../../../../lib/agreements';
import { ensureBillingContractFromAgreement } from '../../../../../lib/contract-handoff';
import { logger } from '../../../../../lib/logger';

export const prerender = false;

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ locals, url }) => {
  if (locals.user?.role !== 'admin') return json({ error: 'Forbidden' }, 403);

  const apply = url.searchParams.get('apply') === 'true';
  const skipInvoice = url.searchParams.get('skipInvoice') === 'true';

  try {
    const all = await listAllAgreements();
    const stranded = all.filter(a => a.status === 'executed' && !a.contract_id);

    if (!apply) {
      return json({
        ok: true,
        mode: 'dry-run',
        stranded_count: stranded.length,
        note: 'No changes made. Re-run with ?apply=true to create billable contracts. ' +
          'Add &skipInvoice=true to skip the at-signing invoice when payment was already collected outside the system.',
        stranded: stranded.map(a => ({
          id: a.id, slug: a.slug, title: a.title, client_id: a.client_id, finalized_at: a.finalized_at,
        })),
      });
    }

    const results: any[] = [];
    let created = 0, skipped = 0, errors = 0;
    for (const a of stranded) {
      try {
        const r = await ensureBillingContractFromAgreement(a, locals.user!.id, { skipAtSigningInvoice: skipInvoice });
        if (r.created) created++; else skipped++;
        results.push({ slug: a.slug, contract_id: r.contractId, invoice_id: r.invoiceId, created: r.created });
      } catch (err: any) {
        errors++;
        logger.error(`backfill-billing-contracts failed for agreement ${a.slug}`, err);
        results.push({ slug: a.slug, error: err?.message || 'failed' });
      }
    }

    return json({ ok: true, mode: 'apply', skip_invoice: skipInvoice, total: stranded.length, created, skipped, errors, results });
  } catch (err: any) {
    logger.error('backfill-billing-contracts failed', err);
    return json({ error: err?.message || 'Backfill failed' }, 500);
  }
};
