#!/usr/bin/env node
// Phase 3 dashboard-email reweighting and flag-generation unit tests.
// Pure-function coverage over reweightCandidates, generateFlags, and
// buildEmailHtml from src/lib/naming/email/dashboard.ts, plus a
// buildDashboardPayload test against a hand-rolled mock NamingStorage.
//
// Runs via tsx because the modules under test are TypeScript.

import {
  reweightCandidates,
  generateFlags,
  buildEmailHtml,
  buildDashboardPayload,
} from '../src/lib/naming/email/dashboard.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass, detail: String(detail).slice(0, 300) });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 300)}`);
}

const NEUTRAL_TONALITY = {
  serious_playful: 3,
  modern_classical: 3,
  descriptive_abstract: 3,
  technical_emotional: 3,
  conservative_bold: 3,
};

function makePersisted(overrides = {}) {
  return {
    id: overrides.id ?? 1,
    runId: overrides.runId ?? 1,
    name: 'Stratagem',
    typology: 'suggestive',
    rationale: 'A direct, classical-leaning name suggestive of a calculated move.',
    tonality: NEUTRAL_TONALITY,
    score: 0,
    excludedReason: null,
    secondaryPriceUsd: null,
    ...overrides,
  };
}

function makeDashCandidate(overrides = {}) {
  return {
    name: 'Stratagem',
    rationale: 'r',
    typology: 'suggestive',
    reweightedScore: 0,
    domain: { available: null, secondaryPriceUsd: null },
    flags: [],
    userSelected: false,
    ...overrides,
  };
}

function quiz(overrides = {}) {
  return {
    runId: 1,
    selectedNames: ['Stratagem', 'Cohere', 'Northbeam'],
    audience: 'Independent operators rebuilding their brand.',
    density: 'moderate',
    brandKind: 'mainstream',
    email: 'test@example.com',
    ...overrides,
  };
}

async function run() {
  // ============ reweightCandidates ============
  console.log('--- reweightCandidates: Q1 selection boost ---');
  {
    const pool = [
      makePersisted({ id: 1, name: 'Stratagem', score: 50, typology: 'suggestive' }),
      makePersisted({ id: 2, name: 'Filler', score: 50, typology: 'suggestive' }),
    ];
    const out = reweightCandidates(pool, quiz({ selectedNames: ['Stratagem', 'X', 'Y'] }));
    const picked = out.find((c) => c.name === 'Stratagem');
    const other = out.find((c) => c.name === 'Filler');
    test('selected name boosted by +2', picked.userSelected === true && picked.reweightedScore >= other.reweightedScore + 2,
      `picked=${picked.reweightedScore} other=${other.reweightedScore}`);
    test('unselected name has userSelected=false', other.userSelected === false);
  }

  console.log('--- reweightCandidates: case-insensitive name match ---');
  {
    const pool = [makePersisted({ name: 'StratAGEM', score: 10 })];
    const out = reweightCandidates(pool, quiz({ selectedNames: ['stratagem', 'X', 'Y'] }));
    test('case-insensitive match flags userSelected', out[0].userSelected === true,
      `score=${out[0].reweightedScore}`);
  }

  console.log('--- reweightCandidates: tonality alignment +1 ---');
  {
    // User picks 3 candidates all with extreme tonality (5,5,5,5,5).
    // Revealed = (5,5,5,5,5). Test candidate at (5,5,5,5,5) should get +1.
    // Test candidate at (1,1,1,1,1) is distance sqrt(80) ≈ 8.94, no +1.
    // Use abstract typology + mainstream brandKind + moderate density so no
    // other modifiers fire and tonality is the only variable.
    const ext = { serious_playful: 5, modern_classical: 5, descriptive_abstract: 5, technical_emotional: 5, conservative_bold: 5 };
    const opp = { serious_playful: 1, modern_classical: 1, descriptive_abstract: 1, technical_emotional: 1, conservative_bold: 1 };
    const pool = [
      makePersisted({ id: 1, name: 'Pick1', typology: 'abstract', tonality: ext, score: 0 }),
      makePersisted({ id: 2, name: 'Pick2', typology: 'abstract', tonality: ext, score: 0 }),
      makePersisted({ id: 3, name: 'Pick3', typology: 'abstract', tonality: ext, score: 0 }),
      makePersisted({ id: 4, name: 'Aligned', typology: 'abstract', tonality: ext, score: 0 }),
      makePersisted({ id: 5, name: 'Opposite', typology: 'abstract', tonality: opp, score: 0 }),
    ];
    const out = reweightCandidates(pool, quiz({
      selectedNames: ['Pick1', 'Pick2', 'Pick3'],
      brandKind: 'mainstream',
      density: 'moderate',
    }));
    const aligned = out.find((c) => c.name === 'Aligned');
    const opposite = out.find((c) => c.name === 'Opposite');
    test('aligned tonality gets +1 boost', aligned.reweightedScore === 1, `aligned=${aligned.reweightedScore}`);
    test('opposite tonality gets no tonality boost', opposite.reweightedScore === 0,
      `opposite=${opposite.reweightedScore}`);
  }

  console.log('--- reweightCandidates: brandKind alignment ---');
  {
    const pool = [
      makePersisted({ id: 1, name: 'Aabstract', typology: 'abstract', score: 0 }),
      makePersisted({ id: 2, name: 'Sugg', typology: 'suggestive', score: 0 }),
      makePersisted({ id: 3, name: 'Assoc', typology: 'associative', score: 0 }),
      makePersisted({ id: 4, name: 'Desc', typology: 'descriptive', score: 0 }),
    ];
    // premium → +0.5 to abstract OR suggestive
    const premium = reweightCandidates(pool, quiz({
      selectedNames: ['none1', 'none2', 'none3'], brandKind: 'premium', density: 'moderate',
    }));
    const pAbstract = premium.find((c) => c.name === 'Aabstract');
    const pDesc = premium.find((c) => c.name === 'Desc');
    test('premium boosts abstract typology', pAbstract.reweightedScore === 0.5);
    test('premium does not boost descriptive typology', pDesc.reweightedScore === 0);

    // utilitarian → +0.5 to descriptive OR suggestive
    const util = reweightCandidates(pool, quiz({
      selectedNames: ['none1', 'none2', 'none3'], brandKind: 'utilitarian', density: 'moderate',
    }));
    const uDesc = util.find((c) => c.name === 'Desc');
    const uAssoc = util.find((c) => c.name === 'Assoc');
    test('utilitarian boosts descriptive typology', uDesc.reweightedScore === 0.5);
    test('utilitarian does not boost associative typology', uAssoc.reweightedScore === 0);
  }

  console.log('--- reweightCandidates: density-adjusted distinctiveness ---');
  {
    const pool = [
      makePersisted({ id: 1, name: 'Aabstract', typology: 'abstract', score: 0 }),
      makePersisted({ id: 2, name: 'Desc', typology: 'descriptive', score: 0 }),
    ];
    // crowded + abstract → +0.5
    const crowded = reweightCandidates(pool, quiz({
      selectedNames: ['x', 'y', 'z'], brandKind: 'mainstream', density: 'crowded',
    }));
    // mainstream brandKind boosts suggestive/associative, neither here, so density isolates
    const cAbstract = crowded.find((c) => c.name === 'Aabstract');
    test('crowded boosts abstract typology', cAbstract.reweightedScore === 0.5,
      `cAbstract=${cAbstract.reweightedScore}`);

    // open + descriptive → +0.5
    const open = reweightCandidates(pool, quiz({
      selectedNames: ['x', 'y', 'z'], brandKind: 'mainstream', density: 'open',
    }));
    const oDesc = open.find((c) => c.name === 'Desc');
    test('open boosts descriptive typology', oDesc.reweightedScore === 0.5);
  }

  console.log('--- reweightCandidates: skips candidates missing typology ---');
  {
    const pool = [
      makePersisted({ id: 1, name: 'Has', typology: 'suggestive', score: 5 }),
      makePersisted({ id: 2, name: 'Missing', typology: null, score: 99 }),
    ];
    const out = reweightCandidates(pool, quiz({ selectedNames: ['x', 'y', 'z'] }));
    test('candidate with null typology is filtered out',
      out.length === 1 && out[0].name === 'Has');
  }

  console.log('--- reweightCandidates: sorts descending ---');
  {
    const pool = [
      makePersisted({ id: 1, name: 'Low', typology: 'suggestive', score: 1 }),
      makePersisted({ id: 2, name: 'High', typology: 'suggestive', score: 10 }),
      makePersisted({ id: 3, name: 'Mid', typology: 'suggestive', score: 5 }),
    ];
    const out = reweightCandidates(pool, quiz({ selectedNames: ['none', 'x', 'y'] }));
    test('sorted by reweightedScore descending',
      out[0].name === 'High' && out[1].name === 'Mid' && out[2].name === 'Low');
  }

  console.log('--- reweightCandidates: rounds to 2 decimals ---');
  {
    // descriptive typology + mainstream brandKind + moderate density isolates
    // the score from every modifier, leaving only the rounding under test.
    const pool = [makePersisted({ name: 'X', typology: 'descriptive', score: 1.234567 })];
    const out = reweightCandidates(pool, quiz({
      selectedNames: ['none1', 'none2', 'none3'],
      brandKind: 'mainstream',
      density: 'moderate',
    }));
    test('reweightedScore rounded to 2 decimals', out[0].reweightedScore === 1.23,
      `score=${out[0].reweightedScore}`);
  }

  console.log('--- reweightCandidates: full DashboardCandidate shape ---');
  {
    const pool = [makePersisted({
      name: 'Stratagem', typology: 'suggestive', score: 7,
      rationale: 'Original rationale text.', secondaryPriceUsd: 2500,
    })];
    const out = reweightCandidates(pool, quiz({ selectedNames: ['none', 'x', 'y'] }));
    const c = out[0];
    test('includes rationale', c.rationale === 'Original rationale text.');
    test('includes typology', c.typology === 'suggestive');
    test('domain.available is null pre-join', c.domain.available === null);
    test('domain.secondaryPriceUsd carries through', c.domain.secondaryPriceUsd === 2500);
    test('flags initially empty', Array.isArray(c.flags) && c.flags.length === 0);
  }

  // ============ generateFlags ============
  console.log('--- generateFlags: user-picked-but-below-median ---');
  {
    const c = makeDashCandidate({ userSelected: true, reweightedScore: 2 });
    const flags = generateFlags(c, 5, 'moderate');
    test('user-picked + below median triggers picked-this-one flag',
      flags.some((f) => f.includes('picked this one')));
  }

  console.log('--- generateFlags: not picked + below median = no flag ---');
  {
    const c = makeDashCandidate({ userSelected: false, reweightedScore: 2 });
    const flags = generateFlags(c, 5, 'moderate');
    test('not-picked + below median does not trigger picked flag',
      !flags.some((f) => f.includes('picked this one')));
  }

  console.log('--- generateFlags: domain price > 3k ---');
  {
    const c = makeDashCandidate({ domain: { available: false, secondaryPriceUsd: 5000 } });
    const flags = generateFlags(c, 0, 'moderate');
    test('price 5000 triggers acquisition flag',
      flags.some((f) => f.includes('5,000') && f.includes('.com is owned')));
  }

  console.log('--- generateFlags: domain price <= 3k ---');
  {
    const c = makeDashCandidate({ domain: { available: false, secondaryPriceUsd: 2000 } });
    const flags = generateFlags(c, 0, 'moderate');
    test('price 2000 does not trigger acquisition flag',
      !flags.some((f) => f.includes('to acquire')));
  }

  console.log('--- generateFlags: tongue-twister consonant cluster ---');
  {
    const c = makeDashCandidate({ name: 'Zxcvbn' });
    const flags = generateFlags(c, 0, 'moderate');
    test('long consonant cluster triggers mispronounce flag',
      flags.some((f) => f.includes('tongue-twister')));
  }

  console.log('--- generateFlags: normal pronounceable name ---');
  {
    const c = makeDashCandidate({ name: 'Stratagem' });
    const flags = generateFlags(c, 0, 'moderate');
    test('Stratagem does not trigger mispronounce flag',
      !flags.some((f) => f.includes('tongue-twister')));
  }

  console.log('--- generateFlags: crowded + descriptive ---');
  {
    const c = makeDashCandidate({ typology: 'descriptive' });
    const flags = generateFlags(c, 0, 'crowded');
    test('crowded + descriptive triggers harder-to-stand-out flag',
      flags.some((f) => f.includes('crowded') && f.includes('descriptive')));
  }

  console.log('--- generateFlags: crowded + abstract = no descriptive flag ---');
  {
    const c = makeDashCandidate({ typology: 'abstract' });
    const flags = generateFlags(c, 0, 'crowded');
    test('crowded + abstract does not trigger descriptive flag',
      !flags.some((f) => f.includes('crowded')));
  }

  console.log('--- generateFlags: caps at 2 flags ---');
  {
    // userSelected + below median (1) + price 5000 (2) + tongue-twister name (3) + crowded descriptive (4)
    const c = makeDashCandidate({
      name: 'Zxcvbn',
      typology: 'descriptive',
      userSelected: true,
      reweightedScore: 1,
      domain: { available: false, secondaryPriceUsd: 5000 },
    });
    const flags = generateFlags(c, 5, 'crowded');
    test('flags capped at 2 even when 4 trigger', flags.length === 2, `len=${flags.length}`);
  }

  console.log('--- generateFlags: returns empty when none trigger ---');
  {
    const c = makeDashCandidate({
      name: 'Stratagem',
      typology: 'suggestive',
      userSelected: false,
      reweightedScore: 10,
      domain: { available: true, secondaryPriceUsd: null },
    });
    const flags = generateFlags(c, 5, 'moderate');
    test('clean name with no triggers returns empty flags', flags.length === 0);
  }

  // ============ buildEmailHtml ============
  console.log('--- buildEmailHtml: includes 5 cards ---');
  {
    const payload = {
      runId: 1, responseId: 2, audience: 'small operators', density: 'moderate', brandKind: 'mainstream',
      email: 'a@b.com', totalCandidates: 100,
      topFive: Array.from({ length: 5 }, (_, i) => makeDashCandidate({
        name: `Name${i}`, typology: 'suggestive', reweightedScore: 5 - i,
        domain: { available: true, secondaryPriceUsd: null },
      })),
    };
    const html = buildEmailHtml(payload);
    const matchCount = (html.match(/Name[0-4]/g) || []).length;
    test('renders all 5 candidate names', matchCount === 5, `matches=${matchCount}`);
    test('includes total candidate count', html.includes('100'));
    test('includes methodology link', html.includes('codyasmith.com/naming/methodology'));
  }

  console.log('--- buildEmailHtml: domain availability rendering ---');
  {
    const cards = [
      makeDashCandidate({ name: 'Avail', domain: { available: true, secondaryPriceUsd: null } }),
      makeDashCandidate({ name: 'Owned', domain: { available: false, secondaryPriceUsd: 4500 } }),
      makeDashCandidate({ name: 'Unknown', domain: { available: null, secondaryPriceUsd: null } }),
    ];
    const html = buildEmailHtml({
      runId: 1, responseId: 1, audience: 'x', density: 'moderate', brandKind: 'mainstream',
      email: 'a@b.com', totalCandidates: 3, topFive: cards,
    });
    test('available .com renders green text', html.includes('.com available'));
    test('owned .com renders price', html.includes('$4,500'));
    test('unknown .com renders fallback', html.includes('availability unknown'));
  }

  console.log('--- buildEmailHtml: long audience truncated ---');
  {
    const long = 'a'.repeat(120);
    const html = buildEmailHtml({
      runId: 1, responseId: 1, audience: long, density: 'moderate', brandKind: 'mainstream',
      email: 'x@y.com', totalCandidates: 1, topFive: [makeDashCandidate()],
    });
    test('audience > 80 chars is truncated with ellipsis',
      html.includes('...') && !html.includes('a'.repeat(120)));
  }

  console.log('--- buildEmailHtml: empty audience uses fallback ---');
  {
    const html = buildEmailHtml({
      runId: 1, responseId: 1, audience: '', density: 'moderate', brandKind: 'mainstream',
      email: 'x@y.com', totalCandidates: 1, topFive: [makeDashCandidate()],
    });
    test('empty audience renders "For your brand," greeting',
      html.includes('For your brand,'));
  }

  console.log('--- buildEmailHtml: flags rendered when present ---');
  {
    const c = makeDashCandidate({ flags: ['Test flag content here.'] });
    const html = buildEmailHtml({
      runId: 1, responseId: 1, audience: 'x', density: 'moderate', brandKind: 'mainstream',
      email: 'a@b.com', totalCandidates: 1, topFive: [c],
    });
    test('flag text appears in html', html.includes('Test flag content here.'));
  }

  console.log('--- buildEmailHtml: escapes html-special chars in name ---');
  {
    const c = makeDashCandidate({ name: 'A&B<C>' });
    const html = buildEmailHtml({
      runId: 1, responseId: 1, audience: 'x', density: 'moderate', brandKind: 'mainstream',
      email: 'a@b.com', totalCandidates: 1, topFive: [c],
    });
    test('name with & < > is escaped',
      html.includes('A&amp;B&lt;C&gt;') && !html.includes('A&B<C>'));
  }

  // ============ buildDashboardPayload ============
  console.log('--- buildDashboardPayload: end-to-end with mock storage ---');
  {
    const candidates = [
      makePersisted({ id: 1, name: 'Aabstract', typology: 'abstract', score: 8 }),
      makePersisted({ id: 2, name: 'Sugg', typology: 'suggestive', score: 7 }),
      makePersisted({ id: 3, name: 'Pick1', typology: 'suggestive', score: 5 }),
      makePersisted({ id: 4, name: 'Pick2', typology: 'associative', score: 5 }),
      makePersisted({ id: 5, name: 'Pick3', typology: 'descriptive', score: 5 }),
      makePersisted({ id: 6, name: 'Filler1', typology: 'descriptive', score: 4 }),
      makePersisted({ id: 7, name: 'Filler2', typology: 'descriptive', score: 3 }),
    ];
    const storage = {
      async getRun() { return { id: 1, seedTerm: 'consulting', createdAt: '2026-04-30' }; },
      async getQuizResponseForRun() {
        return quiz({ selectedNames: ['Pick1', 'Pick2', 'Pick3'], density: 'crowded', brandKind: 'premium' });
      },
      async getCandidatesForRun() { return candidates; },
    };
    const payload = await buildDashboardPayload(1, 99, storage);
    test('payload has 5-name topFive', payload.topFive.length === 5);
    test('all 3 picks appear in topFive (boosted by Q1)',
      ['Pick1', 'Pick2', 'Pick3'].every((n) => payload.topFive.some((c) => c.name === n)));
    test('totalCandidates reflects pool size', payload.totalCandidates === 7);
    test('audience carries through', payload.audience === 'Independent operators rebuilding their brand.');
    test('density carries through', payload.density === 'crowded');
    test('email carries through', payload.email === 'test@example.com');
  }

  console.log('--- buildDashboardPayload: throws when run missing ---');
  {
    const storage = {
      async getRun() { return null; },
      async getQuizResponseForRun() { return quiz(); },
      async getCandidatesForRun() { return []; },
    };
    let threw = false;
    try { await buildDashboardPayload(1, 1, storage); }
    catch (e) { threw = String(e.message).includes('not found'); }
    test('missing run throws', threw);
  }

  console.log('--- buildDashboardPayload: throws when quiz missing ---');
  {
    const storage = {
      async getRun() { return { id: 1, seedTerm: 'x', createdAt: '2026-04-30' }; },
      async getQuizResponseForRun() { return null; },
      async getCandidatesForRun() { return []; },
    };
    let threw = false;
    try { await buildDashboardPayload(1, 1, storage); }
    catch (e) { threw = String(e.message).includes('Quiz response not found'); }
    test('missing quiz throws', threw);
  }

  console.log('--- buildDashboardPayload: empty pool → empty topFive ---');
  {
    const storage = {
      async getRun() { return { id: 1, seedTerm: 'x', createdAt: '2026-04-30' }; },
      async getQuizResponseForRun() { return quiz(); },
      async getCandidatesForRun() { return []; },
    };
    const payload = await buildDashboardPayload(1, 1, storage);
    test('empty pool returns empty topFive',
      payload.topFive.length === 0 && payload.totalCandidates === 0);
  }

  // ============ summary ============
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n=== Naming dashboard email unit tests: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
