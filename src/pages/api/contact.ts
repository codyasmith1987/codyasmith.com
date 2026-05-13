export const prerender = false;

import type { APIRoute } from 'astro';
import { rateLimit } from '../../lib/rate-limit';
import { logger } from '../../lib/logger';
import { buildContactConfirmationEmail } from '../../lib/funnel-emails';
import { escapeHtml, stripCRLF } from '../../lib/email-safety';

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const ip = clientAddress || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!await rateLimit(`contact:${ip}`, 5, 60 * 60 * 1000)) {
    return new Response(JSON.stringify({ error: 'Too many requests. Try again later.' }), {
      status: 429, headers: { 'Content-Type': 'application/json' },
    });
  }
  try {
    const data = await request.formData();
    const name = data.get('name')?.toString() || '';
    const email = data.get('email')?.toString() || '';
    const message = data.get('message')?.toString() || '';

    // Collect all checked interests
    const interests = data.getAll('interest').map(i => i.toString());
    const interestList = interests.length > 0 ? interests.join(', ') : 'Not specified';
    const quizTheme = data.get('quiz-theme')?.toString() || '';

    if (!name || !email || !message) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Basic email validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new Response(JSON.stringify({ error: 'Invalid email' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const apiKey = import.meta.env.BREVO_API_KEY;
    if (!apiKey) {
      logger.error('BREVO_API_KEY not set');
      return new Response(JSON.stringify({ error: 'Server configuration error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Send via Brevo transactional email API
    const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify({
        sender: { name: 'codyasmith.com', email: 'cody@codyasmith.com' },
        to: [{ email: 'cody@codyasmith.com', name: 'Cody Smith' }],
        replyTo: { email: email, name: stripCRLF(name) },
        subject: stripCRLF(`New inquiry from ${name}: ${interestList}${quizTheme ? ` [${quizTheme}]` : ''}`),
        htmlContent: `
          <h2>New contact form submission</h2>
          <p><strong>Name:</strong> ${escapeHtml(name)}</p>
          <p><strong>Email:</strong> ${escapeHtml(email)}</p>
          <p><strong>Interested in:</strong> ${escapeHtml(interestList)}</p>
          ${quizTheme ? `<p><strong>Quiz theme:</strong> ${escapeHtml(quizTheme)}</p>` : ''}
          <p><strong>Message:</strong></p>
          <p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>
        `,
      }),
    });

    if (!brevoRes.ok) {
      const err = await brevoRes.text();
      logger.error('Brevo API error', new Error(err));
      return new Response(JSON.stringify({ error: 'Failed to send' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Send confirmation to the person who submitted
    try {
      const confirmation = buildContactConfirmationEmail({ name, quizTheme, interests });
      const confirmRes = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'application/json',
          'api-key': apiKey,
        },
        body: JSON.stringify({
          sender: { name: 'Cody Smith', email: 'cody@codyasmith.com' },
          to: [{ email: email, name: stripCRLF(name) }],
          subject: stripCRLF(confirmation.subject),
          htmlContent: confirmation.html,
        }),
      });
      if (!confirmRes.ok) {
        const confirmErr = await confirmRes.text();
        logger.error('Confirmation email API error', new Error(`${confirmRes.status}: ${confirmErr}`));
      }
    } catch (err) {
      logger.error('Confirmation email failed', err);
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    logger.error('Contact form error', err);
    return new Response(JSON.stringify({ error: 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
