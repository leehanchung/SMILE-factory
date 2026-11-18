# Engineering Principles for Data + AI Teams

## Framework for Defining Principles

### What Makes a Good Principle
1. **Actionable**: Guides specific decisions, not abstract ideals
2. **Specific**: Differentiates your team from generic best practices
3. **Testable**: You can observe whether it's being followed
4. **Memorable**: Short enough to internalize and recall
5. **Opinionated**: Takes a stance; says "we value X over Y"

### Principle Structure
```
[Principle Name]: [One sentence statement]
- Why: [The belief behind this principle]
- Do: [Concrete example of following this]
- Don't: [Anti-pattern or violation]
```

### How Many Principles?
- **4-6 principles**: Optimal for memory and adoption
- **7-10 principles**: Maximum before cognitive overload
- **10+ principles**: Too many; combine or prioritize

---

## Example Principles for Data + AI Teams

### 1. Outcomes Over Outputs
Measure success by business value delivered, not models built or pipelines shipped.

**Why**: ML teams can optimize for model accuracy or pipeline throughput while delivering zero business value. Impact is what matters.

**Do**: Define success criteria in business terms before starting work. "This model will reduce customer churn by 5%" vs. "This model will achieve 95% AUC."

**Don't**: Report on model metrics without connecting to business outcomes. Celebrate shipping without measuring adoption or impact.

---

### 2. Data Quality is Non-Negotiable
Garbage in, garbage out. Invest in data quality as a first-class concern.

**Why**: No amount of sophisticated modeling compensates for bad data. Quality problems compound through pipelines and into production.

**Do**: Implement data contracts with explicit quality expectations. Monitor data quality metrics continuously. Fail loudly on quality violations.

**Don't**: Trust upstream data without validation. Silently impute missing values. Ship models trained on unvalidated data.

---

### 3. Reproducibility by Default
Every experiment, model, and deployment must be exactly reproducible.

**Why**: ML is experimental by nature. Without reproducibility, we can't debug, audit, or trust our systems. Reproducibility enables learning from failures.

**Do**: Version everything: data, code, configurations, environments. Log all experiment parameters and random seeds. Use deterministic builds.

**Don't**: Run experiments in notebooks without version control. Deploy models without knowing what data trained them. Use "latest" tags in production.

---

### 4. Ship Early, Learn Fast
Prefer rapid iteration over comprehensive solutions. Small batches beat big bangs.

**Why**: ML systems have high uncertainty. Early deployment reveals problems that testing can't find. Customer feedback beats internal validation.

**Do**: Deploy minimal viable models to production quickly. Use feature flags and gradual rollouts. Build feedback loops into every system.

**Don't**: Wait for perfect accuracy before shipping. Build elaborate systems before validating the use case. Optimize before measuring.

---

### 5. Make It Observable
If you can't see it, you can't fix it. Instrument everything.

**Why**: ML systems fail silently. Data drift, model degradation, and integration bugs don't raise exceptions. Observability is prerequisite to reliability.

**Do**: Monitor data distributions, model predictions, and business outcomes. Alert on drift and anomalies. Build dashboards for every production system.

**Don't**: Deploy without monitoring. Rely solely on accuracy metrics. Discover problems from customer complaints.

---

### 6. Own It End-to-End
Responsibility extends from ideation through production support. No throwing over walls.

**Why**: ML value comes from production systems, not notebooks. Teams that own the full lifecycle build better systems and learn faster.

**Do**: On-call for your own systems. Monitor business metrics post-launch. Fix problems immediately, not in the next sprint.

**Don't**: Hand off models to "engineering" for productionization. Blame infrastructure for model failures. Ignore post-deployment performance.

---

### 7. Simplicity Over Cleverness
The best solution is the simplest one that works. Complexity is a liability.

**Why**: Complex models are harder to debug, maintain, and explain. Simple solutions fail gracefully. Cleverness creates technical debt.

**Do**: Start with baselines. Question whether you need ML at all. Choose interpretable models unless black-box is required.

**Don't**: Jump to deep learning for tabular data. Build custom solutions when off-the-shelf exists. Optimize for novelty over utility.

---

### 8. Document Decisions, Not Just Code
Capture the "why" behind technical choices for future teams.

**Why**: Tribal knowledge evaporates. New team members need context. Revisiting decisions requires understanding original constraints.

**Do**: Write Architecture Decision Records (ADRs). Document assumptions and constraints. Update docs when decisions change.

**Don't**: Rely on oral history. Assume future you will remember. Leave code as the only documentation.

---

## Principles by Context

### For ML Engineering Teams
- Reproducibility by Default
- Ship Early, Learn Fast
- Make It Observable
- Simplicity Over Cleverness

### For Data Engineering Teams
- Data Quality is Non-Negotiable
- Own It End-to-End
- Document Decisions, Not Just Code
- Make It Observable

### For Data Science Teams
- Outcomes Over Outputs
- Ship Early, Learn Fast
- Reproducibility by Default
- Simplicity Over Cleverness

### For Platform Teams
- Make It Observable
- Own It End-to-End
- Simplicity Over Cleverness
- Document Decisions, Not Just Code

---

## Socializing Principles

### Rollout Process
1. **Draft with input**: Gather principles from team, not just leadership
2. **Review and refine**: Iterate based on feedback
3. **Publish formally**: Make official with leadership sign-off
4. **Train and reinforce**: Reference in code reviews, retrospectives, hiring
5. **Evolve periodically**: Update based on learnings (annually)

### Making Principles Stick
- **Reference in decisions**: "This aligns with our principle of..."
- **Use in hiring**: Evaluate candidates against principles
- **Include in onboarding**: First-week reading for new hires
- **Celebrate examples**: Call out when principles guide good outcomes
- **Challenge violations**: Constructively address when principles are ignored

### When Principles Conflict
Principles sometimes pull in different directions. Document the hierarchy:

Example: "Ship Early, Learn Fast" vs. "Data Quality is Non-Negotiable"
- **Resolution**: Quality gates are non-negotiable checkpoints; speed comes from smaller scope, not lower quality.

---

## Anti-Patterns to Avoid

### Principle Theater
- Principles on the wall but not in practice
- No one can name the principles from memory
- Decisions made without reference to principles

### Kitchen Sink Principles
- 15+ principles covering every situation
- Principles that say "do good work"
- No prioritization or hierarchy

### Static Principles
- Never updated since original creation
- Don't reflect current challenges
- Based on theory, not experience

### Aspirational vs. Actual
- Principles describe ideal state, not current behavior
- Team can't point to examples of following them
- Principles conflict with incentives

---

## Principle Definition Workshop

### Format (2-3 hours)
1. **Prime** (15 min): Review examples from other organizations
2. **Generate** (30 min): Individuals write candidate principles
3. **Cluster** (20 min): Group similar principles
4. **Debate** (45 min): Discuss and refine top candidates
5. **Prioritize** (20 min): Vote to select 4-6 principles
6. **Wordsmith** (20 min): Refine language for clarity

### Workshop Prompts
- What decisions do we face repeatedly?
- Where do we see disagreements?
- What do we do well that we want to codify?
- What mistakes do we want to prevent?
- What would we tell a new team member on day one?

### Post-Workshop
- Draft full principle descriptions (statement, why, do, don't)
- Circulate for feedback
- Finalize and publish
- Schedule 6-month review
