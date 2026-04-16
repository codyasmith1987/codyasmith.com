import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { renderOg } from '../../../../lib/og';

export const prerender = true;

export async function getStaticPaths() {
  const all = await getCollection('articles');
  return all
    .filter((e) => !e.data.draft)
    .map((entry) => ({
      params: { slug: entry.id },
      props: { entry },
    }));
}

export const GET: APIRoute = async ({ props }) => {
  const { entry } = props as { entry: Awaited<ReturnType<typeof getCollection<'articles'>>>[number] };
  const png = await renderOg({
    title: entry.data.title,
    eyebrow: 'Article',
    kicker: entry.data.publishDate.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
    subtitle: entry.data.description,
  });
  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
