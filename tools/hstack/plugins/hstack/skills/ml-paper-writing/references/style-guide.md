# Academic Writing Style Guide

## Voice and Tone

### Active Voice
Use active voice as the default. Passive voice distances the reader from the work.

| Passive (Avoid) | Active (Prefer) |
|-----------------|-----------------|
| "It was shown that..." | "We show that..." |
| "The model was trained on..." | "We train the model on..." |
| "X is achieved by Y" | "Y achieves X" |
| "Experiments were conducted" | "We conduct experiments" |

**Exception:** Use passive when the actor is irrelevant or unknown: "The dataset was collected in 2019."

### First Person Plural
Use "we" consistently, even for single-author papers (convention in ML/NLP).
- "We propose..." "We show..." "We observe..."
- Not: "I" or "the authors" or "one"

### Confident but Calibrated
Match confidence to evidence strength:

| Evidence Strength | Phrasing |
|-------------------|----------|
| Strong proof | "We prove that X" |
| Strong empirical | "We demonstrate that X" / "We show X" |
| Solid evidence | "Our results indicate X" |
| Suggestive | "Our findings suggest X" |
| Preliminary | "We observe preliminary evidence for X" |
| Speculation | "We hypothesize that X" / "X may be because..." |

**Avoid false hedging:** If you have strong evidence, don't undercut it with "We attempt to show" or "We try to demonstrate."

## Sentence Construction

### Lead with the Point
Put the main message at the start of sentences and paragraphs.

**Weak:** "After training the model for 100 epochs and applying early stopping based on validation loss, we observe that performance improves."

**Strong:** "Performance improves after 100 training epochs with early stopping on validation loss."

### One Idea Per Sentence
Complex sentences with multiple clauses obscure meaning.

**Weak:** "The model, which uses a transformer architecture that we modified to include cross-attention between the encoder and decoder, achieves state-of-the-art results on three benchmarks, though performance varies across domains."

**Strong:** "Our modified transformer adds cross-attention between encoder and decoder. This achieves state-of-the-art results on three benchmarks. Performance varies across domains."

### Vary Sentence Length
Mix short punchy sentences with longer explanatory ones. Short sentences emphasize key points.

"Transformers struggle with length generalization. Despite training on sequences up to 512 tokens, performance degrades sharply beyond this limit. We address this through..."

### Parallel Structure
Use consistent grammatical structure in lists and comparisons.

**Weak:** "Our method is faster, achieves higher accuracy, and memory usage is reduced."

**Strong:** "Our method is faster, more accurate, and more memory-efficient."

## Word Choice

### Prefer Simple Words

| Avoid | Prefer |
|-------|--------|
| utilize | use |
| methodology | method |
| facilitate | help, enable |
| leverage | use |
| prior to | before |
| subsequent to | after |
| in order to | to |
| a large number of | many |
| in the event that | if |
| at this point in time | now |
| due to the fact that | because |

### Avoid Vague Intensifiers

| Vague | Concrete |
|-------|----------|
| significantly better | 12% higher accuracy |
| much faster | 3x speedup |
| state-of-the-art | best published result on X |
| considerable improvement | improves F1 from 78 to 91 |
| very large | 175B parameters |
| substantial gains | +8.2 BLEU |

### Minimize Hedging Words
Every hedge costs clarity. Use only when genuinely uncertain.

**Hedges to audit:** somewhat, relatively, fairly, quite, rather, arguably, perhaps, possibly, might, may, could, seems, appears, tends to

**Weak:** "Our method seems to somewhat improve performance in most cases."

**Strong:** "Our method improves performance in 8 of 10 test cases."

### Avoid Overused Academic Clichés

| Cliché | Alternative |
|--------|-------------|
| "novel" | "new" or just describe what's new |
| "the literature" | cite specific papers |
| "promising results" | report actual numbers |
| "further research is needed" | specify what research |
| "it is well known that" | cite the source |
| "intuitively" | explain why it's intuitive |
| "trivially" | explain or prove it |

### Technical Terminology
- Define terms before using them
- Use terms consistently (don't switch between synonyms)
- Italicize terms when first defined: "We define *attention head salience* as..."
- Include a glossary in appendix for papers with many terms

## Paragraph Structure

### Opening Sentence
Each paragraph's first sentence should convey its main point.

**Test:** Read only first sentences—does the argument flow?

### One Theme Per Paragraph
If a paragraph covers multiple topics, split it.

### Transitions
Connect paragraphs explicitly:
- "Building on this observation, we..."
- "However, this approach has limitations..."
- "We now turn to..."
- "To address this, we..."

### Paragraph Length
- Aim for 4-8 sentences
- Single-sentence paragraphs emphasize key points (use sparingly)
- Walls of text lose readers—break them up

## Numbers and Quantities

### Spelling Out Numbers
- Spell out single-digit numbers: "three models," "seven datasets"
- Use numerals for 10+: "12 experiments," "256 dimensions"
- Always use numerals with units: "5 epochs," "3.2B parameters"
- Use numerals in results: "achieves 94.2% accuracy"

### Precision
- Report precision appropriate to measurement: 94.2% not 94.23847%
- Include standard deviation or confidence intervals: 94.2 ± 1.3%
- Be consistent across tables and text

### Units and Notation
- Define notation when first used: "Let $x \in \mathbb{R}^d$ denote..."
- Use SI units with proper spacing: "5 GB," "100 ms"
- Thousands separator: "10,000" or "10k" (be consistent)

## Citations

### Citation Placement
- Citations support claims, not sentences
- Place after the claim, before the period: "Transformers achieve strong results (Vaswani et al., 2017)."
- For author-as-subject: "Vaswani et al. (2017) introduced the transformer."

### Citation Density
- Cite early and often in intro/related work (establishes credibility)
- Main body needs fewer citations (focus on your contribution)
- Every claim about prior work needs citation

### Multiple Citations
- Chronological order: (Smith, 2019; Jones, 2020; Lee, 2021)
- Group thematically when appropriate
- Use "et al." for 3+ authors: "Smith et al. (2020)"

### Self-Citation (Anonymous Submission)
- Refer to own work in third person: "Prior work showed..." not "We previously showed..."
- Cite normally in references (don't anonymize)
- If reference reveals identity, note "anonymized for review"

## Equations

### Inline vs. Display
- Inline ($...$) for short expressions: "where $\alpha = 0.1$"
- Display for important equations or anything with fractions/summations

### Numbering
- Number all referenced equations: "as shown in Eq. (3)"
- Unnumbered equations for intermediate derivations

### Notation Consistency
- Vectors: bold lowercase ($\mathbf{x}$) or with arrows ($\vec{x}$)—pick one
- Matrices: bold uppercase ($\mathbf{W}$)
- Sets: calligraphic ($\mathcal{D}$)
- Functions: regular font ($f(x)$)
- Define notation on first use

## Figures and Tables

### Figure Captions
- Self-contained: reader should understand without reading text
- Structure: What is shown → How to read it → Key takeaway
- Include enough detail to interpret

**Example:** "Accuracy vs. training steps for three model sizes. Larger models converge faster but plateau at similar final accuracy. Shaded regions show 95% confidence intervals across 5 seeds."

### Table Captions
- Place above the table
- Explain row/column meanings
- Note any abbreviations

### Referring to Figures/Tables
- "Figure 1 shows..." or "...as shown in Figure 1"
- "Table 2 reports..." or "...reported in Table 2"
- Never "the figure below" (position may change)

## Common Grammatical Issues

### That vs. Which
- "That" for restrictive clauses (essential): "The model that uses attention..."
- "Which" for non-restrictive (parenthetical): "The model, which uses attention, ..."

### Affect vs. Effect
- "Affect" is usually a verb: "X affects Y"
- "Effect" is usually a noun: "the effect of X on Y"
- Exception: "effect" as verb means "to bring about": "effect change"

### Data: Singular or Plural?
- ML convention: "The data shows..." (singular)
- Traditional: "The data show..." (plural)
- Be consistent throughout

### Its vs. It's
- "Its" = possessive: "the model and its parameters"
- "It's" = "it is": "It's important to note..."

### Comprise vs. Compose
- "The dataset comprises 10k examples" (whole comprises parts)
- "10k examples compose the dataset" (parts compose whole)
- Never "comprised of"
