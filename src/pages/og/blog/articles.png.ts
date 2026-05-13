import type { APIRoute } from 'astro';
import { renderOg } from '../../../lib/og';

export const prerender = true;

export const GET: APIRoute = async () => {
  const png = await renderOg({
    title: 'I argue for a living.',
    eyebrow: 'Articles',
    kicker: 'Cody Smith',
    subtitle: 'Essays, arguments, the occasional rant.',
  });
  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
