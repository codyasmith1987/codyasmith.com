// Invoice email recipients + sending. The recipient model (Cody, 2026-06-04):
// invoices and overdue notices go to the client's PRIMARY billing contact, NOT
// every portal user. An accountant CC (per client) rides along on FINANCIAL
// documents only. A per-invoice extra recipient alerts someone for one invoice.
//
// resolveInvoiceRecipients is pure (unit-tested). The actual send
// (sendInvoiceEmail) is added with the Send slice and reuses sendBrevo + the
// PDF, gated to the Cody Test client until confirmed for real clients.

export interface InvoiceRecipients {
  to: string[];
  cc: string[];
}

const norm = (e?: string | null): string => (e || '').trim().toLowerCase();
const clean = (e?: string | null): string => (e || '').trim();

// to: the primary billing contact (or, only if none is set, the first fallback
// such as a portal user, as a safety so a misconfigured invoice still reaches
// someone). cc: the per-client accountant + the per-invoice extra, deduped and
// never duplicating a `to` address.
export function resolveInvoiceRecipients(opts: {
  primaryEmail?: string | null;
  billingCcEmail?: string | null;
  extraEmail?: string | null;
  fallbackEmails?: string[];
}): InvoiceRecipients {
  const to: string[] = [];
  const primary = clean(opts.primaryEmail);
  if (primary) {
    to.push(primary);
  } else {
    for (const f of opts.fallbackEmails || []) {
      if (clean(f)) { to.push(clean(f)); break; }
    }
  }

  const seen = new Set(to.map(norm));
  const cc: string[] = [];
  for (const candidate of [opts.billingCcEmail, opts.extraEmail]) {
    const v = clean(candidate);
    if (v && !seen.has(norm(v))) {
      cc.push(v);
      seen.add(norm(v));
    }
  }

  return { to, cc };
}
