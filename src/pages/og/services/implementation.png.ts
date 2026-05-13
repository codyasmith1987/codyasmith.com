import type { APIRoute } from 'astro';
import { renderOg } from '../../../lib/og';

export const prerender = true;

export const GET: APIRoute = async () => {
  const png = await renderOg({
    title: 'Scoped projects. Start, build, hand over.',
    eyebrow: 'Implementation',
    kicker: 'Cedar City, Utah',
    subtitle: 'Integrations, page builds, analytics.',
  });
  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
