import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { getArticles } from '../../../lib/blog';

export const prerender = true;

export const GET: APIRoute = async (context) => {
  const articles = await getArticles();
  return rss({
    title: 'Cody Smith | Articles',
    description: 'Thinking, arguments, and notes from the workbench.',
    site: context.site ?? 'https://codyasmith.com',
    items: articles.map((a) => ({
      title: a.data.title,
      description: a.data.description,
      pubDate: a.data.publishDate,
      link: `/blog/articles/${a.id}`,
      categories: a.data.tags,
    })),
    customData: '<language>en-us</language>',
  });
};
