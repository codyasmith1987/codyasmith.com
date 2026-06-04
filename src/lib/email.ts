// Shared email sending via Brevo. Extracted from create-user.ts and
// send-link.ts to keep the API call shape consistent. Centralizes CRLF
// stripping on subject and recipient names so callers cannot accidentally
// open header-injection holes. Body escaping (HTML) is the caller's
// responsibility because each builder composes its own template; see
// src/lib/email-safety.ts for the helper.

import { logger } from './logger';
import { stripCRLF } from './email-safety';

// Optional extras for financial documents (invoices, overdue notices): a CC
// list (e.g. a client's accountant) and base64 attachments (the invoice PDF).
// Backward compatible: existing 3-arg callers are unaffected.
export interface SendEmailOptions {
  cc?: { email: string; name?: string }[];
  attachments?: { name: string; content: string }[]; // content is base64
}

export async function sendEmail(
  to: { email: string; name: string }[],
  subject: string,
  htmlContent: string,
  opts?: SendEmailOptions
): Promise<boolean> {
  const brevoKey = import.meta.env.BREVO_API_KEY;
  if (!brevoKey) {
    const ccStr = opts?.cc?.length ? ` | Cc: ${opts.cc.map(c => c.email).join(', ')}` : '';
    logger.info(`[EMAIL] (no BREVO_API_KEY) To: ${to.map(t => t.email).join(', ')}${ccStr} | Subject: ${subject}`);
    return false;
  }

  // Defense in depth: subject and recipient names must never contain CRLF
  // (RFC 5322 header injection). Brevo's JSON API is unlikely to honor
  // these in practice, but we strip at the application boundary.
  const safeSubject = stripCRLF(subject);
  const safeTo = to.map(t => ({ email: t.email, name: stripCRLF(t.name || '') }));

  try {
    const body: any = {
      sender: { name: 'Cody Smith', email: 'cody@codyasmith.com' },
      to: safeTo,
      subject: safeSubject,
      htmlContent,
    };
    if (opts?.cc && opts.cc.length > 0) {
      body.cc = opts.cc.map(c => ({ email: c.email, name: stripCRLF(c.name || '') }));
    }
    if (opts?.attachments && opts.attachments.length > 0) {
      body.attachment = opts.attachments;
    }
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': brevoKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    // Previously this returned true unconditionally, so a 4xx (bad address,
    // rejected attachment) looked like success and callers stamped
    // last_reminder_sent on a send that never landed. Report the real result.
    if (!res.ok) {
      logger.error(`Brevo email send failed: ${res.status}`, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (err) {
    logger.error('Brevo email send failed', err);
    return false;
  }
}
