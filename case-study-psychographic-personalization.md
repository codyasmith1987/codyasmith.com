# Case Study: Building a Psychographic Personalization Engine from a Sysadmin's Lunch Break Feedback

## The Starting Point

A sysadmin named Kevin looked at codyasmith.com during a conversation at work and gave six pieces of feedback:

1. The sentiment scanner should show the user it's working
2. The personality quiz should show site changes happening behind a blur as choices are made
3. The word "gap" should squeeze like an iOS text animation
4. The word "outgrew" should look dated — rusted, aged
5. The header needs more visual separation
6. Two new color palettes: "Dracula" and "Mononoke"

These sound like a designer's punch list. Visual tweaks. CSS work. A day of implementation, maybe two.

That's not what happened.

---

## What Actually Happened

The conversation started with Kevin's feedback but immediately went deeper. The site already had a personality quiz — three binary questions (Sun or Moon? Beach or Mountain? Spring or Fall?) that set one of eight color themes. Kevin's suggestion to add Dracula and Mononoke palettes raised a question: how should those map to the quiz?

That question opened a door into consumer psychology that changed the entire project.

### The First Wrong Turn

The initial instinct was to design a fourth quiz question that would route users toward Dracula (for technical/analytical visitors) or Mononoke (for organic/craft-oriented visitors). Candidate questions were proposed: "Garden or Workshop?" "Terminal or Canvas?" "Clock or Compass?"

These were rejected. Not because they were bad questions, but because they violated the design principle that made the original quiz work.

### Why "Sun or Moon?" Works

The original three questions aren't preference settings. They're **projective techniques** — the same mechanism behind Kokology, the Japanese psychology game system built on Jungian principles. A projective technique works by presenting an ambiguous, archetypal stimulus. The person responds from their subconscious identity, not their analytical mind. The connection between their answer and what it reveals is invisible to them.

"Sun or Moon?" doesn't ask "do you prefer light mode or dark mode?" It asks which celestial body you identify with. People have deep, gut-level attachments to being a "sun person" or a "moon person" that connect to introversion/extraversion, energy patterns, and how they process the world. The design preference (light vs dark theme) falls out of the identity preference unconsciously.

The proposed fourth questions — "Terminal or Canvas?", "Clock or Compass?" — failed because they were transparent. A technical person picking "Terminal" knows exactly what they're signaling. There's no projection. The unconscious identity layer is bypassed. It's a settings menu wearing a metaphor costume.

### The Design Principle

This realization established the governing principle for the entire project:

**Psychology first. Questions second. Themes third. Copy fourth. Never the reverse.**

You don't start with "we want Dracula and Mononoke" and work backward to a question that routes there. You start with "what psychological axis is missing?" and let the themes emerge from whatever the answers reveal.

---

## The Psychological Framework

Research into persuasion psychology revealed that the original three quiz questions were already doing real psychographic segmentation — they just weren't being used for anything beyond color themes.

### What Each Question Actually Captures

**Q1: Sun or Moon? — Regulatory Focus Theory (E. Tory Higgins, Columbia)**

People are either promotion-focused (motivated by gains, aspirations, what's possible) or prevention-focused (motivated by avoiding losses, maintaining security, fixing what's broken). Research shows that gain-framed messages are significantly more persuasive to promotion-focused people, and loss-framed messages are significantly more persuasive to prevention-focused people.

- Sun = promotion-focused. Forward energy. "Here's what's possible."
- Moon = prevention-focused. Reflective vigilance. "Here's what's at risk."

**Q2: Beach or Mountain? — Cialdini's Principles of Influence**

Cambridge research on environmental psychology found that landscape preference correlates with Big Five personality traits. Coastal preference correlates with openness to experience; mountain/inland preference correlates with conscientiousness. Research on Cialdini's influence principles found that high-openness people respond to social proof and competitive framing, while high-conscientiousness people respond to authority and commitment.

- Beach = social proof. "Your competitor just showed up on page one."
- Mountain = authority. "I take over the infrastructure."

**Q3: Spring or Fall? — Construal Level Theory (Trope & Liberman)**

When people are psychologically distant from a decision, they process in abstract terms ("why should I?"). When they're close to a decision, they process in concrete terms ("how does this work?"). Spring is beginning energy — potential, possibility, nothing decided yet. Fall is harvest energy — experienced, knows what's not working, ready to act.

- Spring = abstract construal. Vision, direction, "why" messaging.
- Fall = concrete construal. Specifics, process, "how" messaging.

### The Missing Axis

Three axes captured energy/approach, spatial orientation, and temporal phase. The fourth framework not yet represented was the **Elaboration Likelihood Model** (Petty & Cacioppo) — specifically, Need for Cognition. This describes how deeply someone processes information before being persuaded.

High NFC people process through the central route: they want data, evidence, logical argument. They're persuaded by the strength of the argument itself. Low NFC people process through the peripheral route: they're persuaded by trust signals, character, narrative, voice. Not less intelligent — differently wired. The story IS the proof.

This is the most important axis for copy personalization because it determines whether credibility comes from numbers or from narrative.

### Designing Q4: Stars or Clouds?

The question needed to meet the same projective criteria as the original three:

1. Natural and elemental, not man-made
2. Universally understood, no cultural barrier
3. Both options equally appealing — no "right answer"
4. Deep gut-level identification
5. Invisible mapping to the psychological axis

Three candidates were developed:

- **Stars or Clouds?** — Stars = individual points, mappable, precise, navigational (analytical). Clouds = shapes, atmosphere, mood, always changing (experiential).
- **Roots or Canopy?** — Both parts of the same tree. Roots = hidden structure (analytical). Canopy = responsive, sensory (experiential). Concern: overlap with Mountain axis.
- **Still water or Running water?** — Still = reflective, deep, study it (analytical). Running = flowing, trust it (experiential). Concern: overlap with Beach axis.

**Stars or Clouds** was selected. It has the strongest identity resonance ("I'm a stars person" is something people feel), both options are universally beautiful, and the mapping is invisible. It completes the quiz's poetry: Sun or Moon, Beach or Mountain, Spring or Fall, Stars or Clouds — four elemental questions that feel like one unified personality exploration.

---

## The Personalization Architecture

### The Problem with 16 Versions

Four binary questions produce 16 possible combinations (2^4). Writing 16 complete versions of every page on the site is unmaintainable and creates content drift. A moon-mountain-fall-stars edit would need to be replicated across 15 siblings.

### The Composable Solution

Instead of 16 page versions, each axis controls one aspect of the copy independently through HTML data attributes:

```
data-frame="sun|moon|default"          — Lead sentence framing (gain vs loss)
data-vibe="beach|mountain|default"     — Evidence style (social proof vs authority)
data-phase="spring|fall|default"       — Detail level (abstract/why vs concrete/how)
data-processing="stars|clouds|default" — Credibility (data/metrics vs story/trust)
```

Each personalizable section has 2-3 swappable elements for the 1-2 axes that matter most in that section. A single runtime function shows/hides elements by matching each axis independently. The system composes naturally without multiplication.

### Three Things That Shift Per Persona

Rather than rewriting every word, three high-impact elements shift:

1. **What leads each section** — The first sentence someone reads. This is where Regulatory Focus framing lives. Sun visitors see the gain sentence first. Moon visitors see the loss sentence first.

2. **What proof looks like** — Which examples, metrics, or stories get emphasis. Beach visitors get competitive evidence. Mountain visitors get systems evidence. Stars visitors get numbers. Clouds visitors get narrative.

3. **What the CTA says** — The action language. A sun visitor hears "Let's build something." A moon visitor hears "Let's fix this." Both land on the same contact form through different doors.

### The Voice Constraint

Every variant must still be the same person speaking. This isn't A/B testing generic marketing copy. It's editorial sequencing — choosing which facet of an authentic voice to lead with based on which facet each listener is most likely to trust.

The site's copy already contained all four registers naturally (the author instinctively modulates). The personalization system doesn't create new voice — it selects which existing voice to present first.

---

## The Visual Experience

### Quiz as Frosted Glass

Kevin's original suggestion — show changes happening behind a blur — became the quiz's defining interaction. The opaque overlay was replaced with a translucent backdrop-blur. As each answer is selected, the theme applies to the page in real-time behind the frost. The visitor watches their choices reshape the environment before the blur lifts.

A slow-rotating conic gradient ("the swirl") overlays the frosted glass using theme accent colors via CSS custom properties. As the partial theme updates with each answer, the swirl shifts color. It feels like something forming rather than something filtering.

The reveal sequence replaces a simple fade with a three-stage transition: blur lifts (the site resolves), swirl fades (the formation is complete), quiz container disappears (you're in the room that was set for you).

### Kinetic Typography

Two words in the site's hero copy received treatments where the visual performs the meaning:

- **"outgrew"** — Styled with a `--color-dated` CSS variable unique to each of the 16 themes. The color evokes oxidation, rust, patina — something that was once vital but has aged. Each theme's dated color fits its palette character.

- **"gap"** — A CSS scaleX compression animation triggered by IntersectionObserver when the element scrolls into view. The word physically squeezes, closing in on itself, then springs back. The compression performs the concept of closing a gap.

### Name in Hero

The visitor's first name (captured during the quiz lead-capture step) appears at the start of the hero headline on return visits: "Kevin, your business outgrew its website a while ago." One word. Immediate payoff from the quiz. The site speaks to you by name before you scroll.

---

## The Theme System

### 16 Palettes from Psychology, Not Preference

The 16 themes weren't designed as 16 independent color schemes. They were designed as a matrix where each combination of four psychological axes produces a palette that feels like the person it represents:

- **Stars variants** — Sharper. More precise. Cooler undertones. Higher saturation on accents. The visual equivalent of analytical clarity.
- **Clouds variants** — Softer. More atmospheric. Warmer undertones. Earthier accents. The visual equivalent of experiential immersion.

Kevin's Dracula and Mononoke suggestions didn't become 1:1 theme assignments. They became influences that naturally emerged in certain quadrants of the matrix. The moon-beach-spring-stars combination carries Dracula's DNA (dark, cool, high-contrast, saturated). The moon-mountain-fall-clouds combination carries Mononoke's DNA (dark, earthy, warm, organic). But neither was forced. The psychology created the space for them to exist.

---

## The Listener: Real Progress

Kevin's feedback that the sentiment scanner should "show the user it's working" led to converting the scan endpoint from a single POST-and-wait to Server-Sent Events streaming. The server now emits real progress events as each stage completes:

- "Found 14 mentions across the web" (search complete)
- "Read 14 pages" (scraping complete)
- "Sentiment analysis complete — score: 72" (analysis complete)
- "Report ready!" (final)

The previous implementation used fake setTimeout timers (3 seconds, 8 seconds) to simulate progress while the real API call ran. The SSE approach replaced simulation with reality. The user sees what's actually happening because it's actually happening.

---

## Architecture Summary

### Files Modified
- `Quiz.astro` — 4 questions, frosted glass overlay, real-time theme preview, swirl effect, sequenced reveal
- `Base.astro` — Composable personalization runtime (4 axis swap loops), squeeze animation observer, hero name injection, theme migration
- `global.css` — 16 theme palettes with `--color-dated`, swirl animation keyframes, kinetic typography classes, nav shadow
- `quiz.ts` — Q4 labels in Brevo email notification
- `scan.ts` — SSE streaming replacing single POST response
- `listener.astro` — Stream reader replacing fake timer progress
- `index.astro` — Copy variants (data-frame, data-phase, data-processing), kinetic word treatments, hero name
- `services.astro` — Frame variants on subtitle and CTA
- All 4 service detail pages — Frame variants on hero paragraphs
- `contact.astro` — Frame variants on heading, processing variants on body
- `about.astro` — Frame variants on CTA
- `work.astro` — Processing variants on hero (data vs narrative emphasis)

### Data Flow
1. First-time visitor sees frosted quiz overlay
2. Each answer stores in memory AND applies partial theme behind blur
3. Lead capture (name + email) sends to Brevo via API
4. Theme string saved to localStorage: `{sun|moon}-{beach|mountain}-{spring|fall}-{stars|clouds}`
5. Quiz answers saved to localStorage as JSON object
6. On every page load, `initPersonalization()` reads answers and shows/hides variant content by matching each axis independently
7. Returning visitors see name in hero, correct theme, personalized copy — no quiz

### Backward Compatibility
- Existing visitors with 3-part theme names: migration script appends `-stars` as default
- Quiz-skip visitors: all `default` variants show, base theme applies
- No-quiz visitors: standard experience, no personalization, no data collected

---

## What This Project Is Actually About

This started as "add some visual polish based on Kevin's feedback." It became a psychographic personalization engine that uses projective psychology to capture four axes of visitor identity, maps each axis to a validated persuasion framework, and editorially sequences a single authentic voice to lead with the facet each visitor is most likely to trust.

The color themes are real. The animations are real. The SSE progress is real. But the actual product is the invisible layer: a website that reads the room.

Every visitor who takes the 15-second quiz is unknowingly telling you:
- Whether they're motivated by possibility or by risk avoidance
- Whether they respond to competitive positioning or systems reliability
- Whether they're in early-stage exploration or ready-to-act mode
- Whether they trust data or trust story

And the site adapts — not with different words in different fonts, but with the same person's voice tuned to the frequency each listener actually hears on.

The technical implementation is ~700 lines of changes across 14 files. The strategic framework behind those lines took an entire conversation to develop, grounded in Higgins' Regulatory Focus Theory, Cialdini's Principles of Influence, Trope and Liberman's Construal Level Theory, and Petty and Cacioppo's Elaboration Likelihood Model.

Kevin said the quiz was "cool." He doesn't know what it became.

---

## Timeline

One session. Research, strategy, design, implementation, and deployment. Two commits. Live in production.

## Tools and Frameworks Referenced

- **Regulatory Focus Theory** — E. Tory Higgins (Columbia University)
- **Six Principles of Influence** — Robert Cialdini
- **Construal Level Theory** — Yaacov Trope & Nira Liberman
- **Elaboration Likelihood Model** — Richard Petty & John Cacioppo
- **Kokology** — Tadahiko Nagao & Isamu Saito (projective technique design)
- **Environmental Preference and Personality** — Cambridge University research
- **Need for Cognition** — Epstein's Cognitive-Experiential Self-Theory
- **Big Five Personality Traits** — susceptibility to persuasion principles (Oyibo et al.)
