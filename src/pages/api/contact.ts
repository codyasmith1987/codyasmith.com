export const prerender = false;

import type { APIRoute } from 'astro';

export const POST: APIRoute = async ({ request }) => {
  try {
    const data = await request.formData();
    const name = data.get('name')?.toString() || '';
    const email = data.get('email')?.toString() || '';
    const message = data.get('message')?.toString() || '';

    // Collect all checked interests
    const interests = data.getAll('interest').map(i => i.toString());
    const interestList = interests.length > 0 ? interests.join(', ') : 'Not specified';

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
      console.error('BREVO_API_KEY not set');
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
        replyTo: { email: email, name: name },
        subject: `New inquiry from ${name} — ${interestList}`,
        htmlContent: `
          <h2>New contact form submission</h2>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Interested in:</strong> ${interestList}</p>
          <p><strong>Message:</strong></p>
          <p>${message.replace(/\n/g, '<br>')}</p>
        `,
      }),
    });

    if (!brevoRes.ok) {
      const err = await brevoRes.text();
      console.error('Brevo API error:', err);
      return new Response(JSON.stringify({ error: 'Failed to send' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Send confirmation to the person who submitted
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify({
        sender: { name: 'Cody Smith', email: 'cody@codyasmith.com' },
        to: [{ email: email, name: name }],
        subject: 'Got your message',
        htmlContent: `
          <p>Hey ${name},</p>
          <p>Got your message. I'll take a look and get back to you within one business day. Usually faster.</p>
          <p>If anything changes or you want to add context, just reply to this email.</p>
          <p>Talk soon,<br>Cody</p>
        `,
      }),
    }).catch(err => console.error('Confirmation email failed:', err));

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('Contact form error:', err);
    return new Response(JSON.stringify({ error: 'Server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
