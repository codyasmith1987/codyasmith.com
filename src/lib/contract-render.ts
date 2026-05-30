// Contract template renderer.
//
// Single chokepoint for turning a template's markdown source plus
// Schedule A data plus client metadata into a rendered output. The
// mode parameter is the no-internal-exposure boundary: in 'client',
// 'preview' modes, internal-only blocks are stripped, version
// markers do not surface, admin paths in any rendered href are
// scrubbed. In 'admin-source' mode internal blocks are preserved
// for Cody's reference; admin-rendered keeps them stripped but with
// an annotation that they exist.
//
// Placeholder syntax is minimal Mustache-ish: {{ key.sub.path }}
// resolves against the data context. Conditional blocks use
// {{#if path}}...{{/if}}; nothing else is supported.

import { marked } from 'marked';
import { createHash } from 'node:crypto';

export type RenderMode = 'client' | 'preview' | 'admin-source' | 'admin-rendered';

export interface RenderContext {
  client: {
    legal_entity_name: string;
    entity_type: string;
    state_of_organization: string;
    primary_contact_name?: string;
    primary_contact_title?: string;
    primary_contact_email?: string;
    primary_contact_phone?: string;
    principal_address?: string;
    notice_address?: string;
  };
  schedule_a: any; // Resolved by buildScheduleA(); see contract-schedule.ts
  practice: PracticeInfo;
  today: string;
}

export interface PracticeInfo {
  legal_name: string;
  entity_type: string;
  state: string;
  address: string;
  signer_name: string;
  signer_title: string;
  email: string;
  phone: string;
  domain: string;
}

export const PRACTICE: PracticeInfo = {
  legal_name: 'Cody A Smith LLC',
  entity_type: 'Utah limited liability company',
  state: 'Utah',
  address: '604 Morningside Circle, Cedar City, UT 84720',
  signer_name: 'Cody Alan Smith',
  signer_title: 'Member',
  email: 'cody@codyasmith.com',
  phone: '435-868-7133',
  domain: 'codyasmith.com',
};

const INTERNAL_BLOCK_RE = /<!--\s*internal:start\s*-->[\s\S]*?<!--\s*internal:end\s*-->/g;
const PLACEHOLDER_RE = /\{\{\s*([\w.]+)\s*\}\}/g;
const IF_BLOCK_RE = /\{\{#if\s+([\w.]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g;
const PENDING_FIELD_HTML = '<span class="metadata-pending">[to be completed at signing]</span>';

/**
 * Render the contract body. Strip internal blocks per mode, resolve
 * placeholders against the context, run markdown to HTML, and produce
 * a final HTML string. The output is the rendered body of sections
 * 1-25 only; Schedule A is rendered separately and concatenated by
 * the caller.
 */
export function renderTemplate(body: string, ctx: RenderContext, mode: RenderMode): string {
  let text = body;

  // Internal-only blocks: stripped in every mode except admin-source.
  if (mode !== 'admin-source') {
    text = text.replace(INTERNAL_BLOCK_RE, '');
  }

  // Resolve conditional blocks first so nested placeholders inside an
  // omitted block do not leave stray pending markers.
  text = text.replace(IF_BLOCK_RE, (_match, path, inner) => {
    const value = resolvePath(ctx, path);
    return isTruthy(value) ? inner : '';
  });

  // Resolve remaining placeholders.
  text = text.replace(PLACEHOLDER_RE, (_match, path) => {
    const value = resolvePath(ctx, path);
    if (value === null || value === undefined || value === '') {
      return PENDING_FIELD_HTML;
    }
    return escapeHtml(String(value));
  });

  // Markdown to HTML. GFM enables tables, which Section 3.2 requires.
  const html = marked.parse(text, { async: false, gfm: true, breaks: false }) as string;

  // Defense in depth: in client/preview mode, scrub any admin link that
  // may have slipped in through schedule_a or future template edits.
  if (mode === 'client' || mode === 'preview') {
    return scrubInternalLinks(html);
  }
  return html;
}

/**
 * Resolve a template body to MARKDOWN (not HTML), for the PDF path.
 *
 * The PDF generator runs its own markdown subset renderer, so it needs
 * resolved markdown, not HTML. This applies the same client-facing
 * boundary as renderTemplate in 'client' mode: internal-only blocks are
 * stripped and conditional blocks resolved. Placeholders resolve to PLAIN
 * text (no HTML entity escaping), because the value flows into a markdown
 * renderer, not an HTML document. A missing field renders as a plain
 * pending marker rather than an HTML span.
 *
 * This is the fix for the executed-PDF leak: feeding the PDF the raw
 * template body left literal {{ client.* }} placeholders and the internal
 * reserved-coverage note in the legally retained document.
 */
export function renderTemplateToMarkdown(body: string, ctx: RenderContext): string {
  let text = body;

  // Internal-only blocks never reach a client-facing PDF.
  text = text.replace(INTERNAL_BLOCK_RE, '');

  // Conditional blocks first, so placeholders inside an omitted block do
  // not leave stray pending markers.
  text = text.replace(IF_BLOCK_RE, (_match, path, inner) => {
    const value = resolvePath(ctx, path);
    return isTruthy(value) ? inner : '';
  });

  // Remaining placeholders, resolved to plain text for the markdown renderer.
  text = text.replace(PLACEHOLDER_RE, (_match, path) => {
    const value = resolvePath(ctx, path);
    if (value === null || value === undefined || value === '') {
      return '[to be completed at signing]';
    }
    return String(value);
  });

  return text;
}

function scrubInternalLinks(html: string): string {
  // Strip href targets that point at admin or API surfaces.
  return html
    .replace(/href=["'](\/portal\/admin\/[^"']*)["']/g, 'href="#"')
    .replace(/href=["'](\/portal\/api\/[^"']*)["']/g, 'href="#"')
    .replace(/href=["'](\/admin\/[^"']*)["']/g, 'href="#"');
}

function resolvePath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cursor: any = obj;
  for (const p of parts) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = cursor[p];
  }
  return cursor;
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (value === false || value === 0) return false;
  if (typeof value === 'string' && value.length === 0) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  if (typeof value === 'object' && value !== null && Object.keys(value).length === 0) return false;
  return true;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render Schedule A as HTML from a schedule_a JSON object. Conditional
 * sections (web_management, marketing_consulting, build, other_sow)
 * are included only when their products_purchased flag is true. The
 * output is a single HTML fragment suitable for concatenation after
 * the contract body.
 */
export function renderScheduleA(scheduleA: any, mode: RenderMode): string {
  if (!scheduleA) return '<section class="schedule-a"><p>Schedule A pending.</p></section>';

  const parts: string[] = [];
  parts.push('<section class="schedule-a">');
  parts.push('<h2 id="schedule-a">Schedule A: Engagement Specifics</h2>');
  parts.push('<p class="schedule-a-intro">Schedule A is completed per Client and incorporated into the agreement by reference.</p>');

  parts.push(`<h3>A.1 Effective Date</h3>`);
  parts.push(`<p>${fmtField(scheduleA.effective_date)}</p>`);

  parts.push(`<h3>A.2 Designated contacts and notice addresses</h3>`);
  parts.push(`<p><strong>Practice:</strong> ${escapeHtml(PRACTICE.signer_name)}, ${escapeHtml(PRACTICE.signer_title)}, ${escapeHtml(PRACTICE.legal_name)}, ${escapeHtml(PRACTICE.address)}. <a href="mailto:${escapeHtml(PRACTICE.email)}">${escapeHtml(PRACTICE.email)}</a>. ${escapeHtml(PRACTICE.phone)}.</p>`);
  const client = scheduleA.designated_contacts?.client || {};
  parts.push(`<p><strong>Client:</strong> ${fmtField(client.name)}, ${fmtField(client.title)}, ${fmtField(client.address)}, ${fmtField(client.email)}, ${fmtField(client.phone)}.</p>`);

  parts.push(`<h3>A.3 Products purchased</h3>`);
  const pp = scheduleA.products_purchased || {};
  parts.push('<ul>');
  parts.push(`<li>Web Management: <strong>${pp.web_management ? 'Yes' : 'No'}</strong></li>`);
  parts.push(`<li>Marketing Consulting: <strong>${pp.marketing_consulting ? 'Yes' : 'No'}</strong></li>`);
  parts.push(`<li>Build work: <strong>${pp.build ? 'Yes (separate Build Statement of Work)' : 'No'}</strong></li>`);
  parts.push(`<li>Other Statement of Work: <strong>${pp.other_sow ? 'Yes (separate Statement of Work attached)' : 'No'}</strong></li>`);
  parts.push('</ul>');

  // A.4 Amount due at signing. Per section 5.2 this itemizes the one-time
  // fees plus the first month of every recurring fee; the total equals the
  // pricing result's atSigning, the same number the buyer saw on the
  // proposal. Must clear before work begins.
  parts.push(`<h3>A.4 Amount due at signing</h3>`);
  const ads = scheduleA.amount_due_at_signing;
  if (ads && Array.isArray(ads.line_items) && ads.line_items.length > 0) {
    parts.push(`<table class="at-signing-table" style="margin-top:0.5em; border-collapse:collapse; width:100%; font-size:0.95em">`);
    parts.push(`<tbody>`);
    for (const li of ads.line_items) {
      parts.push(`<tr><td style="padding:4px 8px; border-bottom:1px solid #eee">${escapeHtml(li.label || '')}</td><td style="padding:4px 8px; text-align:right; border-bottom:1px solid #eee">${fmtMoney(li.amount)}</td></tr>`);
    }
    parts.push(`<tr><td style="padding:8px 8px 4px; font-weight:bold; border-top:2px solid #333">Total due at signing</td><td style="padding:8px 8px 4px; text-align:right; font-weight:bold; border-top:2px solid #333">${fmtMoney(ads.total)}</td></tr>`);
    parts.push(`</tbody></table>`);
    if (ads.note) parts.push(`<p class="at-signing-note"><em>${escapeHtml(ads.note)}</em></p>`);
  } else {
    parts.push(`<p>Itemized at intake once products and tiers are confirmed.</p>`);
  }

  if (pp.web_management && scheduleA.web_management) {
    const wm = scheduleA.web_management;
    parts.push(`<h3>A.5 Web Management specifics</h3>`);
    parts.push('<ul>');
    parts.push(`<li>Tier: <strong>${escapeHtml(wm.tier_name || '')}</strong></li>`);
    // Per-site breakdown table. Each site shows its own monthly +
    // onboarding contributions under the locked 2026-05-24 multi-site
    // formula (primary at full base; each additional at 0.80 of its own
    // base). The internal ecosystem routing is NOT shown to the client.
    if (Array.isArray(wm.sites) && wm.sites.length > 0) {
      const hasContributions = wm.sites.some(s => typeof s.monthly_contribution === 'number');
      if (hasContributions && wm.sites.length > 1) {
        parts.push(`<li>Sites managed and per-site breakdown:`);
        parts.push(`<table style="margin-top:0.5em; border-collapse:collapse; width:100%; font-size:0.95em">`);
        parts.push(`<thead><tr><th style="text-align:left; padding:4px 8px; border-bottom:1px solid #ccc">Site</th><th style="text-align:right; padding:4px 8px; border-bottom:1px solid #ccc">Monthly</th><th style="text-align:right; padding:4px 8px; border-bottom:1px solid #ccc">Onboarding</th></tr></thead>`);
        parts.push(`<tbody>`);
        for (const s of wm.sites) {
          const desc = s.is_primary ? ' <em>(primary)</em>' : '';
          parts.push(`<tr>`);
          parts.push(`<td style="padding:4px 8px">${escapeHtml(s.domain || '')}${desc}</td>`);
          parts.push(`<td style="padding:4px 8px; text-align:right">${typeof s.monthly_contribution === 'number' ? fmtMoney(s.monthly_contribution) : ''}</td>`);
          parts.push(`<td style="padding:4px 8px; text-align:right">${typeof s.onboarding_contribution === 'number' ? fmtMoney(s.onboarding_contribution) : ''}</td>`);
          parts.push(`</tr>`);
        }
        parts.push(`</tbody></table></li>`);
      } else {
        parts.push(`<li>Sites managed:<ul>`);
        for (const s of wm.sites) {
          const desc = s.description ? ` (${escapeHtml(s.description)})` : '';
          parts.push(`<li>${escapeHtml(s.domain || '')}${desc}</li>`);
        }
        parts.push(`</ul></li>`);
      }
    }
    if (wm.site_count) parts.push(`<li>Site count: ${wm.site_count}</li>`);
    if (wm.monthly_total) parts.push(`<li>Monthly fee total: <strong>${fmtMoney(wm.monthly_total)}</strong></li>`);
    if (wm.included_hours) parts.push(`<li>Included hours per month (total across sites): ${wm.included_hours}</li>`);
    parts.push(`<li>Pre-approved overage buffer (per section 5.4): 2 hours per month</li>`);
    if (wm.onboarding_total) parts.push(`<li>Onboarding total: <strong>${fmtMoney(wm.onboarding_total)}</strong></li>`);
    else if (wm.onboarding_fee) parts.push(`<li>Onboarding fee: ${fmtMoney(wm.onboarding_fee)}</li>`);
    if (wm.update_cadence) parts.push(`<li>Update cadence: ${escapeHtml(wm.update_cadence)}</li>`);
    if (wm.response_time) parts.push(`<li>Response time: ${escapeHtml(wm.response_time)}</li>`);
    if (wm.quarterly_training_sessions != null) parts.push(`<li>Quarterly staff training: ${wm.quarterly_training_sessions ? `${wm.quarterly_training_sessions} sessions` : 'not included'}</li>`);
    parts.push('</ul>');
    // Per Cody operating rule (2026-05-26): single billing cadence
    // across all sites under one agreement; first invoice prorated
    // from each site's go-live. Render the policy note when present.
    if (wm.billing_cadence_note) {
      parts.push(`<p class="billing-cadence-note"><em>${escapeHtml(wm.billing_cadence_note)}</em></p>`);
    }
  }

  if (pp.marketing_consulting && scheduleA.marketing_consulting) {
    const mc = scheduleA.marketing_consulting;
    parts.push(`<h3>A.6 Marketing Consulting specifics</h3>`);
    parts.push('<ul>');
    parts.push(`<li>Tier: <strong>${escapeHtml(mc.tier_name || '')}</strong></li>`);
    if (mc.monthly_retainer) parts.push(`<li>Monthly retainer: ${fmtMoney(mc.monthly_retainer)}</li>`);
    if (mc.initial_audit_fee) parts.push(`<li>Initial audit fee: ${fmtMoney(mc.initial_audit_fee)}</li>`);
    if (mc.strategy_call_frequency) parts.push(`<li>Strategy call frequency: ${escapeHtml(mc.strategy_call_frequency)}</li>`);
    if (mc.deep_advisories_per_cycle) parts.push(`<li>Deep advisories per cycle: ${escapeHtml(mc.deep_advisories_per_cycle)}</li>`);
    if (mc.performance_reporting_cadence) parts.push(`<li>Performance reporting cadence: ${escapeHtml(mc.performance_reporting_cadence)}</li>`);
    parts.push(`<li>Hiring guidance: ${mc.hiring_guidance ? 'included' : 'not included'}</li>`);
    parts.push('</ul>');
  }

  parts.push(`<h3>A.7 Hours and rates</h3>`);
  const hr = scheduleA.hours_and_rates || {};
  const anchorDayValue = typeof hr.billing_anchor_day === 'number' && hr.billing_anchor_day >= 1 && hr.billing_anchor_day <= 31
    ? hr.billing_anchor_day
    : 1;
  const anchorOrdinal = (() => {
    const n = anchorDayValue;
    const teen = n >= 11 && n <= 13;
    const suffix = teen ? 'th' : (n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th');
    return `${n}${suffix}`;
  })();
  parts.push('<ul>');
  if (hr.included_hours != null) parts.push(`<li>Web Management included hours per month: ${hr.included_hours}</li>`);
  parts.push(`<li>Pre-approved overage buffer: 2 hours per month</li>`);
  parts.push(`<li>Overage rate beyond buffer (standard): $100/hr</li>`);
  parts.push(`<li>Rush rate (same-day, defined in section 5.5): $150/hr, two-hour minimum</li>`);
  parts.push(`<li>Emergency rate (security, outage, recovery, defined in section 5.5): $200/hr, two-hour minimum</li>`);
  parts.push(`<li>Monthly billing anchor day (per section 5.3 proration policy): ${escapeHtml(anchorOrdinal)} of each month</li>`);
  parts.push('</ul>');

  parts.push(`<h3>A.8 Day-one access list</h3>`);
  const day1 = scheduleA.day_one_access || {};
  if (day1.required_by) {
    parts.push(`<p>The Client provides administrator-level access to the following systems, by ${escapeHtml(day1.required_by)}, in the manner stated:</p>`);
  } else {
    parts.push(`<p>The Client provides administrator-level access to the following systems on the Effective Date:</p>`);
  }
  if (Array.isArray(day1.items) && day1.items.length > 0) {
    parts.push('<ul>');
    for (const it of day1.items) {
      const provider = it.provider ? `: ${escapeHtml(it.provider)}` : '';
      parts.push(`<li>${escapeHtml(it.system || '')}${provider}</li>`);
    }
    parts.push('</ul>');
  } else {
    parts.push('<p><em>To be completed at intake.</em></p>');
  }

  parts.push(`<h3>A.9 Pass-through items</h3>`);
  const passes = scheduleA.pass_through_items;
  if (Array.isArray(passes) && passes.length > 0) {
    parts.push('<ul>');
    for (const p of passes) {
      const note = p.billing_note ? `. ${escapeHtml(p.billing_note)}` : '';
      parts.push(`<li>${escapeHtml(p.name || '')}: ${fmtMoney(p.monthly_cost)}/month${note}</li>`);
    }
    parts.push('</ul>');
  } else {
    parts.push('<p>None.</p>');
  }

  if (pp.build) {
    parts.push(`<h3>A.10 Build Statement of Work</h3>`);
    parts.push(`<p>A separate, signed Build Statement of Work specifies the scope, deliverables, pages, design, launch criteria, build fee, and payment schedule for any from-scratch build work under this agreement.</p>`);
    if (scheduleA.build_sow_ref) {
      parts.push(`<p><em>${escapeHtml(scheduleA.build_sow_ref)}</em></p>`);
    }
  }

  if (pp.other_sow) {
    parts.push(`<h3>A.11 Other Statement of Work</h3>`);
    parts.push(`<p>A separate, signed Statement of Work specifies the scope, deliverables, fee, and timeline for any non-build execution work under section 3.2 (for example, copy production at scale, campaign setup, social or ad creative, research production).</p>`);
    if (scheduleA.other_sow_ref) {
      parts.push(`<p><em>${escapeHtml(scheduleA.other_sow_ref)}</em></p>`);
    }
  }

  parts.push(`<h3>A.12 Excluded work</h3>`);
  parts.push(`<p>The following are not included in any product purchased under this agreement. Anything in this list requires either a written change order under section 8, a separate Build Statement of Work, or a separate Statement of Work under section 3.2:</p>`);
  parts.push('<ul>');
  parts.push('<li><strong>Net-new builds and redesigns.</strong> Full site redesigns, custom theme development, custom plugin development, e-commerce builds, membership system builds, learning-management builds, and any other from-scratch build work.</li>');
  parts.push('<li><strong>Paid media and campaign work.</strong> Paid search management, paid social management, display advertising, retargeting, ad creative production, campaign setup, ad spend management, attribution setup, conversion tracking implementation beyond a one-time install.</li>');
  parts.push('<li><strong>Content production at scale.</strong> Net-new copywriting for more than a handful of pages, long-form content production, blog post writing, white papers, sales collateral, video scripts, photography, video production, podcast production, and any content creation that goes past light page edits.</li>');
  parts.push('<li><strong>Email marketing and automation.</strong> Email platform setup, list management, segmentation, drip campaigns, broadcast email sends, transactional email beyond the Practice\'s own portal needs.</li>');
  parts.push('<li><strong>Social media management.</strong> Posting, community management, response moderation, social-platform paid promotion, influencer coordination.</li>');
  parts.push('<li><strong>Third-party subscriptions and services.</strong> Plugin licenses, premium themes, SaaS subscriptions, paid API connectors, stock asset libraries, premium hosting upgrades beyond the agreed tier, content delivery network upgrades, domain registrations, and SSL certificates outside what is included with hosting. These are handled as pass-through costs under section 5.6.</li>');
  parts.push('<li><strong>Compliance and certification.</strong> Legal review, accessibility certification (WCAG 2.x, ADA), privacy compliance certification (GDPR, CCPA, HIPAA, PCI-DSS), regulatory filings, or any formal compliance audit. See section 16.</li>');
  parts.push('<li><strong>Guarantees of business outcomes.</strong> Search rankings, organic traffic levels, lead volume, conversion rate targets, paid-media performance, attribution accuracy, uptime beyond what the hosting provider itself guarantees. See section 11.</li>');
  parts.push('<li><strong>Recovery from third-party causes.</strong> Correcting damage caused by other vendors, prior contractors, the Client\'s own staff, or undocumented systems and dependencies discovered after work begins. The Practice will scope and quote this work as billable if the Client wants help.</li>');
  parts.push('<li><strong>Hardware, equipment, and physical work.</strong> On-site server work, networking hardware, peripherals, in-person training travel.</li>');
  parts.push('<li><strong>Translation and localization.</strong> Multi-language content, internationalization beyond what the existing site provides, regional compliance variants.</li>');
  parts.push('<li><strong>SEO link building and outreach.</strong> Manual link acquisition campaigns, guest post outreach, digital PR campaigns. Strategy and recommendations are part of Marketing Consulting; execution is not.</li>');
  parts.push('<li><strong>Custom integrations.</strong> Building or maintaining bespoke integrations between the Client\'s systems and third-party platforms beyond what the Web Management tier supports as standard.</li>');
  parts.push('</ul>');

  parts.push('</section>');
  return parts.join('\n');
}

function fmtField(v: unknown): string {
  if (v === null || v === undefined || v === '') return PENDING_FIELD_HTML;
  return escapeHtml(String(v));
}

function fmtMoney(v: unknown): string {
  if (v === null || v === undefined || v === '') return PENDING_FIELD_HTML;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return PENDING_FIELD_HTML;
  const hasCents = Math.round(n * 100) % 100 !== 0;
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  })}`;
}

/**
 * Compute the deterministic document hash for an agreement. Canonical
 * input is: rendered body HTML (sanitized for client mode) + a separator
 * + the Schedule A JSON with sorted keys + a separator + the
 * client_metadata snapshot with sorted keys.
 *
 * The same render context plus body must always produce the same hash.
 * If hashes differ across two render calls, something non-deterministic
 * has crept in.
 */
export function computeDocumentHash(input: { body_html: string; schedule_a: any; client: any }): string {
  const scheduleStr = stableStringify(input.schedule_a);
  const clientStr = stableStringify(input.client);
  const canonical = `${input.body_html}\n---SCHEDULE_A---\n${scheduleStr}\n---CLIENT---\n${clientStr}`;
  return createHash('sha256').update(canonical).digest('hex');
}

function stableStringify(obj: any): string {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}
