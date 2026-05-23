// One-off availability check for Raised Bar Builders + Tailwater
// candidate domains. Uses the existing naming/availability.ts RDAP
// pipeline. Not committed long-term; run with `npx tsx scripts/check-rb-domains.ts`.

import { checkAvailability } from '../src/lib/naming/availability';

const RAISED_BAR_BUILDERS = [
  // Literal first
  'raisedbarbuilders',
  // Short / family
  'raisedbar',
  // Variants
  'raisedbarbuild',
  'raisedbarbuilding',
  'raisedbarco',
  'raisedbarconstruction',
  'raisedbarhomes',
  'rbbuilders',
  'buildraisedbar',
  'raisebarbuilders',
];

const TAILWATER = [
  // Literal first
  'tailwater',
  // Common qualifiers
  'tailwaterhomes',
  'tailwaterhailey',
  'tailwaterresidences',
  'tailwatertownhomes',
  'tailwaterhouses',
  // Stylistic
  'livetailwater',
  'attailwater',
  'thetailwaterhomes',
  'tailwaterketchum',
];

async function run() {
  console.log('Raised Bar Builders candidates:');
  const rbResults = await checkAvailability(RAISED_BAR_BUILDERS, ['com']);
  for (const r of rbResults) {
    const mark = r.available === true ? 'AVAILABLE'
      : r.available === false ? 'taken'
      : 'unknown';
    console.log(`  [${mark}] ${r.name}.${r.tld}`);
  }

  console.log('');
  console.log('Tailwater candidates:');
  const tResults = await checkAvailability(TAILWATER, ['com']);
  for (const r of tResults) {
    const mark = r.available === true ? 'AVAILABLE'
      : r.available === false ? 'taken'
      : 'unknown';
    console.log(`  [${mark}] ${r.name}.${r.tld}`);
  }
}

run().catch(err => {
  console.error('check threw:', err);
  process.exit(1);
});
