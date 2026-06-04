import assert from 'node:assert';
import { resolveInvoiceRecipients } from '../src/lib/invoice-emails.ts';

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); console.log(`[PASS] ${name}`); passed++; } catch (e) { console.error(`[FAIL] ${name}: ${e.message}`); failed++; } }

test('primary only -> to=[primary], no cc', () => {
  const r = resolveInvoiceRecipients({ primaryEmail: 'sven@zipkithomes.com' });
  assert.deepStrictEqual(r, { to: ['sven@zipkithomes.com'], cc: [] });
});

test('primary + accountant CC + per-invoice extra', () => {
  const r = resolveInvoiceRecipients({
    primaryEmail: 'sven@zipkithomes.com',
    billingCcEmail: 'accountant@zipkithomes.com',
    extraEmail: 'bookkeeper@zipkithomes.com',
  });
  assert.deepStrictEqual(r.to, ['sven@zipkithomes.com']);
  assert.deepStrictEqual(r.cc, ['accountant@zipkithomes.com', 'bookkeeper@zipkithomes.com']);
});

test('does NOT include additional portal users when a primary is set', () => {
  const r = resolveInvoiceRecipients({
    primaryEmail: 'sven@zipkithomes.com',
    fallbackEmails: ['emree@zipkithomes.com', 'other@zipkithomes.com'],
  });
  assert.deepStrictEqual(r.to, ['sven@zipkithomes.com']);
  assert.deepStrictEqual(r.cc, []);
});

test('no primary -> falls back to the first portal user (safety)', () => {
  const r = resolveInvoiceRecipients({ primaryEmail: '', fallbackEmails: ['first@x.com', 'second@x.com'] });
  assert.deepStrictEqual(r.to, ['first@x.com']);
});

test('dedupes a cc that equals the primary (case/space-insensitive)', () => {
  const r = resolveInvoiceRecipients({
    primaryEmail: 'sven@zipkithomes.com',
    billingCcEmail: '  SVEN@ZipKitHomes.com ',
    extraEmail: 'accountant@x.com',
  });
  assert.deepStrictEqual(r.to, ['sven@zipkithomes.com']);
  assert.deepStrictEqual(r.cc, ['accountant@x.com']);
});

test('empty/whitespace fields are ignored', () => {
  const r = resolveInvoiceRecipients({ primaryEmail: 'a@x.com', billingCcEmail: '   ', extraEmail: null });
  assert.deepStrictEqual(r, { to: ['a@x.com'], cc: [] });
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
