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
