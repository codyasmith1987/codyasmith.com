// Funnel-stage confirmation emails: contact and home-quiz.
// Each builder returns { subject, html } so endpoints can plug in
// straight to Brevo (or the shared email.ts helper) without re-deriving
// content from request data.
//
// Voice rules: AP style, no em/en dashes, first-person as Cody,
// no downstream business-outcome claims (no "conversions / revenue / leads"
// language), no dangling tier references, no competitor links.

export type ContactFrame = 'sun' | 'moon' | 'default';
export type ContactInterest =
  | 'web-management'
  | 'marketing-strategy'
  | 'implementation'
  | 'training'
  | 'not-sure';

// Re-export the canonical escapeHtml from src/lib/email-safety.ts so this
// module shares the single-quote escape and null-safe input handling with
// every other email path. See security-audit-2026-05-12 round 3 SEC3-010.
export { escapeHtml } from './email-safety';

function frameFromTheme(theme: string): ContactFrame {
  const first = theme.split('-')[0];
  if (first === 'sun') return 'sun';
  if (first === 'moon') return 'moon';
  return 'default';
}

// Pick the "primary" interest from a list that may contain multiple boxes.
// Form order: web-management, marketing-strategy, implementation, training,
// not-sure. Honor that order and skip 'not-sure' if anything substantive
// was also picked.
function primaryInterest(interests: string[]): ContactInterest {
  const valid: ContactInterest[] = [
    'web-management',
    'marketing-strategy',
    'implementation',
    'training',
    'not-sure',
  ];
  const filtered = interests.filter((i): i is ContactInterest =>
    valid.includes(i as ContactInterest),
  );
  if (filtered.length === 0) return 'not-sure';
  if (filtered.length > 1) {
    const substantive = filtered.find((i) => i !== 'not-sure');
    if (substantive) return substantive;
  }
  return filtered[0];
}

function preCallQuestions(interest: ContactInterest): [string, string] {
  switch (interest) {
    case 'web-management':
      return [
        "What's the URL, and what's the thing on the site that breaks, slows down, or worries you most right now?",
        "What's the one number on the site you'd want to move in the next six months, and what does moving it actually look like to you?",
      ];
    case 'marketing-strategy':
      return [
        "Who's the competitor you can't stop checking on, and what do they do that you don't?",
        "What have you already tried that didn't stick, and what's your honest theory on why?",
      ];
    case 'implementation':
      return [
        "What's the project, and what's actually blocking it from getting built?",
        "Who else has to say yes for this to ship, and what's their version of done?",
      ];
    case 'training':
      return [
        'Who needs to know what, and what would change in their day-to-day if they did?',
        'Is this about teaching them once, or building a habit they keep after?',
      ];
    case 'not-sure':
    default:
      return [
        "Tell me the version you'd tell a friend, not the version you'd put in a board presentation. What's actually going on?",
        "What's the one number on your business you'd want to move in the next six months?",
      ];
  }
}

interface ValuePointer {
  url: string;
  // The HTML inside the value-pointer paragraph, with one anchor.
  html: string;
}

function valuePointer(interest: ContactInterest): ValuePointer {
  const aiPiece = 'https://codyasmith.com/blog/articles/ai-outdated-information-business';
  const listener = 'https://codyasmith.com/listener';
  switch (interest) {
    case 'web-management':
      return {
        url: aiPiece,
        html: `While you're waiting, here's the piece I wrote on <a href="${aiPiece}">why AI shows outdated information about your business</a>. Useful read if web visibility is part of what's worrying you.`,
      };
    case 'marketing-strategy':
      return {
        url: aiPiece,
        html: `While you're waiting, here's the piece I wrote on <a href="${aiPiece}">why AI shows outdated information about your business</a>. Closest thing on the site to how I actually think about strategy work.`,
      };
    case 'implementation':
      return {
        url: listener,
        html: `While you're waiting, try the <a href="${listener}">Listener</a>. Plug in your business name or URL and see how the web is talking about you. Two minutes. Useful to look at before we get into what to build.`,
      };
    case 'training':
      return {
        url: aiPiece,
        html: `While you're waiting, here's the piece I wrote on <a href="${aiPiece}">why AI shows outdated information about your business</a>. The kind of thing teams have to keep up with now, and an example of how I think.`,
      };
    case 'not-sure':
    default:
      return {
        url: aiPiece,
        html: `While you're waiting, here's the piece I wrote on <a href="${aiPiece}">why AI shows outdated information about your business</a>. Closest thing on the site to how I actually think about this stuff.`,
      };
  }
}

function contactSubject(frame: ContactFrame): string {
  if (frame === 'sun') return 'Got it. One thing before we build.';
  if (frame === 'moon') return 'Got it. One thing before we get into it.';
  return 'Got it. One thing before we talk.';
}

function contactOpening(frame: ContactFrame): string {
  if (frame === 'sun') {
    return "Message in. I'll reply within one business day with an honest read on what fits, what it would take to actually build, and what the first move looks like.";
  }
  if (frame === 'moon') {
    return "Message in. I'll reply within one business day with an honest read on whether this is mine to fix, what it would take if it is, and where else to look if it isn't.";
  }
  return "Message in. I'll reply within one business day with an honest read on whether what you're after fits what I do, what it would take, and what comes next.";
}

export interface ContactConfirmationInput {
  name: string;
  quizTheme: string;
  interests: string[];
}

export function buildContactConfirmationEmail(
  input: ContactConfirmationInput,
): { subject: string; html: string } {
  const safeName = escapeHtml(input.name);
  const frame = frameFromTheme(input.quizTheme);
  const interest = primaryInterest(input.interests);
  const [q1, q2] = preCallQuestions(interest);
  const pointer = valuePointer(interest);

  const html =
    `<p>Hey ${safeName},</p>\n` +
    `<p>${contactOpening(frame)}</p>\n` +
    `<p>Before we get on a call, two questions I'd ask you anyway. If you have five minutes, send your answers in a reply and I'll have already done the homework by the time we connect:</p>\n` +
    `<ol>\n  <li>${q1}</li>\n  <li>${q2}</li>\n</ol>\n` +
    `<p>${pointer.html}</p>\n` +
    `<p>Cody</p>`;

  return { subject: contactSubject(frame), html };
}

export interface QuizConfirmationInput {
  name: string;
  theme: string;
}

export function buildQuizConfirmationEmail(
  input: QuizConfirmationInput,
): { subject: string; html: string } {
  const safeName = escapeHtml(input.name);
  const listener = 'https://codyasmith.com/listener';
  const aiPiece = 'https://codyasmith.com/blog/articles/ai-outdated-information-business';
  const contact = 'https://codyasmith.com/contact';

  const html =
    `<p>Hey ${safeName},</p>\n` +
    `<p>The site picked up your signal. It'll remember next time you come back, as long as you keep cookies on.</p>\n` +
    `<p>Two things worth your time while you're here:</p>\n` +
    `<ol>\n` +
    `  <li><a href="${listener}">The Listener</a>. Plug in your business name or URL. Two minutes. The free read shows your score, the sentiment breakdown, and the loudest phrases the web is putting on you. Useful even before we talk.</li>\n` +
    `  <li>The piece I wrote on <a href="${aiPiece}">why AI shows outdated information about your business</a>. Closest thing on the site to how I actually think.</li>\n` +
    `</ol>\n` +
    `<p>If you want to talk: <a href="${contact}">codyasmith.com/contact</a>, or just reply to this. Either works.</p>\n` +
    `<p>Cody</p>`;

  return { subject: "The room is set. Here's what's worth your time.", html };
}
