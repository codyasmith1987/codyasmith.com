import type { APIRoute } from 'astro';
import { renderOg } from '../../lib/og';

export const prerender = true;

export const GET: APIRoute = async () => {
  const png = await renderOg({
    title: 'Web management, marketing strategy, implementation, training.',
    eyebrow: 'Services',
    kicker: 'Cedar City, Utah',
    subtitle: 'Monthly retainers, not hourly surprises.',
  });
  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
