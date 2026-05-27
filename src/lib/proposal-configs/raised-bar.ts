// Raised Bar proposal config, post-5/22 Fit Analysis architecture.
//
// Buyer-facing shape: one bundled Good/Better/Best tier picker at the
// center, one optional Tailwater micro-site add-on below. Two steps
// total. Narrative lifted from Cody's authored HTML proposal
// (Raised Bar - Proposal - 5.22.26.html). Numbers from the Fit Analysis
// Section 5: bundled monthly Good $1,031.60 / Better $1,891.60 /
// Best $2,661.60; one-time Good $7,925 / Better $8,925 / Best $10,625;
// Tailwater add-on +$4,500 once + tier-dependent monthly delta.
//
// Pricing formula is `raised_bar_v2`: a thin wrapper that maps the new
// `tier` + `tailwater_addon` selections to the legacy raised_bar_v1
// shape internally so the existing pricing + Schedule A code reuses.
// Replaces the pre-5/22 four-step config (separate WM tier, site setup,
// MC yes/no, MC tier, builders_domain, tailwater_domain) which did not
// match the Fit Analysis or the HTML.

export const RAISED_BAR_PROPOSAL_CONFIG = {
  version: 2,
  prepared_for: 'Jason Roth and Kevin Adams',
  prepared_on: 'May 22, 2026',
  title: 'Engagement Proposal for Jason Roth and Kevin Adams',

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
          `Two products, sold together. <strong>Web Management</strong> keeps your sites running, secure, and improving every month, billed per site, with hours pooled across the sites I manage for you. <strong>Marketing Consulting</strong> is research and strategy applied to the whole business: I look at your market, your competitors, what people are searching for, where the holes are, and come back with specific recommendations on what to do about it. I never execute on the marketing side. You give me direction, I come back with strategy. Sold once for the family of companies, never multiplied per site.`,
          `For the build side, I recommend <strong>one substantial Raised Bar Builders site</strong>, with Tailwater built in as a focused section, the ZipKit Homes authorized builder-dealer funnel inside the same site, and the F3 Properties takeover as the second managed site. The Tailwater section is built and launches first, so your pre-sell goes live while the rest of the builder content is still in production. F3 is a takeover, not a rebuild: I fix the broken styling, surface the magazine feature and the General's endorsement properly, and tighten the site inside your monthly pooled hours instead of charging you for a new build on a site that is no longer the priority.`,
          `One site instead of two is cheaper to build, simpler to run, and there is nothing that has to wind down later. When the three homes sell, your Tailwater section becomes a permanent portfolio piece on the builder site, not an orphan campaign site you keep paying to maintain. If you want a standalone Tailwater micro-site for the pre-sell, with its own URL for the signage at the park and a focused funnel, that is available as a single add-on below. It is a real option, not a hidden one. You pick it if you want it.`,
        ],
      },
    ],
    rollout: {
      h2: 'How it rolls out',
      // scenarios keyed by tailwater_addon selection. The renderer
      // shows the matching scenario and hides the other.
      scenario_step: 'tailwater_addon',
      scenarios: {
        no: {
          intro_html: `Without the Tailwater add-on, the unified Builders site carries everything and Tailwater lives inside it:`,
          phases: [
            {
              phase_num: 'Phase 1',
              h3: 'The unified Builders site, Tailwater section first',
              html: `Marketing Consulting research starts the day this engagement signs. I build the unified Raised Bar Builders site with the Tailwater section completed first so the pre-sell launches while the rest of the builder content is still being finished. The builder content, the ZipKit Homes authorized builder-dealer funnel, and your About page (the heritage, the magazine feature, the General's endorsement) all land in the same launch. The site moves onto Web Management at launch.`,
            },
            {
              phase_num: 'Phase 2',
              h3: 'F3 Properties takeover',
              html: `I take over F3, fix the broken styling that is degrading the site right now, surface the magazine feature and the General's endorsement properly, and tighten the site inside your monthly pooled hours. F3 joins the management pool as the second site.`,
            },
          ],
          outro_html: `After the three Tailwater homes sell, the Tailwater section on the Builders site becomes a permanent portfolio piece. Two sites under management long-term.`,
        },
        yes: {
          intro_html: `With the Tailwater micro-site add-on, the order shifts so Tailwater launches first on its own URL:`,
          phases: [
            {
              phase_num: 'Phase 1',
              h3: 'The standalone Tailwater micro-site',
              html: `Tailwater launches first on its own URL, focused entirely on the three-home pre-sell. Parcel signage, paid ads, and direct outreach all point at this site. Lean, focused, fast to launch. Marketing Consulting research begins at signing and runs in parallel.`,
            },
            {
              phase_num: 'Phase 2',
              h3: 'The Raised Bar Builders site',
              html: `I build the Builders site without the Tailwater section. This becomes the primary brand site for the contracting practice: heritage, magazine feature, General's endorsement, the ZipKit Homes builder-dealer alliance, and the rest of the builder content. The site moves onto Web Management at launch.`,
            },
            {
              phase_num: 'Phase 3',
              h3: 'F3 Properties takeover',
              html: `Same takeover as the default rollout: fix the broken styling, surface the magazine feature and General's endorsement properly, tighten the site inside your monthly pooled hours. F3 joins the management pool.`,
            },
          ],
          outro_html: `After the three Tailwater homes sell, the micro-site winds down and your monthly recurring drops back to the long-term tier number (two sites managed, not three).`,
        },
      },
    },
  },

  // Two interactive steps. Tier picker is the centerpiece. Add-on is
  // the only other lever.
  steps: [
    {
      id: 'tier',
      type: 'tier_picker',
      h2: 'Your three options',
      prompt: `Pick a level. Good, Better, or Best. The level sets the recurring partnership: how much research and strategy I do for the business every month, how much hands-on work goes into the sites, and how fast I respond. Better is the level that fits where you actually are right now.`,
      options: [
        {
          id: 'good',
          name: 'Good',
          tagline: 'A start, intentionally light.',
          price_label: '$1,031.60',
          price_suffix: ' / month',
          price_subline: '$7,925 to start',
          features: [
            'Marketing Consulting at the lightest level: a baseline competitor and keyword read at the start, then monthly access to my strategic thinking if you have a question. No ongoing roadmap, no monthly strategy call.',
            'Web Management for the unified Raised Bar Builders site and the F3 Properties takeover. Your sites stay online, secure, and updated monthly.',
            '6 pooled hours per month for hands-on site work.',
          ],
        },
        {
          id: 'better',
          name: 'Better',
          tagline: 'The flagship. The right fit for what you are doing right now.',
          recommended: true,
          price_label: '$1,891.60',
          price_suffix: ' / month',
          price_subline: '$8,925 to start',
          features: [
            'A research-grade audit at the start, then a quarterly cycle of competitive analysis, search engine optimization (SEO) and content roadmap, brand positioning, and a 30-minute monthly strategy call. Quarterly performance reporting.',
            'Web Management with bi-weekly software updates, performance optimization, and a monthly health report so you know what is happening.',
            '10 pooled hours per month for active page work, copy, images, content updates, whatever the sites need.',
          ],
        },
        {
          id: 'best',
          name: 'Best',
          tagline: 'Marketing on a monthly cycle. Same-day priority response.',
          price_label: '$2,661.60',
          price_suffix: ' / month',
          price_subline: '$10,625 to start',
          features: [
            'The deepest audit at the start, then a monthly cycle of competitive analysis, SEO and content roadmap, ongoing brand work, a 60-minute strategy call, monthly performance reporting, and hiring guidance when you bring marketing or web roles in-house.',
            'Web Management with weekly updates and same-day priority response when something breaks.',
            '16 pooled hours per month. One staff training session per quarter for your team.',
          ],
        },
      ],
    },
    {
      id: 'tailwater_addon',
      type: 'binary_picker',
      depends_on: 'tier',
      h2: 'Optional: a dedicated Tailwater pre-sell micro-site',
      prompt: `If you want Tailwater on its own URL for the parcel signage, ads, and a focused pre-sell funnel that has no builder content competing for attention, this splits Tailwater out of the unified site into its own micro-site. It is built first and launches first, on its own timeline. The Builders site catches up behind it. After the three homes sell, the micro-site winds down and your monthly returns to the tier number you picked above. Long-term, the recurring is the same whether you add this or not. The add-on is for the pre-sell experience, not the long-term economics.`,
      options: [
        {
          id: 'no',
          name: 'Skip the micro-site',
          html: 'Tailwater lives as a section inside the unified Raised Bar Builders site. The pre-sell runs from that section. No additional one-time, no additional monthly.',
          price_label: 'No additional charge',
          price_detail_html: 'Recurring stays at the tier you picked.',
        },
        {
          id: 'yes',
          name: 'Add a standalone Tailwater micro-site',
          html: 'Tailwater splits out to its own URL for the parcel signage and a focused pre-sell funnel. Adds the second build and one extra managed site while the micro-site runs.',
          price_label: '+$4,500 to start',
          price_detail_html: 'Plus a tier-dependent monthly while Tailwater runs: +$237.60 (Good), +$397.60 (Better), +$517.60 (Best). Long-term recurring returns to the tier number when the three homes sell.',
        },
      ],
    },
  ],

  // Signers stay portal-keyed by email. The renderer matches the
  // logged-in user against this list to know which signature field is
  // theirs and what the partner's name is.
  signers: [
    { id: 'jason', email: 'jasonroth1122@gmail.com', name: 'Jason Roth' },
    { id: 'kevin', email: 'kevo.adams@gmail.com', name: 'Kevin Adams' },
  ],

  // raised_bar_v2: maps the new tier + tailwater_addon selections to
  // the legacy raised_bar_v1 selection shape internally, so the
  // tested pricing and Schedule A code reuses without a rewrite.
  pricing_formula: 'raised_bar_v2',
};
