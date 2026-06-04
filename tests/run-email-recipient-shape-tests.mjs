import assert from 'node:assert';
import { toBrevoRecipient } from '../src/lib/email.ts';

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

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
