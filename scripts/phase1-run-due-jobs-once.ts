// Dev utility — invoke runDueJobs() once and print the result. Same
// code path the /portal/api/jobs/run endpoint exercises. Safe to run
// any time; all handlers are idempotent.

import 'dotenv/config';
import { runDueJobs } from '../src/lib/jobs/runner';

(async () => {
  const r = await runDueJobs(10);
  console.log(JSON.stringify(r, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
