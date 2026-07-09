import type { APIRoute } from 'astro';
import { renderOg } from '../../../lib/og';

export const prerender = true;

export const GET: APIRoute = async () => {
  const png = await renderOg({
    title: 'Jobs my lawyer cleared.',
    eyebrow: 'Case studies',
    kicker: 'Cody Smith',
    subtitle: 'What broke. What we tried. What moved.',
  });
  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
