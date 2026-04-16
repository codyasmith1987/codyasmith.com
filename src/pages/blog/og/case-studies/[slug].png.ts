import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { renderOg } from '../../../../lib/og';

export const prerender = true;

export async function getStaticPaths() {
  const all = await getCollection('caseStudies');
  return all
    .filter((e) => !e.data.draft)
    .map((entry) => ({
      params: { slug: entry.id },
      props: { entry },
    }));
}

export const GET: APIRoute = async ({ props }) => {
  const { entry } = props as { entry: Awaited<ReturnType<typeof getCollection<'caseStudies'>>>[number] };
  const client = entry.data.clientAnonymized ? 'Confidential' : entry.data.client;
  const png = await renderOg({
    title: entry.data.title,
    eyebrow: 'Case study',
    kicker: `${client} · ${entry.data.sector}`,
    subtitle: entry.data.outcome,
  });
  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
