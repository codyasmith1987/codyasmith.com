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
  // checkOrigin is disabled. It rejects multipart POSTs as 403 when
  // Origin does not match request.url.host. Behind Cloudflare + DO
  // the host header sometimes resolves to the DO ingress instead of
  // codyasmith.com, so the check returns false positives on legit
  // uploads (csv.astro file uploads were getting "Cross-site POST
  // form submissions are forbidden" 403s from the framework).
  //
  // Our own CSRF protection lives in src/middleware.ts (X-CSRF-Token
  // header validated against a session-scoped token). That is
  // stronger than checkOrigin for the actual attack pattern (a cross-
  // site form post can include cookies but cannot set the
  // X-CSRF-Token header), so removing the framework-level check does
  // not reduce real security.
  security: {
    checkOrigin: false
  },
  vite: {
    plugins: [tailwindcss()]
  }
});
