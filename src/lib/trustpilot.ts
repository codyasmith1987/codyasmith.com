/**
 * Trustpilot integration — free, no API key required.
 *
 * Uses two endpoints:
 * 1. Review page __NEXT_DATA__: business metadata + full review text
 * 2. Widget endpoint: trust score summary (fallback if page parsing fails)
 *
 * This is not the official API (which requires auth). These are public-facing
 * endpoints that serve the Trustpilot website and widget embeds.
 */

export interface TrustpilotBusiness {
  businessUnitId: string;
  displayName: string;
  trustScore: number;        // 0-5
  numberOfReviews: number;
  starDistribution: Record<string, number>;  // { "1": 100, "2": 50, ... }
}

export interface TrustpilotReview {
  id: string;
  title: string;
  text: string;
  rating: number;            // 1-5 stars
  date: string;
  consumerName: string;
}

export interface TrustpilotResult {
  business: TrustpilotBusiness | null;
  reviews: TrustpilotReview[];
}

/**
 * Look up a business on Trustpilot by domain and retrieve reviews.
 * Returns null business if the domain isn't found on Trustpilot.
 */
export async function fetchTrustpilotData(domain: string): Promise<TrustpilotResult> {
  // Trustpilot uses the domain as the URL slug: trustpilot.com/review/example.com
  // Try with and without www
  const domainsToTry = [
    domain.replace(/^www\./, ''),
    'www.' + domain.replace(/^www\./, ''),
  ];

  for (const d of domainsToTry) {
    try {
      const result = await fetchFromReviewPage(d);
      if (result.business) return result;
    } catch {
      // Try next domain variant
    }
  }

  return { business: null, reviews: [] };
}

async function fetchFromReviewPage(domain: string): Promise<TrustpilotResult> {
  const url = `https://www.trustpilot.com/review/${domain}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) return { business: null, reviews: [] };

  const html = await res.text();

  // Extract __NEXT_DATA__ JSON
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!match) return { business: null, reviews: [] };

  let nextData: any;
  try {
    nextData = JSON.parse(match[1]);
  } catch {
    return { business: null, reviews: [] };
  }

  // Navigate the Next.js data structure to find business info and reviews
  const pageProps = nextData?.props?.pageProps;
  if (!pageProps) return { business: null, reviews: [] };

  // Business unit data
  const bu = pageProps.businessUnit;
  if (!bu) return { business: null, reviews: [] };

  const business: TrustpilotBusiness = {
    businessUnitId: bu.id || bu.businessUnitId || '',
    displayName: bu.displayName || bu.name || domain,
    trustScore: bu.trustScore ?? bu.score ?? 0,
    numberOfReviews: bu.numberOfReviews ?? 0,
    starDistribution: {},
  };

  // Star distribution might be in different locations
  if (bu.stars) {
    for (const s of Object.keys(bu.stars)) {
      business.starDistribution[s] = bu.stars[s];
    }
  }

  // Reviews
  const rawReviews = pageProps.reviews || [];
  const reviews: TrustpilotReview[] = rawReviews.slice(0, 20).map((r: any) => ({
    id: r.id || '',
    title: r.title || '',
    text: r.text || '',
    rating: r.rating ?? r.stars ?? 0,
    date: r.dates?.publishedDate || r.createdAt || '',
    consumerName: r.consumer?.displayName || 'Anonymous',
  })).filter((r: TrustpilotReview) => r.text.length > 0);

  return { business, reviews };
}

/**
 * Fallback: get summary data from the widget endpoint.
 * Only returns aggregate scores, no individual reviews.
 */
export async function fetchTrustpilotSummary(businessUnitId: string): Promise<TrustpilotBusiness | null> {
  try {
    const url = `https://widget.trustpilot.com/trustbox-data/56278e9abfbbba0bdcd568bc?businessUnitId=${businessUnitId}&locale=en-US`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;

    const data = await res.json();
    if (!data.businessEntity) return null;

    const be = data.businessEntity;
    return {
      businessUnitId,
      displayName: be.displayName || '',
      trustScore: be.trustScore ?? 0,
      numberOfReviews: be.numberOfReviews ?? 0,
      starDistribution: be.stars || {},
    };
  } catch {
    return null;
  }
}
