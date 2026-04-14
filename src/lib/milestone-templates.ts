// Milestone templates seeded at contract provisioning.
//
// When a contract is signed with a known service_type, provisionContract
// seeds a small fixed set of default milestones under the default
// project. The templates are deliberately short (4 rows per service
// type) and deliberately non-configurable — this file is the single
// source of truth. Extending a template is a code change, not a runtime
// config change, so the client-facing language stays under review.
//
// Each row carries two distinct pieces of language:
//   - title / description  → admin-side truth, can be detailed / jargon
//   - client_update_text   → client-side truth, 7th-grade reading level
//
// The client-update copy is written in the "we" voice because the
// narrator renders it verbatim in slice 4 of the dashboard ("what is
// being worked on right now") when the milestone completes.

import type { ServiceType } from './contracts';

export interface MilestoneTemplate {
  title: string;
  description: string;
  client_update_text: string;
  sort_order: number;
  client_visible: boolean;
}

const WEB_MANAGEMENT: MilestoneTemplate[] = [
  {
    title: 'Monthly site health check',
    description: 'Crawl audit, broken-link sweep, image / alt-text check, page-speed sampling, quick-fix log',
    client_update_text: "We checked your site's health this month and flagged anything broken.",
    sort_order: 0,
    client_visible: true,
  },
  {
    title: 'Content & copy review',
    description: 'Audit on-page copy for freshness, CTA integrity, SEO relevance; flag pages for refresh',
    client_update_text: "We reviewed your page content and noted what's getting stale.",
    sort_order: 1,
    client_visible: true,
  },
  {
    title: 'Performance & rankings check',
    description: 'Review GSC + Ubersuggest rankings, compare month-over-month, flag wins and losses',
    client_update_text: "We looked at how your site is ranking and where you're winning or losing.",
    sort_order: 2,
    client_visible: true,
  },
  {
    title: 'Monthly report & recommendations',
    description: 'Summarize month, write plain-language recap, queue next month priorities',
    client_update_text: "Your monthly report is ready — here's what's working and what's next.",
    sort_order: 3,
    client_visible: true,
  },
];

const CONSULTING: MilestoneTemplate[] = [
  {
    title: 'Discovery & scoping',
    description: 'Intake call, goals, constraints, risks, baseline data review, written scope',
    client_update_text: "We're figuring out exactly what you need and writing it down.",
    sort_order: 0,
    client_visible: true,
  },
  {
    title: 'Research & recommendations',
    description: 'Competitive landscape, technical review, draft recommendations, stakeholder review',
    client_update_text: "We're looking at your competition and building a plan.",
    sort_order: 1,
    client_visible: true,
  },
  {
    title: 'Delivery & walkthrough',
    description: 'Finalize deliverables, walk client through outcomes and rationale, confirm acceptance',
    client_update_text: "We're wrapping up and walking you through what we built.",
    sort_order: 2,
    client_visible: true,
  },
  {
    title: 'Follow-up check-in',
    description: '30-day post-delivery review, measure impact, adjust recommendations as needed',
    client_update_text: "We're checking back in to see if everything is working for you.",
    sort_order: 3,
    client_visible: true,
  },
];

const HYBRID: MilestoneTemplate[] = [
  {
    title: 'Discovery & scoping',
    description: 'Initial intake + baseline review; sets expectations for the retainer portion',
    client_update_text: "We're figuring out what you need and setting the plan.",
    sort_order: 0,
    client_visible: true,
  },
  {
    title: 'Monthly site health check',
    description: 'Recurring audit + quick-fix log for the retainer portion of the engagement',
    client_update_text: "We're checking your site's health this month.",
    sort_order: 1,
    client_visible: true,
  },
  {
    title: 'Performance & rankings check',
    description: 'Monthly performance monitoring; feeds the report and next-month priorities',
    client_update_text: "We're watching how your site is performing.",
    sort_order: 2,
    client_visible: true,
  },
  {
    title: 'Monthly report & check-in',
    description: 'Monthly recap + check-in call; covers both retainer and consulting work for the period',
    client_update_text: "Your monthly report is ready and we're checking in.",
    sort_order: 3,
    client_visible: true,
  },
];

const TEMPLATES: Record<ServiceType, MilestoneTemplate[]> = {
  web_management: WEB_MANAGEMENT,
  consulting: CONSULTING,
  hybrid: HYBRID,
};

// Returns a deep clone so callers can't mutate the constants by mistake.
export function getMilestoneTemplateForService(
  serviceType: ServiceType | null | undefined
): MilestoneTemplate[] {
  if (!serviceType) return [];
  const tpl = TEMPLATES[serviceType];
  if (!tpl) return [];
  return tpl.map((m) => ({ ...m }));
}
