// Shared helpers for safely embedding user-controlled values in
// outbound transactional emails (Brevo).
//
// escapeHtml: prevents stored XSS / content injection in the htmlContent
// body of an email. Brevo serializes the JSON and sends it as-is, so
// a payload like `<script>...</script>` in scan.brand or contact form
// name would render in the recipient's email client.
//
// stripCRLF: prevents header injection in the subject, sender name,
// recipient name, replyTo name, and any other field that gets
// serialized into an RFC 5322 header. CRLF bytes inside a JSON value
// are technically safe when the provider sanitizes, but stripping
// them at the application boundary is the defensive default.

export function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function stripCRLF(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s).replace(/[\r\n]+/g, ' ').trim();
}

// Strict-enough email validity for OUTBOUND recipients. Rejects the things
// Brevo rejects but a loose `[^\s@]+@[^\s@]+\.[^\s@]+` lets through: display-name
// formats ("Name" <a@b.com>), angle brackets, spaces, commas/semicolons, and
// trailing junk like `a@b.com>`. The local part and domain forbid space and
// < > ( ) [ ] , ; : " and the address must END in a letter TLD. Used to
// validate on save AND to drop invalid addresses at send time so one bad CC
// never fails the whole email (a typo'd accountant must not block the client's
// invoice). Real prod incident 2026-06-04: a malformed CC 400'd the entire
// overdue-notice send.
const EMAIL_RE = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[A-Za-z]{2,}$/;

export function isValidEmail(s: string | null | undefined): boolean {
  if (s == null) return false;
  return EMAIL_RE.test(String(s).trim());
}
