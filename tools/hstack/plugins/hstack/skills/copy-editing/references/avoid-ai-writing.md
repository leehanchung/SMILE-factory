# Avoid AI Writing — Pattern Reference

> Source: [conorbronsdon/avoid-ai-writing](https://github.com/conorbronsdon/avoid-ai-writing) (MIT License)
> A portable writing audit tool that identifies and removes 36 categories of AI-generated writing patterns.

---

## Modes

**Rewrite mode** (default): Flag every AI-ism, rewrite clean, show diff summary.

**Detect mode**: Flag every AI-ism with severity (P0/P1/P2), cite exact text, note whether contextually defensible. Trigger phrases: "detect," "flag only," "audit only," "just flag," "scan," "what AI patterns are in this."

---

## Severity Tiers

### P0 — Credibility Killers (Fix Immediately)

- Cutoff disclaimers ("As of my last update")
- Factual inaccuracy or unverified claims
- Vague attributions without sources
- Reasoning chain artifacts visible in final text
- Chatbot artifacts ("I hope this helps!")

### P1 — Obvious AI Smell (Fix Before Publishing)

- Tier 1 words (all 60+ terms)
- Em dashes (more than one per 1,000 words)
- Title case headings
- Emoji in headers
- Superficial -ing analyses
- Formulaic challenges
- Generic conclusions
- Novelty inflation
- "Let's" constructions (false collaborative openers)

### P2 — Stylistic Polish (Fix When Time Allows)

- Tier 2 words (when 2+ appear in same paragraph)
- Excessive bullet lists
- Mechanical filler phrases
- Synonym cycling
- Parenthetical hedging
- Rhetorical question openers
- Emotional flatline (unsupported claims)
- False concession structure

---

## All 36 Patterns

### Content Patterns (7)

**1. Significance inflation**
Replaces understated facts with grandiose framing.
- Bad: "marking a pivotal moment"
- Fix: State what happened plainly ("was founded in 2019 to solve X")

**2. Notability name-dropping**
Lists prestigious outlets without context.
- Bad: "cited in NYT, BBC, and Wired"
- Fix: Use one specific reference with context ("In a 2024 NYT interview, she argued...")

**3. Superficial -ing analyses**
Uses gerunds for vague observations.
- Bad: "symbolizing... reflecting... showcasing..."
- Fix: Replace with specific facts or cut entirely

**4. Promotional language**
Applies adjectives that market rather than describe.
- Bad: "nestled within the breathtaking region"
- Fix: Plain description ("is a town in the Gonder region")

**5. Vague attributions**
Sources claims to undefined groups.
- Bad: "Experts believe it plays a crucial role"
- Fix: Name the expert/study ("according to a 2019 survey by Gartner")

**6. Formulaic challenges**
Presents obstacles without specificity.
- Bad: "Despite challenges... continues to thrive"
- Fix: Name the challenge and response

**7. Novelty inflation**
Overstates the originality of mundane observations.
- Bad: "He introduced a term I hadn't heard before"
- Fix: Describe what person did with the concept ("He walked through how X works")

### Language Patterns (7)

**8. Word/phrase replacements (3 tiers)**
Replaces plain words with inflated alternatives. See the vocabulary table below.
- Bad: "leverage... robust... seamless... utilize"
- Fix: "use... reliable... smooth... use"

**9. Copula avoidance**
Circumlocutes simple "is/has" constructions.
- Bad: "serves as... features... boasts"
- Fix: "is... has"

**10. Synonym cycling**
Repeats concepts with different synonyms paragraph to paragraph.
- Bad: "developers... engineers... practitioners... builders"
- Fix: Repeat the clearest word; forced variation reads as thesaurus abuse

**11. Template phrases**
Uses fill-in-the-blank patterns.
- Bad: "a [adj] step towards [adj] infrastructure"
- Fix: Describe the specific outcome

**12. Filler phrases**
Adds unnecessary words.
- Bad: "In order to," "Due to the fact that," "It is important to note that," "In terms of," "The reality is"
- Fix: "To," "Because," or cut entirely

**13. False ranges**
Frames unrelated items as a spectrum.
- Bad: "from the Big Bang to dark matter"
- Fix: List the actual topics or pick the one that matters

**14. Parenthetical hedging**
Hides specifics in asides.
- Bad: "tools (like X and Y)"
- Fix: Name them directly or cut

### Structure Patterns (9)

**15. Formatting overuse**
Overuses em dashes, bold text, emoji headers, bullet lists.
- Rule: Zero em dashes preferred. Hard max: one per 1,000 words. One bolded phrase per major section at most. No emoji in headers. Convert bullet-heavy sections into prose.

**16. Sentence structure issues**
Employs negation framing with intensifiers and hedging.
- Bad: "It's not X — it's Y," hollow intensifiers (genuine, real, truly, quite frankly, to be honest), hedging (perhaps, could potentially, to be clear)
- Fix: Direct positive statements. Max one "It's not X — it's Y" per piece.

**17. Structural uniformity**
Creates uniform paragraphs and formulaic openings with over-polished grammar.
- Fix: Vary paragraph length deliberately; include 1-2 sentence paragraphs; lead with news/insight, context second

**18. Transition phrase overuse**
Relies on stiff connectors.
- Bad: "Moreover," "Furthermore," "Additionally," "In today's [X]," "When it comes to," "At the end of the day," "That said"
- Fix: "and," "also," or restructure the sentence

**19. Inline-header lists**
Repeats the header text in the following sentence.
- Bad: "**Speed:** Speed improved by..."
- Fix: Write the point directly

**20. Title case headings**
Capitalizes each word in headers.
- Bad: "Strategic Negotiations And Partnerships"
- Fix: Use sentence case ("Strategic negotiations and partnerships")

**21. Numbered list inflation**
Presents excessive items when fewer would suffice.
- Bad: "Here are 7 reasons why..."
- Fix: Cut to the 2-3 that matter; vary list lengths and densities

**22. False concession**
Acknowledges limitations while immediately dismissing them.
- Bad: "While X has limitations, it's still remarkable"
- Fix: Make both halves specific or pick a side — state real tradeoffs

**23. Rhetorical question openers**
Opens with leading questions.
- Bad: "What if there were a better way to...?"
- Fix: Lead with the claim; if you know the answer, just say it

### Communication Patterns (9)

**24. Chatbot artifacts**
Includes assistant pleasantries.
- Bad: "I hope this helps! Let me know if..." / "Certainly!" / "Feel free to reach out"
- Fix: Remove entirely

**25. "Let's" constructions**
Uses collaborative framing unnecessarily.
- Bad: "Let's explore," "Let's break this down," "Let's dive in!"
- Fix: Start with the point

**26. Cutoff disclaimers**
Acknowledges missing information instead of finding it.
- Bad: "While details are limited in available sources..." / "As of my last update"
- Fix: Find the information or remove the hedge; never admit you didn't look

**27. Generic conclusions**
Ends with platitudes.
- Bad: "The future looks bright," "Only time will tell," "In conclusion," "In summary"
- Fix: Specific closing or cut; your conclusion should be obvious

**28. Emotional flatline**
Claims surprise without earning it.
- Bad: "What surprised me most," "I was fascinated to discover"
- Fix: Writing must earn the emotion; otherwise cut

**29. Reasoning chain artifacts**
Explains thinking process in output.
- Bad: "Let me think step by step," "Breaking this down"
- Fix: State conclusion first, then evidence; remove visible chain-of-thought scaffolding

**30. Sycophantic tone**
Flatters the reader.
- Bad: "Great question!", "You're absolutely right!"
- Fix: Remove entirely; let reader judge significance

**31. Acknowledgment loops**
Restates the question before answering.
- Bad: "You're asking about," "To answer your question," "I acknowledge/understand"
- Fix: Answer directly

**32. Confidence calibration issues**
Adds unnecessary emphasis or hedging.
- Bad: "It's worth noting," "Interestingly," "Surprisingly," "I believe," "I think," "It seems"
- Fix: Let facts speak; remove unless contextually necessary

### Meta Patterns (4)

**33. Excessive structure**
Uses too many headers for the content length.
- Bad: 5 headers in 200 words, "Overview:", "Key Points:"
- Fix: Merge sections, use specific headers; not every paragraph needs a topic sentence

**34. Rhythm and uniformity**
Maintains identical sentence length and paragraph structure throughout.
- Bad: All sentences 15-25 words
- Fix: Mix short and long sentences, fragments, questions; vary deliberately

**35. Over-polishing**
Creates perfectly sanded prose with no irregularity.
- Fix: Keep natural disfluency and varied rhythm; not everything needs to be grammatically pristine

**36. Rewrite-vs-patch threshold**
Determines when a full rewrite is needed vs. spot fixes.
- Rule: If 5+ vocabulary flags + 3+ pattern categories + uniform rhythm are present, advise a full rewrite rather than patching individual issues

---

## Vocabulary Replacement Table

### Tier 1 — Always Replace

| Replace | With |
|---------|------|
| delve / delve into | explore, dig into, look at |
| landscape (metaphor) | field, space, industry, world |
| tapestry | describe the actual complexity |
| realm | area, field, domain |
| paradigm | model, approach, framework |
| embark | start, begin |
| beacon | rewrite entirely |
| testament to | shows, proves, demonstrates |
| robust | strong, reliable, solid |
| comprehensive | thorough, complete, full |
| cutting-edge | latest, newest, advanced |
| leverage (verb) | use |
| pivotal | important, key, critical |
| underscores | highlights, shows |
| meticulous / meticulously | careful, detailed, precise |
| seamless / seamlessly | smooth, easy, without friction |
| game-changer / game-changing | describe what specifically changed |
| hit differently / hits different | say what specifically changed, or cut |
| utilize | use |
| watershed moment | turning point, shift, or describe |
| marking a pivotal moment | state what happened |
| the future looks bright | cut — say something specific |
| only time will tell | cut — say something specific |
| nestled | is located, sits, is in |
| vibrant | describe what makes it active, or cut |
| thriving | growing, active, or cite a number |
| despite challenges... continues to thrive | name challenge and response, or cut |
| showcasing | showing, demonstrating, or cut |
| deep dive / dive into | look at, examine, explore |
| unpack / unpacking | explain, break down, walk through |
| bustling | busy, active, or cite what makes busy |
| intricate / intricacies | complex, detailed, or name complexity |
| complexities | name actual complexities, or use "problems" |
| ever-evolving | changing, growing, or describe how |
| enduring | lasting, long-running, or cite duration |
| daunting | hard, difficult, challenging |
| holistic / holistically | complete, full, whole, or describe |
| actionable | practical, useful, concrete |
| impactful | effective, significant, or describe impact |
| learnings | lessons, findings, takeaways |
| thought leader / thought leadership | expert, authority, or describe contribution |
| best practices | what works, proven methods |
| at its core | cut — just state the thing |
| synergy / synergies | describe the actual combined effect |
| interplay | relationship, connection, interaction |
| in order to | to |
| due to the fact that | because |
| serves as | is |
| features (verb) | has, includes |
| boasts | has |
| presents (inflated) | is, shows, gives |
| commence | start, begin |
| ascertain | find out, determine, learn |
| endeavor | effort, attempt, try |
| keen (as intensifier) | interested, eager, or cut |
| symphony (metaphor) | describe actual coordination |
| embrace (metaphor) | adopt, accept, use, switch to |

### Tier 2 — Flag When 2+ in Same Paragraph

| Replace | With |
|---------|------|
| harness | use, take advantage of |
| navigate / navigating | work through, handle, deal with |
| foster | encourage, support, build |
| elevate | improve, raise, strengthen |
| unleash | release, enable, unlock |
| streamline | simplify, speed up |
| empower | enable, let, allow |
| bolster | support, strengthen, back up |
| spearhead | lead, drive, run |
| resonate / resonates with | connect with, appeal to |
| revolutionize | change, transform, reshape, or describe |
| facilitate / facilitates | enable, help, allow, run |
| underpin | support, form the basis of |
| nuanced | specific, subtle, detailed, or name nuance |
| crucial | important, key, necessary |
| multifaceted | describe actual facets, or cut |
| ecosystem (metaphor) | system, community, network, market |
| myriad | many, numerous, or give number |
| plethora | many, a lot of, or give number |
| encompass | include, cover, span |
| catalyze | start, trigger, accelerate |
| reimagine | rethink, redesign, rebuild |
| galvanize | motivate, rally, push |
| augment | add to, expand, supplement |
| cultivate | build, develop, grow |
| illuminate | clarify, explain, show |
| elucidate | explain, clarify, spell out |
| juxtapose | compare, contrast, set side by side |
| paradigm-shifting | describe what actually shifted |
| transformative / transformation | describe what changed and how |
| cornerstone | foundation, basis, key part |
| paramount | most important, top priority |
| poised (to) | ready, set, about to |
| burgeoning | growing, emerging, or cite number |
| nascent | new, early-stage, emerging |
| quintessential | typical, classic, defining |
| overarching | main, central, broad |
| underpinning / underpinnings | basis, foundation, what supports |

### Tier 3 — Flag Only at High Density

| Word | Action |
|------|--------|
| significant / significantly | Replace some with specifics: numbers, comparisons |
| innovative / innovation | Describe what's actually new |
| effective / effectively | Say how or cite a metric |
| dynamic / dynamics | Name the actual forces or changes |
| scalable / scalability | Describe what scales and to what |
| compelling | Say why it compels |
| unprecedented | Name the precedent it breaks, or cut |
| exceptional / exceptionally | Cite what makes it an exception |
| remarkable / remarkably | Say what's worth remarking on |
| sophisticated | Describe the sophistication |
| instrumental | Say what role it played |
| world-class / state-of-the-art / best-in-class | Cite a benchmark or comparison |

---

## Context Profiles

Adapt detection tolerance based on content type:

- **Published thought leadership**: Stricter on Tier 1; allow one measured use of paradigm/ecosystem
- **Technical documentation**: Flag vague hedging; allow "significant" if paired with metrics
- **Social media**: Emoji acceptable; "let's" more forgivable; shorter paragraphs expected
- **Academic/research**: Flag all Tier 1; flag copula avoidance; stricter on hedging
- **Product marketing**: Flag promotional language; relax on enthusiasm if grounded in features
- **Personal blog/memoir**: Allow more emotion; stricter on Tier 1; less strict on hedging

---

## Output Format

**Rewrite mode**: Show original flagged text in block quotes, explain fix, provide rewritten version.

**Detect mode**: List each flag with severity (P0/P1/P2), cite exact text, note whether it's a clear problem or contextually defensible.
