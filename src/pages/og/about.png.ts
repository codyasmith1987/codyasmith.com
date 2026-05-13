import type { APIRoute } from 'astro';
import { renderOg } from '../../lib/og';

export const prerender = true;

export const GET: APIRoute = async () => {
  const png = await renderOg({
    title: 'The longer version.',
    eyebrow: 'About',
    kicker: 'Cedar City, Utah',
    subtitle: 'Writer, marketer, strategist, consultant.',
  });
  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
