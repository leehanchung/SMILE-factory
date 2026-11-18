# Reviewer Guidelines & Evaluation Criteria

How reviewers evaluate papers at major ML/AI conferences—understand reviewer expectations to anticipate and address concerns.

---

## Contents

- [Universal Evaluation Dimensions](#universal-evaluation-dimensions)
- [NeurIPS Reviewer Guidelines](#neurips-reviewer-guidelines)
- [Common Reviewer Concerns](#common-reviewer-concerns)
- [How to Address Reviewer Feedback](#how-to-address-reviewer-feedback)
- [Pre-Submission Reviewer Simulation](#pre-submission-reviewer-simulation)

---

## Universal Evaluation Dimensions

All major ML conferences assess papers across four core dimensions:

### 1. Quality (Technical Soundness)

**What reviewers ask:**
- Are claims well-supported by evidence?
- Are proofs correct? Experiments properly controlled?
- Are baselines appropriate and fairly compared?

**How to ensure high quality:**
- Include complete proofs (main paper or appendix)
- Use appropriate baselines (not strawmen)
- Report variance/error bars with methodology
- Document hyperparameter selection

### 2. Clarity (Writing & Organization)

**What reviewers ask:**
- Is the paper clearly written?
- Can an expert reproduce the results?
- Is notation consistent?

**How to ensure clarity:**
- Use consistent terminology
- Define all notation at first use
- Include reproducibility details
- Have non-authors read before submission

### 3. Significance (Impact & Importance)

**What reviewers ask:**
- Are results impactful for the community?
- Will others build upon this work?
- Does it address an important problem?

**How to demonstrate significance:**
- Articulate the problem's importance
- Connect to broader research themes
- Discuss potential applications

### 4. Originality (Novelty & Contribution)

**What reviewers ask:**
- Does this provide new insights?
- How does it differ from prior work?
- Is the contribution non-trivial?

**Key insight from NeurIPS:**
> "Originality does not necessarily require introducing an entirely new method. Papers that provide novel insights from evaluating existing approaches can also be highly original."

---

## NeurIPS Reviewer Guidelines

### Scoring System (1-6 Scale)

| Score | Label | Description |
|-------|-------|-------------|
| **6** | Strong Accept | Groundbreaking, flawless; top 2-3% |
| **5** | Accept | Technically solid, high impact |
| **4** | Borderline Accept | Solid with limited evaluation |
| **3** | Borderline Reject | Weaknesses outweigh strengths |
| **2** | Reject | Technical flaws |
| **1** | Strong Reject | Known results or ethics concerns |

### Reviewer Instructions

Reviewers are explicitly instructed to:

1. **Evaluate the paper as written** - not what it could be
2. **Provide constructive feedback** - 3-5 actionable points
3. **Not penalize honest limitations** - acknowledging weaknesses is encouraged
4. **Assess reproducibility** - can the work be verified?
5. **Consider ethical implications**

### What Reviewers Should Avoid

- Superficial, uninformed reviews
- Demanding unreasonable additional experiments
- Penalizing honest limitation acknowledgment
- Rejecting for missing citations to reviewer's own work

---

## Common Reviewer Concerns

### Technical Concerns

| Concern | How to Pre-empt |
|---------|-----------------|
| "Baselines too weak" | Use state-of-the-art baselines, cite recent work |
| "Missing ablations" | Include systematic ablation study |
| "No error bars" | Report std dev/error, multiple runs |
| "Hyperparameters not tuned" | Document tuning process, search ranges |
| "Claims not supported" | Ensure every claim has evidence |

### Novelty Concerns

| Concern | How to Pre-empt |
|---------|-----------------|
| "Incremental contribution" | Articulate what's new vs prior work |
| "Similar to [paper X]" | Explicitly compare to X in Related Work |
| "Straightforward extension" | Highlight non-obvious aspects |

### Clarity Concerns

| Concern | How to Pre-empt |
|---------|-----------------|
| "Hard to follow" | Clear structure, signposting |
| "Notation inconsistent" | Review all notation, create table |
| "Missing details" | Include reproducibility appendix |
| "Figures unclear" | Self-contained captions, proper sizing |

### Significance Concerns

| Concern | How to Pre-empt |
|---------|-----------------|
| "Limited impact" | Discuss broader implications |
| "Narrow evaluation" | Evaluate on multiple benchmarks |
| "Only works in restricted setting" | Acknowledge scope, explain value |

---

## How to Address Reviewer Feedback

### Rebuttal Best Practices

**Do:**
- Thank reviewers for their time
- Address each concern specifically
- Provide evidence (new experiments if possible)
- Be concise—reviewers are busy
- Acknowledge valid criticisms

**Don't:**
- Be defensive or dismissive
- Make promises you can't keep
- Ignore difficult criticisms
- Write excessively long rebuttals
- Argue about subjective assessments

### Rebuttal Template

```markdown
We thank the reviewers for their thoughtful feedback.

## Reviewer 1

**R1-Q1: [Quoted concern]**
[Direct response with evidence]

**R1-Q2: [Quoted concern]**
[Direct response with evidence]

## Reviewer 2
...

## Summary of Changes
If accepted, we will:
1. [Specific change]
2. [Specific change]
```

### When to Accept Criticism

Some feedback should simply be accepted:
- Valid technical errors
- Missing important related work
- Unclear explanations
- Missing experimental details

Acknowledge gracefully: "The reviewer is correct that... We will revise to..."

### When to Push Back

You can respectfully disagree when:
- Reviewer misunderstood the paper
- Requested experiments are out of scope
- Criticism is factually incorrect

Frame constructively: "We appreciate this perspective. However, [explanation]..."

---

## Pre-Submission Reviewer Simulation

Before submitting, ask yourself:

### Quality
- [ ] Would I trust these results if I saw them?
- [ ] Are all claims supported by evidence?
- [ ] Are baselines fair and recent?

### Clarity
- [ ] Can someone reproduce this from the paper?
- [ ] Is writing clear to non-experts in this subfield?
- [ ] Are all terms and notation defined?

### Significance
- [ ] Why should the community care?
- [ ] What can people do with this work?
- [ ] Is the problem important?

### Originality
- [ ] What specifically is new here?
- [ ] How does this differ from closest related work?
- [ ] Is the contribution non-trivial?

---

## Strong Review Structure

Following Daniel Dennett's rules for criticism:

1. **Re-express the position fairly** - Show you understand
2. **List agreements** - Acknowledge what works well
3. **List what you learned** - Credit the contribution
4. **Only then critique** - After establishing understanding

### Review Template

```
Summary (1 paragraph):
- What the paper does
- Main contribution claimed

Strengths (3-5 bullets):
- Specific positive aspects
- Why these matter

Weaknesses (3-5 bullets):
- Specific concerns
- Why these matter
- Suggestions for addressing

Questions (2-4 items):
- Clarifications needed
- Things that would change assessment

Minor Issues (optional):
- Typos, unclear sentences

Overall Assessment:
- Clear recommendation with reasoning
```
