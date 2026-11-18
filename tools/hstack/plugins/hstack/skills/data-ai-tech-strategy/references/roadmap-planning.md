# Roadmap Planning for Data + AI

## Roadmap Purpose

A roadmap is NOT:
- A list of features
- A Gantt chart
- A promise to stakeholders

A roadmap IS:
- A communication tool showing strategic direction
- A prioritization framework for resource allocation
- A living document that evolves with learnings

---

## Roadmap Horizons

### H1: Committed (0-6 months)
**Certainty**: High (80%+)
**Detail Level**: Specific deliverables with owners
**Resource Status**: Fully allocated
**Communication**: "We will deliver X by Y"

### H2: Planned (6-12 months)
**Certainty**: Medium (50-80%)
**Detail Level**: Initiatives with rough scope
**Resource Status**: Directionally planned
**Communication**: "We plan to pursue X"

### H3: Exploratory (12-18+ months)
**Certainty**: Low (<50%)
**Detail Level**: Themes and bets
**Resource Status**: Not allocated
**Communication**: "We're watching X"

---

## Prioritization Framework

### Business Value Assessment

| Factor | Weight | Questions |
|--------|--------|-----------|
| Revenue Impact | 30% | Will this directly increase revenue? By how much? |
| Cost Reduction | 25% | Will this reduce operational costs? By how much? |
| Risk Mitigation | 20% | Does this reduce regulatory, security, or operational risk? |
| Strategic Enablement | 15% | Does this enable future capabilities or market entry? |
| Customer Experience | 10% | Does this improve user satisfaction or retention? |

**Scoring**: 1 (minimal) to 5 (transformative)

### Feasibility Assessment

| Factor | Weight | Questions |
|--------|--------|-----------|
| Technical Complexity | 30% | How complex is the solution? Do we have expertise? |
| Data Readiness | 25% | Is the data available, clean, and accessible? |
| Resource Availability | 20% | Do we have people to execute? |
| Dependencies | 15% | What must happen first? Are dependencies in our control? |
| Timeline Risk | 10% | How confident are we in the timeline? |

**Scoring**: 1 (very difficult) to 5 (straightforward)

### Prioritization Matrix

Calculate: **Priority Score = Business Value × Feasibility**

| Score | Priority | Action |
|-------|----------|--------|
| 20-25 | Critical | Do first, dedicate resources |
| 15-19 | High | Include in H1 roadmap |
| 10-14 | Medium | Include in H2 roadmap |
| 5-9 | Low | Consider for H3 or backlog |
| <5 | Skip | Remove from consideration |

---

## Roadmap Structure

### Initiative Format
```
[Initiative Name]
- Objective: [One sentence goal]
- Business Value: [Quantified impact]
- Success Criteria: [Measurable outcomes]
- Timeline: [Q1, Q2, etc.]
- Owner: [Name]
- Dependencies: [What must happen first]
- Risks: [Top 2-3 risks]
- Status: [Not Started / In Progress / Complete]
```

### Roadmap Visualization

**Swimlane View** (by team/squad):
```
Q1          Q2          Q3          Q4
|-----------|-----------|-----------|
[Agent Squad]
  [Initiative A]------>
              [Initiative B]-------->
[Data Platform Squad]
  [Initiative C]------>
                      [Initiative D]->
```

**Theme View** (by strategic objective):
```
Theme: Customer Experience
├── Q1: [Initiative X]
├── Q2: [Initiative Y]
└── Q3: [Initiative Z]

Theme: Operational Excellence
├── Q1: [Initiative A]
└── Q2: [Initiative B]
```

---

## AI/ML Roadmap Specifics

### ML Project Phases
Each ML initiative has distinct phases with different resource needs:

| Phase | Duration | Activities | Key Risk |
|-------|----------|------------|----------|
| Discovery | 2-4 weeks | Problem definition, data assessment, feasibility | Wrong problem |
| Development | 4-12 weeks | Data prep, model training, evaluation | Data quality |
| Deployment | 2-4 weeks | Integration, testing, rollout | Production issues |
| Monitoring | Ongoing | Performance tracking, retraining | Model drift |

### ML-Specific Dependencies
- **Data dependencies**: What data must exist before training?
- **Infrastructure dependencies**: What platform capabilities are needed?
- **Model dependencies**: Does this model depend on other models?
- **Integration dependencies**: What systems must integrate?

### Accounting for ML Uncertainty

ML projects have higher uncertainty than traditional software. Build in buffers:

| Project Type | Buffer Multiplier | Rationale |
|--------------|------------------|-----------|
| New data source | 1.5x | Unknown data quality issues |
| New model type | 2.0x | Research uncertainty |
| New domain | 1.5x | Domain expertise gaps |
| Production deployment | 1.3x | Integration unknowns |

**Example**: If estimates say 8 weeks for a new model on new data:
- 8 weeks × 2.0 (new model) × 1.5 (new data) = 24 weeks realistic timeline

---

## Stakeholder Communication

### Executive Summary (Monthly)
**Audience**: Leadership team
**Format**: 1-page summary + brief discussion
**Content**:
- Overall status (🟢 🟡 🔴)
- Top 3 accomplishments
- Top 3 priorities next period
- Key risks or blockers needing attention

### Detailed Review (Quarterly)
**Audience**: Extended leadership + key stakeholders
**Format**: 30-60 minute review session
**Content**:
- Progress against roadmap
- Metrics and outcomes
- Roadmap updates and rationale
- Resource needs and constraints

### Team Updates (Weekly)
**Audience**: Engineering team
**Format**: Written update (async-friendly)
**Content**:
- What shipped this week
- What's planned next week
- Blockers and help needed

---

## Common Roadmap Mistakes

### Over-Committing
**Symptom**: Every quarter has more work than capacity
**Fix**: Plan to 70% capacity; buffer for unplanned work

### Under-Communicating
**Symptom**: Stakeholders surprised by changes
**Fix**: Regular updates; flag risks early

### Over-Specifying
**Symptom**: H3 items have detailed specs
**Fix**: Match detail to certainty level

### Under-Sequencing
**Symptom**: Dependencies not identified until blocked
**Fix**: Explicit dependency mapping; critical path analysis

### Ignoring Technical Debt
**Symptom**: All roadmap items are features
**Fix**: Allocate 20-30% capacity to platform/infrastructure

### Feature Factory
**Symptom**: Roadmap is feature list without outcomes
**Fix**: Every item has "why" and success criteria

---

## Roadmap Review Cadence

### Weekly: Execution Check
- Are we on track this week?
- What's blocked?
- Any scope changes needed?

### Monthly: Progress Review
- Are we on track for quarterly goals?
- Any risks emerging?
- Resource reallocation needed?

### Quarterly: Strategy Alignment
- Did we achieve planned outcomes?
- Has business context changed?
- Roadmap updates for next quarter?

### Annual: Strategy Refresh
- Full strategy document update
- 12-month roadmap revision
- Resource planning for next year

---

## Templates

### Initiative One-Pager

```
# [Initiative Name]

## Problem Statement
[What problem are we solving? For whom? Why now?]

## Proposed Solution
[High-level approach. Not implementation details.]

## Business Value
[Quantified impact: revenue, cost, risk, experience]

## Success Criteria
- [Metric 1]: [Target]
- [Metric 2]: [Target]

## Scope
**In Scope:**
- [Item 1]
- [Item 2]

**Out of Scope:**
- [Item 1]
- [Item 2]

## Timeline
| Phase | Duration | Deliverable |
|-------|----------|-------------|
| Phase 1 | [X weeks] | [Deliverable] |
| Phase 2 | [X weeks] | [Deliverable] |

## Resources
- [X] engineers for [Y] weeks
- Dependencies on [teams/systems]

## Risks
| Risk | Impact | Mitigation |
|------|--------|------------|
| [Risk 1] | [H/M/L] | [Mitigation] |
| [Risk 2] | [H/M/L] | [Mitigation] |

## Owner
[Name, Title]
```

### Quarterly OKR Template

```
# Q[X] Objectives and Key Results

## Objective 1: [Objective Statement]
Outcome-focused, not activity-focused

### Key Results:
- KR1: [Measurable result] | Target: [X] | Current: [Y]
- KR2: [Measurable result] | Target: [X] | Current: [Y]
- KR3: [Measurable result] | Target: [X] | Current: [Y]

### Initiatives Supporting This Objective:
- [Initiative 1]: [Owner]
- [Initiative 2]: [Owner]

---

## Objective 2: [Objective Statement]
[...]
```

### Risk Register Template

```
| ID | Risk | Probability | Impact | Score | Mitigation | Owner | Status |
|----|------|-------------|--------|-------|------------|-------|--------|
| R1 | [Description] | H/M/L | H/M/L | [P×I] | [Action] | [Name] | Open/Mitigated |
| R2 | [Description] | H/M/L | H/M/L | [P×I] | [Action] | [Name] | Open/Mitigated |
```

---

## Building Buy-In

### Before the Roadmap Meeting
1. Pre-align with key stakeholders 1:1
2. Address objections before public forum
3. Identify potential blockers and have answers ready

### During the Roadmap Meeting
1. Start with business context, not technical details
2. Frame trade-offs explicitly
3. Ask for consent, not consensus

### After the Roadmap Meeting
1. Document decisions and rationale
2. Follow up on action items
3. Communicate to broader team

### Handling Pushback

**"We need X feature immediately"**
→ "I understand the urgency. Here's what we'd need to deprioritize to fit it in. Should we discuss the trade-off?"

**"This is taking too long"**
→ "Let me share the constraints we're working within and discuss whether the scope can be reduced."

**"Why isn't Y on the roadmap?"**
→ "We considered Y. Here's why it ranked lower in our prioritization. What context am I missing?"

**"Can you commit to a date?"**
→ "I can commit to [phase/milestone]. For full delivery, I need [dependency/decision] first."
