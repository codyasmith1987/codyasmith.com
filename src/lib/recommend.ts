/**
 * Smart service recommendation engine.
 * Routes prospects to the right service based on their scan results.
 */

export interface Recommendation {
  bucket: 'low-visibility' | 'negative' | 'mixed' | 'positive-thin' | 'strong';
  headline: string;
  body: string;
  services: {
    name: string;
    slug: string;
    url: string;
    why: string;
  }[];
  cta_text: string;
  cta_url: string;
  urgency: 'high' | 'medium' | 'low';
}

export function getRecommendation(overallScore: number, mentionCount: number): Recommendation {

  // Low visibility: barely exists online
  if (mentionCount <= 5) {
    return {
      bucket: 'low-visibility',
      headline: 'Your brand is nearly invisible online.',
      body: "The web does not have much to work with yet. With this few mentions, the first job is to make the owned pieces stable, clear, and easier to understand before chasing anything louder.",
      services: [
        {
          name: 'Web Management',
          slug: 'web-management',
          url: '/services/web-management',
          why: 'Get your site stable, fast, monitored, and easier to trust',
        },
        {
          name: 'Implementation',
          slug: 'implementation',
          url: '/services/implementation',
          why: 'Build the pages, integrations, and listings the current footprint is missing',
        },
      ],
      cta_text: 'Build my online presence',
      cta_url: '/contact?interest=web-management&interest=implementation',
      urgency: 'high',
    };
  }

  // Negative sentiment: people are talking, but badly
  if (overallScore < 35) {
    return {
      bucket: 'negative',
      headline: 'Your online reputation needs attention.',
      body: "People are talking about your brand, and the tone is not helping. The first move is a clear read on what is being said, where it is coming from, and what deserves a response, a content change, or no action at all.",
      services: [
        {
          name: 'Strategy Consulting',
          slug: 'marketing-strategy',
          url: '/services/marketing-strategy',
          why: 'Read the reputation pattern and decide what should happen next',
        },
        {
          name: 'Implementation',
          slug: 'implementation',
          url: '/services/implementation',
          why: 'Make scoped updates after the response plan is clear',
        },
      ],
      cta_text: 'Get an outside read',
      cta_url: '/contact?interest=strategy-consulting&interest=implementation',
      urgency: 'high',
    };
  }

  // Mixed sentiment: present but not in control
  if (overallScore < 55) {
    return {
      bucket: 'mixed',
      headline: "You have presence, but you're not controlling the narrative.",
      body: "Your brand shows up online, but the signal is inconsistent. Some mentions are positive, some are not, and there is no clear story. This is a Strategy Consulting problem first: read the pattern before deciding what to change.",
      services: [
        {
          name: 'Strategy Consulting',
          slug: 'marketing-strategy',
          url: '/services/marketing-strategy',
          why: "Read the pattern and name the message, search, or operations gap",
        },
        {
          name: 'Web Management',
          slug: 'web-management',
          url: '/services/web-management',
          why: 'Keep your owned site stable, monitored, and easy to update',
        },
      ],
      cta_text: 'Untangle the signal',
      cta_url: '/contact?interest=strategy-consulting&interest=web-management',
      urgency: 'medium',
    };
  }

  // Positive but thin: good vibes, not enough volume
  if (mentionCount < 10) {
    return {
      bucket: 'positive-thin',
      headline: "Good sentiment. Not enough volume.",
      body: "When your brand appears, the tone is generally positive. There just is not much volume yet. The next move is likely a mix of clearer owned pages, stronger listing coverage, and a strategy read on where attention belongs.",
      services: [
        {
          name: 'Implementation',
          slug: 'implementation',
          url: '/services/implementation',
          why: 'Build missing pages, listings, and integrations after the scope is clear',
        },
        {
          name: 'Strategy Consulting',
          slug: 'marketing-strategy',
          url: '/services/marketing-strategy',
          why: 'Decide where your visibility and positioning need attention next',
        },
      ],
      cta_text: 'Name the next move',
      cta_url: '/contact?interest=implementation&interest=strategy-consulting',
      urgency: 'medium',
    };
  }

  // Strong: in good shape
  return {
    bucket: 'strong',
    headline: "Your brand is in strong shape.",
    body: "You have positive signal across multiple sources. The work now is maintenance, clarity, and internal capacity: keep the site healthy, keep the story accurate, and make sure the team can handle the parts it should own.",
    services: [
      {
        name: 'Training',
        slug: 'training',
        url: '/services/training',
        why: 'Teach your team the workflows it should own internally',
      },
      {
        name: 'Web Management',
        slug: 'web-management',
        url: '/services/web-management',
        why: 'Ongoing monitoring, updates, and maintenance so the owned site stays steady',
      },
    ],
    cta_text: "Let's protect what you've built",
    cta_url: '/contact?interest=training&interest=web-management',
    urgency: 'low',
  };
}
