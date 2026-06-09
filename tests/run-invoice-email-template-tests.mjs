#!/usr/bin/env node
// Unit tests for the pure invoice-email renderer (src/lib/invoice-email-templates.ts).
// No DB / no network -- exercises daysPastDue, the three variants, the amount
// line, and HTML escaping. Runs via tsx.

import { daysPastDue, renderInvoiceEmail, variantForStatus, money } from '../src/lib/invoice-email-templates.ts';

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; }
  else { failed++; console.log(`  [FAIL] ${name}`); }
}

const NOW = new Date('2026-06-09T18:00:00Z');
const base = {
  invoice_number: 'INV-2026-0004',
  title: null,
  total: 1360,
  amount_paid: 0,
  due_date: '2026-06-01',
  terms_label: null,
  greet_name: 'Sven',
};

// --- daysPastDue ---
check('daysPastDue past', daysPastDue('2026-06-01', NOW) === 8);
check('daysPastDue today is 0', daysPastDue('2026-06-09', NOW) === 0);
check('daysPastDue future is 0', daysPastDue('2026-07-01', NOW) === 0);
check('daysPastDue null is 0', daysPastDue(null, NOW) === 0);
check('daysPastDue garbage is 0', daysPastDue('not-a-date', NOW) === 0);
check('daysPastDue one day singular', daysPastDue('2026-06-08', NOW) === 1);

// --- ready variant (must match the long-standing copy) ---
const ready = renderInvoiceEmail(base, 'ready', { portalUrl: 'https://codyasmith.com', now: NOW });
check('ready heading', ready.html.includes('Your invoice is ready'));
check('ready greet', ready.html.includes('Hi Sven,'));
check('ready amount', ready.html.includes('$1,360.00 due'));
check('ready subject', ready.subject === 'Your invoice INV-2026-0004 from Cody A Smith LLC');
check('ready not overdue wording', !ready.html.toLowerCase().includes('past due'));

// --- reminder variant ---
const reminder = renderInvoiceEmail(base, 'reminder', { portalUrl: 'https://codyasmith.com', now: NOW });
check('reminder heading', reminder.html.includes('A reminder on your invoice'));
check('reminder subject', reminder.subject === 'Reminder: invoice INV-2026-0004');
check('reminder amount', reminder.html.includes('$1,360.00 due'));

// --- overdue variant: names the days past due ---
const overdue = renderInvoiceEmail(base, 'overdue', { portalUrl: 'https://codyasmith.com', now: NOW });
check('overdue heading', overdue.html.includes('Invoice past due'));
check('overdue days', overdue.html.includes('8 days past due'));
check('overdue references due date', overdue.html.includes('was due 2026-06-01'));
check('overdue subject', overdue.subject === 'Past due: invoice INV-2026-0004');

// overdue with no due date falls back gracefully (no "NaN days")
const noDue = renderInvoiceEmail({ ...base, due_date: null }, 'overdue', { portalUrl: 'https://codyasmith.com', now: NOW });
check('overdue no due date graceful', noDue.html.includes('is now past due') && !noDue.html.includes('NaN'));

// overdue exactly one day -> singular
const oneDay = renderInvoiceEmail({ ...base, due_date: '2026-06-08' }, 'overdue', { portalUrl: 'https://codyasmith.com', now: NOW });
check('overdue singular day', oneDay.html.includes('1 day past due') && !oneDay.html.includes('1 days'));

// --- title in subject + partial payment amount line ---
const titled = renderInvoiceEmail({ ...base, title: 'May 2026 Web Management', amount_paid: 360 }, 'ready', { portalUrl: 'https://codyasmith.com', now: NOW });
check('title subject', titled.subject === 'Your invoice: May 2026 Web Management (INV-2026-0004)');
check('partial amount line', titled.html.includes('$1,360.00 total, $1,000.00 now due'));

// --- HTML escaping of greet name ---
const xss = renderInvoiceEmail({ ...base, greet_name: '<script>x</script>' }, 'ready', { portalUrl: 'https://codyasmith.com', now: NOW });
check('greet escaped', xss.html.includes('&lt;script&gt;') && !xss.html.includes('<script>x'));

// --- variantForStatus ---
check('variantForStatus overdue', variantForStatus('overdue') === 'overdue');
check('variantForStatus sent', variantForStatus('sent') === 'ready');
check('variantForStatus payment_pending', variantForStatus('payment_pending') === 'ready');

// --- money ---
check('money formats', money(1360) === '$1,360.00' && money(0) === '$0.00');

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
