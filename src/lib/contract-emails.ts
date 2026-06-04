// Contract lifecycle email senders.
//
// Templates 5.3 - 5.7 from the design doc: contract issued, first signer
// signed, fully executed (with PDF attachment), signer revoked, Schedule A
// changed. All use Brevo as the transport and follow the same editorial
// HTML pattern as the proposal-flow emails for visual continuity.

import { logger } from './logger';
import { escapeHtml, stripCRLF } from './email-safety';
import type { ClientAgreement, AgreementSigner } from './agreements';

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const FROM_EMAIL = 'cody@codyasmith.com';
const FROM_NAME = 'Cody Smith';

interface BrevoAttachment {
  name: string;
  content: string; // base64
}

interface SendBrevoArgs {
  to: Array<{ email: string; name?: string }>;
  cc?: Array<{ email: string; name?: string }>;
  subject: string;
  html: string;
  attachments?: BrevoAttachment[];
}

// Strip CRLF from recipient names (RFC 5322 header-injection defense), and OMIT
// the name key when empty: Brevo rejects an empty-string name with HTTP 400
// "name is missing in to". Signer `to` names come from snapshots (populated),
// but the accountant cc carries no name, so this guard matters there.
const safeRecipients = (list: Array<{ email: string; name?: string }>) =>
  list.map(r => {
    const n = stripCRLF(r.name || '');
    return n ? { email: r.email, name: n } : { email: r.email };
  });

async function sendBrevo(args: SendBrevoArgs): Promise<boolean> {
  const brevoKey = import.meta.env.BREVO_API_KEY;
  if (!brevoKey) {
    logger.error('Brevo API key missing; contract email not sent');
    return false;
  }
  try {
    const body: any = {
      sender: { name: FROM_NAME, email: FROM_EMAIL },
      to: safeRecipients(args.to),
      subject: stripCRLF(args.subject),
      htmlContent: args.html,
    };
    if (args.cc && args.cc.length > 0) body.cc = safeRecipients(args.cc);
    if (args.attachments && args.attachments.length > 0) body.attachment = args.attachments;
    const res = await fetch(BREVO_ENDPOINT, {
      method: 'POST',
      headers: { 'api-key': brevoKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      logger.error(`Brevo contract email send failed: ${res.status}`, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    logger.error('Brevo contract email send threw', err);
    return false;
  }
}

function firstName(fullName: string): string {
  return (fullName || '').split(' ')[0] || 'there';
}

function shell(inner: string): string {
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 22px; color: #1a1814; line-height: 1.55;">
      ${inner}
      <p style="font-size: 13px; color: #6b6359; margin: 24px 0 0; padding-top: 16px; border-top: 1px solid #e6ddd0;">Cody Smith, Cody A Smith LLC &middot; codyasmith.com</p>
    </div>
  `;
}

function personalNoteBlock(note: string | null | undefined): string {
  if (!note) return '';
  const safeBody = escapeHtml(note).replace(/\n/g, '<br/>');
  return `
    <div style="margin: 0 0 24px; padding: 0 0 20px; border-bottom: 1px solid #e6ddd0; color: #1a1814; font-size: 15px; line-height: 1.6;">
      ${safeBody}
    </div>
  `;
}

// 5.3 Contract issued (admin sent invite). One per signer.
export async function sendContractIssuedEmail(args: {
  signer: AgreementSigner;
  agreement: ClientAgreement;
  agreementUrl: string;
}): Promise<boolean> {
  const fn = firstName(args.signer.name_snapshot);
  const inner = `
    <h2 style="font-size: 22px; margin: 0 0 16px;">Your contract from Cody A Smith LLC is ready to sign</h2>
    ${personalNoteBlock(args.agreement.personal_note)}
    <p style="font-size: 15px; color: #4a4239; margin: 0 0 16px;">Hey ${escapeHtml(fn)}, the standard client services agreement is ready for your signature in the portal. Schedule A reflects what we discussed on the call.</p>
    <p style="font-size: 15px; color: #4a4239; margin: 0 0 20px;">Read it through, complete any remaining intake fields, check the two consent boxes, and type your name to sign. The other signer signs independently. When you are both in, the contract is fully executed and a copy lands in your documents area.</p>
    <p style="margin: 24px 0;">
      <a href="${escapeHtml(args.agreementUrl)}" style="display: inline-block; background: #1a1814; color: #faf7f2; padding: 12px 22px; text-decoration: none; font-size: 15px;">Review and sign</a>
    </p>
    <p style="font-size: 14px; color: #6b6359; margin: 16px 0 0;">Questions before signing? Reply to this email or text Cody.</p>
  `;
  return sendBrevo({
    to: [{ email: args.signer.email_snapshot, name: args.signer.name_snapshot }],
    subject: `Your contract from Cody A Smith LLC is ready to sign`,
    html: shell(inner),
  });
}

// 5.4 First signer signed. Sent to other signers.
export async function sendCountersignNeededEmail(args: {
  signedBy: AgreementSigner;
  otherSigner: AgreementSigner;
  agreement: ClientAgreement;
  agreementUrl: string;
  signedAt: string;
}): Promise<boolean> {
  const fn = firstName(args.signedBy.name_snapshot);
  const otherFn = firstName(args.otherSigner.name_snapshot);
  const inner = `
    <h2 style="font-size: 22px; margin: 0 0 16px;">${escapeHtml(fn)} signed your contract. Your turn.</h2>
    <p style="font-size: 15px; color: #4a4239; margin: 0 0 16px;">Hey ${escapeHtml(otherFn)}, ${escapeHtml(fn)} just signed the standard client services agreement on ${escapeHtml(args.signedAt)}. Schedule A and the audit trail are locked at the version they signed.</p>
    <p style="font-size: 15px; color: #4a4239; margin: 0 0 20px;">Review and countersign in the portal to fully execute. If you want to discuss anything before signing, reply to this email or text Cody.</p>
    <p style="margin: 24px 0;">
      <a href="${escapeHtml(args.agreementUrl)}" style="display: inline-block; background: #1a1814; color: #faf7f2; padding: 12px 22px; text-decoration: none; font-size: 15px;">Review and sign</a>
    </p>
  `;
  return sendBrevo({
    to: [{ email: args.otherSigner.email_snapshot, name: args.otherSigner.name_snapshot }],
    subject: `${fn} signed your contract. Your turn.`,
    html: shell(inner),
  });
}

// 5.5 Fully executed. Sent to both signers, optionally with PDF.
export async function sendFullyExecutedEmail(args: {
  recipient: AgreementSigner;
  agreement: ClientAgreement;
  agreementUrl: string;
  documentsUrl: string;
  finalizedAt: string;
  pdfBase64?: string;
  pdfFilename?: string;
  cc?: Array<{ email: string; name?: string }>;
}): Promise<boolean> {
  const fn = firstName(args.recipient.name_snapshot);
  // Only promise an attachment when one is actually present. If PDF
  // generation/upload failed, the copy points to the portal instead, so the
  // email never claims an attachment that isn't there.
  const hasPdf = !!(args.pdfBase64 && args.pdfFilename);
  const copyLine = hasPdf
    ? 'Your fully executed copy is attached, and the same copy is permanently available in your portal documents area.'
    : 'Your fully executed copy is available in your portal documents area.';
  const inner = `
    <h2 style="font-size: 22px; margin: 0 0 16px;">Contract executed</h2>
    <p style="font-size: 15px; color: #4a4239; margin: 0 0 16px;">Hey ${escapeHtml(fn)}, both signatures are in. ${copyLine}</p>
    <p style="font-size: 15px; color: #4a4239; margin: 0 0 20px;">Cody will be in touch about kickoff and first-invoice timing.</p>
    <p style="margin: 24px 0;">
      <a href="${escapeHtml(args.documentsUrl)}" style="display: inline-block; background: #1a1814; color: #faf7f2; padding: 12px 22px; text-decoration: none; font-size: 15px;">Open documents area</a>
    </p>
    <p style="font-size: 13px; color: #6b6359; margin: 16px 0 0;">Executed ${escapeHtml(args.finalizedAt)}.</p>
  `;
  const attachments: BrevoAttachment[] = [];
  if (hasPdf) {
    attachments.push({ name: args.pdfFilename!, content: args.pdfBase64! });
  }
  return sendBrevo({
    to: [{ email: args.recipient.email_snapshot, name: args.recipient.name_snapshot }],
    cc: args.cc,
    subject: hasPdf ? `Contract executed. Your copy is attached.` : `Contract executed`,
    html: shell(inner),
    attachments: attachments.length > 0 ? attachments : undefined,
  });
}

// 5.5b At-signing invoice. Sent to each signer right after execution, with
// the invoice PDF attached. Closes the last manual step: the client no
// longer has to discover the invoice in the portal. Value-first copy.
export async function sendAtSigningInvoiceEmail(args: {
  recipient: AgreementSigner;
  agreement: ClientAgreement;
  invoiceNumber: string;
  amountDue: number;
  invoicesUrl: string;
  pdfBase64?: string;
  pdfFilename?: string;
  cc?: Array<{ email: string; name?: string }>;
}): Promise<boolean> {
  const fn = firstName(args.recipient.name_snapshot);
  const amount = '$' + args.amountDue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const hasPdf = !!(args.pdfBase64 && args.pdfFilename);
  const inner = `
    <h2 style="font-size: 22px; margin: 0 0 16px;">You are all set. Here is your invoice to get started.</h2>
    <p style="font-size: 15px; color: #4a4239; margin: 0 0 16px;">Hey ${escapeHtml(fn)}, the agreement is fully executed and I am ready to begin. Here is the invoice that kicks things off: <strong>${escapeHtml(amount)}</strong> (invoice ${escapeHtml(args.invoiceNumber)}). It covers your one-time setup and your first month. The day it clears, I start.</p>
    <p style="font-size: 15px; color: #4a4239; margin: 0 0 20px;">${hasPdf ? 'It is attached here and waiting in your portal.' : 'It is waiting in your portal.'}</p>
    <p style="margin: 24px 0;">
      <a href="${escapeHtml(args.invoicesUrl)}" style="display: inline-block; background: #1a1814; color: #faf7f2; padding: 12px 22px; text-decoration: none; font-size: 15px;">View your invoice</a>
    </p>
    <p style="font-size: 15px; color: #4a4239; margin: 16px 0 0;">Reach me any time if you have a question about it.</p>
  `;
  const attachments: BrevoAttachment[] = [];
  if (hasPdf) attachments.push({ name: args.pdfFilename!, content: args.pdfBase64! });
  return sendBrevo({
    to: [{ email: args.recipient.email_snapshot, name: args.recipient.name_snapshot }],
    cc: args.cc,
    subject: `Your invoice to get started: ${args.agreement.title}`,
    html: shell(inner),
    attachments: attachments.length > 0 ? attachments : undefined,
  });
}

// 5.6 Signer revoked. Sent to other signers.
export async function sendSignerRevokedEmail(args: {
  revokedBy: AgreementSigner;
  otherSigner: AgreementSigner;
  agreement: ClientAgreement;
  agreementUrl: string;
}): Promise<boolean> {
  const fn = firstName(args.revokedBy.name_snapshot);
  const otherFn = firstName(args.otherSigner.name_snapshot);
  const inner = `
    <h2 style="font-size: 22px; margin: 0 0 16px;">${escapeHtml(fn)} revoked their signature on the contract</h2>
    <p style="font-size: 15px; color: #4a4239; margin: 0 0 16px;">Hey ${escapeHtml(otherFn)}, ${escapeHtml(fn)} just revoked their signature on the standard client services agreement. They likely want to re-review or change something.</p>
    <p style="font-size: 15px; color: #4a4239; margin: 0 0 20px;">Your signature stays in place; nothing to do unless you want to take yours back too or re-discuss the terms with Cody.</p>
    <p style="margin: 24px 0;">
      <a href="${escapeHtml(args.agreementUrl)}" style="display: inline-block; background: #1a1814; color: #faf7f2; padding: 12px 22px; text-decoration: none; font-size: 15px;">Review the contract</a>
    </p>
  `;
  return sendBrevo({
    to: [{ email: args.otherSigner.email_snapshot, name: args.otherSigner.name_snapshot }],
    subject: `${fn} revoked their signature on the contract`,
    html: shell(inner),
  });
}

// 5.7 Schedule A changed after signing. Sent to a signer whose signature
// is now against an outdated hash.
export async function sendScheduleChangedEmail(args: {
  recipient: AgreementSigner;
  agreement: ClientAgreement;
  agreementUrl: string;
  changeSummary?: string;
}): Promise<boolean> {
  const fn = firstName(args.recipient.name_snapshot);
  const change = args.changeSummary ? `<p style="font-size: 14px; color: #4a4239; margin: 0 0 16px; padding: 12px 14px; background: #f0ead9; border-radius: 4px;"><strong>What changed:</strong> ${escapeHtml(args.changeSummary)}</p>` : '';
  const inner = `
    <h2 style="font-size: 22px; margin: 0 0 16px;">Schedule A changed on a contract you signed. Review needed.</h2>
    <p style="font-size: 15px; color: #4a4239; margin: 0 0 16px;">Hey ${escapeHtml(fn)}, Cody edited Schedule A on the standard client services agreement after you signed it. Your signature is paused until you confirm the updated version.</p>
    ${change}
    <p style="font-size: 15px; color: #4a4239; margin: 0 0 20px;">Open the contract to review the change and re-sign if you agree. If you do not agree, reply to this email or text Cody.</p>
    <p style="margin: 24px 0;">
      <a href="${escapeHtml(args.agreementUrl)}" style="display: inline-block; background: #1a1814; color: #faf7f2; padding: 12px 22px; text-decoration: none; font-size: 15px;">Review and re-sign</a>
    </p>
  `;
  return sendBrevo({
    to: [{ email: args.recipient.email_snapshot, name: args.recipient.name_snapshot }],
    subject: `Schedule A changed on a contract you signed. Review needed.`,
    html: shell(inner),
  });
}
