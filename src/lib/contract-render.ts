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
  parts.push('<h2 id="schedule-a">Schedule A &mdash; Engagement Specifics</h2>');
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

  if (pp.web_management && scheduleA.web_management) {
    const wm = scheduleA.web_management;
    parts.push(`<h3>A.4 Web Management specifics</h3>`);
    parts.push('<ul>');
    parts.push(`<li>Tier: <strong>${escapeHtml(wm.tier_name || '')}</strong></li>`);
    if (Array.isArray(wm.sites) && wm.sites.length > 0) {
      parts.push(`<li>Sites managed:<ul>`);
      for (const s of wm.sites) {
        const desc = s.description ? ` &mdash; ${escapeHtml(s.description)}` : '';
        parts.push(`<li>${escapeHtml(s.domain || s.name || '')}${desc}</li>`);
      }
      parts.push(`</ul></li>`);
    }
    if (wm.site_count) parts.push(`<li>Per-site count: ${wm.site_count}</li>`);
    if (wm.monthly_base) parts.push(`<li>Monthly fee (single-site base): ${fmtMoney(wm.monthly_base)}</li>`);
    if (wm.monthly_total) parts.push(`<li>Monthly fee total (with multi-site formula): ${fmtMoney(wm.monthly_total)}</li>`);
    if (wm.included_hours) parts.push(`<li>Included hours per month (total across sites): ${wm.included_hours}</li>`);
    parts.push(`<li>Pre-approved overage buffer (per section 5.4): 2 hours per month</li>`);
    if (wm.onboarding_fee) parts.push(`<li>Onboarding fee: ${fmtMoney(wm.onboarding_fee)}</li>`);
    if (wm.update_cadence) parts.push(`<li>Update cadence: ${escapeHtml(wm.update_cadence)}</li>`);
    if (wm.response_time) parts.push(`<li>Response time: ${escapeHtml(wm.response_time)}</li>`);
    if (wm.quarterly_training_sessions != null) parts.push(`<li>Quarterly staff training: ${wm.quarterly_training_sessions ? `${wm.quarterly_training_sessions} sessions` : 'not included'}</li>`);
    parts.push('</ul>');
  }

  if (pp.marketing_consulting && scheduleA.marketing_consulting) {
    const mc = scheduleA.marketing_consulting;
    parts.push(`<h3>A.5 Marketing Consulting specifics</h3>`);
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

  parts.push(`<h3>A.6 Hours and rates</h3>`);
  const hr = scheduleA.hours_and_rates || {};
  parts.push('<ul>');
  if (hr.included_hours != null) parts.push(`<li>Web Management included hours per month: ${hr.included_hours}</li>`);
  parts.push(`<li>Pre-approved overage buffer: 2 hours per month</li>`);
  parts.push(`<li>Overage rate beyond buffer (standard): $100/hr</li>`);
  parts.push(`<li>Rush rate (same-day, defined in section 5.5): $150/hr, two-hour minimum</li>`);
  parts.push(`<li>Emergency rate (security, outage, recovery, defined in section 5.5): $200/hr, two-hour minimum</li>`);
  parts.push('</ul>');

  parts.push(`<h3>A.7 Day-one access list</h3>`);
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

  parts.push(`<h3>A.8 Pass-through items at signing</h3>`);
  const passes = scheduleA.pass_through_items;
  if (Array.isArray(passes) && passes.length > 0) {
    parts.push('<ul>');
    for (const p of passes) {
      const note = p.billing_note ? ` (${escapeHtml(p.billing_note)})` : '';
      parts.push(`<li>${escapeHtml(p.name || '')} &mdash; ${fmtMoney(p.annual_cost)}${note}</li>`);
    }
    parts.push('</ul>');
  } else {
    parts.push('<p>None at signing.</p>');
  }

  if (pp.build) {
    parts.push(`<h3>A.9 Build Statement of Work</h3>`);
    parts.push(`<p>A separate, signed Build Statement of Work specifies the scope, deliverables, pages, design, launch criteria, build fee, and payment schedule for any from-scratch build work under this agreement.</p>`);
    if (scheduleA.build_sow_ref) {
      parts.push(`<p><em>${escapeHtml(scheduleA.build_sow_ref)}</em></p>`);
    }
  }

  if (pp.other_sow) {
    parts.push(`<h3>A.10 Other Statement of Work</h3>`);
    parts.push(`<p>A separate, signed Statement of Work specifies the scope, deliverables, fee, and timeline for any non-build execution work under section 3.2 (for example, copy production at scale, campaign setup, social or ad creative, research production).</p>`);
    if (scheduleA.other_sow_ref) {
      parts.push(`<p><em>${escapeHtml(scheduleA.other_sow_ref)}</em></p>`);
    }
  }

  parts.push(`<h3>A.11 Excluded work</h3>`);
  parts.push(`<p>The following are not included in any product purchased under this agreement and require either a change order under section 8, a separate Build Statement of Work, or a separate Statement of Work:</p>`);
  parts.push('<ul>');
  parts.push('<li>Full site redesign, custom theme or plugin development, advanced coding</li>');
  parts.push('<li>Paid media management, campaign management, ad buying, email marketing automation, social media management, photography, video production</li>');
  parts.push('<li>Building large volumes of net-new pages or extensive copywriting projects</li>');
  parts.push('<li>Third-party subscription fees, premium plugins, paid connectors, hosting upgrades beyond agreed scope, domain renewals (handled as pass-through under section 5.6)</li>');
  parts.push('<li>Legal, accessibility, privacy, or regulatory compliance certification (see section 16)</li>');
  parts.push('<li>Guaranteed uptime, rankings, lead volume, or attribution accuracy (see section 11)</li>');
  parts.push('<li>Correction of problems caused by undocumented third-party systems, legacy custom code, or hidden vendor dependencies discovered after work begins</li>');
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
  return `$${Math.round(n).toLocaleString('en-US')}`;
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
