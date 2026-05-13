# Security Research Reference: 2026-05-12

Scope: Astro + Turso (libSQL) + Brevo + DigitalOcean Spaces, public marketing site + password+session client portal (`portal_session` cookie, httpOnly, SameSite=Lax, 30-day TTL). Persona variants swap copy via `data-*` at runtime.

Rules: every topic has a one-line rule, a "why," and an implementation hint. Cite by URL inline. No code changes performed.

---

## 1. OWASP Top 10:2025 (current list)

- A01 Broken Access Control: enforce server-side authz on every protected route; default-deny. Reference middleware in Astro's `onRequest` chain that loads session, then asserts `locals.user` for every `/portal/*` route.
- A02 Security Misconfiguration: produce hardened default response headers from middleware on every response; ban "default password" / debug pages in prod.
- A03 Software Supply Chain Failures (new emphasis, expanded from 2021 "Vulnerable Components"): pin transitive deps via lockfile, require npm provenance for critical packages, disable lifecycle scripts where possible (`npm install --ignore-scripts` in CI when verifying).
- A04 Cryptographic Failures: TLS everywhere, Argon2id for passwords, CSPRNG for tokens.
- A05 Injection (SSRF folded into A01 in 2025; A05 still covers SQLi/XSS/template injection): always parameterized queries; auto-escape templates.
- A06 Insecure Design: threat-model destructive endpoints (deletes, snapshot replaces) up front.
- A07 Authentication Failures: rate-limit logins, hash sessions at rest, rotate on auth state change.
- A08 Software or Data Integrity Failures: verify package signatures (npm provenance), enable Subresource Integrity for third-party `<script src>` if any.
- A09 Security Logging and Alerting Failures: log auth events, but redact PII; alert on anomaly.
- A10 Mishandling of Exceptional Conditions (new in 2025): never "fail open"; explicit deny on any unhandled exception in auth/authz code paths.

Sources: [OWASP Top 10:2025](https://owasp.org/Top10/2025/), [GitLab summary of 2025 changes](https://about.gitlab.com/blog/2025-owasp-top-10-whats-changed-and-why-it-matters/), [Fastly 2025 changes](https://www.fastly.com/blog/new-2025-owasp-top-10-list-what-changed-what-you-need-to-know).

---

## 2. Authentication patterns

### 2a. Password hashing (Argon2id)

- Use Argon2id, not Argon2i or Argon2d, for password storage.
- 2026 baseline (OWASP minimums): `m=19456 KiB (19 MiB), t=2, p=1`. Equivalent alternatives: `m=47104 KiB, t=1, p=1`; `m=12288, t=3, p=1`; `m=9216, t=4, p=1`; `m=7168, t=5, p=1`.
- For sensitive accounts (admin, billing) target 64 to 128 MiB memory, 3 to 5 iterations.
- Node library: `argon2` (latest 0.44.x, actively maintained) or `@node-rs/argon2` (Rust-backed, faster).
- bcrypt still acceptable for legacy systems at cost factor 10+, but plan migration. 72-byte password limit is a real bug surface; pre-hash long inputs with SHA-256 before bcrypt or migrate to Argon2id.
- scrypt fallback if Argon2id unavailable: `N=2^17 (128 MiB), r=8, p=1`.

```js
import argon2 from 'argon2';
const hash = await argon2.hash(password, {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
});
```

Sources: [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [argon2 npm](https://www.npmjs.com/package/argon2).

### 2b. Session tokens

- Generate with CSPRNG: `crypto.randomBytes(32)` (256 bits) is the modern default; 128 bits is the floor.
- Use async `randomBytes` in request paths to avoid blocking the event loop under load.
- Store hashed at rest (SHA-256 of the token); cookie holds the raw token, DB holds `sha256(token)`. This way a DB leak does not yield live sessions.
- Rotate session ID on every authentication state change (login, logout, privilege elevation, password change).
- Compare with `crypto.timingSafeEqual` on equal-length buffers.

```js
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
const raw = randomBytes(32).toString('base64url');           // cookie value
const stored = createHash('sha256').update(raw).digest();    // DB column (BLOB)
```

Sources: [Node crypto docs](https://nodejs.org/api/crypto.html), [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).

### 2c. Cookie attributes (2026)

- `__Host-` prefix for portal session: requires `Secure`, `Path=/`, no `Domain` attribute, blocks subdomain overwrites.
- Use `__Secure-` only when you must scope to subdomains via the `Domain` attribute.
- `SameSite=Strict` for portal-only flows (portal_session never leaves the portal). `Lax` only if you need top-level GET navigations from external sites to carry the cookie.
- `HttpOnly` always for session cookies. `Secure` always.
- `Partitioned` (CHIPS): only relevant for third-party cross-site embeds; on a first-party portal you do not need it. Adding it is harmless and future-proof on Chromium browsers (Chrome 114+, Edge 114+; Firefox/Safari behavior is partial). Must be paired with `Secure`.
- Do not set `Domain` if you do not have to; an explicit `Domain=codyasmith.com` makes the cookie available to every subdomain forever. `__Host-` prefix forbids `Domain`, which is the safer constraint.

```
Set-Cookie: __Host-portal_session=<base64url>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000
```

Site-stack note: current cookie is named `portal_session` with `SameSite=lax` and a 30-day TTL. Switching to `__Host-portal_session` with `SameSite=Strict` is a hardening upgrade; the trade-off is that an external link to `/portal/...` will not carry the cookie on the first GET (user lands logged out and must re-auth in that one navigation). For a B2B portal this is usually acceptable.

Sources: [MDN Secure Cookie Configuration](https://developer.mozilla.org/en-US/docs/Web/Security/Practical_implementation_guides/Cookies), [MDN CHIPS](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Privacy_sandbox/Partitioned_cookies), [PortSwigger Cookie Chaos](https://portswigger.net/research/cookie-chaos-how-to-bypass-host-and-secure-cookie-prefixes).

### 2d. Magic link auth (if reintroduced)

- Token entropy: 128+ bits from CSPRNG; 256 bits preferred.
- TTL: 10 to 15 minutes; never longer than 60.
- Single-use: enforce in DB with a `used_at` column and conditional `UPDATE ... WHERE used_at IS NULL` in one query; check rows affected = 1.
- Bind to the originating session (cookie set at request time) so a phished link cannot be redeemed in a different browser.
- On successful redeem, issue a fresh session token and invalidate the magic-link row.

Sources: [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html), [Razoyo magic link guide](https://www.razoyo.com/posts/2025/10/08/the-secret-spellbook-of-login-magic-link-authentication-unveiled/).

### 2e. Login throttling

- Throttle both per-username and per-IP. NIST SP 800-63B-4 prefers progressive throttling over hard lockout to avoid DoS of legitimate users.
- Use exponential backoff: 1s, 2s, 4s, 8s, ..., capped at e.g. 60s. NIST allows up to roughly 100 consecutive failures with throttling before considering lockout.
- Count failures against the account (not just the IP) so distributed credential stuffing still trips throttling.
- Always keep password-reset accessible during lockout to avoid weaponizing the lockout as a DoS.
- Add Turnstile or hCaptcha after N failed attempts as a second control.

Sources: [NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html), [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).

---

## 3. CSRF protection

- Synchronizer Token Pattern is the default for stateful apps (server stores token tied to session). Stateless apps use Signed Double-Submit Cookie with HMAC.
- HMAC-signed double-submit: cookie carries `HMAC(secret, sessionId + random) + ":" + random`; form/header carries the same; server recomputes HMAC and timing-safe-compares. No DB hit needed.
- Plain (unsigned) double-submit is vulnerable to subdomain cookie injection; do not use it.
- `SameSite=Lax` alone is not sufficient: GET state-changing endpoints are still exposed. Audit every mutation to confirm it is a POST/PUT/PATCH/DELETE.
- `SameSite=Strict` plus rejecting any non-`POST` for mutations makes CSRF tokens nearly redundant on first-party-only origins, but keep a token as defense-in-depth (subdomain takeover is the residual risk).
- Always compare tokens with `crypto.timingSafeEqual`, never `===`.
- Send the token via custom request header (`X-CSRF-Token`) so it cannot be triggered by a simple form-based forgery (cross-origin forms cannot set custom headers without preflight).

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
function csrfToken(sessionId, secret) {
  const r = randomBytes(16).toString('base64url');
  const sig = createHmac('sha256', secret).update(sessionId + '.' + r).digest('base64url');
  return r + '.' + sig;
}
```

Site-stack note: Astro has no built-in CSRF middleware; you must add one in `src/middleware.ts`. With `SameSite=Lax` on `portal_session`, treat CSRF tokens as required for all `/portal/*` mutations.

Sources: [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), [dev.to HMAC double-submit walkthrough](https://dev.to/silentwatcher_95/building-your-own-hmac-signed-double-submit-csrf-3cgh).

---

## 4. CSP (Content Security Policy)

### 4a. Baseline directives (2026)

```
default-src 'self';
script-src 'self' 'strict-dynamic' 'nonce-{RANDOM}';
style-src 'self' 'nonce-{RANDOM}';
img-src 'self' data: https://*.digitaloceanspaces.com;
font-src 'self';
connect-src 'self';
frame-ancestors 'none';
form-action 'self';
base-uri 'none';
object-src 'none';
worker-src 'self';
manifest-src 'self';
media-src 'self';
report-to csp-endpoint;
```

- Nonce: 128+ bits, base64-encoded, regenerated per response. Inject from middleware on SSR routes; for prerendered pages, hashes are the only option.
- `strict-dynamic`: lets a trusted script load further scripts without re-allowlisting hosts; pairs with nonce.
- `'none'` on `object-src`, `base-uri`, `frame-ancestors` blocks classic CSP bypass vectors.
- `script-src-elem` and `script-src-attr` (CSP3) allow finer control: keep inline event handlers blocked (`script-src-attr 'none'`).
- Reporting: prefer `Reporting-Endpoints` + `report-to`; send both `report-uri` and `report-to` for back-compat. `report-uri` is deprecated but still consumed by older browsers.
- `unsafe-inline` and `unsafe-eval` are not acceptable in 2026 for first-party code; the only legitimate use is `unsafe-eval` for a third-party that genuinely needs it (avoid).

Sources: [OWASP CSP Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html), [web.dev strict CSP](https://web.dev/articles/strict-csp), [MDN CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP).

### 4b. Astro + `<script is:inline>` under strict CSP

- Astro 5.9+ ships experimental built-in CSP via `<meta http-equiv="content-security-policy">` using hashes (sha-256/384/512). It hashes both bundled island scripts and `is:inline` blocks at build time.
- Astro 6.0+ adds `security.csp.scriptDirective.strictDynamic: true` to allow `strict-dynamic`.
- Trade-off: meta-tag CSP cannot carry `frame-ancestors` or `report-uri`; you still need an HTTP `Content-Security-Policy` response header for those directives. Run both: meta from Astro for the hash list, header from middleware for the rest.
- `<ClientRouter />` (View Transitions) is documented as incompatible with the built-in CSP. If using view transitions, you must either disable the integration or compute hashes manually.
- Persona-variant note: copy swaps via `data-*` do not run JS by themselves and so do not need CSP changes, but if any persona injects HTML via `innerHTML` it will be blocked by strict CSP and Trusted Types (good thing).

Sources: [Astro experimental CSP](https://docs.astro.build/en/reference/experimental-flags/csp/), [Astro 5.9 blog](https://astro.build/blog/astro-590/).

---

## 5. Other security headers (2026 baseline set)

- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` (2 years; submit to [hstspreload.org](https://hstspreload.org/) only after testing). Ramp from 1 month before going to 2 years if you have subdomains you have not verified.
- `X-Content-Type-Options: nosniff` (still required; cheap).
- `X-Frame-Options: DENY` plus `Content-Security-Policy: frame-ancestors 'none'`. `frame-ancestors` is the modern control; keep XFO for older crawlers/scanners and the rare browser that does not handle CSP framing.
- `Referrer-Policy: strict-origin-when-cross-origin` as the default (also the browser default since 2020). Use `no-referrer` on `/portal/login`, `/portal/reset-password` and any page whose URL itself is sensitive.
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), display-capture=(), bluetooth=(), magnetometer=(), gyroscope=(), accelerometer=(), midi=(), fullscreen=(self), picture-in-picture=(), interest-cohort=()`.
- `Cross-Origin-Opener-Policy: same-origin` on `/portal/*` (blocks frame-counting and reference-leak attacks). `same-origin-allow-popups` is fine for the marketing site if you embed third-party widgets that open popups.
- `Cross-Origin-Embedder-Policy: require-corp` only if you need `SharedArrayBuffer` or precise `performance.now()`. For a normal portal it is overkill and breaks third-party image embeds.
- `Cross-Origin-Resource-Policy: same-origin` on portal HTML and JSON endpoints; `same-site` if you serve assets to a subdomain; `cross-origin` only on public CDN-ish assets.
- Remove `Server` and `X-Powered-By`. Astro/Vite do not advertise; verify your reverse proxy or hosting layer also strips these.

Sources: [MDN Strict-Transport-Security](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Strict-Transport-Security), [MDN Referrer-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy), [MDN Permissions-Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Permissions-Policy), [MDN CORP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Resource-Policy), [web.dev COOP/COEP](https://web.dev/articles/coop-coep), [HTTP Archive Web Almanac Security 2025](https://almanac.httparchive.org/en/2025/security).

---

## 6. SQL injection on Turso (libSQL)

- Always use parameter binding; never template literals with user data into SQL strings.
- libSQL Node client supports both positional `?` and named `:name` placeholders.
- Identifier (table/column) injection: parameter binding only covers values. For dynamic table/column names from user input, validate against a hard-coded allowlist (regex `^[a-z_][a-z0-9_]*$` plus an `in` check against known column names).
- Reject input that contains anything beyond expected value type at the validation layer (Zod/Valibot) before it reaches the SQL layer.

```js
import { createClient } from '@libsql/client';
const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

// positional
await db.execute({
  sql: 'SELECT id, email FROM users WHERE email = ? AND tenant_id = ?',
  args: [email, tenantId],
});

// named
await db.execute({
  sql: 'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (:user_id, :hash, :exp)',
  args: { user_id, hash, exp },
});

// identifier allowlist
const ALLOWED_SORT = new Set(['created_at', 'email', 'last_login']);
if (!ALLOWED_SORT.has(sort)) throw new Error('bad sort');
await db.execute(`SELECT * FROM users ORDER BY ${sort} DESC LIMIT 50`);
```

Sources: [libSQL client TS](https://github.com/tursodatabase/libsql-client-ts), [Turso libSQL docs](https://docs.turso.tech/libsql).

---

## 7. XSS prevention

- Astro auto-escapes `{value}` interpolation in `.astro` files and JSX expressions. `set:html`, `Fragment set:html`, and `is:raw` opt out of escaping; treat them as dangerous by default.
- For user-supplied HTML (rich text, markdown output) sanitize on the server before render with `sanitize-html` or DOMPurify (`jsdom` adapter for SSR). Track CVE history: DOMPurify had mXSS issues fixed in 3.2.4 (CVE-2025-26791); pin >= 3.2.4.
- For untrusted markdown, render with a hardened renderer (markdown-it with `html: false`) and then sanitize.
- Trusted Types (`Content-Security-Policy: require-trusted-types-for 'script'`): Chrome/Edge ship and enforce; Firefox and Safari implementations are in progress as of mid-2026. Deploy report-only first; do not gate functionality on it across browsers yet.
- JSON inside `<script>` blocks: never `innerHTML` a JSON string; render with `<script type="application/json" id="data">{...}</script>` and parse with `JSON.parse(document.getElementById('data').textContent)`. Escape `</script>` and `<!--` sequences in the JSON payload.

Site-stack note: persona variants swap visible body copy via `data-*` attributes. Make sure the swap reads from a static lookup table on the client, not from `innerHTML`-ing the `data-*` value directly. `element.textContent = variants[key]` is safe; `element.innerHTML = variants[key]` is not.

Sources: [Astro set:html ESLint rule](https://ota-meshi.github.io/eslint-plugin-astro/rules/no-set-html-directive/), [DOMPurify](https://github.com/cure53/DOMPurify), [CVE-2025-26791](https://www.cve.news/cve-2025-26791/), [MDN require-trusted-types-for](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/require-trusted-types-for).

---

## 8. Input validation libraries (2026)

- Zod v4: dominant ecosystem (~20M weekly downloads), large bundle (~17 kB for a login form schema), excellent docs. Use when ecosystem integrations matter (tRPC, drizzle-zod).
- Valibot: ~90% smaller bundle (~1.4 kB for the same schema) via modular tree-shakeable design; ~7x faster than Zod v4 in raw parse benchmarks. Use for serverless/edge endpoints where bundle size and cold-start matter.
- ArkType: fastest (3 to 4x faster than Zod, ~15x faster on some benchmarks), TypeScript-literal syntax; smaller community, steeper learning curve.
- For Astro API routes (`src/pages/api/*.ts`), Valibot is usually the better fit: small bundle is shipped to the edge runtime, parse is fast, and the API is similar enough to Zod to migrate.
- For complex form schemas with React Hook Form integration on the client, Zod's tooling lead still wins.

```ts
import * as v from 'valibot';
const ContactSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  email: v.pipe(v.string(), v.email(), v.maxLength(254)),
  message: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
});
export async function POST({ request }: APIContext) {
  const data = await request.json();
  const parsed = v.safeParse(ContactSchema, data);
  if (!parsed.success) return new Response('invalid', { status: 400 });
}
```

Sources: [Valibot comparison guide](https://valibot.dev/guides/comparison/), [zenn.dev Zod vs Valibot vs ArkType](https://zenn.dev/m_noto/articles/a2c09f741ba65e?locale=en).

---

## 9. File uploads (DigitalOcean Spaces / S3-compatible)

- Use pre-signed PUT URLs from the server; never embed permanent credentials in the browser.
- TTL: 5 to 15 minutes for uploads; 5 minutes for downloads. Shorter on sensitive content.
- Object key sanitization: regex-allowlist `^[a-zA-Z0-9._-]+$` for the basename, prepend a server-controlled prefix (`tenant/{uuid}/uploads/{uuid}/{name}`), strip `../`, leading `/`, NUL bytes; cap full key length to 1024.
- Enforce `Content-Type` and `Content-Length` in the presigned policy (S3 conditions); the browser cannot lie about these and still get a valid signature.
- Server-side magic-byte sniffing on download: read the first 16 bytes and compare to known signatures with `file-type` (npm). Reject if the magic bytes do not match the declared MIME.
- Anti-virus: run ClamAV in a background worker or use a vendor (Bucket AV, Cloudmersive). Quarantine bucket pattern: upload to `quarantine/`, scan, move to `clean/` on success or `infected/` on detection.
- Object ACL: default-private. Serve downloads through your app with short-lived signed GET URLs, not public-read.
- Spaces CDN does not cache presigned URLs; do not try.
- Strip metadata server-side from images (EXIF/GPS) with sharp before serving to other users; raw EXIF can leak location.

Sources: [DO Spaces presigned URLs](https://docs.digitalocean.com/products/spaces/how-to/set-file-permissions/), [DO Spaces S3 compatibility](https://docs.digitalocean.com/products/spaces/reference/s3-compatibility/), [Transloadit magic-number guide](https://transloadit.com/devtips/secure-api-file-uploads-with-magic-numbers/).

---

## 10. Rate limiting (2026)

- Algorithms ranked: token bucket (best general-purpose API rate limit; smooth bursts), sliding window log (most accurate; memory-heavy), sliding window counter (approximate, light), fixed window (simple but vulnerable to edge bursts), leaky bucket (smooth output, good for downstream protection).
- Storage: Turso (libSQL) works for sub-100 req/s use cases via a `rate_limit_buckets` table; for higher throughput use Redis/Upstash. In-memory only works on a single instance and is lost on restart; do not use it for security-relevant limits.
- Dimensions: layer per-IP + per-user + per-endpoint. Login should be per-username AND per-IP simultaneously.
- IPv6: rate-limit on `/64` prefix (consumer ISP standard) or `/48` (enterprise); a single user gets 2^64 addresses on a `/64`. Per-/128 limiting is useless against IPv6 abusers.
- `X-Forwarded-For` trust: only honor it from a fixed list of upstream proxies you control. Take the leftmost untrusted IP, not just `xff[0]` (attackers can pad the header). Behind Cloudflare prefer `CF-Connecting-IP`; behind DigitalOcean App Platform configure `trust proxy` and validate.
- Defense-in-depth: Cloudflare Turnstile (free, non-interactive) on login and contact forms; rate-limit independently because direct-POST attackers will not load the widget.

```sql
CREATE TABLE rate_limit_buckets (
  key TEXT PRIMARY KEY,
  tokens REAL NOT NULL,
  last_refill INTEGER NOT NULL
);
```

Sources: [Cloudflare WAF rate limiting](https://developers.cloudflare.com/waf/rate-limiting-rules/best-practices/), [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/), [OneUptime IPv6 rate limit](https://oneuptime.com/blog/post/2026-03-20-rate-limit-ipv6-reverse-proxy/view).

---

## 11. Email injection (Brevo)

- Never put untrusted input into headers (`Subject`, `From`, `Reply-To`, `To`) without stripping CR/LF.
- Strip `\r` and `\n` from any form field that ends up in a header. Length-cap subjects at ~150 chars.
- Use Brevo's transactional API (JSON body) rather than building SMTP messages by hand; the API treats headers as JSON fields and resists CRLF injection by encoding, but still validate input.
- Validate email syntax with Valibot/Zod `.email()`, then re-check via Brevo's verification before adding to high-value lists.
- Set `From` to a fixed sender you control; put the user's email only in `Reply-To` and only after CRLF stripping.
- Bounce handling: configure Brevo webhook for hard bounces, suppress automatically. Set up `DKIM`, `SPF`, and `DMARC` on the sending domain.

```ts
function safeHeader(input: string, max = 150): string {
  return input.replace(/[\r\n]+/g, ' ').slice(0, max).trim();
}
```

Sources: [Brevo technical guide](https://www.captaindns.com/en/blog/brevo-transactional-email-technical-guide).

---

## 12. Secrets management

- `.env` for local-only secrets, never committed. `.env.example` checked in with placeholder names. `.env.local` for personal overrides (gitignored).
- Astro: `import.meta.env.PUBLIC_*` is exposed to client bundles. Anything not prefixed `PUBLIC_` stays server-only, but only inside SSR/middleware. Audit any `Astro.props` or component that passes `import.meta.env.SECRET_*` into rendered HTML.
- Prefer the typed `astro:env` schema (`envField.string({ context: 'server', access: 'secret' })`) so misuse is a build-time TS error.
- Pre-commit secret scanning: Gitleaks (open-source, fast) or Trufflehog as a git hook. GitGuardian as a GitHub App for org-wide scanning.
- Rotation: rotate Brevo API key, Turso auth token, Spaces access key on a fixed schedule (90 days) and immediately on any suspected leak. Store rotation dates in a runbook.
- Never log secrets, including in error stacks. Use a logger that allowlists fields.

Sources: [Astro env vars docs](https://docs.astro.build/en/guides/environment-variables/), [Gitleaks](https://github.com/gitleaks/gitleaks).

---

## 13. Dependency security

- `npm audit` over-reports for transitive dev-only deps; manually verify reachability before scrambling. Use `npm audit --omit=dev --production` to focus on runtime.
- Pin to exact versions for security-critical libs (argon2, libSQL client, sharp, DOMPurify). Use `npm ci` in CI/CD.
- `package-lock.json` carries `integrity` SHA-512 hashes; do not let lockfile diffs sneak through PR review.
- Supply-chain attacks (Shai-Hulud, Axios March 2026): disable lifecycle scripts by default with `npm config set ignore-scripts true` and re-enable per-package when needed.
- Prefer packages published with npm provenance (Sigstore attestation). `npm install` will surface provenance status; require it for new dependencies.
- Trusted Publishing (npm, July 2025) via GitHub Actions OIDC: if you publish your own packages, use it; it eliminates the long-lived NPM token.
- Tooling: Dependabot for routine bumps; Snyk for SCA + runtime; GitHub Security Advisories for the CVE feed.

Sources: [Snyk Shai-Hulud post-mortem](https://snyk.io/articles/npm-security-best-practices-shai-hulud-attack/), [npm provenance](https://docs.npmjs.com/generating-provenance-statements/), [pnpm supply-chain guide](https://pnpm.io/supply-chain-security).

---

## 14. Logging and observability

- Never log raw passwords, full session tokens, full credit card numbers, or full API keys. Allowlist log fields; default-deny.
- Email in logs: hash with a server-side salt (`HMAC-SHA256(email, salt)`) for correlation; do not store plain email in long-lived logs unless legally required.
- IP truncation for GDPR: trim IPv4 to `/24` (last octet) and IPv6 to `/48` for analytics retention beyond 24 hours. CNIL guidance treats truncated IPs as no longer PII.
- Structured logging: JSON only. Fields: `ts`, `level`, `event`, `user_id` (not email), `request_id`, `ip_truncated`, `path`, `status`, `latency_ms`.
- Error messages to clients: generic `"Something went wrong"`; details only in server logs with a `request_id` echoed to the client.
- Audit trail: append-only table (`activity_log`), no UPDATE/DELETE grants; checksum-chain rows (`prev_hash` column with SHA-256 of previous row) for tamper detection on sensitive actions.
- Retention: 30 to 90 days for operational logs; longer (1+ year) for security/audit logs with documented justification under GDPR's storage-limitation principle.

Sources: [Last9 GDPR log management](https://last9.io/blog/gdpr-log-management/), [OneUptime PII in telemetry](https://oneuptime.com/blog/post/2025-11-13-keep-pii-out-of-observability-telemetry/view).

---

## 15. Astro-specific security

- Middleware chain order: `sequence(authMiddleware, csrfMiddleware, headerMiddleware)` runs left-to-right on request, right-to-left on response. Put auth/session loading first so `locals.user` is available to all downstream middleware.
- `prerender = true` pages skip request-time middleware in production builds; their HTML is served statically. Cookie reads/writes there are meaningless. Mark all `/portal/*` pages `prerender = false` (or set `output: 'server'` and use `prerender = true` only for marketing pages).
- Persona swap pages must stay `prerender = true` (the persona swap is client-side) so they cache well.
- `Astro.cookies.set(name, value, options)`: pass `{ httpOnly, secure, sameSite, path, maxAge }` explicitly every time; Astro does not default `httpOnly`. Avoid `Astro.cookies.set(name, value)` (no options) anywhere.
- SSR endpoint (`src/pages/api/*.ts`): always `try/catch`, always validate body with Valibot before touching the DB, always check `locals.user` for `/api/portal/*`.
- View Transitions / `<ClientRouter />`: the client navigates by fetching the next page's HTML and patching the DOM. This means a session cookie change mid-navigation can leave stale state. After login/logout, force a full reload (`window.location.assign`) instead of a transition.
- `Astro.url` parsing: trust it for path/query; do not trust `Astro.request.headers.get('host')` without a `trusted-hosts` allowlist.

Sources: [Astro Middleware](https://docs.astro.build/en/guides/middleware/), [Astro View Transitions](https://docs.astro.build/en/guides/view-transitions/).

---

## 16. CORS

- Astro is same-origin by default. Marketing site has no reason to add CORS headers.
- For the portal, if you expose an API to a separate subdomain or app: set `Access-Control-Allow-Origin` to a specific origin (echo the `Origin` request header only after allowlist check), `Access-Control-Allow-Credentials: true`, and `Vary: Origin`.
- Never combine `Access-Control-Allow-Origin: *` with `Access-Control-Allow-Credentials: true` (browser blocks it; even setting it is a misconfiguration signal).
- Do not reflect arbitrary `Origin` headers; build a hard-coded set of allowed origins.

```ts
const ALLOWED = new Set(['https://portal.codyasmith.com']);
const origin = request.headers.get('origin') ?? '';
const ok = ALLOWED.has(origin);
const headers = {
  'Access-Control-Allow-Origin': ok ? origin : '',
  'Access-Control-Allow-Credentials': ok ? 'true' : '',
  'Vary': 'Origin',
};
```

Sources: [MDN CORS misconfig with credentials](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS/Errors/CORSNotSupportingCredentials).

---

## 17. Open redirects

- Never echo a `?next=` or `?return_to=` parameter into a `Location` header without validation.
- Validate with `new URL(input, siteOrigin)` then assert `.origin === siteOrigin`. Reject `//attacker.com`, `\\attacker.com`, `javascript:`, and full URLs with different hosts.
- Prefer server-side mapping: client sends `?next=dashboard`, server maps to `/portal/dashboard`. No URL escapes the allowlist.
- Always start redirects with `/` so they are relative to the current origin; `new URL(path, location)` will resolve correctly.

```ts
function safeNext(input: string | null, origin: string): string {
  if (!input) return '/portal';
  try {
    const u = new URL(input, origin);
    if (u.origin !== origin) return '/portal';
    return u.pathname + u.search;
  } catch { return '/portal'; }
}
```

Sources: [OWASP Unvalidated Redirects](https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html).

---

## 18. Cross-tab attacks / XS-Leak

- COOP `same-origin` on `/portal/*` blocks `window.opener` references and frame-counting attacks.
- CORP `same-origin` on portal JSON/HTML responses blocks `<img>`/`<script>` probing from external pages.
- `SameSite=Strict` on `portal_session` blocks login-status probing via authenticated subresource loads from other origins.
- `frame-ancestors 'none'` blocks iframe embedding attacks.
- Fetch Metadata Request Headers (`Sec-Fetch-Site`, `Sec-Fetch-Mode`, `Sec-Fetch-Dest`, `Sec-Fetch-User`): reject `Sec-Fetch-Site: cross-site` for portal navigations that should never be cross-site initiated. Lightweight middleware can drop these requests early.
- Cache partitioning is on by default in modern Chromium/Firefox; you do not need to configure it. Do not disable it via misuse of `Cache-Control: public` on authenticated responses.

```ts
const site = request.headers.get('sec-fetch-site');
if (site === 'cross-site' && request.method === 'POST') {
  return new Response('blocked', { status: 403 });
}
```

Sources: [MDN XS-Leaks](https://developer.mozilla.org/en-US/docs/Web/Security/Attacks/XS-Leaks), [HTTP Archive Web Almanac Security 2025](https://almanac.httparchive.org/en/2025/security).

---

## 19. Modern auth alternatives

- Passkeys (WebAuthn): supported on every major browser and synced by Apple iCloud Keychain, Google Password Manager, Microsoft account, 1Password, Bitwarden. iOS 16+, macOS 13+ (Ventura+), Android 9+.
- Use SimpleWebAuthn (`@simplewebauthn/server`, `@simplewebauthn/browser`): TypeScript-first, runs on Node 20+, Cloudflare Workers, Bun, Deno.
- Registration options: `residentKey: 'required'`, `userVerification: 'preferred'` for passkey-style discoverable credentials. Conditional UI lets browsers autofill passkeys without an explicit "Sign in with passkey" button.
- MFA: TOTP (Google Authenticator, Authy) for low-friction; WebAuthn security keys for high-value accounts. Avoid SMS as a second factor (SIM-swap risk) per NIST SP 800-63B-4.
- Even with passkeys, keep password as fallback if your audience includes shared-device or kiosk-style logins; otherwise go passkey-only.

Sources: [SimpleWebAuthn docs](https://simplewebauthn.dev/), [SimpleWebAuthn passkeys](https://simplewebauthn.dev/docs/advanced/passkeys).

---

## 20. Privacy compliance (GDPR, CCPA, US state laws)

- Right to deletion: provide a self-service flow or an email channel (`privacy@codyasmith.com`) that triggers deletion within 30 days (GDPR) or 45 days (CCPA, extendable to 90 with notice). Document what gets deleted vs retained (e.g., financial records you must keep).
- Right of access: produce an export of all PII you hold within 30 days. JSON dump is fine; structure it.
- Cookie consent: GDPR/ePrivacy requires prior consent for any non-essential cookie (analytics, marketing, advertising). Strictly necessary cookies (`portal_session`, CSRF tokens) are exempt but should be disclosed in the privacy notice.
- The site claims no tracking. Audit third-party calls anyway: any font, map, video embed, chat widget, or analytics that calls a third-party CDN can leak the visitor IP and may legally constitute tracking under GDPR/ePrivacy. Self-host fonts, lazy-load embeds with consent gating.
- US state laws (CCPA, Virginia VCDPA, Colorado CPA, Connecticut CTDPA, etc.): require a "Do Not Sell or Share My Personal Information" link if you sell/share PII; provide opt-out signals (GPC `Sec-GPC` header). California DROP platform from 2026 requires data brokers to honor universal deletion requests.
- Privacy policy must be specific: what data, why, who it goes to, how long, how to delete.

Sources: [GDPR cookie consent 2025](https://transcend.io/blog/2025-cookie-consent-laws), [CA Right to Delete](https://privacy.ca.gov/2025/08/locked-series-right-to-equal-treatment-right-to-delete/), [California DROP platform](https://cppa.ca.gov/announcements/2025/20251113.html).

---

## Stack-specific concerns to flag up front

1. **Persona swap via `data-*`**: if the swap implementation ever does `element.innerHTML = el.dataset.variant`, every persona becomes a stored-XSS sink the moment any persona copy is sourced from a CMS or form. Use `textContent` or a static lookup keyed by persona ID.
2. **Astro CSP + View Transitions**: built-in CSP integration is incompatible with `<ClientRouter />`. If view transitions are used on the marketing site, CSP must be hand-rolled in middleware, which adds maintenance load every time a script is added.
3. **`portal_session` is `SameSite=Lax`**: that means CSRF tokens are mandatory on every state-changing portal endpoint. Lax does not protect GET-triggered state changes, so audit that no portal mutation is reachable via GET.
4. **30-day session TTL**: long for a portal that handles client files and PII. Consider 7-day sliding window or 30-day idle with absolute 90-day cap. Always rotate session ID on auth state changes and store sessions hashed at rest.
5. **Turso (libSQL) for rate-limit/audit state**: works at low scale. If the portal grows past a few req/s sustained, move rate limit buckets to Redis/Upstash; libSQL is not optimized for high-write rate-limit hot paths.
6. **DO Spaces presigned uploads**: presigned PUTs that do not constrain `Content-Type` and `Content-Length` let an attacker upload arbitrary files to your bucket. Always set both conditions on the signed policy.
7. **Brevo header injection**: any contact/feedback form that puts the user's email into `Reply-To` must strip CR/LF; the Brevo API helps but does not absolve you.
8. **Supply chain**: keep `argon2`, `@libsql/client`, DOMPurify, `sharp`, and any auth library pinned. Enable Dependabot, require npm provenance for new dependencies, audit lifecycle scripts on every `npm install`.
