// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import node from '@astrojs/node';
import sitemap from '@astrojs/sitemap';
import mdx from '@astrojs/mdx';

// https://astro.build/config
export default defineConfig({
  site: 'https://codyasmith.com',
  // Canonical URLs and sitemap entries omit trailing slashes. The deploy
  // (Cloudflare / DO App Platform) should redirect /foo/ to /foo so both
  // forms resolve consistently. See seo-audit-2026-05-12 SEO-027.
  trailingSlash: 'never',
  integrations: [
    mdx(),
    sitemap({
      // Exclude portal, API endpoints, the OG image endpoints (PNGs do not
      // belong in an HTML sitemap), and the still-experimental naming
      // preview route. See seo-audit-2026-05-12 SEO-014 and SEO-015.
      filter: (page) =>
        !page.includes('/portal/')
        && !page.includes('/api/')
        && !page.endsWith('.png')
        && !page.includes('/naming-preview'),
    }),
  ],
  adapter: node({ mode: 'standalone' }),
  security: {
    checkOrigin: true
  },
  vite: {
    plugins: [tailwindcss()]
  }
});
