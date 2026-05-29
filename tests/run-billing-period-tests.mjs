#!/usr/bin/env node
// getCurrentBillingPeriod date-validity test.
//
// Regression guard for the billing_day=1 bug: the old string math
// (`String(billingDay - 1).padStart(2,'0')`) produced an invalid
// period_end of 'YYYY-MM-00' for the default anchor day, which the
// billing handoff then wrote to every at-signing invoice. This asserts
// the period bounds are always real, parseable YYYY-MM-DD dates with
// start strictly before end, for every plausible anchor day. Runs via tsx.

import { getCurrentBillingPeriod } from '../src/lib/billing.ts';

const results = [];
function test(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
  if (!pass && detail) console.log(`       ${String(detail).slice(0, 200)}`);
}
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (s) => Number(s.slice(8, 10));
const valid = (s) => ISO.test(s) && !Number.isNaN(Date.parse(s)) && dayOf(s) >= 1 && dayOf(s) <= 31;

function run() {
  for (const day of [1, 2, 15, 27, 28]) {
    const { start, end } = getCurrentBillingPeriod(day);
    test(`billing_day=${day}: start is a valid date (${start})`, valid(start), `start=${start}`);
    test(`billing_day=${day}: end is a valid date (${end})`, valid(end), `end=${end}`);
    test(`billing_day=${day}: end is NOT 'YYYY-MM-00'`, !end.endsWith('-00'), `end=${end}`);
    test(`billing_day=${day}: start strictly before end`, Date.parse(start) < Date.parse(end),
      `start=${start} end=${end}`);
    // The period should be roughly a month long (27-31 days), never zero/negative.
    const days = Math.round((Date.parse(end) - Date.parse(start)) / 86400000);
    test(`billing_day=${day}: period spans ~a month (${days}d)`, days >= 26 && days <= 32, `${days} days`);
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

run();
