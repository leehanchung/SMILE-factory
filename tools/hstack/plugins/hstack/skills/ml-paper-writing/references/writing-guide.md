# ML Paper Writing Philosophy & Best Practices

Writing advice from prominent ML researchers: Neel Nanda, Sebastian Farquhar, Gopen & Swan, Zachary Lipton, Jacob Steinhardt, and Ethan Perez.

---

## Contents

- [The Narrative Principle](#the-narrative-principle)
- [Time Allocation](#time-allocation)
- [Abstract Writing Formula](#abstract-writing-formula)
- [Introduction Structure](#introduction-structure)
- [The 7 Principles of Reader Expectations](#the-7-principles-of-reader-expectations)
- [Micro-Level Writing Tips](#micro-level-writing-tips)
- [Word Choice and Precision](#word-choice-and-precision)
- [Figure Design](#figure-design)
- [Common Mistakes](#common-mistakes)

---

## The Narrative Principle

### From Neel Nanda

"A paper is a short, rigorous, evidence-based technical story with a takeaway readers care about."

**Three Pillars (must be crystal clear by end of introduction):**

**The "What"**: 1-3 specific novel claims within a cohesive theme. Vague contributions like "we study X" fail—reviewers need precise, falsifiable claims.

**The "Why"**: Rigorous empirical evidence. Strong baselines honestly tuned. Experiments that distinguish competing hypotheses.

**The "So What"**: Why readers should care. Connect to problems the community recognizes as important.

### From Andrej Karpathy

"A paper is not a random collection of experiments. The paper sells a single thing that was not obvious or present before."

**Practical Implication**: If you cannot state your contribution in one sentence, you don't yet have a paper.

---

## Time Allocation

### From Neel Nanda

Spend approximately **the same amount of time** on each of:
1. The abstract
2. The introduction
3. The figures
4. Everything else combined

**Why?** Readers encounter your paper as: **title → abstract → introduction → figures → maybe the rest.**

### Reviewer Reading Patterns

| Section | % Reviewers Who Read |
|---------|---------------------|
| Abstract | 100% |
| Introduction | 90%+ (skimmed) |
| Figures | Examined before methods |
| Full methods | Only if interested |

---

## Abstract Writing Formula

### Sebastian Farquhar's 5-Sentence Formula

1. **What you achieved**: "We introduce...", "We prove...", "We demonstrate..."
2. **Why this is hard and important**
3. **How you do it** (with specialist keywords for discoverability)
4. **What evidence you have**
5. **Your most remarkable number/result**

### What to Avoid (Zachary Lipton)

"If the first sentence can be pre-pended to any ML paper, delete it."

**Delete these openings**:
- "Large language models have achieved remarkable success..."
- "Deep learning has revolutionized..."
- "In recent years, neural networks have..."

**Start with your specific contribution instead.**

---

## Introduction Structure

### Requirements

- **1-1.5 pages maximum** (in two-column format)
- **Methods should start by page 2-3**
- Must include **2-4 bullet contribution list** (max 1-2 lines each)

### Structure Template

```
1. Opening Hook (2-3 sentences)
   - State the problem
   - Why it matters RIGHT NOW

2. Background/Challenge (1 paragraph)
   - What makes this hard?
   - What have others tried?

3. Your Approach (1 paragraph)
   - What do you do differently?
   - Key enabling insight

4. Contribution Bullets (2-4 items)
   - Specific and falsifiable
   - Each: 1-2 lines maximum

5. Results Preview (2-3 sentences)
   - Most impressive numbers

6. Paper Organization (optional, 1-2 sentences)
```

### Contribution Bullets: Good vs Bad

**Good:**
- We prove that X converges in O(n log n) time under assumption Y
- We introduce Z, a 3-layer architecture that reduces memory by 40%
- We demonstrate that A outperforms B by 15% on benchmark C

**Bad:**
- We study the problem of X (not a contribution)
- We provide extensive experiments (too vague)
- We make several contributions (says nothing)

---

## The 7 Principles of Reader Expectations

### From Gopen & Swan: "The Science of Scientific Writing"

Readers have **structural expectations** about where information appears. Violating these forces readers to spend energy on structure rather than content.

### Principle 1: Subject-Verb Proximity

Keep grammatical subject and verb close together.

**Weak**: "The model, which was trained on 100M tokens and fine-tuned with LoRA rank 16, achieves state-of-the-art results"

**Strong**: "The model achieves state-of-the-art results after training on 100M tokens and fine-tuning with LoRA"

### Principle 2: Stress Position (Save the Best for Last)

Readers naturally emphasize the **last words of a sentence**.

**Weak**: "Accuracy improves by 15% when using attention"
**Strong**: "When using attention, accuracy improves by **15%**"

### Principle 3: Topic Position (First Things First)

The beginning establishes perspective. Put the "whose story" element first.

**Weak**: "A novel attention mechanism that computes alignment scores is introduced"
**Strong**: "To address the alignment problem, we introduce a novel attention mechanism"

### Principle 4: Old Information Before New

Put familiar information in topic position; put new information in stress position.

**Weak**: "Sparse attention was introduced by Child et al. The quadratic complexity of standard attention motivates this work."
**Strong**: "Standard attention has quadratic complexity. To address this, Child et al. introduced sparse attention."

### Principle 5: One Unit, One Function

Each unit of discourse (sentence, paragraph, section) should serve a single function.

### Principle 6: Articulate Action in the Verb

Express action in verbs, not nominalized nouns.

**Weak**: "We performed an analysis of the results"
**Strong**: "We analyzed the results"

### Principle 7: Context Before New Information

Provide context before asking readers to consider anything new.

**Weak**: "Equation 3 shows that convergence is guaranteed when..."
**Strong**: "For convergence to be guaranteed, the learning rate must satisfy Equation 3..."

### Summary Table

| Principle | Mnemonic |
|-----------|----------|
| Subject-Verb Proximity | "Don't interrupt yourself" |
| Stress Position | "Save the best for last" |
| Topic Position | "First things first" |
| Old Before New | "Build on known ground" |
| One Unit, One Function | "One idea per container" |
| Action in Verb | "Verbs do, nouns sit" |
| Context Before New | "Set the stage first" |

---

## Micro-Level Writing Tips

### From Ethan Perez

#### Pronoun Management

**Minimize pronouns** ("this," "it," "these"). When necessary, use them as adjectives:

**Weak**: "This shows that the model converges."
**Strong**: "This result shows that the model converges."

#### Verb Placement

**Position verbs early** in sentences:

**Weak**: "The gradient, after being computed and normalized, updates the weights."
**Strong**: "The gradient updates the weights after being computed and normalized."

#### Apostrophe Unfolding

When sentences feel awkward: "X's Y" → "The Y of X"

**Before**: "The model's accuracy on the test set"
**After**: "The accuracy of the model on the test set"

#### Words to Eliminate

Delete these filler words:
- "actually"
- "a bit"
- "very" / "really"
- "quite"
- "basically"
- "essentially"
- Excessive connectives ("however," "moreover," "furthermore")

#### Sentence Construction

1. **One idea per sentence**
2. **No repeated sounds** in same sentence
3. **Every sentence adds information**
4. **Active voice always**: "We find..." not "It is found..."
5. **Expand contractions**: "don't" → "do not"

---

## Word Choice and Precision

### From Zachary Lipton

**Eliminate hedging** unless genuine uncertainty:
- Delete "may" and "can" unless necessary
- "provides *very* tight approximation" → "provides tight approximation"

**Avoid vacuous intensifiers**: very, extremely, highly, significantly (unless statistical)

### From Jacob Steinhardt

**Precision over brevity**:

| Vague | Specific |
|-------|----------|
| performance | accuracy, latency, throughput |
| improves | increases accuracy by X% |
| large | 1B parameters |
| fast | 3x faster, 50ms latency |
| good results | 92% accuracy, 0.85 F1 |

**Consistent terminology**: Use one term per concept throughout.

### Vocabulary Signaling

**Avoid words signaling incremental work**:
- Never: "combine," "modify," "expand," "extend"
- Instead: "develop," "propose," "introduce"

---

## Figure Design

### Design Principles

1. **Figure 1 is crucial**: Often first thing readers examine
2. **Self-contained captions**: Reader should understand without main text
3. **No title inside figure**: Caption serves this function
4. **Vector graphics**: PDF/EPS for plots, PNG (600 DPI) only for photographs

### Accessibility

8% of men have color vision deficiency.

**Solutions**:
- Use colorblind-safe palettes: Okabe-Ito or Paul Tol
- Avoid red-green combinations
- Verify figures work in grayscale
- Use different line styles (solid, dashed, dotted)

### Tools

```python
import matplotlib.pyplot as plt
plt.style.use(['science', 'ieee'])  # SciencePlots library
```

---

## Common Mistakes

### Structure Mistakes

| Mistake | Solution |
|---------|----------|
| Introduction >1.5 pages | Move background to Related Work |
| Methods after page 3 | Front-load contribution |
| Missing contribution bullets | Add 2-4 specific claims |
| Experiments without claims | State what each tests |

### Writing Mistakes

| Mistake | Solution |
|---------|----------|
| Generic abstract opening | Start with specific contribution |
| Inconsistent terminology | One term per concept |
| Passive voice overuse | "We show" not "It is shown" |
| Hedging everywhere | Be confident unless uncertain |

### Figure Mistakes

| Mistake | Solution |
|---------|----------|
| Raster graphics for plots | Use vector (PDF/EPS) |
| Red-green colors | Colorblind-safe palette |
| Title inside figure | Put in caption |
| Captions require main text | Make self-contained |

---

## Pre-Submission Checklist

**Narrative**:
- [ ] Can state contribution in one sentence
- [ ] Three pillars (What/Why/So What) clear in intro
- [ ] Every experiment supports a specific claim

**Structure**:
- [ ] Abstract follows 5-sentence formula
- [ ] Introduction ≤1.5 pages
- [ ] Methods start by page 2-3
- [ ] 2-4 contribution bullets included
- [ ] Limitations section present

**Writing**:
- [ ] Consistent terminology throughout
- [ ] No generic opening sentences
- [ ] Hedging removed unless necessary
- [ ] All figures have self-contained captions

**Technical**:
- [ ] All citations verified
- [ ] Error bars included with methodology
- [ ] Compute resources documented
