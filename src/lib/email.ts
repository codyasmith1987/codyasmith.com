// Shared email sending via Brevo. Extracted from create-user.ts and
// send-link.ts to keep the API call shape consistent. Centralizes CRLF
// stripping on subject and recipient names so callers cannot accidentally
// open header-injection holes. Body escaping (HTML) is the caller's
// responsibility because each builder composes its own template; see
// src/lib/email-safety.ts for the helper.

import { logger } from './logger';
import { stripCRLF } from './email-safety';

export async function sendEmail(
  to: { email: string; name: string }[],
  subject: string,
  htmlContent: string
): Promise<boolean> {
  const brevoKey = import.meta.env.BREVO_API_KEY;
  if (!brevoKey) {
    logger.info(`[EMAIL] (no BREVO_API_KEY) To: ${to.map(t => t.email).join(', ')} | Subject: ${subject}`);
    return false;
  }

  // Defense in depth: subject and recipient names must never contain CRLF
  // (RFC 5322 header injection). Brevo's JSON API is unlikely to honor
  // these in practice, but we strip at the application boundary.
  const safeSubject = stripCRLF(subject);
  const safeTo = to.map(t => ({ email: t.email, name: stripCRLF(t.name) }));

  try {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': brevoKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: 'Cody Smith', email: 'cody@codyasmith.com' },
        to: safeTo,
        subject: safeSubject,
        htmlContent,
      }),
    });
    return true;
  } catch (err) {
    logger.error('Brevo email send failed', err);
    return false;
  }
}
