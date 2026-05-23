#!/usr/bin/env node
// Contract renderer unit tests. Verifies the no-internal-exposure
// boundary (Section 14 internal block stripped), placeholder
// substitution, hash determinism, and Schedule A conditional sections.
// Runs via tsx because the modules are TypeScript.

import { renderTemplate, renderScheduleA, computeDocumentHash, PRACTICE } from '../src/lib/contract-render.ts';
import { buildScheduleA } from '../src/lib/contract-schedule.ts';
import { computePricing } from '../src/lib/proposal-pricing.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass, detail: String(detail).slice(0, 300) });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 300)}`);
}

const SAMPLE_TEMPLATE = `# Standard Client Services Agreement

## 1. Parties

Between the Practice and **{{ client.legal_entity_name }}**, a {{ client.entity_type }} organized under the laws of {{ client.state_of_organization }}.

## 14. Insurance

<!-- internal:start -->
*Reserved. Internal draft note about insurance binding in progress.*
<!-- internal:end -->

The Client is responsible for its own insurance.

## 25. Signatures

**{{ client.legal_entity_name }}**
`;

const SAMPLE_CONTEXT = {
  client: {
    legal_entity_name: 'Raised Bar Group LLC',
    entity_type: 'limited liability company',
    state_of_organization: 'Idaho',
  },
  schedule_a: {},
  practice: PRACTICE,
  today: '2026-05-23',
};

async function run() {
  // Test 1: Internal-block strip in client mode.
  {
    const html = renderTemplate(SAMPLE_TEMPLATE, SAMPLE_CONTEXT, 'client');
    const hasInternalNote = html.includes('Reserved. Internal draft note');
    const hasNeutralLine = html.includes('Client is responsible for its own insurance');
    test('client mode strips internal block', !hasInternalNote, hasInternalNote ? 'leak: internal-only italic shows in client output' : '');
    test('client mode keeps neutral one-liner', hasNeutralLine, !hasNeutralLine ? 'neutral section text was lost' : '');
  }

  // Test 2: Admin-source mode preserves the internal block.
  {
    const html = renderTemplate(SAMPLE_TEMPLATE, SAMPLE_CONTEXT, 'admin-source');
    const hasInternalNote = html.includes('Reserved. Internal draft note');
    test('admin-source mode preserves internal block', hasInternalNote, !hasInternalNote ? 'internal note missing for admin' : '');
  }

  // Test 3: Placeholder substitution against context.
  {
    const html = renderTemplate(SAMPLE_TEMPLATE, SAMPLE_CONTEXT, 'client');
    const hasName = html.includes('Raised Bar Group LLC');
    const hasEntityType = html.includes('limited liability company');
    const hasState = html.includes('Idaho');
    test('placeholders resolve from context', hasName && hasEntityType && hasState, !hasName ? 'legal name missing' : !hasEntityType ? 'entity type missing' : 'state missing');
  }

  // Test 4: Missing values render as pending pill.
  {
    const html = renderTemplate(SAMPLE_TEMPLATE, { ...SAMPLE_CONTEXT, client: { ...SAMPLE_CONTEXT.client, entity_type: '' } }, 'client');
    const hasPending = html.includes('metadata-pending');
    test('missing values render as pending pill', hasPending, !hasPending ? 'empty values did not produce pending marker' : '');
  }

  // Test 5: Hash determinism — rendering twice yields the same hash.
  {
    const html1 = renderTemplate(SAMPLE_TEMPLATE, SAMPLE_CONTEXT, 'client');
    const html2 = renderTemplate(SAMPLE_TEMPLATE, SAMPLE_CONTEXT, 'client');
    const h1 = computeDocumentHash({ body_html: html1, schedule_a: SAMPLE_CONTEXT.schedule_a, client: SAMPLE_CONTEXT.client });
    const h2 = computeDocumentHash({ body_html: html2, schedule_a: SAMPLE_CONTEXT.schedule_a, client: SAMPLE_CONTEXT.client });
    test('hash determinism: same input yields identical hash', h1 === h2, `h1=${h1.slice(0, 12)} h2=${h2.slice(0, 12)}`);
  }

  // Test 6: Hash changes when Schedule A changes.
  {
    const html = renderTemplate(SAMPLE_TEMPLATE, SAMPLE_CONTEXT, 'client');
    const h1 = computeDocumentHash({ body_html: html, schedule_a: { v: 1 }, client: SAMPLE_CONTEXT.client });
    const h2 = computeDocumentHash({ body_html: html, schedule_a: { v: 2 }, client: SAMPLE_CONTEXT.client });
    test('hash changes when schedule_a changes', h1 !== h2, h1 === h2 ? 'identical schedule_a changes still produced same hash' : '');
  }

  // Test 7: Admin path scrub in client mode.
  {
    const tpl = `Visit [admin](/portal/admin/agreements/new) for setup.`;
    const html = renderTemplate(tpl, SAMPLE_CONTEXT, 'client');
    const hasAdminPath = html.includes('/portal/admin/');
    test('client mode scrubs admin links', !hasAdminPath, hasAdminPath ? 'admin path leaked in client view' : '');
  }

  // Test 8: buildScheduleA for raised_bar_v1 with full selections.
  {
    const selections = {
      mgmt_tier: 'better',
      site_setup: 'o2',
      consulting: 'yes',
      consulting_tier: 'better',
    };
    const pricing = computePricing('raised_bar_v1', selections);
    const scheduleA = buildScheduleA({
      proposalConfig: { pricing_formula: 'raised_bar_v1' },
      draftSelections: selections,
      pricing,
      clientMetadata: { legal_entity_name: 'Raised Bar Group LLC', primary_contact_name: 'Jason Roth' },
      effectiveDate: '2026-06-01',
    });

    test('schedule_a marks Web Management purchased', scheduleA.products_purchased.web_management === true);
    test('schedule_a marks Marketing Consulting purchased when consulting=yes', scheduleA.products_purchased.marketing_consulting === true);
    test('schedule_a marks build purchased for raised-bar', scheduleA.products_purchased.build === true);
    test('schedule_a A.4 web_management populated when web_management=true', scheduleA.web_management !== null);
    test('schedule_a tier_name reflects pricing result', scheduleA.web_management?.tier_name === 'Better');
    test('schedule_a site_count is 3 for o2 (split setup)', scheduleA.web_management?.site_count === 3);
    test('schedule_a monthly_total uses multi-site formula', Math.round(scheduleA.web_management?.monthly_total) === 1292);
    test('schedule_a marketing_consulting populated when consulting=yes', scheduleA.marketing_consulting !== null);
    test('schedule_a A.5 tier_name reflects pricing result', scheduleA.marketing_consulting?.tier_name === 'Better');
    test('schedule_a A.5 monthly_retainer is $997', scheduleA.marketing_consulting?.monthly_retainer === 997);
  }

  // Test 9: buildScheduleA omits A.5 when consulting=no.
  {
    const selections = {
      mgmt_tier: 'good',
      site_setup: 'o1',
      consulting: 'no',
    };
    const pricing = computePricing('raised_bar_v1', selections);
    const scheduleA = buildScheduleA({
      proposalConfig: { pricing_formula: 'raised_bar_v1' },
      draftSelections: selections,
      pricing,
      clientMetadata: {},
      effectiveDate: '2026-06-01',
    });
    test('schedule_a omits marketing_consulting when consulting=no', scheduleA.marketing_consulting === null);
    test('schedule_a products_purchased.marketing_consulting is false', scheduleA.products_purchased.marketing_consulting === false);
    test('schedule_a site_count is 2 for o1 (single setup)', scheduleA.web_management?.site_count === 2);
  }

  // Test 10: Schedule A renderer omits A.5 when products_purchased.marketing_consulting is false.
  {
    const selections = { mgmt_tier: 'better', site_setup: 'o1', consulting: 'no' };
    const pricing = computePricing('raised_bar_v1', selections);
    const scheduleA = buildScheduleA({
      proposalConfig: { pricing_formula: 'raised_bar_v1' },
      draftSelections: selections,
      pricing,
      clientMetadata: {},
      effectiveDate: '2026-06-01',
    });
    const html = renderScheduleA(scheduleA, 'client');
    const hasA5 = html.includes('A.5 Marketing Consulting specifics');
    test('Schedule A renderer omits A.5 section when MC not purchased', !hasA5, hasA5 ? 'A.5 still rendered despite MC=no' : '');
  }

  // Test 11: Schedule A renderer includes A.5 when MC purchased.
  {
    const selections = { mgmt_tier: 'better', site_setup: 'o1', consulting: 'yes', consulting_tier: 'best' };
    const pricing = computePricing('raised_bar_v1', selections);
    const scheduleA = buildScheduleA({
      proposalConfig: { pricing_formula: 'raised_bar_v1' },
      draftSelections: selections,
      pricing,
      clientMetadata: {},
      effectiveDate: '2026-06-01',
    });
    const html = renderScheduleA(scheduleA, 'client');
    test('Schedule A renderer includes A.5 when MC purchased', html.includes('A.5 Marketing Consulting specifics'));
    test('Schedule A A.5 includes hiring guidance line for Best tier', html.includes('included') && html.includes('Hiring guidance'));
  }

  // Test 12: Pricing formula math (multi-site Better, 3 sites).
  {
    const pricing = computePricing('raised_bar_v1', { mgmt_tier: 'better', site_setup: 'o2', consulting: 'no' });
    // 497 + 2 * 497 * 0.80 = 497 + 795.20 = 1292.20
    test('pricing: Better tier 3-site monthly equals $1,292.20', Math.abs((pricing?.mgmtMonthly || 0) - 1292.20) < 0.001, `got ${pricing?.mgmtMonthly}`);
  }

  // Test 13: Domain picks land in Schedule A site list.
  {
    const selections = {
      mgmt_tier: 'better',
      site_setup: 'o2',
      builders_domain: 'raisedbarbuilders',
      tailwater_domain: 'tailwaterhailey',
      consulting: 'no',
    };
    const pricing = computePricing('raised_bar_v1', selections);
    const scheduleA = buildScheduleA({
      proposalConfig: { pricing_formula: 'raised_bar_v1' },
      draftSelections: selections,
      pricing,
      clientMetadata: {},
      effectiveDate: '2026-06-01',
    });
    const sites = scheduleA.web_management?.sites || [];
    const buildersSite = sites.find(s => s.domain === 'raisedbarbuilders.com');
    const tailwaterSite = sites.find(s => s.domain === 'tailwaterhailey.com');
    test('schedule_a uses picked Builders domain', !!buildersSite, `got: ${sites.map(s => s.domain).join(', ')}`);
    test('schedule_a uses picked Tailwater domain', !!tailwaterSite, `got: ${sites.map(s => s.domain).join(', ')}`);
  }

  // Test 14: "discuss" pick falls back to placeholder language.
  {
    const selections = {
      mgmt_tier: 'better',
      site_setup: 'o1',
      builders_domain: 'discuss',
      consulting: 'no',
    };
    const pricing = computePricing('raised_bar_v1', selections);
    const scheduleA = buildScheduleA({
      proposalConfig: { pricing_formula: 'raised_bar_v1' },
      draftSelections: selections,
      pricing,
      clientMetadata: {},
      effectiveDate: '2026-06-01',
    });
    const sites = scheduleA.web_management?.sites || [];
    const hasPlaceholder = sites.some(s => s.domain.includes('confirmed by Client at signing'));
    test('schedule_a falls back to placeholder when domain pick is "discuss"', hasPlaceholder, `got: ${sites.map(s => s.domain).join(', ')}`);
  }

  // Test 15: Alternative Builders domain pick resolves correctly.
  {
    const selections = {
      mgmt_tier: 'good',
      site_setup: 'o1',
      builders_domain: 'raisedbarconstruction',
      consulting: 'no',
    };
    const pricing = computePricing('raised_bar_v1', selections);
    const scheduleA = buildScheduleA({
      proposalConfig: { pricing_formula: 'raised_bar_v1' },
      draftSelections: selections,
      pricing,
      clientMetadata: {},
      effectiveDate: '2026-06-01',
    });
    const sites = scheduleA.web_management?.sites || [];
    const hasAlt = sites.some(s => s.domain === 'raisedbarconstruction.com');
    test('schedule_a resolves alternative Builders domain', hasAlt, `got: ${sites.map(s => s.domain).join(', ')}`);
  }

  // Print summary.
  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

run().catch(err => {
  console.error('Test run threw:', err);
  process.exit(1);
});
