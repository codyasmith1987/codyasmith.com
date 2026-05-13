import type { APIRoute } from 'astro';
import { renderOg } from '../../../lib/og';

export const prerender = true;

export const GET: APIRoute = async () => {
  const png = await renderOg({
    title: 'Built on learning science, not slide decks.',
    eyebrow: 'Training',
    kicker: 'Cedar City, Utah',
    subtitle: 'Three-session guided programs. Real work between sessions.',
  });
  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
