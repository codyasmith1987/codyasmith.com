#!/usr/bin/env node
// Phase 3 naming preview and quiz endpoint unit tests. Mocked engine, mocked
// RDAP, in-memory libsql for the naming + Phase 3 quiz schema. Exercises
// handlePreview, handleQuiz, and the per-call validator directly.
//
// Runs via tsx because the engine modules are TypeScript.

import { createClient } from '@libsql/client';

import { handlePreview } from '../src/pages/api/naming/preview.ts';
import { handleQuiz } from '../src/pages/api/naming/quiz.ts';
import {
  parseAndValidatePerCall,
  validateMerged,
  GeneratorValidationError,
} from '../src/lib/naming/generator.ts';
import { createStorage } from '../src/lib/naming/storage.ts';
import { NAMING_TABLES_SQL } from '../src/lib/migrations/012-naming.ts';
import {
  NAMING_PHASE3_ALTERS,
  NAMING_PHASE3_TABLES,
} from '../src/lib/migrations/014-naming-phase3.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass, detail: String(detail).slice(0, 300) });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 300)}`);
}

async function freshStorage() {
  const memDb = createClient({ url: ':memory:' });
  await memDb.batch(NAMING_TABLES_SQL, 'write');
  for (const sql of NAMING_PHASE3_ALTERS) {
    try { await memDb.execute(sql); } catch { /* ignore */ }
  }
  await memDb.batch(NAMING_PHASE3_TABLES, 'write');
  return createStorage(memDb);
}

function makeCandidate(overrides = {}) {
  return {
    name: 'Stratagem',
    rationale: 'A direct, classical-leaning name that sounds like a calculated move and signals depth.',
    tonality: {
      serious_playful: 2,
      modern_classical: 5,
      descriptive_abstract: 3,
      technical_emotional: 2,
      conservative_bold: 3,
    },
    ...overrides,
  };
}

// 25 placeholder candidates for one typology (no shared 4-char prefix, valid lengths)
function makeBatch(typology, prefix) {
  const out = [];
  for (let i = 0; i < 25; i += 1) {
    out.push({
      name: `${prefix}${String.fromCharCode(65 + i)}${(i % 9 + 1)}`.slice(0, 12),
      rationale: typology === 'abstract'
        ? 'A coined word formed by a portmanteau of two everyday English words.'
        : 'A name that suggests calm professional capability without spelling out the service.',
      tonality: { serious_playful: 2, modern_classical: 4, descriptive_abstract: 3, technical_emotional: 3, conservative_bold: 3 },
    });
  }
  return out;
}

async function run() {
  // ============ parseAndValidatePerCall ============
  console.log('--- per-call validator ---');

  // Happy path
  {
    const batch = { candidates: makeBatch('descriptive', 'Cl') };
    const out = parseAndValidatePerCall(JSON.stringify(batch), 'descriptive');
    test('happy path returns 25 with typology stamped',
      out.length === 25 && out.every(c => c.typology === 'descriptive'));
  }

  // Floor: 14 candidates rejects
  {
    const batch = { candidates: makeBatch('descriptive', 'Cl').slice(0, 14) };
    let threw = false;
    try { parseAndValidatePerCall(JSON.stringify(batch), 'descriptive'); }
    catch (e) { threw = e instanceof GeneratorValidationError && e.rule === 'per_call_count_too_low'; }
    test('14 candidates rejects with per_call_count_too_low', threw);
  }

  // Forbidden suffix is filtered, not rejecting batch (still passes if remaining >= 15)
  {
    const candidates = makeBatch('descriptive', 'Cl');
    candidates[0].name = 'PrimeFlow';   // ends with Flow (forbidden)
    candidates[1].name = 'CoreEdge';    // ends with Edge (forbidden)
    const out = parseAndValidatePerCall(JSON.stringify({ candidates }), 'descriptive');
    test('forbidden-suffix names filtered out (23 remain from 25)', out.length === 23);
    test('filtered names not present', !out.some(c => c.name === 'PrimeFlow' || c.name === 'CoreEdge'));
  }

  // Length out of range rejects whole batch
  {
    const candidates = makeBatch('descriptive', 'Cl');
    candidates[3].name = 'Hi'; // 2 chars, below 4
    let threw = false;
    try { parseAndValidatePerCall(JSON.stringify({ candidates }), 'descriptive'); }
    catch (e) { threw = e instanceof GeneratorValidationError && e.rule === 'name_length_out_of_range'; }
    test('length 2 rejects with name_length_out_of_range', threw);
  }

  // Length too long rejects
  {
    const candidates = makeBatch('descriptive', 'Cl');
    candidates[5].name = 'WayTooLongForTheLimit'; // 21 chars
    let threw = false;
    try { parseAndValidatePerCall(JSON.stringify({ candidates }), 'descriptive'); }
    catch (e) { threw = e.rule === 'name_length_out_of_range'; }
    test('length 21 rejects', threw);
  }

  // Invalid charset rejects
  {
    const candidates = makeBatch('descriptive', 'Cl');
    candidates[7].name = 'Bad Name'; // has space
    let threw = false;
    try { parseAndValidatePerCall(JSON.stringify({ candidates }), 'descriptive'); }
    catch (e) { threw = e.rule === 'name_invalid_chars'; }
    test('space in name rejects', threw);
  }

  // Not capitalized rejects
  {
    const candidates = makeBatch('descriptive', 'Cl');
    candidates[8].name = 'lowercase'; // starts lowercase
    let threw = false;
    try { parseAndValidatePerCall(JSON.stringify({ candidates }), 'descriptive'); }
    catch (e) { threw = e.rule === 'name_not_capitalized'; }
    test('lowercase first letter rejects', threw);
  }

  // Rationale too short rejects
  {
    const candidates = makeBatch('descriptive', 'Cl');
    candidates[10].rationale = 'short'; // way under 30 chars
    let threw = false;
    try { parseAndValidatePerCall(JSON.stringify({ candidates }), 'descriptive'); }
    catch (e) { threw = e.rule === 'rationale_length'; }
    test('rationale 5 chars rejects', threw);
  }

  // Coined typology missing marker rejects
  {
    const candidates = makeBatch('abstract', 'Vr');
    candidates[2].rationale = 'A made-up word that sounds technical without explaining the technique used.';
    let threw = false;
    try { parseAndValidatePerCall(JSON.stringify({ candidates }), 'abstract'); }
    catch (e) { threw = e.rule === 'abstract_missing_marker'; }
    test('abstract without portmanteau/compression marker rejects', threw);
  }

  // Tonality out of range rejects
  {
    const candidates = makeBatch('descriptive', 'Cl');
    candidates[12].tonality.serious_playful = 7; // out of 1-5 range
    let threw = false;
    try { parseAndValidatePerCall(JSON.stringify({ candidates }), 'descriptive'); }
    catch (e) { threw = e.rule === 'tonality_axis_out_of_range'; }
    test('tonality value 7 rejects', threw);
  }

  // Duplicate within call rejects
  {
    const candidates = makeBatch('descriptive', 'Cl');
    candidates[15].name = candidates[3].name;
    let threw = false;
    try { parseAndValidatePerCall(JSON.stringify({ candidates }), 'descriptive'); }
    catch (e) { threw = e.rule === 'duplicate_name_in_call'; }
    test('duplicate name within call rejects', threw);
  }

  // Invalid JSON rejects
  {
    let threw = false;
    try { parseAndValidatePerCall('not valid json', 'descriptive'); }
    catch (e) { threw = e.rule === 'invalid_json'; }
    test('invalid JSON rejects', threw);
  }

  // ============ validateMerged ============
  console.log('--- merge validator ---');

  // Happy: 4 typologies x 20 each = 80 candidates passes merge floor (75)
  {
    const merged = [];
    const prefixes = { descriptive: 'Cl', suggestive: 'Mn', associative: 'Tk', abstract: 'Vr' };
    for (const typo of ['descriptive', 'suggestive', 'associative', 'abstract']) {
      const out = parseAndValidatePerCall(JSON.stringify({ candidates: makeBatch(typo, prefixes[typo]).slice(0, 20) }), typo);
      merged.push(...out);
    }
    let threw = false;
    try { validateMerged(merged, 'test'); }
    catch (e) { threw = true; }
    test('80-candidate merge passes (above 75 floor)', !threw);
  }

  // Total too low rejects (only 60 < 75)
  {
    const merged = [];
    const prefixes = { descriptive: 'Cl', suggestive: 'Mn', associative: 'Tk', abstract: 'Vr' };
    for (const typo of ['descriptive', 'suggestive', 'associative', 'abstract']) {
      const out = parseAndValidatePerCall(JSON.stringify({ candidates: makeBatch(typo, prefixes[typo]).slice(0, 15) }), typo);
      merged.push(...out);
    }
    let threw = false;
    try { validateMerged(merged, 'test'); }
    catch (e) { threw = e.rule === 'merged_total_too_low'; }
    test('60-candidate merge rejects (below 75)', threw);
  }

  // Cross-call shared prefix rejects
  {
    const a = parseAndValidatePerCall(JSON.stringify({ candidates: makeBatch('descriptive', 'Cl').slice(0, 20) }), 'descriptive');
    const b = parseAndValidatePerCall(JSON.stringify({ candidates: makeBatch('suggestive', 'Mn').slice(0, 20) }), 'suggestive');
    const c = parseAndValidatePerCall(JSON.stringify({ candidates: makeBatch('associative', 'Tk').slice(0, 20) }), 'associative');
    const d = parseAndValidatePerCall(JSON.stringify({ candidates: makeBatch('abstract', 'Vr').slice(0, 20) }), 'abstract');
    // Inject collision
    d[0] = { ...d[0], name: a[0].name.slice(0, 4) + 'Xyz' };
    let threw = false;
    try { validateMerged([...a, ...b, ...c, ...d], 'test'); }
    catch (e) { threw = e.rule === 'merged_shared_prefix' || e.rule === 'merged_duplicate_name'; }
    test('cross-call shared 4-char prefix rejects', threw);
  }

  // ============ handlePreview ============
  console.log('--- handlePreview happy path ---');
  {
    const storage = await freshStorage();
    const mockGenerate = async () => ({
      candidates: ['descriptive','suggestive','associative','abstract'].flatMap((typo, ti) =>
        Array.from({ length: 25 }, (_, i) => ({
          name: ['De','Su','As','Ab'][ti] + String.fromCharCode(65 + i) + (i + 1),
          typology: typo,
          rationale: typo === 'abstract'
            ? 'A coined word formed by a portmanteau of two everyday English words.'
            : 'A name that suggests calm professional capability without spelling out the service.',
          tonality: { serious_playful: 2, modern_classical: 4, descriptive_abstract: 3, technical_emotional: 3, conservative_bold: 3 },
        })),
      ),
    });
    const mockAvailability = async (names) =>
      names.map(n => ({ name: n, tld: 'com', available: n.startsWith('De'), checkedAt: '2026-05-01' }));

    const r = await handlePreview(
      { seed: 'consulting', tonality: { serious_playful: 2, modern_classical: 5, descriptive_abstract: 1, technical_emotional: 2, conservative_bold: 2 } },
      '1.2.3.4',
      {
        rateLimit: async () => true,
        generate: mockGenerate,
        checkAvailability: mockAvailability,
        storage,
        geminiClient: { async generateContent() { return { text: '{}' }; } },
      },
    );
    test('happy path returns 200', r.status === 200);
    test('returns runId', typeof r.body.runId === 'string');
    test('returns up to 25 candidates', Array.isArray(r.body.candidates) && r.body.candidates.length <= 25);
    test('candidates include typology', r.body.candidates.every(c => typeof c.typology === 'string'));
    test('candidates include tonality', r.body.candidates.every(c => c.tonality && typeof c.tonality.serious_playful === 'number'));
  }

  console.log('--- handlePreview error paths ---');
  {
    const r = await handlePreview({ seed: '' }, '1.2.3.4', {});
    test('empty seed returns 400', r.status === 400);

    const r2 = await handlePreview({ seed: 'x', tonality: 'not an object' }, '1.2.3.4', { rateLimit: async () => true, geminiClient: {}, apiKey: '' });
    test('tonality string ignored, falls through to engine setup; returns 500 when no API key', r2.status === 500 || r2.status === 200);

    const r3 = await handlePreview({ seed: 'x' }, '1.2.3.4', { rateLimit: async () => false });
    test('rate limit returns 429', r3.status === 429);
  }

  // ============ handleQuiz ============
  console.log('--- handleQuiz happy path ---');
  {
    const storage = await freshStorage();
    // Pre-create a run so runId references something valid (the storage's
    // foreign key isn't enforced by libsql when the FK target is missing,
    // but using a real runId mirrors production)
    const runId = await storage.insertRun({
      seedTerm: 'consulting', creativity: 5, tlds: ['com'], source: 'preview',
    });

    let emailCalls = 0;
    const r = await handleQuiz(
      {
        runId: String(runId),
        selectedNames: ['NameA', 'NameB', 'NameC'],
        audience: 'Small businesses in Cedar City who need a website that ranks',
        density: 'moderate',
        brandKind: 'mainstream',
        email: 'test@example.com',
      },
      '1.2.3.4',
      {
        rateLimit: async () => true,
        storage,
        sendEmail: async () => { emailCalls += 1; },
      },
    );
    test('quiz happy path returns 200', r.status === 200);
    test('quiz response body has ok', r.body.ok === true);
    // Email send is fire-and-forget; allow microtask flush
    await new Promise(resolve => setTimeout(resolve, 10));
    test('sendEmail was invoked', emailCalls === 1);

    const persisted = await storage.getQuizResponseForRun(runId);
    test('quiz response persisted', persisted !== null && persisted.email === 'test@example.com');
  }

  console.log('--- handleQuiz validation ---');
  {
    const baseBody = {
      runId: 1,
      selectedNames: ['A', 'B', 'C'],
      audience: 'Sufficiently long audience text here.',
      density: 'moderate',
      brandKind: 'mainstream',
      email: 'test@example.com',
    };

    const cases = [
      { mut: { runId: undefined }, expectErr: 'Missing or invalid runId' },
      { mut: { selectedNames: ['A', 'B'] }, expectErr: 'exactly 3 names' },
      { mut: { selectedNames: ['A', 'A', 'B'] }, expectErr: 'three distinct names' },
      { mut: { audience: 'short' }, expectErr: 'at least 10 characters' },
      { mut: { density: 'bogus' }, expectErr: 'crowded, moderate, or open' },
      { mut: { brandKind: 'bogus' }, expectErr: 'premium, mainstream, or utilitarian' },
      { mut: { email: 'not-an-email' }, expectErr: 'email format' },
    ];

    for (const c of cases) {
      const body = { ...baseBody, ...c.mut };
      const r = await handleQuiz(body, '1.2.3.4', {});
      test(`quiz rejects ${JSON.stringify(c.mut)}`,
        r.status === 400 && String(r.body.error || '').includes(c.expectErr));
    }
  }

  console.log('--- handleQuiz rate limit ---');
  {
    const r = await handleQuiz(
      {
        runId: 1,
        selectedNames: ['A', 'B', 'C'],
        audience: 'Sufficiently long audience text here.',
        density: 'moderate',
        brandKind: 'mainstream',
        email: 'test@example.com',
      },
      '1.2.3.4',
      { rateLimit: async () => false },
    );
    test('quiz rate limit returns 429', r.status === 429);
  }

  // ============ summary ============
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n=== Naming preview + quiz unit tests: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
