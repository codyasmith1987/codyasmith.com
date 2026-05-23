// Raised Bar proposal config used by the migration seed and (in
// Phase 2) the generic renderer. Encodes the four-step interactive
// flow currently hardcoded in src/pages/portal/proposals/raised-bar.astro.

export const RAISED_BAR_PROPOSAL_CONFIG = {
  version: 1,
  prepared_for: 'Jason Roth and Kevin Adams',
  prepared_on: 'May 22, 2026',
  title: 'Engagement Proposal for Jason Roth and Kevin Adams',

  // Narrative sections rendered above the interactive steps.
  narrative: {
    intro: `After our call, I sat with your family of companies, your sites, and the market you sell into. Here is the engagement I recommend, the real numbers behind it, the order it rolls out in, and a clean way to start today.`,
    sections: [
      {
        h2: 'What I see in your business',
        paragraphs: [
          `You run three companies. <strong>F3 Properties</strong> is the real estate brokerage your family built up over twenty-plus years. It is online but visibly broken right now: the styling fails to load on most pages, and the magazine feature and the Brigadier General's endorsement that should be doing PR work for you are buried in the file directory where almost nobody finds them. <strong>Raised Bar Builders</strong> is the general contracting practice carrying three generations of your family's name, your grandfather's work in South Dakota in the 1920s, your father Wayne's decades in the Wood River Valley, your three companies now. It has no web presence at all. <strong>Raised Bar Development Group</strong> is the investment and acquisition arm; you said it stays behind the scenes, and that is how I treat it.`,
          `And you have <strong>Tailwater</strong>, three customized ZipKit Homes plans on an infill parcel in downtown Hailey, two blocks from Main Street, on a city park that already pulls foot traffic. You and Kevin want to pre-sell those three homes, and the location plus the ZipKit Homes finish give you something most luxury pre-sells do not have: a real story.`,
          `Your urgency is Tailwater. Your growth is Raised Bar Builders, especially with the ZipKit Homes authorized builder-dealer alliance Sven and Hayden have been building with you. Your maintenance priority is F3, the brokerage you said you want tightened up but is no longer where your energy is. That is the order I treat them in.`,
        ],
      },
      {
        h2: 'What I recommend',
        paragraphs: [
          `Two products. <strong>Web Management</strong> keeps your sites running, secure, and improving every month, billed per site, with hours pooled across the sites I manage for you. <strong>Marketing Consulting</strong> is research and strategy applied to the whole business: market, competitors, search and content, brand. I never execute on the marketing side. You give me direction, I come back with strategy. Sold once for the family of companies, never multiplied per site. Buy one, the other, or both.`,
          `For the build side I recommend the Raised Bar Builders site as the primary, with the F3 Properties takeover as a second managed site. Tailwater can live as a focused section inside the Builders site (the simpler rollout) or as a standalone pre-sell micro-site on its own URL (the harder push for the parcel signage and ads). Both options are below; the numbers update as you pick.`,
        ],
      },
    ],
    rollout: {
      h2: 'How it rolls out',
      intro_html: `If you pick <strong>Option 1</strong> in Step 2:`,
      phases: [
        {
          phase_num: 'Phase 1',
          h3: 'The unified Builders site, Tailwater section first',
          html: `Marketing Consulting research starts the day this engagement signs (if you picked it). I build the unified Raised Bar Builders site with the Tailwater section completed first so the pre-sell launches while the rest of the builder content is still being finished. The ZipKit Homes authorized builder-dealer funnel and your About page (heritage, magazine feature, General's endorsement) land in the same launch. The site moves onto Web Management at launch.`,
        },
        {
          phase_num: 'Phase 2',
          h3: 'F3 Properties takeover',
          html: `I take over F3, fix the broken styling, surface the magazine feature and General's endorsement properly, and tighten the site inside your monthly pooled hours. F3 joins the management pool as the second site.`,
        },
      ],
      outro_html: `If you pick <strong>Option 2</strong>, the order shifts: Phase 1 is the standalone Tailwater micro-site (built and launched first, on its own URL, for the pre-sell), Phase 2 is the Raised Bar Builders site without the Tailwater section, Phase 3 is the F3 takeover. The micro-site winds down after the three homes sell.`,
    },
  },

  // Interactive steps. Each step has an id, a type, and config that
  // the renderer uses to draw the cards and the renderer/server uses
  // to validate selections.
  steps: [
    {
      id: 'mgmt_tier',
      type: 'tier_picker',
      h2: 'Step 1: Pick a Web Management level',
      prompt: `Good, Better, or Best for Web Management. The level sets how often I update your sites, how fast I respond when something breaks, and how many hands-on hours per month sit in your pool. Marketing Consulting is a separate decision farther down the page. Pick management first, then the site setup, then decide if you want consulting on top.`,
      options: [
        {
          id: 'good',
          name: 'Good',
          tagline: 'A start, intentionally light.',
          price_label: '$534.60 – $772.20',
          price_suffix: '/ month',
          price_subline: 'depending on Step 2',
          features: [
            'Web Management for the Raised Bar Builders site and the F3 Properties takeover. Sites stay online, secure, monitored, and updated monthly.',
            'About 5 to 8 pooled hours per month for hands-on site work, depending on Step 2.',
            'Hosting, daily backups, security and uptime monitoring on every site I manage for you.',
          ],
        },
        {
          id: 'better',
          name: 'Better',
          tagline: 'The flagship. The right fit for what you are doing right now.',
          recommended: true,
          price_label: '$894.60 – $1,292.20',
          price_suffix: '/ month',
          price_subline: 'depending on Step 2',
          features: [
            'Everything in Good, plus bi-weekly software updates, performance optimization, and a monthly health report so you always know what is happening.',
            'About 9 to 13 pooled hours per month for active page work, copy, images, content updates.',
            'The level most clients land on. The price jump from Good buys real visibility into your sites and disproportionate value.',
          ],
        },
        {
          id: 'best',
          name: 'Best',
          tagline: 'Weekly updates. Same-day priority response.',
          price_label: '$1,164.60 – $1,682.20',
          price_suffix: '/ month',
          price_subline: 'depending on Step 2',
          features: [
            'Everything in Better, plus weekly updates and same-day priority response when something breaks.',
            'About 14 to 21 pooled hours per month, depending on Step 2.',
            'One staff training session per quarter for your team, on whichever topic helps them most.',
          ],
        },
      ],
    },
    {
      id: 'site_setup',
      type: 'binary_picker',
      depends_on: 'mgmt_tier',
      h2: 'Step 2: Pick your site setup',
      prompt: 'Pick a Web Management level above and the two site-setup options will appear below.',
      options: [
        {
          id: 'o1',
          name: 'Option 1: Single unified site',
          html: `One Raised Bar Builders site, with Tailwater built in as a focused section. Default rollout, Tailwater launches first inside the build, and after the three homes sell the Tailwater section becomes a permanent portfolio piece. Two sites managed: Builders and the F3 Properties takeover.`,
          price_dynamic: 'mgmtMonthly:o1', // resolved by formula
          price_detail_html: 'Builders site build: $5,625. F3 takeover onboarding: $800. Web Management onboarding: <span class="dyn-mgmt-onb"></span>.',
        },
        {
          id: 'o2',
          name: 'Option 2: Split setup',
          html: `Standalone Tailwater micro-site at its own URL for the parcel signage, ads, and a focused pre-sell funnel, plus the Raised Bar Builders site (without the Tailwater section), plus the F3 takeover. Three sites managed. After the three homes sell, the micro-site winds down and your monthly returns to the Option 1 number.`,
          price_dynamic: 'mgmtMonthly:o2',
          price_detail_html: 'Adds Tailwater micro-site build $4,500 and a small multi-site onboarding addition (<span class="dyn-multi-onb"></span>).',
        },
      ],
    },
    {
      id: 'consulting',
      type: 'binary_picker',
      depends_on: 'site_setup',
      h2: 'Step 3: Add Marketing Consulting?',
      prompt: 'Pick a site setup above and the consulting choice will appear below.',
      options: [
        {
          id: 'no',
          name: 'Web Management only',
          html: 'Skip Marketing Consulting for now. You can add it later at any time. The recurring stays at your management number from Step 2. Nothing changes about the sites or how I run them.',
          price_label: 'No additional charge',
          price_detail_html: 'Mgmt-only monthly.',
        },
        {
          id: 'yes',
          name: 'Add Marketing Consulting',
          html: 'Research and strategy applied to the whole family of companies. Competitive analysis, search and content direction, brand positioning. I never execute on the marketing side. You give me direction, I come back with strategy. Sold once for the business, not per site.',
          price_label: '+$497 to +$1,497 / month',
          price_detail_html: 'Pick a level next. Audit at signing ranges $1,500 to $4,000 by level.',
        },
      ],
    },
    {
      id: 'consulting_tier',
      type: 'tier_picker',
      depends_on: 'consulting',
      show_when: { consulting: 'yes' },
      h2: 'Step 4: Pick a Consulting level',
      prompt: 'Choose Good, Better, or Best for the consulting engagement.',
      options: [
        {
          id: 'good',
          name: 'Good',
          tagline: 'The lightest consulting engagement.',
          price_label: '$497',
          price_suffix: '/ month',
          price_subline: '$1,500 audit at signing',
          features: [
            'A baseline competitive and keyword read at the start of the engagement.',
            'Monthly access to my strategic thinking if you have a question. No ongoing roadmap, no monthly strategy call.',
            'Designed to get you in the door. Most clients move up after a few months because they want the cycle.',
          ],
        },
        {
          id: 'better',
          name: 'Better',
          tagline: 'The flagship consulting cycle.',
          recommended: true,
          price_label: '$997',
          price_suffix: '/ month',
          price_subline: '$2,500 audit at signing',
          features: [
            'A research-grade audit at the start, then a quarterly cycle of competitive analysis, SEO and content roadmap, and brand positioning.',
            'A 30-minute monthly strategy call. Quarterly performance reporting.',
            'This is the cycle for a business that is actually trying to grow.',
          ],
        },
        {
          id: 'best',
          name: 'Best',
          tagline: 'Monthly strategy cycle. Hiring guidance included.',
          price_label: '$1,497',
          price_suffix: '/ month',
          price_subline: '$4,000 audit at signing',
          features: [
            'The deepest audit at the start, then a monthly cycle of competitive analysis, SEO and content roadmap, and ongoing brand work.',
            'A 60-minute strategy call every month. Monthly performance reporting.',
            'Hiring guidance when you bring marketing or web roles in-house. One staff training session per quarter for your team.',
          ],
        },
      ],
    },
  ],

  // Signers (must match portal user emails). The renderer matches the
  // logged-in user against this list to know which signature field is
  // theirs and what the partner's name is.
  signers: [
    { id: 'jason', email: 'jasonroth1122@gmail.com', name: 'Jason Roth' },
    { id: 'kevin', email: 'kevo.adams@gmail.com', name: 'Kevin Adams' },
  ],

  // Pricing formula identifier. The accept endpoint applies the named
  // formula to the selections to compute one-time + monthly totals.
  // For now the only implementation is 'raised_bar_v1' which is wired
  // up in the existing accept endpoint.
  pricing_formula: 'raised_bar_v1',
};
