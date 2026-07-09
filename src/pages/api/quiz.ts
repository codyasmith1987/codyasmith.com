export const prerender = false;

import type { APIRoute } from 'astro';
import { rateLimit } from '../../lib/rate-limit';
import { logger } from '../../lib/logger';
import { buildQuizConfirmationEmail } from '../../lib/funnel-emails';
import { escapeHtml, stripCRLF } from '../../lib/email-safety';
import turso from '../../lib/turso';

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const ip = clientAddress || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!await rateLimit(`quiz:${ip}`, 5, 60 * 60 * 1000)) {
    return new Response(JSON.stringify({ error: 'Too many requests' }), {
      status: 429, headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const { name, email, theme, answers } = await request.json();

    // Validate shape and length before any processing. Without these caps
    // an attacker can post multi-megabyte name/email/theme strings that
    // tie up the Brevo call and burn the daily send budget. See
    // security-audit-2026-05-12 round 3 SEC3-006.
    if (
      typeof name !== 'string' || typeof email !== 'string' ||
      !name.trim() || !email.trim() ||
      name.length > 100 || email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      (theme && (typeof theme !== 'string' || theme.length > 80))
    ) {
      return new Response(JSON.stringify({ error: 'Missing or invalid fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const apiKey = import.meta.env.BREVO_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'Server config error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const labels: Record<string, string> = {
      sun: 'Sun', moon: 'Moon',
      beach: 'Beach', mountain: 'Mountain',
      spring: 'Spring', fall: 'Fall',
      stars: 'Stars', clouds: 'Clouds',
    };

    const q1 = labels[answers?.['1']] || '?';
    const q2 = labels[answers?.['2']] || '?';
    const q3 = labels[answers?.['3']] || '?';
    const q4 = labels[answers?.['4']] || '?';

    // Persist persona axes per audit move 3. UPSERT keyed on email so
    // a prospect retaking the quiz updates instead of duplicating;
    // most recent pick wins. Non-blocking: an axis storage failure
    // shouldn't break the email send or hurt the visitor's experience.
    // Validate values against the closed set of axis answers so we
    // never store junk from a malformed POST.
    try {
      const validSunMoon = new Set(['sun', 'moon']);
      const validBeachMountain = new Set(['beach', 'mountain']);
      const validSpringFall = new Set(['spring', 'fall']);
      const validStarsClouds = new Set(['stars', 'clouds']);
      const sun_moon = validSunMoon.has(answers?.['1']) ? answers['1'] : null;
      const beach_mountain = validBeachMountain.has(answers?.['2']) ? answers['2'] : null;
      const spring_fall = validSpringFall.has(answers?.['3']) ? answers['3'] : null;
      const stars_clouds = validStarsClouds.has(answers?.['4']) ? answers['4'] : null;
      const normalizedEmail = email.trim().toLowerCase();
      await turso.execute({
        sql: `
          INSERT INTO lead_personas (email, name, sun_moon, beach_mountain, spring_fall, stars_clouds, theme, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(email) DO UPDATE SET
            name = excluded.name,
            sun_moon = excluded.sun_moon,
            beach_mountain = excluded.beach_mountain,
            spring_fall = excluded.spring_fall,
            stars_clouds = excluded.stars_clouds,
            theme = excluded.theme,
            updated_at = datetime('now')
        `,
        args: [
          normalizedEmail,
          name.trim(),
          sun_moon,
          beach_mountain,
          spring_fall,
          stars_clouds,
          theme || null,
        ],
      });
    } catch (err) {
      logger.error('Quiz persona persist failed', err);
    }

    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify({
        sender: { name: 'codyasmith.com', email: 'cody@codyasmith.com' },
        to: [{ email: 'cody@codyasmith.com', name: 'Cody Smith' }],
        replyTo: { email, name: stripCRLF(name) },
        subject: stripCRLF(`New visitor: ${name} (${q1} / ${q2} / ${q3} / ${q4})`),
        htmlContent: `
          <h2>Someone personalized the site</h2>
          <p><strong>Name:</strong> ${escapeHtml(name)}</p>
          <p><strong>Email:</strong> ${escapeHtml(email)}</p>
          <p><strong>Persona:</strong> ${escapeHtml(q1)} / ${escapeHtml(q2)} / ${escapeHtml(q3)} / ${escapeHtml(q4)}</p>
          <p><strong>Theme:</strong> ${escapeHtml(theme || '')}</p>
        `,
      }),
    });

    // Follow-up email to the visitor. Non-blocking: an admin notification
    // already landed, so we shouldn't fail the request if the visitor copy
    // bounces.
    try {
      const followUp = buildQuizConfirmationEmail({ name, theme: theme || '' });
      const followUpRes = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'application/json',
          'api-key': apiKey,
        },
        body: JSON.stringify({
          sender: { name: 'Cody Smith', email: 'cody@codyasmith.com' },
          to: [{ email, name: stripCRLF(name) }],
          subject: stripCRLF(followUp.subject),
          htmlContent: followUp.html,
        }),
      });
      if (!followUpRes.ok) {
        const followUpErr = await followUpRes.text();
        logger.error('Quiz follow-up email API error', new Error(`${followUpRes.status}: ${followUpErr}`));
      }
    } catch (err) {
      logger.error('Quiz follow-up email failed', err);
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    logger.error('Quiz API error', err);
    return new Response(JSON.stringify({ error: 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
