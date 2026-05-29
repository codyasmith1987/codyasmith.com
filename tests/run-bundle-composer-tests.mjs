#!/usr/bin/env node
// Bundle composer test: composeProposal in bundle mode emits config.bundle
// and a single Good/Better/Best card (+ optional add-on) with fused prices,
// suppressing the separate WM/MC/build pickers. Non-bundle mode is
// unchanged. Prices are asserted against the 5/22 Raised Bar Fit Analysis.
// Runs via tsx.

import { composeProposal } from '../src/lib/products/index.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 300)}`);
}

// Raised Bar / Jason shape: WM (F3 primary + Raised Bar Builders build site)
// + MC (Ecosystem B) + build with a 2-option add-on (base vs Tailwater).
function args(extra = {}) {
  return {
    client: { id: 'c1', name: 'Raised Bar', slug: 'raised-bar', discount_rate: 0 },
    signers: [{ id: 's1', email: 'jason@example.com', name: 'Jason Roth' }],
    products: ['web-management', 'marketing-consulting', 'build'],
    product_vars: {
      'web-management': { page_count: 20, site_count: 2 },
      'marketing-consulting': { revenue_band: '1m-to-10m' },
      'build': {
        build_total_pages: 14,
        build_options: [
          { id: 'rb_base', name: 'Two sites', pitch: 'F3 plus the new Raised Bar Builders site.', pricing_delta: 0 },
          { id: 'rb_tailwater', name: 'Tailwater pre-sell site', pitch: 'A dedicated Tailwater micro-site.', pricing_delta: 4500, wm_sites_added: [{ domain: 'tailwaterhailey.com', label: 'Tailwater', page_count_estimate: 20 }] },
        ],
      },
    },
    managedSites: [
      { domain: 'f3properties.com', label: 'F3 Properties', is_primary: true, page_count: 20 },
      { domain: 'raisedbarbuilders.com', label: 'Raised Bar Builders', is_primary: false, page_count: 20, onboarding_override: 0 },
    ],
    narrative_variables: {},
    ...extra,
  };
}

function stepById(config, id) { return (config.steps || []).find(s => s.id === id); }

function run() {
  const bundled = composeProposal(args({ bundle_mode: true }));
  const plain = composeProposal(args({ bundle_mode: false }));

  // Config carries the symmetric bundle + add-on.
  test('bundle config emitted', !!bundled.bundle, 'no bundle on config');
  test('bundle tiers symmetric (good->WM good+MC good)', bundled.bundle?.tiers?.good?.wm === 'good' && bundled.bundle?.tiers?.good?.mc === 'good');
  test('bundle better symmetric', bundled.bundle?.tiers?.better?.wm === 'better' && bundled.bundle?.tiers?.better?.mc === 'better');
  test('bundle add-on wired from build_options (rb_base skip, rb_tailwater add)',
    bundled.bundle?.addon?.skip_option_id === 'rb_base' && bundled.bundle?.addon?.build_option_id === 'rb_tailwater');

  // Steps: one GBB card + add-on, and NO separate WM/MC pickers.
  const bt = stepById(bundled, 'bundle_tier');
  test('bundle_tier step exists with 3 options', !!bt && bt.options.length === 3);
  test('bundle_tier options are good/better/best', !!bt && ['good', 'better', 'best'].every(id => bt.options.some(o => o.id === id)));
  test('bundle_addon step exists', !!stepById(bundled, 'bundle_addon'));
  test('separate wm_tier picker suppressed in bundle mode', !stepById(bundled, 'wm_tier'));
  test('separate mc_tier picker suppressed in bundle mode', !stepById(bundled, 'mc_tier'));
  test('Better is the recommended card', !!bt && bt.options.find(o => o.id === 'better')?.recommended === true);

  // Fused prices on the cards match the Fit Analysis.
  const better = bt?.options.find(o => o.id === 'better');
  test('Better card monthly = $1,891.60', better?.price_label === '$1,891.60', `got ${better?.price_label}`);
  test('Better card to-start = $8,925', /\$8,925\b/.test(better?.price_subline || ''), `got ${better?.price_subline}`);
  const good = bt?.options.find(o => o.id === 'good');
  test('Good card monthly = $1,031.60', good?.price_label === '$1,031.60', `got ${good?.price_label}`);
  test('Good card to-start = $7,925', /\$7,925\b/.test(good?.price_subline || ''), `got ${good?.price_subline}`);
  const best = bt?.options.find(o => o.id === 'best');
  test('Best card to-start = $10,625', /\$10,625\b/.test(best?.price_subline || ''), `got ${best?.price_subline}`);
  test('Better card carries fused features (WM + MC)', (better?.features || []).length >= 2);
  test('Better card shows included hours', typeof better?.included_hours === 'number');

  // Non-bundle mode unchanged: separate pickers, no bundle.
  test('non-bundle: no bundle on config', !plain.bundle);
  test('non-bundle: wm_tier picker present', !!stepById(plain, 'wm_tier'));
  test('non-bundle: no bundle_tier step', !stepById(plain, 'bundle_tier'));

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

run();
