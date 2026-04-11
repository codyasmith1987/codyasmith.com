export const prerender = false;

import type { APIRoute } from 'astro';

export const POST: APIRoute = async ({ request }) => {
  try {
    const { name, email, theme, answers } = await request.json();

    if (!name || !email) {
      return new Response(JSON.stringify({ error: 'Missing fields' }), {
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
        replyTo: { email, name },
        subject: `New visitor: ${name} (${q1} / ${q2} / ${q3} / ${q4})`,
        htmlContent: `
          <h2>Someone personalized the site</h2>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Persona:</strong> ${q1} / ${q2} / ${q3} / ${q4}</p>
          <p><strong>Theme:</strong> ${theme}</p>
        `,
      }),
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Quiz API error:', err);
    return new Response(JSON.stringify({ error: 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
