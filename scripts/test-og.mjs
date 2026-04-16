// Smoke-test the OG image pipeline. Run with: npx tsx scripts/test-og.mjs
// Writes a sample OG PNG to scripts/test-og-output.png so you can eyeball it.
import { writeFileSync } from 'node:fs';
import { renderOg } from '../src/lib/og.ts';

const start = Date.now();
try {
  const png = await renderOg({
    title: 'Sample post title — what the post is about in plain language',
    eyebrow: 'Article',
    kicker: 'Apr 16, 2026',
    subtitle: 'A one-line description that sits under the title to give reader context without being cute about it.',
  });
  const out = new URL('./test-og-output.png', import.meta.url);
  writeFileSync(out, png);
  console.log(`OG pipeline OK — wrote ${png.length} bytes to ${out.pathname} in ${Date.now() - start}ms`);
} catch (err) {
  console.error('OG pipeline FAILED:', err);
  process.exit(1);
}
