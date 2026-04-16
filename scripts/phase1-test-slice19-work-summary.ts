// Slice 19 test: admin work summary — three-bucket triage from existing queue truth.
//
// Tests 1-9: pure-function unit tests against synthetic AdminQueue objects.
// Test 10: integration against the live database via loadAdminQueue().

import 'dotenv/config';
import { buildWorkSummary, MAPPED_SECTION_KEYS } from '../src/lib/admin-work-summary';
import type { AdminQueue, QueueSection, Blocker } from '../src/lib/admin-queue';

// --- Helpers ---

function makeSection(key: string, count: number): QueueSection {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `${key}-${i}`,
    what: `${key} item ${i}`,
    where: 'test client',
    why: 'test reason',
    action: 'test action',
  }));
  return { key, label: key, count, rows };
}

function makeBlocker(severity: 'hard' | 'soft', key: string): Blocker {
  return {
    key,
    severity,
    title: `${key} title`,
    detail: `${key} detail`,
    action: `${key} action`,
  };
}

function makeQueue(sections: QueueSection[], blockers: Blocker[] = []): AdminQueue {
  const counts: Record<string, number> = {};
  for (const s of sections) counts[s.key] = s.count;
  counts.blockers = blockers.length;
  return {
    generatedAt: new Date().toISOString(),
    sections,
    blockers,
    counts,
  };
}

// --- Tests ---

console.log('=== Slice 19 test: admin work summary ===\n');

// 19.1 — urgent item lands in actNow
{
  console.log('--- 19.1 failed_jobs → actNow ---');
  const q = makeQueue([makeSection('failed_jobs', 2)]);
  const s = buildWorkSummary(q);
  const item = s.actNow.find((i) => i.label === 'failed jobs');
  if (!item) throw new Error('failed_jobs not in actNow');
  if (item.count !== 2) throw new Error(`expected count 2, got ${item.count}`);
  if (item.detail !== null) throw new Error('multi-row should have null detail');
  if (s.waiting.length !== 0) throw new Error('waiting should be empty');
  if (s.upcoming.length !== 0) throw new Error('upcoming should be empty');
  console.log('  OK\n');
}

// 19.2 — approval lands in waiting
{
  console.log('--- 19.2 pending_approvals → waiting ---');
  const q = makeQueue([makeSection('pending_approvals', 1)]);
  const s = buildWorkSummary(q);
  const item = s.waiting.find((i) => i.label === 'pending approvals');
  if (!item) throw new Error('pending_approvals not in waiting');
  if (item.count !== 1) throw new Error(`expected count 1, got ${item.count}`);
  if (!item.detail) throw new Error('single-row section should have detail');
  if (!item.detail.includes('test client')) throw new Error('detail should include context');
  console.log('  OK\n');
}

// 19.3 — upcoming milestone lands in upcoming
{
  console.log('--- 19.3 upcoming_milestones → upcoming ---');
  const q = makeQueue([makeSection('upcoming_milestones', 3)]);
  const s = buildWorkSummary(q);
  const item = s.upcoming.find((i) => i.label === 'milestones coming up');
  if (!item) throw new Error('upcoming_milestones not in upcoming');
  if (item.count !== 3) throw new Error(`expected count 3, got ${item.count}`);
  if (item.detail !== null) throw new Error('multi-row should have null detail');
  console.log('  OK\n');
}

// 19.4 — 3-row section dedupes to 1 summary item
{
  console.log('--- 19.4 dedupe: 3-row section → 1 summary item ---');
  const q = makeQueue([makeSection('late', 3)]);
  const s = buildWorkSummary(q);
  const lateItems = s.actNow.filter((i) => i.label === 'late invoices');
  if (lateItems.length !== 1) throw new Error(`expected 1 summary item, got ${lateItems.length}`);
  if (lateItems[0].count !== 3) throw new Error(`expected count 3, got ${lateItems[0].count}`);
  console.log('  OK\n');
}

// 19.5 — empty queue → empty buckets
{
  console.log('--- 19.5 empty queue → all clear ---');
  const q = makeQueue([
    makeSection('failed_jobs', 0),
    makeSection('late', 0),
    makeSection('pending_approvals', 0),
    makeSection('upcoming_milestones', 0),
  ]);
  const s = buildWorkSummary(q);
  if (s.actNow.length !== 0) throw new Error('actNow should be empty');
  if (s.waiting.length !== 0) throw new Error('waiting should be empty');
  if (s.upcoming.length !== 0) throw new Error('upcoming should be empty');
  console.log('  OK\n');
}

// 19.6 — hard blocker → actNow, soft blocker → waiting
{
  console.log('--- 19.6 blockers split correctly ---');
  const q = makeQueue([], [
    makeBlocker('hard', 'cron_stuck'),
    makeBlocker('soft', 'reminders_require_sent'),
  ]);
  const s = buildWorkSummary(q);
  if (s.actNow.length !== 1) throw new Error(`actNow should have 1, got ${s.actNow.length}`);
  if (s.actNow[0].label !== 'blockers') throw new Error(`expected 'blockers', got '${s.actNow[0].label}'`);
  if (s.actNow[0].count !== 1) throw new Error(`expected blocker count 1, got ${s.actNow[0].count}`);
  if (!s.actNow[0].detail) throw new Error('single hard blocker should have detail');
  if (s.waiting.length !== 1) throw new Error(`waiting should have 1, got ${s.waiting.length}`);
  if (s.waiting[0].label !== 'known limitations') throw new Error(`expected 'known limitations'`);
  console.log('  OK\n');
}

// 19.7 — locked_periods stays out of all buckets
{
  console.log('--- 19.7 locked_periods → skipped ---');
  const q = makeQueue([makeSection('locked_periods', 5)]);
  const s = buildWorkSummary(q);
  if (s.actNow.length !== 0) throw new Error('locked_periods leaked into actNow');
  if (s.waiting.length !== 0) throw new Error('locked_periods leaked into waiting');
  if (s.upcoming.length !== 0) throw new Error('locked_periods leaked into upcoming');
  console.log('  OK\n');
}

// 19.8 — severity ordering within actNow
{
  console.log('--- 19.8 severity ordering ---');
  const q = makeQueue(
    [
      makeSection('csv_source_attention', 1), // severity 11
      makeSection('overdue_milestones', 2),   // severity 4
      makeSection('failed_jobs', 1),          // severity 0
    ],
    [makeBlocker('hard', 'cron_stuck')],      // severity -1
  );
  const s = buildWorkSummary(q);
  if (s.actNow.length !== 4) throw new Error(`expected 4 items, got ${s.actNow.length}`);
  const labels = s.actNow.map((i) => i.label);
  if (labels[0] !== 'blockers') throw new Error(`[0] expected blockers, got ${labels[0]}`);
  if (labels[1] !== 'failed jobs') throw new Error(`[1] expected failed jobs, got ${labels[1]}`);
  if (labels[2] !== 'overdue milestones') throw new Error(`[2] expected overdue milestones, got ${labels[2]}`);
  if (labels[3] !== 'CSV sources unhealthy') throw new Error(`[3] expected CSV sources unhealthy, got ${labels[3]}`);
  console.log('  OK\n');
}

// 19.9 — full bucket assignment: every mapped section lands in exactly one bucket
{
  console.log('--- 19.9 full bucket assignment ---');
  const allSections = [
    'failed_jobs', 'failed_imports', 'stale_pending', 'late',
    'overdue_milestones', 'unbilled_needs_approval', 'unbilled_manual_review',
    'drafts', 'expired', 'missing_automation', 'google_sync_attention',
    'csv_source_attention',
    'pending_approvals', 'due_soon',
    'upcoming_milestones', 'expiring', 'unbilled_auto_bill',
    'locked_periods',
  ];
  const q = makeQueue(allSections.map((k) => makeSection(k, 1)));
  const s = buildWorkSummary(q);

  // 12 actNow (all attention + infrastructure sections)
  if (s.actNow.length !== 12) throw new Error(`actNow: expected 12, got ${s.actNow.length}`);
  // 2 waiting (pending_approvals + due_soon)
  if (s.waiting.length !== 2) throw new Error(`waiting: expected 2, got ${s.waiting.length}`);
  // 3 upcoming (upcoming_milestones + expiring + unbilled_auto_bill)
  if (s.upcoming.length !== 3) throw new Error(`upcoming: expected 3, got ${s.upcoming.length}`);
  // Total: 17 items from 17 mapped sections (locked_periods skipped)
  const total = s.actNow.length + s.waiting.length + s.upcoming.length;
  if (total !== 17) throw new Error(`total: expected 17, got ${total}`);
  // Verify MAPPED_SECTION_KEYS matches the 17 expected
  if (MAPPED_SECTION_KEYS.length !== 17) throw new Error(`MAPPED_SECTION_KEYS: expected 17, got ${MAPPED_SECTION_KEYS.length}`);
  console.log('  OK\n');
}

// 19.integration — live queue → work summary
{
  console.log('--- 19.integration: live queue → work summary ---');
  const { loadAdminQueue } = await import('../src/lib/admin-queue');
  const liveQueue = await loadAdminQueue();
  const liveSummary = buildWorkSummary(liveQueue);

  // Structure checks
  if (!Array.isArray(liveSummary.actNow)) throw new Error('actNow not an array');
  if (!Array.isArray(liveSummary.waiting)) throw new Error('waiting not an array');
  if (!Array.isArray(liveSummary.upcoming)) throw new Error('upcoming not an array');

  // Every item must have label, anchor, count
  for (const bucket of [liveSummary.actNow, liveSummary.waiting, liveSummary.upcoming]) {
    for (const item of bucket) {
      if (typeof item.label !== 'string' || !item.label) throw new Error('item missing label');
      if (typeof item.anchor !== 'string' || !item.anchor.startsWith('#')) throw new Error(`bad anchor: ${item.anchor}`);
      if (typeof item.count !== 'number' || item.count < 1) throw new Error(`bad count: ${item.count}`);
    }
  }

  // No duplicate labels within any bucket
  for (const [name, bucket] of [
    ['actNow', liveSummary.actNow],
    ['waiting', liveSummary.waiting],
    ['upcoming', liveSummary.upcoming],
  ] as const) {
    const labels = (bucket as { label: string }[]).map((i) => i.label);
    const unique = new Set(labels);
    if (unique.size !== labels.length) throw new Error(`duplicate label in ${name}`);
  }

  console.log(`  actNow:   ${liveSummary.actNow.length} items (${liveSummary.actNow.map((i) => `${i.count} ${i.label}`).join(', ') || 'clear'})`);
  console.log(`  waiting:  ${liveSummary.waiting.length} items (${liveSummary.waiting.map((i) => `${i.count} ${i.label}`).join(', ') || 'clear'})`);
  console.log(`  upcoming: ${liveSummary.upcoming.length} items (${liveSummary.upcoming.map((i) => `${i.count} ${i.label}`).join(', ') || 'clear'})`);
  console.log('  OK\n');
}

console.log('SLICE 19 TEST PASSED \u2713');
