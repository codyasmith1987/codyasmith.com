// Shared email sending via Brevo — extracted from create-user.ts / send-link.ts pattern

import { logger } from './logger';

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

  try {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': brevoKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: 'Cody Smith', email: 'cody@codyasmith.com' },
        to,
        subject,
        htmlContent,
      }),
    });
    return true;
  } catch (err) {
    logger.error('Brevo email send failed', err);
    return false;
  }
}
