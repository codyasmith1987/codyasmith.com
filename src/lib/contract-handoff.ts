// Billing handoff: executed agreement -> billable contract + at-signing invoice.
//
// When the second signer finalizes an agreement, sign.ts has historically
// generated the PDF and sent confirmation emails but never created a
// billable contract, so nothing ever invoiced. This module closes that
// gap. It reads the signed Schedule A (the snapshot the client agreed to),
// creates an active Contract the recurring-invoice engine can bill, links
// it back to the agreement, and raises the at-signing invoice (one-time
// fees plus the first month, per contract section 5.2).
//
// Idempotent: the agreement's contract_id is set via a compare-and-set,
// so a retried finalize cannot create a second contract. The first-month
// line is tagged to the current billing period so the recurring engine
// (which dedupes on contract + period) does not bill that month twice.

import { createContract, updateContract, deleteContract } from './contracts';
import { createInvoiceWithGeneratedNumber, updateInvoice, addInvoiceItem } from './invoices';
import { getCurrentBillingPeriod } from './billing';
import { linkAgreementContract, getAgreementBySlug, type ClientAgreement } from './agreements';
import { logger } from './logger';

const round2 = (n: number) => Math.round(n * 100) / 100;

function clampBillingDay(input: unknown): number {
  const n = typeof input === 'number' ? input : Number(input);
  if (!Number.isInteger(n) || n < 1) return 1;
  if (n > 28) return 28; // keep the anchor valid in every month
  return n;
}

export interface BillingHandoffResult {
  contractId: string;
  invoiceId: string | null;
  created: boolean;
}

export interface DerivedBillingTerms {
  recurring: number;
  isRecurring: boolean;
  includedHours: number | null;
  overageRate: number;
  billingDay: number;
  contractType: 'retainer' | 'fixed';
  cadence: 'monthly' | 'one-time';
  atSigningTotal: number;
  atSigningItems: Array<{ label: string; amount: number }>;
}

// Pure: read the billable terms off a signed Schedule A. Recurring is the
// sum of the WM monthly total and the MC retainer; the at-signing figures
// come from the Schedule A "Amount due at signing" block. No DB access, so
// this is unit-tested directly against buildScheduleA output.
export function deriveBillingTerms(scheduleA: any, billingAnchorDay?: number | null): DerivedBillingTerms {
  const s: any = scheduleA || {};
  const wm = s.web_management || null;
  const mc = s.marketing_consulting || null;
  const wmMonthly = wm && typeof wm.monthly_total === 'number' ? wm.monthly_total : 0;
  const mcMonthly = mc && typeof mc.monthly_retainer === 'number' ? mc.monthly_retainer : 0;
  const recurring = round2(wmMonthly + mcMonthly);
  const isRecurring = recurring > 0;

  const hr = s.hours_and_rates || {};
  const includedHours = typeof hr.included_hours === 'number'
    ? hr.included_hours
    : (wm && typeof wm.included_hours === 'number' ? wm.included_hours : null);
  const overageRate = typeof hr.overage_rate === 'number' ? hr.overage_rate : 100;
  const billingDay = clampBillingDay(hr.billing_anchor_day ?? billingAnchorDay ?? 1);

  const ads = s.amount_due_at_signing || null;
  const atSigningTotal = ads && typeof ads.total === 'number' ? ads.total : 0;
  const atSigningItems = ads && Array.isArray(ads.line_items) ? ads.line_items : [];

  return {
    recurring,
    isRecurring,
    includedHours,
    overageRate,
    billingDay,
    contractType: isRecurring ? 'retainer' : 'fixed',
    cadence: isRecurring ? 'monthly' : 'one-time',
    atSigningTotal,
    atSigningItems,
  };
}

// Create the billable contract + at-signing invoice for a freshly
// executed agreement. Safe to call more than once: returns the existing
// link without creating duplicates.
export async function ensureBillingContractFromAgreement(
  agreement: ClientAgreement,
  createdBy: string,
): Promise<BillingHandoffResult> {
  if (agreement.contract_id) {
    return { contractId: agreement.contract_id, invoiceId: null, created: false };
  }

  const terms = deriveBillingTerms(agreement.schedule_a, agreement.billing_anchor_day);
  const { recurring, isRecurring, includedHours, overageRate, billingDay, atSigningTotal, atSigningItems } = terms;
  const today = new Date().toISOString().slice(0, 10);

  // Create the contract from the signed Schedule A.
  const contractId = await createContract({
    client_id: agreement.client_id,
    title: agreement.title,
    type: terms.contractType,
    billing_cadence: terms.cadence,
    billing_day: isRecurring ? billingDay : undefined,
    recurring_amount: isRecurring ? recurring : undefined,
    included_hours: includedHours ?? undefined,
    overage_rate: overageRate,
    total_value: atSigningTotal > 0 ? atSigningTotal : undefined,
    start_date: today,
    created_by: createdBy,
  });
  await updateContract(contractId, { status: 'active', signed_at: today });

  // Link agreement -> contract (compare-and-set). If another finalize
  // already linked one, drop the orphan we just made and defer to it.
  const linked = await linkAgreementContract(agreement.id, contractId);
  if (!linked) {
    await deleteContract(contractId);
    const fresh = await getAgreementBySlug(agreement.slug);
    return { contractId: fresh?.contract_id || contractId, invoiceId: null, created: false };
  }

  // Raise the at-signing invoice from the Schedule A itemization.
  let invoiceId: string | null = null;
  if (atSigningItems.length > 0 && atSigningTotal > 0) {
    const { id } = await createInvoiceWithGeneratedNumber({
      contract_id: contractId,
      client_id: agreement.client_id,
      due_date: today, // due on receipt; work begins once it clears (section 5.2)
      notes: `Due at signing for ${agreement.title}. Work begins once this clears.`,
      created_by: createdBy,
    });
    invoiceId = id;

    // Tag the invoice to the current billing period so the recurring
    // engine treats this month as already billed and starts at the next
    // period. (Builds-only contracts have no recurring period to guard.)
    const period = isRecurring ? getCurrentBillingPeriod(billingDay) : null;
    await updateInvoice(id, {
      status: 'sent',
      issued_date: today,
      client_visible: 1,
      ...(period ? { billing_period_start: period.start, billing_period_end: period.end } : {}),
    } as any);

    for (const li of atSigningItems) {
      if (typeof li.amount === 'number' && li.amount !== 0) {
        await addInvoiceItem({ invoice_id: id, description: String(li.label || 'Line item'), unit_price: li.amount });
      }
    }
  }

  logger.info(`Billing handoff: contract ${contractId} created for agreement ${agreement.id} (recurring $${recurring}/mo, at-signing invoice ${invoiceId || 'none'})`);
  return { contractId, invoiceId, created: true };
}
