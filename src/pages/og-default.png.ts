import type { APIRoute } from 'astro';
import { renderOg } from '../lib/og';

export const prerender = true;

export const GET: APIRoute = async () => {
  const png = await renderOg({
    title: 'Web management, strategy consulting, implementation, training.',
    eyebrow: 'Cody Smith',
    kicker: 'Cedar City, Utah',
    subtitle: 'For small businesses that outgrew their website.',
  });
  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
