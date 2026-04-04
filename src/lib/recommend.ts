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
      body: "People can't choose you if they can't find you. With this few mentions, potential customers searching for businesses like yours are finding your competitors instead. The fix starts with building a real web presence and getting your name in front of the right people.",
      services: [
        {
          name: 'Web Management',
          slug: 'web-management',
          url: '/services/web-management',
          why: 'Get your site stable, fast, and showing up in search results',
        },
        {
          name: 'Implementation',
          slug: 'implementation',
          url: '/services/implementation',
          why: 'Build the pages, integrations, and listings that create visibility',
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
      body: "People are talking about your brand, and the tone isn't working in your favor. This is fixable — most businesses can shift their online sentiment within 90 days with the right strategy. But the longer negative mentions sit unanswered, the more they compound.",
      services: [
        {
          name: 'Marketing Strategy',
          slug: 'marketing-strategy',
          url: '/services/marketing-strategy',
          why: 'Develop a reputation repair plan with review management and content strategy',
        },
        {
          name: 'Implementation',
          slug: 'implementation',
          url: '/services/implementation',
          why: 'Execute the changes — respond to reviews, update listings, publish content',
        },
      ],
      cta_text: 'Fix my reputation',
      cta_url: '/contact?interest=marketing-strategy&interest=implementation',
      urgency: 'high',
    };
  }

  // Mixed sentiment: present but not in control
  if (overallScore < 55) {
    return {
      bucket: 'mixed',
      headline: "You have presence, but you're not controlling the narrative.",
      body: "Your brand shows up online, but the signal is inconsistent. Some mentions are positive, some aren't, and there's no clear story. A focused strategy can tip the balance — amplify what's working, address what isn't, and make sure the right message shows up first.",
      services: [
        {
          name: 'Marketing Strategy',
          slug: 'marketing-strategy',
          url: '/services/marketing-strategy',
          why: "Build a clear strategy to shape how you show up online",
        },
        {
          name: 'Web Management',
          slug: 'web-management',
          url: '/services/web-management',
          why: 'Keep your owned properties tight — fast site, strong SEO, consistent message',
        },
      ],
      cta_text: 'Take control of my brand',
      cta_url: '/contact?interest=marketing-strategy&interest=web-management',
      urgency: 'medium',
    };
  }

  // Positive but thin: good vibes, not enough volume
  if (mentionCount < 10) {
    return {
      bucket: 'positive-thin',
      headline: "Good sentiment. Not enough volume.",
      body: "When people do find you, they like what they see. The problem is not enough people are finding you. You're leaving money on the table — the foundation is solid, now it's time to amplify. More listings, more content, more places where the right people can discover you.",
      services: [
        {
          name: 'Implementation',
          slug: 'implementation',
          url: '/services/implementation',
          why: 'Build out listings, landing pages, and integrations to increase discoverability',
        },
        {
          name: 'Marketing Strategy',
          slug: 'marketing-strategy',
          url: '/services/marketing-strategy',
          why: 'Plan the content and channels that will multiply your positive signal',
        },
      ],
      cta_text: 'Amplify my brand',
      cta_url: '/contact?interest=implementation&interest=marketing-strategy',
      urgency: 'medium',
    };
  }

  // Strong: in good shape
  return {
    bucket: 'strong',
    headline: "Your brand is in strong shape.",
    body: "You've built real positive sentiment across multiple sources. The goal now is to protect it, maintain it, and make sure your team can keep the momentum going without depending on outside help. Or, if you want to push further — monitoring, competitor benchmarking, and scaling what works.",
    services: [
      {
        name: 'Training',
        slug: 'training',
        url: '/services/training',
        why: 'Teach your team to manage SEO, content, and reputation independently',
      },
      {
        name: 'Web Management',
        slug: 'web-management',
        url: '/services/web-management',
        why: 'Ongoing monitoring, updates, and protection so nothing breaks what you built',
      },
    ],
    cta_text: "Let's protect what you've built",
    cta_url: '/contact?interest=training&interest=web-management',
    urgency: 'low',
  };
}
