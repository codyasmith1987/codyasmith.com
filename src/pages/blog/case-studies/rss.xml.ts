import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { getCaseStudies } from '../../../lib/blog';

export const prerender = true;

export const GET: APIRoute = async (context) => {
  const cases = await getCaseStudies();
  return rss({
    title: 'Cody Smith | Case Studies',
    description: "Receipts. What the problem was, what we tried, what moved, and what didn't.",
    site: context.site ?? 'https://codyasmith.com',
    items: cases.map((c) => ({
      title: c.data.title,
      description: c.data.description,
      pubDate: c.data.publishDate,
      link: `/blog/case-studies/${c.id}`,
      categories: [c.data.sector, ...c.data.tags],
    })),
    customData: '<language>en-us</language>',
  });
};
