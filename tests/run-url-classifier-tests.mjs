// url-classifier: is_expected (URL-shape benign) + crawler-blocked-host
// allowlist gated on bot-block status. Guards the H2 broken-link false-positive
// suppression so a client is never shown a benign link as broken, while a
// genuine 404 still flags.
import assert from 'node:assert';
import { classifyUrl, isCrawlerBlockedHost, CRAWLER_BLOCKING_DOMAINS } from '../src/lib/url-classifier.ts';

let passed = 0, failed = 0;
function test(n, f) {
  try { f(); console.log(`[PASS] ${n}`); passed++; }
  catch (e) { console.error(`[FAIL] ${n}: ${e.message}`); failed++; }
}

// is_expected (URL-shape): an error here is benign, never shown as broken.
test('cdn-cgi email-protection -> is_expected, not a page', () => {
  const c = classifyUrl('https://zipkithomes.com/cdn-cgi/l/email-protection#abc');
  assert.strictEqual(c.type, 'cdn');
  assert.strictEqual(c.is_expected, true);
  assert.strictEqual(c.is_page, false);
});
test('mailto: -> is_expected, not a page', () => {
  const c = classifyUrl('mailto:hello@zipkithomes.com');
  assert.strictEqual(c.is_expected, true);
  assert.strictEqual(c.is_page, false);
});
test('tel: -> is_expected', () => assert.strictEqual(classifyUrl('tel:+18015551234').is_expected, true));

// A real page and a real broken asset are NOT expected (must still flag).
test('normal page -> not expected, is_page', () => {
  const c = classifyUrl('https://zipkithomes.com/about');
  assert.strictEqual(c.is_expected, false);
  assert.strictEqual(c.is_page, true);
});
test('wp-content image -> not expected (a broken site image IS a real issue)', () => {
  const c = classifyUrl('https://zipkithomes.com/wp-content/uploads/2025/12/x.webp');
  assert.strictEqual(c.is_expected, false);
  assert.strictEqual(c.is_page, false); // not a page, but its 404 is worth flagging
});

// Crawler-blocked host allowlist.
test('youtube/youtu.be/linkedin are crawler-blocked hosts (www stripped)', () => {
  assert.ok(isCrawlerBlockedHost('www.youtube.com'));
  assert.ok(isCrawlerBlockedHost('youtu.be'));
  assert.ok(isCrawlerBlockedHost('linkedin.com'));
});
test('the client domain is NOT a crawler-blocked host', () => {
  assert.strictEqual(isCrawlerBlockedHost('zipkithomes.com'), false);
  assert.strictEqual(isCrawlerBlockedHost('f3properties.com'), false);
});
// The exact suppression the broken-link widget applies (it already operates
// only within the >=400 broken set, so a crawler-blocked host is suppressed on
// ANY error — verified: YouTube 404s a LIVE @handle to the crawler).
function suppressed(dest) {
  if (classifyUrl(dest).is_expected) return true;
  let host = ''; try { host = new URL(dest).hostname; } catch { /* keep */ }
  return isCrawlerBlockedHost(host);
}
test('youtube is suppressed on any error (the verified 404-to-live-@handle case)', () => {
  assert.strictEqual(suppressed('https://www.youtube.com/@zipkithomes4527'), true);
  assert.strictEqual(suppressed('https://www.youtube.com/watch?v=anything'), true);
});
test('on-site 404 is NOT suppressed; a broken wp-content image is NOT suppressed; cdn-cgi IS', () => {
  assert.strictEqual(suppressed('https://zipkithomes.com/gone'), false);
  assert.strictEqual(suppressed('https://zipkithomes.com/wp-content/uploads/x.webp'), false); // real broken image, keep flagged
  assert.strictEqual(suppressed('https://zipkithomes.com/cdn-cgi/l/email-protection'), true);
});
test('allowlist covers the documented social/video set', () => {
  for (const d of ['youtube.com', 'linkedin.com', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'tiktok.com', 'pinterest.com']) {
    assert.ok(CRAWLER_BLOCKING_DOMAINS.includes(d), `${d} missing from allowlist`);
  }
});

console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
