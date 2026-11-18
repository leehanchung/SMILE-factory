# Paper Structure: Section-by-Section Guide

## Abstract

**Purpose:** Cold-start orientation + complete narrative in miniature. Most readers stop here.

**Length:** One paragraph, 4-6 sentences, 150-250 words.

**Structure:**

1. **Context sentence:** Uncontroversially true statement situating the subfield
   - "Large language models have achieved remarkable performance on reasoning tasks."
   
2. **Problem/gap sentence:** What's unknown, needed, or problematic
   - "However, the mechanisms underlying their reasoning capabilities remain poorly understood."
   
3. **Contribution sentence:** Your key claim(s)—be specific
   - "We demonstrate that [specific finding] through [brief method description]."
   
4. **Evidence sentence(s):** Key results with concrete numbers
   - "Our approach achieves 94.2% accuracy, outperforming prior methods by 12 points."
   
5. **Impact sentence:** Why this matters
   - "These findings suggest that [implication] and open new directions for [future work]."

**Guidelines:**
- Minimize jargon; define essential terms inline
- Include at least one concrete metric or result
- State the standard of evidence (preliminary exploration vs. systematic study)
- Never "tease"—the abstract should spoil the paper completely

## Introduction

**Purpose:** Extended abstract that motivates, contextualizes, and previews the full paper.

**Length:** 1-2 pages, 4-6 paragraphs.

**Structure:**

### Paragraph 1: Context and Motivation
- What topic are we studying?
- Why does it matter broadly?
- What is the key motivating question?
- Cite liberally to establish "this is a real field with real interest"

### Paragraph 2: Technical Background and Gap
- What do we know about this problem?
- What established techniques does your work use?
- What remains unknown or problematic?
- Cite prior work and explain why it's insufficient

### Paragraph 3: Your Contribution
- What exactly is your main claim?
- Add necessary nuance, detail, caveats
- Be precise about what is and isn't novel

### Paragraph 4: Evidence Summary
- High-level description of key experiments
- Key results with numbers
- Why this evidence supports the claims

### Paragraph 5: Impact and Implications
- What should readers take away?
- Who should change their behavior and how?
- What future work does this enable?

### Final Element: Contributions List
End with explicit bullet points:
- "Our contributions are: (1) We show that... (2) We introduce... (3) We demonstrate..."

**Guidelines:**
- The introduction is a self-contained paper summary
- Repetition with abstract is fine—complex ideas need reinforcement
- Don't "save" key insights for later—reveal everything upfront
- Set up the structure of the rest of the paper

## Background / Related Work

**Placement:** Either Section 2 (if needed to understand contributions) or near the end (if contextualization only).

**Purpose:** Define terms, explain necessary concepts, situate work in literature.

### Background Subsection
- Define key terminology readers may not know
- Explain techniques your method builds on
- Provide only what's needed to understand your paper
- Move detailed tutorials to appendix

### Related Work Subsection
- Group related papers thematically, not chronologically
- For each group: what did they do, how is yours different?
- Be precise about novelty: "Unlike [X] which [limitation], we [improvement]"
- Cite fairly, including critical work even if inconvenient
- Acknowledge parallel/concurrent work explicitly

**Guidelines:**
- The goal is positioning, not comprehensiveness
- Err toward defining terms—readers have less context than you think
- "Insufficiently novel" perception often comes from unclear positioning

## Methods

**Purpose:** Explain what you did in enough detail to replicate.

**Structure Options:**

### For single method papers:
- Problem formulation (formal setup)
- Method description (algorithm, architecture, training)
- Implementation details (hyperparameters, compute)

### For empirical studies:
- Experimental setup (datasets, metrics, baselines)
- Procedure (what experiments, in what order)
- Analysis approach (statistical tests, qualitative methods)

**Guidelines:**
- Enough detail that someone could reimplement from this section
- Justify non-obvious choices ("We use X because...")
- Move extensive details (hyperparameter tables, architecture diagrams) to appendix
- Reference appendix sections explicitly

## Results / Experiments

**Purpose:** Present evidence supporting your claims.

**Structure per experiment:**
1. **What question does this answer?** (Link to claims)
2. **Setup:** Specific instantiation of methods section
3. **Results:** Present findings with figures/tables
4. **Interpretation:** What does this mean for the claim?

**Guidelines:**
- Lead with the most compelling evidence
- Each experiment should clearly connect to a claim
- Present results before interpretation
- Acknowledge unexpected or negative results
- Include error bars, confidence intervals, or statistical tests
- Ensure figures are self-contained with informative captions

### Figure Best Practices
- One key takeaway per figure
- Caption should explain what to look at and why
- Include axis labels, legends, units
- Use color meaningfully (not decoratively)
- Design for grayscale printing

### Table Best Practices
- Bold the best result (indicate what "best" means)
- Include baselines and ablations
- Note statistical significance
- Caption explains rows/columns

## Discussion / Limitations

**Purpose:** Honest reflection on what the work shows and doesn't show.

### Limitations
- What are the boundaries of your claims?
- What assumptions might not hold?
- What could go wrong if practitioners apply this?
- What remains unknown?

### Broader Impact (if required)
- Potential positive applications
- Potential misuse or negative consequences
- Who might be affected?

### Future Work
- Natural extensions
- Open questions your work raises
- What would strengthen the conclusions?

**Guidelines:**
- Honest limitations increase credibility
- Papers without limitations sections seem naive or deceptive
- Frame limitations constructively—opportunities, not failures

## Conclusion

**Purpose:** Reinforce key takeaways (optional section—introduction often suffices).

**Length:** 1-2 paragraphs.

**Content:**
- Restate main claims (different words than abstract)
- Summarize key evidence
- Emphasize implications
- Point to future directions

**Guideline:** If you've written a good introduction, the conclusion may be unnecessary.

## Appendices

**Purpose:** Everything that doesn't fit in the main paper but supports reproducibility and completeness.

**Common appendix contents:**
- Proof details
- Extended experimental results
- Hyperparameter tables
- Dataset statistics
- Additional examples
- Implementation details
- Negative results
- Extended related work

**Guidelines:**
- Appendices are held to lower standards—completeness over polish
- Reference appendix sections from main text: "See Appendix A for details"
- Readers rarely read appendices unless deeply engaged
- Include a table of contents if appendix is long
