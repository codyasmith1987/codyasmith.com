export const prerender = false;

import type { APIRoute } from 'astro';
import { getScan, getMentions, insertLead } from '../../lib/db';

export const POST: APIRoute = async ({ request }) => {
  const json = (s: any, status = 200) => new Response(JSON.stringify(s), {
    status, headers: { 'Content-Type': 'application/json' },
  });

  try {
    const body = await request.json();
    const { scan_id, first_name, email, consent } = body;

    if (!scan_id || !first_name?.trim() || !email?.trim()) {
      return json({ error: 'Name and email are required' }, 400);
    }

    if (!consent) {
      return json({ error: 'Consent is required to receive your report' }, 400);
    }

    // Validate email
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: 'Invalid email address' }, 400);
    }

    // Get the scan
    const scan = await getScan(scan_id);
    if (!scan) {
      return json({ error: 'Scan not found' }, 404);
    }

    // Store the lead
    await insertLead({
      scan_id,
      first_name: first_name.trim(),
      email: email.trim(),
      brand_searched: scan.brand,
      domain_searched: scan.domain,
      overall_score: scan.overall_score,
    });

    // Send report email via Brevo (non-blocking)
    const brevoKey = import.meta.env.BREVO_API_KEY;
    if (brevoKey) {
      sendReportEmail(brevoKey, email.trim(), first_name.trim(), scan).catch(
        err => console.error('Report email failed:', err)
      );
    }

    // Return full Tier 2 data
    const mentions = await getMentions(scan_id);
    let topPositive: string[] = [];
    let topNegative: string[] = [];
    try { topPositive = JSON.parse(scan.top_positive_phrases || '[]'); } catch {}
    try { topNegative = JSON.parse(scan.top_negative_phrases || '[]'); } catch {}

    return json({
      mentions,
      top_positive_phrases: topPositive,
      top_negative_phrases: topNegative,
      source_breakdown: JSON.parse(scan.source_breakdown || '{}'),
      summary: scan.summary,
    });

  } catch (err: any) {
    console.error('Unlock error:', err);
    return json({ error: err.message || 'Failed to unlock report' }, 500);
  }
};

async function sendReportEmail(apiKey: string, email: string, name: string, scan: any) {
  const scoreColor = scan.overall_score >= 65 ? '#10b981' : scan.overall_score >= 40 ? '#f59e0b' : '#ef4444';

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      sender: { name: 'Cody Smith', email: 'cody@codyasmith.com' },
      to: [{ email, name }],
      subject: `Your Sentiment Report: ${scan.brand}`,
      htmlContent: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
          <p>Hey ${name},</p>
          <p>Here's your sentiment report for <strong>${scan.brand}</strong>.</p>

          <div style="background: #f8f9fa; border-radius: 12px; padding: 24px; margin: 24px 0; text-align: center;">
            <p style="font-size: 48px; font-weight: bold; color: ${scoreColor}; margin: 0;">${scan.overall_score}</p>
            <p style="font-size: 14px; color: #666; margin: 4px 0 0 0;">${scan.overall_label} &middot; ${scan.mention_count} mentions analyzed</p>
          </div>

          <p>${scan.summary}</p>

          <p style="margin-top: 24px;">
            <a href="https://codyasmith.com/listener" style="background: #f59e0b; color: #1a1a1a; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 14px;">View Full Report</a>
          </p>

          <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;" />

          <p style="font-size: 14px; color: #666;">
            I help businesses fix exactly these kinds of problems — from cleaning up how your brand shows up online to building a web presence that actually converts.
            Reply to this email if you want to talk about what this report means for your business.
          </p>

          <p>Cody Smith<br /><a href="https://codyasmith.com" style="color: #f59e0b;">codyasmith.com</a></p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Brevo report email error:', res.status, err);
  }
}
