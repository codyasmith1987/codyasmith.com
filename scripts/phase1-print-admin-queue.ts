// Dev utility — prints the admin queue aggregator result against live
// prod Turso so you can see what the admin dashboard will render without
// standing up the dev server. Safe: read-only.
//
// Run: npx tsx scripts/phase1-print-admin-queue.ts

import 'dotenv/config';
import { loadAdminQueue } from '../src/lib/admin-queue';

(async () => {
  const q = await loadAdminQueue();
  console.log('generated:', q.generatedAt);
  console.log('counts:', JSON.stringify(q.counts));
  console.log();
  console.log(`=== blockers: ${q.blockers.length}`);
  for (const b of q.blockers) console.log(`  [${b.severity}]`, b.title);
  console.log();
  for (const s of q.sections) {
    console.log(`=== ${s.label}: ${s.count}`);
    for (const r of s.rows.slice(0, 5)) {
      console.log('  ·', r.what, '|', r.where, '|', r.why);
    }
    if (s.count === 0) console.log('  (none)');
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
