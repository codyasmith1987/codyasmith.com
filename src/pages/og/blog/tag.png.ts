import type { APIRoute } from 'astro';
import { renderOg } from '../../../lib/og';

export const prerender = true;

export const GET: APIRoute = async () => {
  const png = await renderOg({
    title: 'Patterns I can\'t shake.',
    eyebrow: 'Tagged',
    kicker: 'Cody Smith',
    subtitle: 'Articles and case studies grouped by what keeps coming back.',
  });
  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
