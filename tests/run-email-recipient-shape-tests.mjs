import assert from 'node:assert';
import { toBrevoRecipient } from '../src/lib/email.ts';
import { isValidEmail } from '../src/lib/email-safety.ts';

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); console.log(`[PASS] ${name}`); passed++; } catch (e) { console.error(`[FAIL] ${name}: ${e.message}`); failed++; } }

// Brevo rejects an empty-string name in `to`/`cc` with HTTP 400
// "name is missing in to". The shaper must OMIT name when empty, not send ''.

test('name present -> {email,name}', () => {
  assert.deepStrictEqual(toBrevoRecipient('a@x.com', 'Bob'), { email: 'a@x.com', name: 'Bob' });
});

test('empty name -> {email} only (no name key)', () => {
  assert.deepStrictEqual(toBrevoRecipient('a@x.com', ''), { email: 'a@x.com' });
});

test('undefined name -> {email} only', () => {
  assert.deepStrictEqual(toBrevoRecipient('a@x.com'), { email: 'a@x.com' });
});

test('whitespace-only name -> {email} only', () => {
  assert.deepStrictEqual(toBrevoRecipient('a@x.com', '   '), { email: 'a@x.com' });
});

test('CRLF stripped from name (no raw newline survives)', () => {
  const r = toBrevoRecipient('a@x.com', 'Bob\r\nEvil: x');
  assert.strictEqual(r.email, 'a@x.com');
  assert.ok(!/[\r\n]/.test(r.name), 'name must contain no CR/LF');
  assert.strictEqual(r.name, 'Bob Evil: x');
});

// --- isValidEmail: must reject what Brevo rejects (real incident 2026-06-04:
//     a malformed CC 400'd the whole overdue-notice send) ---

test('plain address is valid', () => {
  assert.strictEqual(isValidEmail('robbie@zipkithomes.com'), true);
  assert.strictEqual(isValidEmail('a@b.co'), true);
});

test('display-name format is rejected (the exact bad paste)', () => {
  assert.strictEqual(isValidEmail('"robbie@zipkithomes.com" <robbie@zipkithomes.com>'), false);
});

test('trailing angle bracket is rejected', () => {
  assert.strictEqual(isValidEmail('robbie@zipkithomes.com>'), false);
});

test('spaces / commas / semicolons rejected', () => {
  assert.strictEqual(isValidEmail('a b@c.com'), false);
  assert.strictEqual(isValidEmail('a@b.com,c@d.com'), false);
  assert.strictEqual(isValidEmail('a@b.com;c@d.com'), false);
});

test('missing TLD rejected', () => {
  assert.strictEqual(isValidEmail('a@b'), false);
  assert.strictEqual(isValidEmail('a@b.'), false);
});

test('empty / null rejected; surrounding whitespace tolerated', () => {
  assert.strictEqual(isValidEmail(''), false);
  assert.strictEqual(isValidEmail(null), false);
  assert.strictEqual(isValidEmail('  a@b.com  '), true);
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
