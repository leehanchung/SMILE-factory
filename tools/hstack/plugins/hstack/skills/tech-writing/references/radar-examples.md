# Annotated O'Reilly Radar Examples

This file contains annotated excerpts from published Radar articles demonstrating key patterns.

## Opening Hooks

### Pattern: Challenge Conventional Wisdom

**From "What MCP and Claude Skills Teach Us About Open Source for AI":**

> The debate about open source AI has largely featured open weight models. But that's a bit like arguing that in the PC era, the most important goal would have been to have Intel open source its chip designs. That might have been useful to some people, but it wouldn't have created Linux, Apache, or the collaborative software ecosystem that powers the modern internet.

**Why it works:**
- Acknowledges the current debate (open weight models)
- Pivots with "But that's a bit like..."
- Uses historical analogy to reframe
- Sets up the real thesis (architecture of participation matters more)

### Pattern: Competing Futures

**From "What If? AI in 2026 and Beyond":**

> The market is betting that AI is an unprecedented technology breakthrough, valuing Sam Altman and Jensen Huang like demigods already astride the world. The slow progress of enterprise AI adoption from pilot to production, however, still suggests at least the possibility of a less earthshaking future. Which is right?

**Why it works:**
- States the dominant narrative clearly
- Introduces tension with "however"
- Poses the question explicitly
- Creates stakes for the reader

## Historical Parallels

### Pattern: "This reminds me of..."

**From "What MCP and Claude Skills Teach Us":**

> MCP and Claude Skills remind me of those early days of Unix/Linux and the web. MCP lets you write small servers that give AI systems new capabilities such as access to your database, your development tools, your internal APIs, or third-party services like GitHub, GitLab, or Stripe.

**Structure:**
1. Explicit comparison ("reminds me of")
2. Name the historical reference
3. Draw the parallel concretely
4. Show why the parallel matters

### Pattern: Architecture of Participation

**From "What MCP and Claude Skills Teach Us":**

> This architecture of participation has a few key properties:
> - Legibility: You can understand what a component does without understanding the whole system.
> - Modifiability: You can change one piece without rewriting everything.
> - Composability: Pieces work together through simple, well-defined interfaces.
> - Shareability: Your small contribution can be useful to others without them adopting your entire stack.

**Why it works:**
- Introduces a named framework ("architecture of participation")
- Defines it concretely with properties
- Each property is actionable and testable
- Framework can be applied beyond the specific example

## Scenario-Based Analysis

### Pattern: Two Futures Framework

**From "What If? AI in 2026 and Beyond":**

> **Scenario one: AGI is an economic singularity**. AI boosters are already backing away from predictions of imminent superintelligent AI leading to a complete break with all human history, but they still envision a fast takeoff...
>
> **Scenario two: AI is a normal technology.** In this scenario, articulated most clearly by Arvind Narayanan and Sayash Kapoor of Princeton, AI is a powerful and important technology but nonetheless subject to all the normal dynamics of adoption, integration, and diminishing returns.

**Structure:**
1. Name each scenario explicitly
2. Attribute viewpoints to real people/sources
3. State the implications of each
4. Don't pre-judge which is correct

### Pattern: What to Watch For

**From "What If? AI in 2026 and Beyond":**

> **What to watch for:** What tech stack are developers and entrepreneurs building on?
>
> Right now, Anthropic's Claude appears to be winning that race, though that could change quickly. Developers are increasingly not locked into a proprietary stack but are easily switching based on cost or capability differences.

**Why it works:**
- Bold "What to watch for" creates scannable signpost
- Specific, observable signal (not vague)
- Current state as baseline
- Acknowledges uncertainty ("could change quickly")

## Robust Strategies

### Pattern: Strategy That Works Either Way

**From "What If? AI in 2026 and Beyond":**

> **A robust strategy**: Don't build a business model that relies on subsidized intelligence. If your margins only work because VC money is paying for 40% of your inference costs, you are vulnerable. Focus on unit economics. Build products where the AI adds value that customers are willing to pay for now, not in a theoretical future where AI does everything.

**Structure:**
1. Bold "A robust strategy" label
2. State the strategy as imperative
3. Explain the vulnerability it addresses
4. Make it actionable

## Calls to Action

### Pattern: Return to Opening Thesis

**From "What MCP and Claude Skills Teach Us":**

> We're at a choice point. We can make AI development look like app stores and proprietary platforms, or we can make it look like the open web and the open source lineages that descended from Unix. I know which future I'd like to live in.

**Why it works:**
- Returns to the core tension from opening
- Frames as choice, not inevitability
- States author's position clearly
- Invites reader to choose

### Pattern: Quote or Aphorism Ending

**From "What If? AI in 2026 and Beyond":**

> As Alan Kay once said, "The best way to predict the future is to invent it." Don't wait for the AI future to happen to you. Do what you can to shape it. Build the future you want to live in.

**Structure:**
1. Relevant quote from respected figure
2. Application to current context
3. Call to action
4. Inspiring final sentence

## Formatting Patterns

### Bold for Concepts

> Skills are **prompt-based conversation and execution context modifiers** that work through a meta-tool architecture.

Use bold to introduce a term or concept the reader should remember.

### Italics for Emphasis

> The real question is *where the value will accrue*.

Use italics to stress a word or phrase within a sentence.

### Mixed Formatting

> **Building reusable libraries of fuzzy functions is the future of open source AI.**

Entire sentence in bold = major thesis statement. Use very sparingly (1-2 per article).
