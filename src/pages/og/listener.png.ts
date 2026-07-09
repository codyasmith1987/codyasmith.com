import type { APIRoute } from 'astro';
import { renderOg } from '../../lib/og';

export const prerender = true;

export const GET: APIRoute = async () => {
  const png = await renderOg({
    title: 'What does the web say about you?',
    eyebrow: 'Free tool',
    kicker: 'Sentiment Scanner',
    subtitle: 'Enter your brand. See the sentiment. Free, no login.',
  });
  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
