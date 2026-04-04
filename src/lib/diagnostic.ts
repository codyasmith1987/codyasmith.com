/**
 * Dimensional diagnostic for data-sparse scans.
 *
 * When web mentions are sparse (<5), a sentiment score is statistically
 * indefensible (Wilson intervals: ±25+ points at n=10-20). Instead of
 * showing a weak score, diagnose what's present and what's missing.
 *
 * Based on the pertinent negatives concept from clinical medicine:
 * what we looked for and DIDN'T find is itself a diagnostic finding.
 *
 * Current dimensions use only data we already collect (Serper + Trustpilot).
 * Future dimensions (GBP status, website quality) require Google Places API.
 */

import type { TrustpilotBusiness } from './trustpilot';

export type DimensionStatus = 'strong' | 'adequate' | 'needs-attention' | 'critical-gap' | 'not-found';

export interface Dimension {
  name: string;
  status: DimensionStatus;
  detail: string;
  priority: number;  // 1 = address immediately, 2 = build over 3-6 months, 3 = maintain
}

export interface DiagnosticReport {
  mode: 'diagnostic';
  dimensions: Dimension[];
  summary: string;
  address_now: Dimension[];
  build_next: Dimension[];
  maintain: Dimension[];
}

// Color mapping for the frontend
export const STATUS_COLORS: Record<DimensionStatus, string> = {
  'strong': 'emerald',
  'adequate': 'emerald',
  'needs-attention': 'amber',
  'critical-gap': 'red',
  'not-found': 'neutral',
};

export const STATUS_LABELS: Record<DimensionStatus, string> = {
  'strong': 'Strong',
  'adequate': 'Adequate',
  'needs-attention': 'Needs Attention',
  'critical-gap': 'Critical Gap',
  'not-found': 'Not Found',
};

interface DiagnosticInput {
  brand: string;
  domain: string | null;
  mentionCount: number;
  sourceTypes: string[];           // source_type values found (review, forum, news, social, etc.)
  sourceNames: string[];           // source_name values found (Yelp, Reddit, etc.)
  trustpilot: TrustpilotBusiness | null;
  positiveCount: number;
  negativeCount: number;
  neutralCount: number;
}

export function generateDiagnostic(input: DiagnosticInput): DiagnosticReport {
  const dimensions: Dimension[] = [];

  // --- Dimension 1: Web Mention Volume ---
  if (input.mentionCount === 0) {
    dimensions.push({
      name: 'Web Mentions',
      status: 'critical-gap',
      detail: `We searched across review sites, forums, news, and social media and found no mentions of ${input.brand}. Potential customers searching online will find nothing.`,
      priority: 1,
    });
  } else if (input.mentionCount <= 3) {
    dimensions.push({
      name: 'Web Mentions',
      status: 'needs-attention',
      detail: `Only ${input.mentionCount} mention${input.mentionCount !== 1 ? 's' : ''} found across the web. This is well below what customers expect to see when researching a business.`,
      priority: 1,
    });
  } else if (input.mentionCount <= 10) {
    dimensions.push({
      name: 'Web Mentions',
      status: 'adequate',
      detail: `${input.mentionCount} mentions found. Enough for a basic presence, but more coverage would strengthen your visibility.`,
      priority: 2,
    });
  } else {
    dimensions.push({
      name: 'Web Mentions',
      status: 'strong',
      detail: `${input.mentionCount} mentions found across multiple sources. Good coverage.`,
      priority: 3,
    });
  }

  // --- Dimension 2: Review Site Presence ---
  const hasReviewSites = input.sourceTypes.includes('review');
  const reviewSources = input.sourceNames.filter(n =>
    ['Yelp', 'BBB', 'Trustpilot', 'Google', 'TripAdvisor', 'Glassdoor', 'Angi', 'Thumbtack'].includes(n)
  );

  if (!hasReviewSites && !input.trustpilot) {
    dimensions.push({
      name: 'Review Sites',
      status: 'critical-gap',
      detail: `${input.brand} doesn't appear on any major review platform we checked (Yelp, BBB, Trustpilot, Google). 59% of consumers expect 20-99 reviews before trusting a business.`,
      priority: 1,
    });
  } else if (reviewSources.length <= 1) {
    const where = reviewSources[0] || (input.trustpilot ? 'Trustpilot' : 'one platform');
    dimensions.push({
      name: 'Review Sites',
      status: 'needs-attention',
      detail: `Found on ${where} only. Businesses on 4+ review sites earn 58% more revenue (Womply, 200K businesses). Claim and build profiles on Yelp, BBB, and Google at minimum.`,
      priority: 1,
    });
  } else {
    dimensions.push({
      name: 'Review Sites',
      status: 'adequate',
      detail: `Present on ${reviewSources.length} review platforms: ${reviewSources.join(', ')}. Good distribution.`,
      priority: 2,
    });
  }

  // --- Dimension 3: Trustpilot Presence ---
  if (input.trustpilot) {
    const tp = input.trustpilot;
    if (tp.numberOfReviews === 0) {
      dimensions.push({
        name: 'Trustpilot',
        status: 'needs-attention',
        detail: `Listed on Trustpilot but with 0 reviews. The profile exists — now it needs activity.`,
        priority: 2,
      });
    } else if (tp.trustScore >= 4.0) {
      dimensions.push({
        name: 'Trustpilot',
        status: 'strong',
        detail: `${tp.trustScore.toFixed(1)}/5 trust score with ${tp.numberOfReviews} reviews. Strong.`,
        priority: 3,
      });
    } else if (tp.trustScore >= 3.0) {
      dimensions.push({
        name: 'Trustpilot',
        status: 'adequate',
        detail: `${tp.trustScore.toFixed(1)}/5 trust score with ${tp.numberOfReviews} reviews. Room to improve.`,
        priority: 2,
      });
    } else {
      dimensions.push({
        name: 'Trustpilot',
        status: 'needs-attention',
        detail: `${tp.trustScore.toFixed(1)}/5 trust score with ${tp.numberOfReviews} reviews. This rating is visible to anyone who searches for ${input.brand} on Trustpilot.`,
        priority: 1,
      });
    }
  } else if (input.domain) {
    dimensions.push({
      name: 'Trustpilot',
      status: 'not-found',
      detail: `No Trustpilot listing found for ${input.domain}. Trustpilot is a growing trust signal, especially for businesses with a web presence.`,
      priority: 2,
    });
  }

  // --- Dimension 4: Source Diversity ---
  const uniqueSourceTypes = new Set(input.sourceTypes);
  if (uniqueSourceTypes.size === 0) {
    dimensions.push({
      name: 'Source Diversity',
      status: 'critical-gap',
      detail: `No presence across any source type — review sites, forums, news, or social media. Your brand has no digital footprint for customers to discover.`,
      priority: 1,
    });
  } else if (uniqueSourceTypes.size === 1) {
    dimensions.push({
      name: 'Source Diversity',
      status: 'needs-attention',
      detail: `Mentions found only in ${[...uniqueSourceTypes][0]} sources. A healthy brand presence spans reviews, forums, news, and social media.`,
      priority: 2,
    });
  } else if (uniqueSourceTypes.size <= 3) {
    dimensions.push({
      name: 'Source Diversity',
      status: 'adequate',
      detail: `Present across ${uniqueSourceTypes.size} source types: ${[...uniqueSourceTypes].join(', ')}. Decent coverage with room to expand.`,
      priority: 2,
    });
  } else {
    dimensions.push({
      name: 'Source Diversity',
      status: 'strong',
      detail: `Present across ${uniqueSourceTypes.size} source types: ${[...uniqueSourceTypes].join(', ')}. Well-distributed presence.`,
      priority: 3,
    });
  }

  // --- Dimension 5: Sentiment Signal (only if we have enough data) ---
  const totalClassified = input.positiveCount + input.negativeCount + input.neutralCount;
  if (totalClassified >= 3) {
    const negRatio = input.negativeCount / totalClassified;
    if (negRatio > 0.5) {
      dimensions.push({
        name: 'Sentiment Signal',
        status: 'needs-attention',
        detail: `${input.negativeCount} of ${totalClassified} mentions have negative sentiment. This is a preliminary signal — not enough data for a definitive assessment, but worth watching.`,
        priority: 1,
      });
    } else if (negRatio > 0.25) {
      dimensions.push({
        name: 'Sentiment Signal',
        status: 'adequate',
        detail: `Mixed sentiment: ${input.positiveCount} positive, ${input.negativeCount} negative, ${input.neutralCount} neutral. Directional only — more data needed for a reliable picture.`,
        priority: 2,
      });
    } else {
      dimensions.push({
        name: 'Sentiment Signal',
        status: 'strong',
        detail: `${input.positiveCount} of ${totalClassified} mentions are positive. Limited data, but the signal is encouraging.`,
        priority: 3,
      });
    }
  } else if (totalClassified > 0) {
    dimensions.push({
      name: 'Sentiment Signal',
      status: 'not-found',
      detail: `Only ${totalClassified} mention${totalClassified !== 1 ? 's' : ''} — not enough to assess sentiment reliably. This is a data gap, not a finding.`,
      priority: 2,
    });
  }

  // --- Dimension 6: Website (basic check via domain) ---
  if (!input.domain) {
    dimensions.push({
      name: 'Website',
      status: 'not-found',
      detail: `No website domain detected. If ${input.brand} has a website, try scanning with the URL instead of the brand name.`,
      priority: 1,
    });
  }
  // Note: actual website quality check requires PageSpeed API (future)

  // Sort by priority (address now first)
  dimensions.sort((a, b) => a.priority - b.priority);

  // Categorize
  const address_now = dimensions.filter(d => d.priority === 1);
  const build_next = dimensions.filter(d => d.priority === 2);
  const maintain = dimensions.filter(d => d.priority === 3);

  // Summary
  const criticalCount = dimensions.filter(d => d.status === 'critical-gap').length;
  const needsAttentionCount = dimensions.filter(d => d.status === 'needs-attention').length;
  const strongCount = dimensions.filter(d => d.status === 'strong' || d.status === 'adequate').length;

  let summary: string;
  if (criticalCount >= 2) {
    summary = `${input.brand} has significant gaps in its digital presence. We checked ${dimensions.length} dimensions of your online visibility and found ${criticalCount} critical gaps that need immediate attention. The good news: every gap has a clear path to fix.`;
  } else if (criticalCount === 1 || needsAttentionCount >= 2) {
    summary = `${input.brand} has some presence online but there are clear opportunities to strengthen it. ${needsAttentionCount + criticalCount} area${(needsAttentionCount + criticalCount) !== 1 ? 's' : ''} need attention.`;
  } else if (strongCount >= dimensions.length - 1) {
    summary = `${input.brand}'s digital presence looks solid across the dimensions we checked. A few areas could be strengthened, but the foundation is there.`;
  } else {
    summary = `${input.brand} has a mixed digital presence. Some dimensions are healthy, others need work. Here's the breakdown.`;
  }

  return {
    mode: 'diagnostic',
    dimensions,
    summary,
    address_now,
    build_next,
    maintain,
  };
}
