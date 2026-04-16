// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import node from '@astrojs/node';
import sitemap from '@astrojs/sitemap';
import mdx from '@astrojs/mdx';

// https://astro.build/config
export default defineConfig({
  site: 'https://codyasmith.com',
  integrations: [mdx(), sitemap()],
  adapter: node({ mode: 'standalone' }),
  security: {
    checkOrigin: true
  },
  vite: {
    plugins: [tailwindcss()]
  }
});
