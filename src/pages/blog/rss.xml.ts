import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { getAllEntries } from '../../lib/blog';

export const prerender = true;

export const GET: APIRoute = async (context) => {
  const entries = await getAllEntries();
  return rss({
    title: 'Cody Smith | Blog',
    description: 'Articles and case studies from a working consultancy.',
    site: context.site ?? 'https://codyasmith.com',
    items: entries.map((e) => ({
      title: e.data.title,
      description: e.data.description,
      pubDate: e.data.publishDate,
      link: e.href,
      categories: [e.kind === 'case-study' ? 'Case Study' : 'Article', ...e.data.tags],
    })),
    customData: '<language>en-us</language>',
  });
};
