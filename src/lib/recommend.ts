/**
 * Smart service recommendation engine.
 * Routes prospects to the right service based on their scan results.
 *
 * Personalized based on actual findings — not generic buckets.
 * Per research: personalized CTAs convert 202% better than generic (HubSpot, 330K CTAs).
 */

export interface Recommendation {
  bucket: 'insufficient-data' | 'negative' | 'mixed' | 'positive-thin' | 'strong';
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

export function getRecommendation(overallScore: number, mentionCount: number, brand?: string): Recommendation {
  const brandName = brand || 'your brand';

  // Insufficient data: barely exists online
  if (mentionCount <= 5) {
    return {
      bucket: 'insufficient-data',
      headline: `We couldn't find much about ${brandName} online.`,
      body: `We searched across review sites, forums, news, and social media, and found ${mentionCount === 0 ? 'nothing' : `only ${mentionCount} mention${mentionCount !== 1 ? 's' : ''}`}. That means potential customers searching for businesses like yours are finding your competitors instead. The good news: this is a solvable problem with a clear path forward.`,
      services: [
        {
          name: 'Web Management',
          slug: 'web-management',
          url: '/services/web-management',
          why: 'Get a site that shows up in search — stable, fast, and actually working for you',
        },
        {
          name: 'Implementation',
          slug: 'implementation',
          url: '/services/implementation',
          why: 'Build the listings, pages, and integrations that make you findable',
        },
      ],
      cta_text: `Build ${brandName}'s online presence`,
      cta_url: `/contact?interest=web-management&interest=implementation&brand=${encodeURIComponent(brandName)}`,
      urgency: 'high',
    };
  }

  // Negative sentiment: people are talking, but badly
  if (overallScore < 35) {
    return {
      bucket: 'negative',
      headline: `${brandName}'s online reputation needs attention.`,
      body: `People are talking about ${brandName}, and the tone isn't working in your favor. This is fixable — most businesses can shift their online sentiment within 90 days with the right strategy. But the longer negative mentions sit unanswered, the more they compound.`,
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
      cta_text: `Fix ${brandName}'s reputation`,
      cta_url: `/contact?interest=marketing-strategy&interest=implementation&brand=${encodeURIComponent(brandName)}`,
      urgency: 'high',
    };
  }

  // Mixed sentiment: present but not in control
  if (overallScore < 55) {
    return {
      bucket: 'mixed',
      headline: `${brandName} has presence, but the signal is inconsistent.`,
      body: `${brandName} shows up online, but the message is mixed. Some mentions are positive, some aren't, and there's no clear story. A focused strategy can tip the balance — amplify what's working, address what isn't, and make sure the right message shows up first.`,
      services: [
        {
          name: 'Marketing Strategy',
          slug: 'marketing-strategy',
          url: '/services/marketing-strategy',
          why: 'Build a clear strategy to shape how you show up online',
        },
        {
          name: 'Web Management',
          slug: 'web-management',
          url: '/services/web-management',
          why: 'Keep your owned properties tight — fast site, strong SEO, consistent message',
        },
      ],
      cta_text: `Take control of ${brandName}'s narrative`,
      cta_url: `/contact?interest=marketing-strategy&interest=web-management&brand=${encodeURIComponent(brandName)}`,
      urgency: 'medium',
    };
  }

  // Positive but thin: good vibes, not enough volume
  if (mentionCount < 10) {
    return {
      bucket: 'positive-thin',
      headline: `Good sentiment for ${brandName}. Not enough volume.`,
      body: `When people find ${brandName}, they like what they see. The problem is not enough people are finding you. The foundation is solid — now it's time to amplify. More listings, more content, more places where the right people can discover you.`,
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
      cta_text: `Amplify ${brandName}'s reach`,
      cta_url: `/contact?interest=implementation&interest=marketing-strategy&brand=${encodeURIComponent(brandName)}`,
      urgency: 'medium',
    };
  }

  // Strong: in good shape
  return {
    bucket: 'strong',
    headline: `${brandName} is in strong shape.`,
    body: `You've built real positive sentiment across multiple sources. The goal now is to protect it, maintain it, and make sure your team can keep the momentum going. Or, if you want to push further — monitoring, competitor benchmarking, and scaling what works.`,
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
    cta_text: `Protect what ${brandName} has built`,
    cta_url: `/contact?interest=training&interest=web-management&brand=${encodeURIComponent(brandName)}`,
    urgency: 'low',
  };
}
