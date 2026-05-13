import type { APIRoute } from 'astro';
import { renderOg } from '../../lib/og';

export const prerender = true;

export const GET: APIRoute = async () => {
  const png = await renderOg({
    title: "Let's talk.",
    eyebrow: 'Contact',
    kicker: 'Cedar City, Utah',
    subtitle: "Tell me what's going on. No pitch deck. No call theater.",
  });
  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
