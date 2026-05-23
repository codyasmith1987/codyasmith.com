#!/usr/bin/env node
// Proposal-AI unit tests.
//
// Covers:
//   - Voice lint patterns (positive and negative cases).
//   - validateClientResearch (accepts valid, rejects invalid).
//   - researchClient end-to-end with mocked Gemini + cache.
//   - Cache key derivation determinism.
//
// Runs via tsx because the modules are TypeScript.

import { lintSnippet, listVoiceRules } from '../src/lib/proposal-ai/voice-lint.ts';
import {
  researchClient,
  validateClientResearch,
} from '../src/lib/proposal-ai/research/client-research.ts';
import { deriveCacheKey } from '../src/lib/proposal-ai/cache.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass, detail: String(detail).slice(0, 300) });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 300)}`);
}

async function run() {

  // ---------------------------------------------------------------------
  // Voice lint
  // ---------------------------------------------------------------------

  // Clean text passes.
  const clean = 'I keep your sites running, secure, and improving every month. The fee covers hosting, backups, security monitoring, software updates, and a pool of hours for site work.';
  test('voice lint: clean Cody-voice copy passes', lintSnippet(clean).ok);

  // Em dash rejected.
  const emDash = 'Here is the plan — short and clear.';
  const emRes = lintSnippet(emDash);
  test('voice lint: em dash rejected', !emRes.ok && emRes.violations.some(v => v.rule === 'em-or-en-dash'));

  // En dash rejected.
  const enDash = 'Pages 30–150 fall in the mid band.';
  test('voice lint: en dash rejected', !lintSnippet(enDash).ok);

  // Banned preamble.
  const preamble = "Based on my analysis, your site needs work.";
  const preRes = lintSnippet(preamble);
  test('voice lint: banned preamble rejected', !preRes.ok && preRes.violations.some(v => v.rule === 'banned-preamble'));

  // AI-template language.
  const tmpl = 'A holistic approach to leverage your brand and unlock cutting-edge results.';
  const tmplRes = lintSnippet(tmpl);
  test('voice lint: AI-template language rejected', !tmplRes.ok && tmplRes.violations.some(v => v.rule === 'ai-template-language'));

  // WM overclaim only rejected in wm-only scope.
  const wmText = 'This service will drive conversions and increase leads.';
  test('voice lint: WM overclaim rejected in wm-only scope',
    !lintSnippet(wmText, { productScope: 'wm-only' }).ok);
  test('voice lint: same text allowed when not wm-only',
    lintSnippet(wmText, { productScope: 'all' }).ok || lintSnippet(wmText, { productScope: 'all' }).violations.every(v => v.rule !== 'wm-overclaim'));

  // Internal exposure.
  const intExp = 'See the file at src/lib/products/web-management.ts for details.';
  const intRes = lintSnippet(intExp);
  test('voice lint: internal-exposure file path rejected',
    !intRes.ok && intRes.violations.some(v => v.rule === 'internal-exposure-path'));

  // Dangling tier reference.
  const tier = 'This is calibrated to your tier.';
  const tierRes = lintSnippet(tier);
  test('voice lint: dangling tier reference rejected',
    !tierRes.ok && tierRes.violations.some(v => v.rule === 'dangling-tier-reference'));

  // List of rules is exposed.
  test('voice lint: listVoiceRules returns at least 5 rules', listVoiceRules().length >= 5);

  // ---------------------------------------------------------------------
  // validateClientResearch
  // ---------------------------------------------------------------------

  const validBlob = {
    estimated_revenue_band: '1m-to-10m',
    revenue_evidence: 'LinkedIn shows 25 employees.',
    revenue_confidence: 'medium',
    inferred_industry: 'professional-services',
    industry_evidence: 'Site lists services for legal firms.',
    inferred_urgency: 'growth',
    urgency_evidence: 'Recent blog posts emphasize scaling.',
    inferred_focus: ['brand', 'search'],
    domains_found: [
      { domain: 'example.com', role_guess: 'primary', confidence: 'high' },
    ],
    estimated_page_count: 87,
    page_count_source: 'sitemap at https://example.com/sitemap.xml',
    notes: '',
  };
  let validated;
  try {
    validated = validateClientResearch(validBlob);
    test('validateClientResearch: accepts valid blob', validated.estimated_revenue_band === '1m-to-10m');
  } catch (e) {
    test('validateClientResearch: accepts valid blob', false, String(e));
  }

  // Reject bad revenue band.
  try {
    validateClientResearch({ ...validBlob, estimated_revenue_band: 'bogus' });
    test('validateClientResearch: rejects bad revenue band', false, 'did not throw');
  } catch {
    test('validateClientResearch: rejects bad revenue band', true);
  }

  // Reject non-object.
  try {
    validateClientResearch(null);
    test('validateClientResearch: rejects null', false, 'did not throw');
  } catch {
    test('validateClientResearch: rejects null', true);
  }

  // Filters invalid focus tags out (drops them, does not throw).
  const focusFiltered = validateClientResearch({
    ...validBlob,
    inferred_focus: ['brand', 'made-up-tag', 'search', 42],
  });
  test('validateClientResearch: silently drops invalid focus tags',
    focusFiltered.inferred_focus.length === 2
      && focusFiltered.inferred_focus.includes('brand')
      && focusFiltered.inferred_focus.includes('search'),
    JSON.stringify(focusFiltered.inferred_focus));

  // Coerce non-numeric page count to null.
  const pcNull = validateClientResearch({ ...validBlob, estimated_page_count: 'lots' });
  test('validateClientResearch: coerces non-numeric page count to null',
    pcNull.estimated_page_count === null);

  // ---------------------------------------------------------------------
  // deriveCacheKey determinism
  // ---------------------------------------------------------------------

  const k1 = deriveCacheKey({
    promptVersion: 'v1', model: 'gemini-2.5-flash-lite', feature: 'client-research',
    inputs: 'acme|acme.com',
  });
  const k2 = deriveCacheKey({
    promptVersion: 'v1', model: 'gemini-2.5-flash-lite', feature: 'client-research',
    inputs: 'acme|acme.com',
  });
  const k3 = deriveCacheKey({
    promptVersion: 'v1', model: 'gemini-2.5-flash-lite', feature: 'client-research',
    inputs: 'acme|other.com',
  });
  test('deriveCacheKey: same inputs produce same key', k1 === k2);
  test('deriveCacheKey: different inputs produce different keys', k1 !== k3);
  test('deriveCacheKey: returns hex string', /^[a-f0-9]{64}$/.test(k1));

  // ---------------------------------------------------------------------
  // researchClient with mocks
  // ---------------------------------------------------------------------

  // Mock Gemini that returns a valid research blob.
  const mockGemini = {
    async generateJson({ systemPrompt }) {
      // Sanity: the prompt enumerates voice rules; if missing, the test
      // catches a regression in the prompt builder.
      if (!systemPrompt.includes('No em dashes')) {
        throw new Error('mock gemini: prompt missing em-dash rule');
      }
      return { text: JSON.stringify(validBlob) };
    },
  };

  // In-memory cache.
  const cacheStore = new Map();
  const mockCache = {
    async get(key) {
      const v = cacheStore.get(key);
      return v ? { value: v, expiresAt: 'never' } : null;
    },
    async set(key, value) {
      cacheStore.set(key, value);
    },
  };

  // Mock Serper: returns one fake hit.
  const mockSerper = async (_q, _n) => [
    { url: 'https://example.com/about', title: 'About', snippet: 'About Example.' },
  ];

  // Mock scraper: returns a single text body.
  const mockScrape = async (urls) => urls.map(u => ({
    url: u.url,
    source_name: 'example.com',
    source_type: 'other',
    snippet: 'About Example.',
    full_text: 'Example is a 25-person professional services firm based in Boise.',
    query_type: u.query_type,
  }));

  // Mock sitemap: returns 87 pages.
  const mockSitemap = async (_domain) => ({
    url_count: 87,
    source: 'sitemap at https://example.com/sitemap.xml',
    sitemap_url: 'https://example.com/sitemap.xml',
  });

  const deps = {
    gemini: mockGemini,
    cache: mockCache,
    serperApiKey: 'fake',
    model: 'gemini-2.5-flash-lite',
    serperSearch: mockSerper,
    scrape: mockScrape,
    sitemapFetch: mockSitemap,
  };

  const r1 = await researchClient({ clientName: 'Acme', domain: 'acme.com' }, deps);
  test('researchClient: returns validated result', r1.estimated_revenue_band === '1m-to-10m');
  test('researchClient: writes to cache', cacheStore.size === 1);

  // Second call hits cache (mock Gemini throws if it gets called).
  const throwGemini = {
    async generateJson() { throw new Error('cache should have hit'); },
  };
  const r2 = await researchClient({ clientName: 'Acme', domain: 'acme.com' }, {
    ...deps,
    gemini: throwGemini,
  });
  test('researchClient: second call hits cache without Gemini', r2.estimated_revenue_band === '1m-to-10m');

  // Different inputs miss cache.
  let missedCache = false;
  try {
    await researchClient({ clientName: 'Other', domain: 'other.com' }, {
      ...deps,
      gemini: throwGemini, // will throw, proving cache miss happened
    });
  } catch {
    missedCache = true;
  }
  test('researchClient: different client misses cache', missedCache);

  // Gemini quota exhaustion is surfaced.
  const quotaGemini = {
    async generateJson() { throw new Error('RESOURCE_EXHAUSTED: 429'); },
  };
  let quotaCaught = false;
  try {
    await researchClient({ clientName: 'Quota', domain: 'quota.com' }, {
      ...deps, gemini: quotaGemini,
    });
  } catch (err) {
    quotaCaught = /RESOURCE_EXHAUSTED|429/i.test(err.message || '');
  }
  test('researchClient: quota exhaustion bubbles up', quotaCaught);

  // ---------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass);
  console.log(`\n${passed}/${results.length} passed`);
  if (failed.length > 0) {
    console.log('\nFailed:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
