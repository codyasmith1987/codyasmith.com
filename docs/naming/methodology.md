# Naming methodology

## Dashboard

Three Theoretical Network Analysis (TNA) tasks mapped what is actually known about brand naming. The combined evidence base anchors a position the rest of this document follows: name choice affects commercial outcomes, but at smaller magnitudes than the professional naming industry's marketing implies. Best estimate of name-attributable variance in commercial outcomes is 3 to 10 percent in well-controlled studies and likely less in real markets, where confounding factors (advertising spend, distribution, product quality, category dynamics, market timing) dominate. The industry's implicit claim is closer to 30 to 50 percent. The gap is not subtle and it is not a matter of interpretation. It is a real overstatement that survives because successful brands are remembered and failed brands are forgotten.

Three structural findings carry the most weight for the tool we are building. First, digital constraints divide cleanly into binary feasibility constraints (the brand can or cannot own the .com; the brand can or cannot register the @brand handle on Instagram) and soft outcome effects (top-level domain (TLD) trust penalty, handle consistency, processing fluency, sound symbolism). The practitioner literature habitually conflates the two and treats soft preferences as if they were hard gates. Honest practice keeps them apart. Second, the cognitive and linguistic foundations that practitioner firms cite as scientific grounding are real but small in effect size. Sound symbolism replicates broadly. Processing fluency produces measurable first-impression effects. Working memory caps name length. Effect sizes are in the small-to-moderate range and they attenuate further in field settings. Third, the digital landscape is binary at the per-name feasibility check and soft everywhere else. A name that fails the .com check or fails primary handle availability is not viable for most contemporary brand launches at scale. A name that passes those checks but is moderately disfluent or inconsistent across platforms operates inside the small-effect territory.

What this means for the tool. The honest value proposition has three deliverables: rigorous availability checks across binary feasibility constraints, evidence-grounded creative input with appropriate magnitude language, and explicit positioning that names are one variable among many. What it does not deliver: commercial outcome guarantees, AI-search optimization features, brand voice integration, fifty-language linguistic vetting, or any claim that a great name builds a great brand. The tool that exaggerates its own importance is the tool that produces template-y output, which is the failure mode we already rejected once. Position 1, naming as one variable, is the operating frame for everything downstream.

## How this document came together

This synthesis draws from three Theoretical Network Analysis passes commissioned for the express purpose of grounding a domain-name generation tool in real evidence rather than practitioner intuition. The rationale was direct. An earlier attempt at the tool produced obvious sludge (three of five generated names sharing a single misspelled stem, generic tautological rationales, a creativity dial that did not visibly affect output across settings). The diagnostic showed the model was rotating suffixes on stems because the prompt did not encode any actual naming methodology. The fix could have been more prompt engineering. Instead the decision was to research the discipline before redesigning anything.

Task 1 mapped the cognitive and linguistic foundations: name typology, sound symbolism and phonetic perception, memorability research, processing fluency, and cross-cultural considerations. Task 2 mapped the professional naming industry: the empirical anchor on name-attributable outcomes, practitioner methodology documented versus claimed, the trademark and legal dimension, linguistic screening practice, and the price-quality relationship. Task 3 mapped the digital dimension: domain availability, social handle scarcity, search engine optimization (SEO) and brand search, and AI search with named-entity disambiguation. Task 3 also handled two scope questions as findings rather than instructions, deferring brand voice (insufficient digital-specific literature) and including AI search with explicit thin-evidence caveats.

The combined network anchored eighteen claims, identified fifteen contested claims, and resolved twenty-eight practitioner claims as supported, contradicted, untested, or unable-to-resolve. The recommendation at the end of Task 3 was that the combined network is sufficient for downstream product work and that further research should be deferred until the redesign surfaces specific gaps. This document is that sufficient base, organized for product reference.

The codebase identifier for the tool is "naming" because the public brand has not been chosen and is intentionally deferred until product Phase 4. This document will be renamed along with everything else when the brand decision lands.

## The empirical anchor

This is the load-bearing finding, repeated in plain language because everything downstream rests on it.

Name-attributable variance in commercial outcomes is small. Best estimate from controlled studies is 3 to 10 percent. The estimate is medium-low confidence because the data is sparse, selection-biased, and largely from English-language consumer-product contexts. The estimate could be wrong by a factor of two to three in either direction. Higher-confidence claim: the industry's implicit claim of 30 to 50 percent name-driven outcomes is overstated by something like five to ten times.

The evidence supporting the anchor includes Klink-style sound-symbolism effect sizes (Cohen's d around 0.3 to 0.5 in laboratory studies, attenuated in field), Alter and Oppenheimer's fluency effects on short-term IPO returns (small but real, replicated at smaller magnitudes than the original paper), brand-renaming quasi-experiments (mixed-to-modest stock-price effects often dominated by announcement effects rather than name itself), and the general pattern across new-product launch studies that confounding factors dominate variance once introduced.

Specific cases that disconfirm the "great names build great brands" framing. Quibi was named by Lexicon Branding, the gold-standard methodology firm. The company spent roughly 1.75 billion dollars and shut down in six months. The name was not the failure cause. The product-market fit and distribution strategy were. Apple was chosen by Steve Jobs reportedly after a fruitarian phase. Google was a deliberate misspelling of "googol." Amazon was Jeff Bezos's working choice from a book of words. Tesla, Twitter, GoPro, Yahoo, Netflix: none emerged from professional naming engagements. The "great names" most often cited as wins in practitioner literature were not professionally named. The successful self-named-or-amateur-named brand list is much longer than the successful professionally-named list when controlled for company size.

The honest reframe of professional naming's value proposition follows from the anchor. The narrow deliverables (legal protection, linguistic clearance, semiotic screening, internal stakeholder alignment) are real and valuable. The broad claim ("we make brands better") is not supported. The professional-services value is real even when the empirical anchor is weak; it lives in deliverables and risk-management rather than in measurable outcome differential. This is consistent with how architecture, design, and management consulting operate. Weak rigorous-outcome evidence; strong professional value propositions; value concentrated in narrower deliverables than the marketing implies.

The implication for the tool: any feature, copy choice, or recommendation that depends on a large name effect is overstating what the evidence supports. The tool's deliverables have to live within the actual effect size, not the marketed one.

## Binary feasibility versus soft outcome effects

This is the analytical framework that distinguishes constraint from preference, gate from soft signal. The practitioner literature regularly fails this distinction. The tool will not.

Binary feasibility constraints are gates. A name either passes or it does not. Domain ownership is the cleanest case. The brand either owns the .com or does not. If not, acquisition is possible at a price (documented sales: Voice.com at 30 million dollars, Insurance.com at 35.6 million dollars, CarInsurance.com at 49.7 million dollars), available through a marketplace (Sedo, Afternic, GoDaddy Premium move thousands of domains in the 1,000 to 1,000,000 dollar range annually), or unavailable at any reasonable price. Handle availability on major social platforms operates similarly at the per-platform level. The brand either owns @brand on Instagram or does not. App store naming rules (length limits, character set restrictions, search-rank effects) are platform-specific feasibility gates in the same shape.

Soft outcome effects are preferences with measurable but small influence. TLD trust effects are 5 to 15 percent click-through variations in cold-traffic contexts and shrinking as alternative TLDs normalize. Handle consistency on commercial outcomes is not rigorously measured and adjacent visual-identity research suggests small effects at most. Processing fluency produces small first-impression effects that decay with familiarity. Sound symbolism produces small evaluation lifts in laboratory contexts attenuated in field. Voice search effects on brand discovery are real but small in current markets where voice-search adoption stabilized lower than forecast. AI search effects on brand discovery are structurally real but magnitude is unmeasured.

The practitioner habit of conflating these. "You must have the .com" is framed as a binary feasibility constraint when the evidence supports it as a soft trust effect of 5 to 15 percent click-through difference. "Handle consistency matters for brand recognition" is presented as a hard requirement when the evidence supports it as practitioner intuition without rigorous outcome support. "AI search demands new naming methodology" is presented as urgent and binary when the evidence supports it as forward-looking and soft. The conflation is structural, not accidental. Soft effects framed as hard gates justify expensive deliverables and tight specifications. Honest framing produces less billable work.

The tool's commitment. Domain availability and primary-handle availability are gates the tool checks transparently. The user sees the result and decides. Everything else (TLD trust, handle consistency, fluency, sound profile, voice and AI search effects) is reported with appropriate magnitude language and never as a screening filter. A name with a moderately disfluent profile is not penalized in ranking. A name whose @brand handle is taken on TikTok but available on Instagram is not penalized in ranking. The user sees the situation and chooses. The tool's job is to surface the gates honestly and the soft effects honestly, not to pretend soft effects are gates so the output looks more rigorous.

## Anchored claims

Eighteen claims survived disconfirmation across all three networks. Grouped here for product reference. Citations are abbreviated but traceable to the underlying network artifacts.

The cognitive and linguistic foundations.

The bouba/kiki effect and broad sound-symbolism mappings replicate across many language families. Front vowels (the i in "tip," the e in "bet") map onto smaller, lighter, faster, sharper. Back vowels (the o in "loop," the u in "tug") map onto larger, heavier, slower, blunter. Voiceless stops (p, t, k) carry sharper signals than voiced counterparts (b, d, g). Fricatives (f, s, sh) carry softer signals than plosives. Liquids (l, r) carry smooth, flowing connotations. Köhler 1929; Klink 2000, 2001, 2003; Yorkston and Menon 2004; Sidhu and Pexman 2018 review.

Imageability and concreteness aid first-encounter brand-name recall. Concrete imageable names (Apple, Caterpillar, Greyhound) recruit both visual and verbal memory codes per Paivio's dual-coding theory and produce stronger traces than abstract names of equivalent length. Roughly 1.5x recall advantage in Robertson 1989's analysis. The advantage diminishes with repeated exposure.

Suggestive names produce stronger benefit recall when ad budgets are low; descriptive names with category fit hold up better than the academic literature credits. Keller, Heckler, and Houston 1998. The substitution: the name does the cognitive work that an ad budget cannot afford. Once advertising establishes meaning, suggestive names lose their relative advantage.

Easy-to-pronounce names produce small positive effects on first-impression evaluations and short-term outcomes. Effect smaller than originally reported but real. Alter and Oppenheimer 2006 and replications. The effect is largest at first encounter and decays with familiarity. It applies to launches and short-term reactions, not long-term brand outcomes.

Disfluent names can signal premium positioning in luxury categories. Pocheptsova, Labroo, and Dhar 2010. Boundary-conditioned to luxury and premium product types. Häagen-Dazs is the canonical case: phonetically faux-Scandinavian, hard for English speakers to pronounce, the disfluency itself part of the premium signal.

Working memory constraints cap effective name length. Names over four syllables face encoding penalties at first exposure. Lerman 2014; broader Cowan 2001 working-memory literature. The U-shape matters: very short two-to-three-letter names sometimes face recall difficulty because they lack phonological structure to anchor encoding.

The professional industry and its evidence.

The trademark-protection gradient (descriptive less than suggestive less than arbitrary less than fanciful) is real for legal protection per United States Patent and Trademark Office (USPTO) doctrine and the Abercrombie spectrum from Abercrombie and Fitch v. Hunting World, 1976. The gradient does not necessarily map onto consumer effectiveness. The two axes (trademark strength, consumer effectiveness) are sometimes orthogonal.

Name-attributable variance in commercial outcomes is small (3 to 10 percent in well-controlled studies, less in real markets). The empirical anchor. Industry's implicit claim of large effects is not supported.

The base rate of name-related cross-cultural failures in major brand launches is low, roughly 1 to 3 percent. Most documented "failures" cited in practitioner literature are urban legends or exaggerations. The Chevy Nova story is debunked. The Pepsi-brings-ancestors-back-from-the-dead story has no documented primary source. The Coca-Cola Chinese name story is partly real and partly mythologized. Real cases exist (Mitsubishi Pajero, Honda Fitta, Vicks/Wick) but they are uncommon and most are minor corrections rather than wholesale renames.

The price differential between top-tier and lower-tier naming firms is not justified by measurable commercial-outcome differential. It reflects methodology depth, linguistic resources, signaling, risk-aversion, and project-management overhead. No rigorous evidence supports the claim that higher-tier methodology produces better commercial outcomes.

Naming firms' published methodologies cite cognitive and linguistic research selectively and post-hoc. The Lexicon Branding patent (issued 2003) predates Alter and Oppenheimer 2006 by three years and predates Klink's brand-naming work substantially. Lexicon was founded in 1982. The fluency and sound-symbolism citations in their marketing are post-hoc justification of an existing methodology, not derivation from the research.

Linguistic screening for major Asian markets (Mandarin, Japanese, Korean) and major European markets has documented value at scale. Sound-symbolic and fifty-language screening is mostly insurance against low-probability events for typical brands.

The digital landscape.

The .com namespace is functionally exhausted for short, common, descriptive names. Premium .com market is real and substantial. Acquisition costs of 100,000 to 30,000,000 dollars are documented. Top-tier acquisitions often equal or exceed the entire naming engagement fee. For brands targeting English-speaking consumer markets at scale, the .com is treated as table stakes by professional engagements.

The "you must have .com" claim is partly mythology. Many successful brands operate on alternative TLDs (.io, .ai, .co) without measurable commercial penalty in their target audiences. The trust penalty for non-.com TLDs is 5 to 15 percent in click-through studies and shrinking as alternative TLDs normalize. The claim is heavily promoted by domain brokers and naming firms with commercial incentives in acquisition fees.

Handle scarcity is severe across major platforms (X/Twitter, Instagram, TikTok, LinkedIn, YouTube, Threads, Bluesky). Each platform has independent dispute mechanisms with no Uniform Domain-Name Dispute-Resolution Policy (UDRP) equivalent and weaker enforcement than domain trademarks. Trademark-backed reclaim is possible but slow.

Branded search volume correlates with brand awareness. The relationship is downstream of marketing investment, not driven primarily by name choice. Strong brands have more branded searches because they have more brand awareness. Weak brands with great names do not, generally, have high branded search volumes.

The descriptive-versus-distinctive name choice has a real SEO tradeoff. Descriptive names win category-search exposure (HotelTonight, OpenTable, Better.com, Flexport). Distinctive names win own-brand search dominance (Notion, Quora, Stripe). The choice is category-conditional and depends on the brand's growth strategy.

Digital constraints split into two structurally distinct types. Binary feasibility constraints are hard gates. Soft outcome effects are within the small-effect-size territory of Tasks 1 and 2. The practitioner literature in this territory often conflates the two; the tool will not.

## Contested claims

Fifteen claims have meaningful disagreement in the evidence. These are not weaknesses; they are honest uncertainty. The tool's copy and methodology language must reflect this uncertainty rather than picking a side.

The magnitude of cross-cultural universality of sound symbolism. Bouba and kiki replicates broadly but not universally. Bremner et al. 2013 found null results in Himba speakers. Cuskley et al. 2017 added the role of literacy. Effect is real, universality is partial.

Whether memorability advantages in laboratory recall transfer to long-term commercial brand outcomes. Lab effects are small. Commercial outcomes are dominated by other factors. The transfer question is open.

The "K is funny" rule. Cited frequently in practitioner literature. Weak academic support. Westbury et al. 2016 found weak K-effects but stronger effects from low-frequency word patterns broadly.

Effect sizes for Alter and Oppenheimer's fluency and stock-returns finding. Original effect was substantial. Replications have been smaller. Whether the original is overstated or replications are underpowered is open.

Whether descriptive names underperform coined names commercially. Conventional wisdom says yes. Empirical record says it depends on category clutter, ad budget, and product type. Many descriptive names succeed.

The "founder names work better than coined" claim. Conditional on the founder having a personal brand. Tesla works because Elon Musk's persona carries the brand. Disney worked while Walt was alive.

The role of distinctiveness in long-term brand equity. Distinctive in lab. Mediated in market. Apple and Google are highly distinctive and highly successful. Microsoft and Cisco are moderately distinctive and equally successful. The relationship is weak.

Whether the "linguistic vetting prevents costly mistakes" claim has favorable expected value for typical brands. Cost-benefit math favors screening for global brands at scale. Less clearly for smaller brands launching in fewer markets.

The actual differentiating value of "creative space" or "brand vocabulary" frameworks in naming firm methodology. Marketed as differentiating. Documented practice across firms converges on similar working units.

Whether naming firm patents reflect current practice or historical snapshots. Patents are public; current practice is opaque.

Whether handle consistency materially affects commercial outcomes. The claim is heavily marketed and weakly evidenced. Many successful brands have inconsistent handles.

The magnitude of TLD trust effects on conversion in 2024 and 2025 markets. Studies vary. Effects appear to be shrinking but remain measurable.

Whether AI search is rapidly replacing traditional search and justifies near-term naming-methodology adaptation. The directional claim has support. The magnitude and urgency are contested. Most Generative Engine Optimization (GEO) content is marketing.

Whether voice search creates meaningful brand-naming constraints in current markets. Lower-than-expected voice-search adoption reduces urgency.

The actual commercial impact of cross-entity collision in AI-search results for new brands. Structural problem is real. Magnitude is unmeasured.

## Practitioner claims, supported and contradicted

Twenty-eight claims commonly made by naming firms or naming-adjacent practitioners. Each was tested against the combined evidence base. Status given as Supported, Partially Supported, Contradicted, Untested, or Unable to Resolve.

Lexicon Branding's methodology cites Klink and Alter and Oppenheimer as foundational. Contradicted. Methodology predates the citations.

Catchword's Linguistic Naming Audit screens across twenty-eight to fifty languages. Partially Supported. Service description is accurate. Value depends on the brand's actual market reach. Coverage of fifty languages is theatrical for most engagements.

Interbrand's Best Global Brands methodology weights name strength. Partially Supported. Implicit weighting only. Not explicit in published methodology.

Coined names recommended for trademark strength justifies their cost. Partially Supported. Legal protection differential is real per the Abercrombie spectrum. Commercial cost-benefit is unsupported. For most brands, expected value of stronger trademark protection is small relative to the engagement cost.

Linguistic vetting prevents costly mistakes. Partially Supported. Real cases exist. Most cited "mistakes" are urban legends. Base rate of name-related cross-cultural failures is 1 to 3 percent of major launches. Expected value of screening is positive for global brands at scale and dubious for smaller brands.

The two-syllable rule. Untested. Working memory research supports moderate length. The specific two-syllable prescription is heuristic.

No negative meanings in fifty languages. Partially Supported. Principle is sound. Fifty-language framing is theatrical for most brands.

Industry rates of 40,000 to 500,000 dollars and up reflect outcome differential. Contradicted. No rigorous evidence. Reflects methodology depth, signaling, risk-aversion, and project-management overhead.

Seven to thirty percent of names "fail" linguistic screening. Partially Supported. Flag rate accurate. Failure rate much lower than the flag rate.

Names need to be memorable. Contradicted as standalone claim. Brand needs to be memorable. Name is one input. Many B2B brands have unmemorable names but high recognition because the marketing carries the load.

Higher-tier methodology produces measurably better commercial outcomes. Contradicted by empirical anchor.

Brand vocabulary or creative space frameworks differentiate top-tier methodology. Untested. Marketed as differentiating. Documented practice across firms converges on similar working units.

Crowdsourced naming produces lower-quality outcomes. Untested. Squadhelp and similar platforms publish portfolio case studies with apparent commercial success. Selection bias prevents clean comparison.

Lexicon's PhD-linguist team produces measurably different output. Untested. Lexicon's portfolio is impressive but selection-biased.

Trademark strength is the primary value of naming engagements. Partially Supported for global brands with high-stakes trademark exposure. Insurance against low-probability events for most brands.

Linguistic screening is cost-effective. Partially Supported. Cost-effective for global brands at scale. Dubiously cost-effective for smaller brands launching in fewer markets.

You must have the .com. Partially Supported, mostly Contradicted at scale. Trust penalty is real but small. Many successful brands operate on alternative TLDs in tech-fluent audiences. The "must have" framing is mostly mythology amplified by domain brokers and naming firms.

Premium .com domains are worth six to seven figures. Supported. Documented sales record. Market is real and active.

Alternative TLDs carry meaningful trust penalty. Partially Supported. True for unfamiliar TLDs in cold-traffic contexts. Not true for normalized TLDs (.io, .ai) within their target audiences.

The .com tax forces brands toward coined names. Partially Supported. Pattern is real. Causality is partial. The .com scarcity contributes to but does not solely explain the coined-name trend.

Handle consistency across platforms matters for brand recognition. Untested in rigorous outcome studies. Practitioner intuition. Many successful brands have inconsistent handles.

Handle squatting prevents brands from operating on platforms. Partially Supported. Real friction exists. Trademark-based reclaim is available though slow. Brands routinely operate with sub-optimal handles.

Memorable names drive organic discovery. Contradicted. Discovery is downstream of marketing, not driven by name memorability in most studied cases.

Distinctive names win SEO competition. Partially Supported. Distinctive wins own-brand search. Descriptive wins category-search exposure. Choice is category-conditional.

Voice search demands pronunciation-friendly names. Partially Supported. Pronunciation effects on voice search are real but small. Voice-search adoption has stabilized lower than forecast.

AI search will replace traditional search; brands must adapt naming methodology now. Partially Supported, possibly Overstated. Directional claim has support. Urgency and magnitude are contested. Most GEO content is marketing.

AI search penalizes names that collide with existing entities. Untested for commercial outcomes. Structural problem is real. Magnitude is unmeasured. Forward-looking concern.

Naming engagements should include AI-search optimization audits. Untested. Industry has begun offering this. Rigorous evidence on value is absent.

The aggregate pattern: practitioner claims in the digital territory follow the same shape as the older industry claims. Heavily marketed. Modestly supported by rigorous evidence. Structurally similar overstatement of effect sizes. The tool's copy must avoid replicating this pattern.

## Industry working conventions

What naming firms actually do, separated from what they market. This is implementation reality, not best-practice prescription. The patterns are reported as observed, with no claim that they should be copied.

Input parameters from clients converge on a consistent shape: strategic positioning, target audience, brand attributes or personality, category context and competitive set, voice or tonality preferences (sometimes explicit, sometimes implicit), messaging hierarchy where applicable, trademark constraints and existing intellectual property, domain availability constraints (modern firms; older firms still treat as secondary), and market reach or international plans for global engagements. Variation is in emphasis, not structure.

Working units of generation vary by firm. The dominant pattern is "themes" or "territories" or "creative spaces." Firms organize generation around strategic axes (premium versus accessible, technical versus human) and produce named candidates within each space. Typology buckets are less common as the primary organizing structure. Flat candidate lists with attribute tagging are used by some. Iterative small batches with immediate feedback are common in shorter engagements. Nested parent-child structures (one stem with many variants) are not standard practice anywhere documented. Some firms use stem-based generation as a generation technique but do not deliver nested structures to clients. The 10-categories-by-10-variants nested structure that the tool's earlier prompt used is not standard practice in the industry.

Output volumes per engagement: hundreds to thousands of candidates generated, narrowed to 50 to 300 candidates in first review, presented to client in batches of 5 to 30 finalists per round, with multiple rounds. Total candidates seen by client across all rounds typically 30 to 100. Most firms publish more candidates internally than they show clients.

Organizing structures applied to candidate lists in client delivery: thematic groupings dominant, occasional typology buckets, less common strategic-positioning groupings. Most firms present finalist names with strategic argument per name, not just the name.

Creative range as engineering input: multi-axis tonality framing dominant. Common axes include serious to playful, classical to modern, descriptive to abstract, technical to emotional, conservative to bold. Single-axis "creativity" framing (the original tool's approach) is not standard. Some firms use it informally but do not document it.

Number of rounds: small engagements 1 to 2 rounds, mid-tier 2 to 3, top-tier 3 to 4 with intermediate working sessions.

Engagement length: crowdsourced 1 to 4 weeks, boutique 4 to 8 weeks, mid-tier 6 to 16 weeks, top-tier 12 to 24 weeks.

Validation: most firms do not have a formal post-launch validation process. Lexicon and Interbrand do some post-launch tracking; results are not published. Squadhelp and crowdsourced platforms publish portfolio outcomes with selection bias. The systematic feedback loop from outcomes to methodology is weak across the industry. This is a real arbitrage opportunity, in the sense that any tool that ships with even a basic outcome-tracking mechanism would have something the entire industry lacks.

Domain strategy in current practice: domain availability check is now standard at most professional engagements. Premium domain budget is often reserved separately from the engagement fee, with typical reservations of 25,000 to 250,000 dollars for mid-stakes engagements and 500,000 dollars and up for high-stakes engagements. Acquisition negotiations are sometimes handled by the naming firm and sometimes by separate domain brokers (Sedo, GoDaddy Domain Investments) at 10 to 15 percent of acquisition price. Most firms now treat .io and .ai as legitimate options for tech and AI brands. The .co and .net are less commonly recommended. Vanity TLDs are rarely recommended for primary brand domain.

Handle strategy in current practice: major-platform handle availability check is included in most modern engagements. Handle reservation before name finalization is recommended by some firms and discouraged by others to avoid signaling. The dominant variation pattern when preferred handle is unavailable: brand-plus-descriptor (most common), underscore additions, "the" or "we" prefix. App store name reservation is included in some engagements for app-first brands.

SEO consideration in current practice: SEO audit increasingly included in pre-finalization checks at mid-tier and above. Branded-search-volume baseline established for some brands during diligence. Voice-search compatibility check sometimes included with varying methodology. Keyword-conflict check sometimes included.

AI search adaptation in current practice: some firms have added "AI mention audit" or "GEO check" services in 2023 and 2024. Service definitions vary. The service is too new to have established methodology or pricing norms. Most engagements do not yet include AI-search work as standard.

The aggregate finding from this section: the industry has integrated domain availability and primary-handle availability into core practice. SEO consideration is integrated at mid-tier and above but methodology varies. AI-search work is emerging and not yet standardized. The integration is uneven across firms and rarely well-documented. As with the earlier industry findings, documented practice is heuristic and craft-based rather than research-driven.

## What this means for the tool

The synthesis above is the source of truth. This section translates it into operating commitments. Product decisions cite these commitments rather than re-deriving them.

Position 1: naming as one variable. The funnel's value proposition is honesty about effect sizes. The tool reports availability rigorously, applies evidence-grounded creative input with appropriate magnitude language, and explicitly positions naming as one of several variables in commercial outcomes. The tool does not claim that a great name builds a great brand. It does not promise commercial outcome differential. It does not market AI-search optimization features that lack evidence. This commitment is structural, not stylistic. Every piece of copy, every recommendation, every methodology section in the gated report follows from it.

Three deliverables, defined by what the evidence supports.

First deliverable: rigorous binary-feasibility checks. Domain availability across the user-selected TLDs, with real-time Registration Data Access Protocol (RDAP) lookups and pricing where the data is available. Primary-handle availability across major platforms (X/Twitter, Instagram, TikTok, LinkedIn, YouTube, Threads). Premium-domain pricing surfaced when the .com is taken but available for acquisition. App store name availability for app-first brands. The user sees the gates and decides. The tool does not score names higher or lower based on these results; it reports them.

Second deliverable: evidence-grounded creative input. Generation that draws from the typology that survived disconfirmation in Task 1 (descriptive, suggestive, associative or metaphoric, abstract or coined, with founder and acronymic and geographic as additional types). Sound-symbolism principles applied where the evidence supports them. Working memory length caps observed. Imageability and concreteness preferred for first-encounter recall where the brand benefits from it. Disfluency permitted as a deliberate choice for premium positioning. Single-axis creativity replaced with multi-axis tonality framing per industry working conventions. Rationales required to identify the actual mechanism (memorability hook, positioning angle, or sound-shape reason) rather than restating etymology.

Third deliverable: explicit positioning that names are one variable. The gated report includes a methodology section that names this directly. The empirical anchor is stated. The Quibi case is referenced as the cleanest demonstration that even gold-standard naming methodology cannot rescue a flawed product. The user sees that the tool is not selling them a guarantee.

What the tool does not deliver, with reasoning.

Commercial outcome guarantees. Empirical anchor does not support these. Any claim that a name will drive specific commercial outcomes is overstating what the evidence permits.

AI-search optimization features. The evidence base is thin. Most GEO content is marketing. Adding features that depend on this evidence is theater. Revisit in two to three years when the field matures.

Brand voice integration as a primary feature. Deferred from Task 3 with reasoning. The literature treats brand voice as primarily strategic-positioning craft, not primarily a digital concern. The phonetic profile of a name does constrain the voice register the brand can credibly inhabit (a hard-plosive name does not pair with a contemplative voice), and that constraint can inform generation, but voice as a standalone feature is not part of the tool's scope.

Fifty-language linguistic vetting. The base rate of name-related cross-cultural failures is 1 to 3 percent of major launches. The tool's audience (consultants, freelancers, small business founders, solo operators) is not Mitsubishi launching in Spanish-speaking markets. Cross-cultural screening would be marketing theater that does not serve the actual users. If the tool eventually serves global brand launches at scale, this can be revisited.

Outcome guarantees on handle consistency. Untested in rigorous outcome studies. Treated as transparency reporting, not as a screening filter. Names with inconsistent handle availability are not penalized in ranking.

Voice-search compatibility scoring as a primary feature. Voice-search adoption stabilized lower than forecast. The effects are small in current markets. Mentioned in copy where relevant; not a scoring axis.

Scope decisions follow from the deliverables.

Audience: solo operators, consultants, freelancers, small business founders. Not Fortune 500 launches. Not pre-launch consumer testing. Not rebranding consultations. Not global launches at scale. The audience constraint matters because it determines which deliverables are honest. Premium .com acquisition costs of 50,000 to 500,000 dollars are not actionable for this audience. The tool's domain availability surface should prioritize names with available .com (or genuinely affordable acquisition options) over names whose acquisition costs exceed the user's likely budget.

Output structure: the 10-by-10 nested structure was a working hypothesis, not a research finding, and the industry working conventions show no precedent for it. The combined evidence supports a typology-based output organized by the survived classification (descriptive, suggestive, associative or metaphoric, abstract or coined, with optional secondary types). Output volume per generation should match the practitioner pattern: hundreds of candidates generated internally, narrowed to a smaller set for client (here, user) review with multiple options to refine. Specific implementation choices are downstream product decisions; the methodology constraint is that the structure reflect what the evidence supports rather than the original shotgun.

The dial: single-axis creativity is contradicted by industry practice. Replace with multi-axis tonality framing. Suggested axes from the working conventions: serious to playful, classical to modern, descriptive to abstract, technical to emotional, conservative to bold. The user gets sensible defaults and a customization layer that exposes the axes for users who want them. Hover descriptions on the axes can carry educational copy that turns the form into trust-building (the user learns what each axis means by hovering).

Scoring rubric: the original 10-axis scoring was a working hypothesis. The combined evidence supports specific axes (memorability hook quality, positioning fit to brief, sound-shape match to category, fluency at the desired register, distinctiveness within the category competitive set, length and complexity within working-memory bounds, trademark protectability per the Abercrombie spectrum, domain availability or affordability, primary-handle availability, voice-readability where relevant). Specific weights and implementation are downstream product decisions; the methodology constraint is that scoring axes correspond to evidence, not invented rigor.

Funnel structure: scope-as-gate. Preview is ungated and shows a small number of names with availability and rationale. Gated full report shows the full output with scoring, methodology section, and the explicit "naming as one variable" framing. Email capture between preview and report. Brevo for lead handoff. Same engine throughout. Preview and report are differentiated by scope, not by quality of analysis. The preview is genuinely useful, not bait.

Methodology document publication: this synthesis (after some editing for public consumption) becomes a public methodology page on the site, linked from the gated report. The methodology page is itself a funnel asset. A user who reads it sees a tool grounded in real evidence rather than vibes. The page differentiates the tool from every other naming generator that does not show its work.

Outcome tracking: the industry's validation gap is a real arbitrage opportunity. The tool can ship with optional outcome tracking (the user picks a name, the tool emails them in 90 or 180 days asking how it worked out, the responses inform future tool tuning) without requiring it. Even basic tracking would be more than the industry has. This is a feature decision for later phases, not the next phase, but worth flagging here so it does not get lost.

## Open questions and conditions for further research

The combined three-task network is sufficient for product work. The remaining gaps are real but smaller than what has been mapped. Specific conditions under which a Task 4 might be commissioned.

Pre-launch testing methodology. Naming firms claim to "test" finalist names but the testing methodology varies and is rarely empirically validated. A task on consumer-testing methodology for names (focus groups, surveys, conjoint analysis, A/B testing in market) would address how names get validated before launch and whether the methodology produces predictive outcomes. Commission this Task 4 only if the tool moves toward integrating pre-launch validation features for users. Not required for the current scope.

Rebranding outcomes. Task 2 touched on this in the empirical-anchor discussion. A dedicated task on corporate rebranding outcomes would deepen the empirical anchor. Specific subjects would include what fraction of rebrandings produce measurable outcome changes, what determines rebrand success, and what the cost structure of rebranding is. Commission only if the tool moves toward serving rebranding use cases.

Deeper memorability cognition. Task 1 noted that the cognitive memory literature is vast and most has not been applied to commercial naming. Dual-coding theory, schema-fit research, recognition-versus-recall asymmetries, and broader memory science would produce more specific predictions for naming if pursued. The size of this gap relative to product needs is small. The redesigned tool can probably proceed without deeper cognitive work. Commission Task 4 against this only if the prompt-redesign work surfaces specific cognitive-mechanism questions the existing network cannot answer.

Brand voice and name-system interaction. Deferred from Task 3 with reasoning. The literature is sparse and mostly strategic-positioning craft rather than digital concern. Commission only if the prompt-redesign work surfaces voice-related questions that require dedicated research.

AI search and named-entity disambiguation. Included in Task 3 with explicit thin-evidence flagging. The recommendation is to monitor rather than research. Subscribe to GEO and entity-linking research outputs. Do not commission a focused task until the empirical base improves substantially. Revisit in two to three years.

The decision on whether to commission Task 4 should follow the downstream product work rather than precede it. Build the redesigned prompt and methodology against this synthesis. Surface specific gaps that the redesign cannot resolve. Commission Task 4 against those specific gaps if any emerge. This sequencing avoids over-researching against speculative needs.

## Document maintenance

This document is the source of truth for the tool's methodology. It is current as of the synthesis date and reflects the combined network from Tasks 1, 2, and 3. It will be updated when any of the following happens.

Task 4 (or further tasks) is commissioned and produces findings that bear on the evidence base. The new findings get integrated into the relevant sections.

A specific claim in this document is challenged by new evidence (a study, a real-world case, a domain change). The challenge gets investigated and the document gets updated with the resolution.

The tool's product decisions diverge from what this document supports. The divergence is either reconciled (the document is wrong and gets updated) or flagged (the product decision is going beyond what the evidence supports and that fact is documented in the relevant product decision).

The brand of the tool is locked in product Phase 4. The document path and codebase identifier rename from "naming" to the chosen brand at that point.

The document is not a finished artifact. It is a working source of truth that gets edited as the tool evolves and as the evidence base evolves.
