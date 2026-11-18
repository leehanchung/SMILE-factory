# Scenario Planning for Technology Analysis

Scenario planning is a core methodology in O'Reilly Radar writing. Rather than predicting a single future, scenario planning explores multiple plausible futures and identifies strategies that work across them.

## Core Philosophy

> "At O'Reilly, we don't believe in predicting the future. But we do believe you can see signs of the future in the present."

The goal is not to be right about which future arrives, but to:
1. Expand imagination about possibilities
2. Identify signals that indicate which future is emerging
3. Develop robust strategies that work in multiple scenarios

## The Two-Scenario Framework

The simplest and most effective structure presents two contrasting futures.

### Structure

```
Scenario A: [Name that captures the essence]
- Core assumption
- Key implications
- Who benefits
- Warning signs it's correct

Scenario B: [Contrasting name]
- Core assumption
- Key implications  
- Who benefits
- Warning signs it's correct
```

### Example from "What If? AI in 2026"

**Scenario One: AGI is an economic singularity**
- Assumption: AI capabilities improve rapidly enough to perform most cognitive work
- Implications: Winner-takes-all dynamics, massive labor displacement
- Beneficiaries: First movers, infrastructure providers
- Signals: Capability jumps, robotics breakthroughs, sustained infrastructure utilization

**Scenario Two: AI is a normal technology**
- Assumption: AI faces normal adoption barriers despite impressive capabilities
- Implications: Gradual diffusion, integration costs, diminishing returns
- Beneficiaries: Companies that integrate AI well, not just AI providers
- Signals: Pilot-to-production gaps persist, security problems unsolved, domain complexity defeats generalization

### Choosing Your Scenarios

Good scenario pairs:
- Are mutually exclusive (can't both be fully true)
- Are both plausible (not strawman vs obvious truth)
- Have different implications for action
- Can be distinguished by observable signals

Bad scenario pairs:
- "AI succeeds" vs "AI fails" (too vague)
- "Good outcome" vs "Bad outcome" (value-laden framing)
- One obviously correct, one obviously wrong

## "News from the Future" Methodology

### What It Is

Identifying current signals that indicate which future is emerging. Like finding today's newspaper from 2027 and reading it backwards.

### How to Do It

1. **Watch the alpha geeks**: What are practitioners actually doing?
2. **Follow the money**: Where is capital flowing? Where is it hesitating?
3. **Read practitioner reports**: Not surveys, but deployment stories
4. **Note surprising developments**: What happened that nobody expected?
5. **Track adoption patterns**: Not announcements, but actual usage

### Signal Quality

**Strong signals:**
- Practitioner behavior change (developers switching tools)
- Revenue, not just funding
- Repeated patterns across multiple contexts
- Surprises to insiders

**Weak signals:**
- Survey responses about intentions
- Announcements and press releases
- Benchmark performance
- Expert predictions

### Example Signal Analysis

> **What to watch for:** There are so many possibilities that this is an act of imagination! Start with Wile E. Coyote running over a cliff in pursuit of Road Runner in the classic Warner Bros. cartoons. Imagine the moment when investors realize that they are trying to defy gravity.
>
> What made them notice? Was it the failure of a much-hyped data center project? Was it that it couldn't get financing, that it couldn't get completed because of regulatory constraints, that it couldn't get enough chips, that it couldn't get enough power, that it couldn't get enough customers?

## Robust Strategies

### Definition

A robust strategy is one that works reasonably well regardless of which scenario unfolds. It's not optimal for any single future, but survives in all of them.

### Structure for Presenting

```
**A robust strategy**: [Imperative statement of the strategy]

[Explain the vulnerability it addresses]
[Explain why it works in Scenario A]
[Explain why it works in Scenario B]
```

### Example

> **A robust strategy**: Move up the stack. If the model is a commodity, the value is in the integration, the data, and the workflow. Build applications and services using the unique data, context, and workflows that no one else has.

Works in AGI scenario: You have something AI can't replicate (your specific context)
Works in normal tech scenario: You're building on stable foundations

### Common Robust Strategy Patterns

1. **Diversify architectures**: Don't bet everything on one approach
2. **Own the relationship**: Direct connection to customers survives platform shifts
3. **Focus on integration**: Value accrues to those who make things work together
4. **Invest in efficiency**: Works whether compute is abundant or scarce
5. **Build on open standards**: Reduces platform lock-in risk
6. **Develop unique data/context**: Hard to replicate regardless of AI capability

## "What If?" Section Format

### Template

```
### N. What if [provocative possibility]?

**The vector:** [Current trend that makes this plausible]

**The scenario:** [What happens if this comes to pass]

**A robust strategy:** [Action that works regardless]
```

### Example

> ### 3. What if inference becomes a commodity?
>
> **The vector**: Chinese labs continue to release open weight models with performance comparable to each previous generation of top-of-line US frontier models but at a fraction of the training and inference cost.
>
> **The scenario**: The price of "intelligence" collapses to near zero. The moat of having the biggest model and the best cutting-edge chips for training evaporates.
>
> **A robust strategy**: Move up the stack. If the model is a commodity, the value is in the integration, the data, and the workflow.

## Writing Scenario Content

### Tone

- **Analytical, not predictive**: "If X, then Y" not "X will happen"
- **Humble**: Acknowledge uncertainty explicitly
- **Actionable**: Every scenario discussion should enable decisions
- **Even-handed**: Present each scenario fairly

### Language Patterns

- "In this scenario, we would see..."
- "Signs pointing toward [scenario name] include..."
- "If this scenario is correct, then..."
- "The robust strategy is... because it works whether..."

### Avoiding Common Mistakes

1. **Don't telegraph your preferred scenario**: Present both fairly first
2. **Don't make scenarios too extreme**: Extreme scenarios aren't useful
3. **Don't forget the middle**: Most likely outcome is often somewhere between
4. **Don't skip the signals**: Readers need to know what to watch
5. **Don't leave readers without action**: Every analysis should enable decisions

## When to Use Scenario Planning

Good for:
- Genuinely uncertain futures with multiple plausible paths
- High-stakes decisions where being wrong is costly
- Topics where conventional wisdom may be wrong
- Situations where different stakeholders have different interests

Not necessary for:
- Clear trends where direction is obvious
- Technical explanations where uncertainty is low
- Historical analysis
- Tactical how-to content
