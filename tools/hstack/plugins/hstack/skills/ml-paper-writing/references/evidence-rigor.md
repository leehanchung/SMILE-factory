# Evidence and Rigor in ML/NLP Papers

## The Purpose of Evidence

Evidence exists to **update readers' beliefs** about your claims. The question is not "Does this look like rigorous science?" but "Should this change what people think is true?"

## Red-Teaming Your Narrative

Spend substantial time trying to break your own claims. This is not optional—it's the core of good science.

### Questions to Ask Yourself

1. **Assume you've made a mistake.** Where is it most likely?
2. **Assume there's a hole in your evidence.** What is it?
3. **How could your results be correct but your interpretation wrong?**
4. **What would a skeptical reviewer say?** Address it preemptively.
5. **If you weren't emotionally invested, would you believe this?**

### Common Failure Modes

| Failure Mode | Description | How to Check |
|--------------|-------------|--------------|
| Confirmation bias | Only running experiments you expect to work | Pre-register predictions; run neutral experiments |
| Cherry-picking | Showing only favorable examples | Report random samples alongside curated ones |
| p-hacking | Running many tests, reporting only significant ones | Correct for multiple comparisons; pre-register analyses |
| Overfitting to test | Tuning on test set (directly or indirectly) | Strict train/val/test separation; held-out test set |
| Confounds | Alternative explanations for results | Ablations; controlled experiments |
| Data leakage | Test info leaking into training | Check preprocessing pipeline carefully |

## Experiment Design Principles

### Quality Over Quantity

One compelling experiment that's hard to deny beats ten mediocre ones. Prioritize:
1. Experiments that distinguish between hypotheses (high information)
2. Experiments with clear, quantitative outcomes
3. Experiments that address obvious objections

### Diverse Lines of Evidence

Multiple *qualitatively different* evidence types are more robust than similar experiments repeated.

**Question:** Given the result of Experiment 1, how well can I predict Experiment 2? If highly, they're not diverse.

**Example of diverse evidence:**
- Quantitative accuracy improvements (performance)
- Ablation showing component necessity (causation)
- Probing experiment revealing mechanism (explanation)
- Case study showing qualitative behavior (interpretation)

### Baselines Done Right

**Baseline requirements:**
1. Include the strongest published baseline on your task
2. Implement baselines carefully—tune hyperparameters fairly
3. Run baselines with same compute budget as your method
4. Use same evaluation protocol for all methods

**Common baseline mistakes:**
- Using default hyperparameters for baselines, tuned ones for your method
- Comparing to outdated baselines when stronger ones exist
- Using different evaluation setups that favor your approach
- Not including simple baselines that might work surprisingly well

### Ablation Studies

When your method has components A, B, C, show each component's contribution:
- Full method (A + B + C)
- Remove A (B + C)
- Remove B (A + C)
- Remove C (A + B)
- (If interactions expected) individual components (A, B, C alone)

**Key question:** What happens if I remove each component? Does the claim still hold?

## Statistical Rigor

### Sample Size and Variance

- Report mean and standard deviation across multiple runs (minimum 3, preferably 5+)
- Use different random seeds for training
- Report variance in tables: "94.2 ± 1.3"
- Confidence intervals are better than point estimates

### Significance Testing

**For frequentist tests:**
- p < 0.05 is often insufficient, especially for exploratory work
- Studies at 0.01 < p < 0.05 frequently fail to replicate
- Target p < 0.001 for claims you want to stand on
- Report exact p-values, not just thresholds

**Multiple comparisons:**
- If testing n hypotheses, apply Bonferroni or similar correction
- Pre-register your main hypothesis to distinguish from exploratory analyses
- Report how many tests were run, not just significant ones

### Recommended Tests

| Comparison | Recommended Test |
|------------|------------------|
| Two models, multiple runs | Paired t-test or Wilcoxon signed-rank |
| Multiple models | ANOVA + post-hoc (Tukey HSD) |
| Proportions | McNemar's test |
| Correlation | Pearson (linear) or Spearman (monotonic) |

### Effect Size

Report effect size alongside significance:
- Cohen's d for comparing means
- Percentage improvement
- Absolute differences (not just relative)

Statistically significant ≠ practically meaningful. A 0.1% improvement may be significant with enough samples but meaningless in practice.

## Reproducibility

### What to Report

**Model/method:**
- Architecture details (layers, dimensions, etc.)
- Training procedure (optimizer, learning rate schedule)
- Hyperparameters (all of them)
- How hyperparameters were selected (grid search, etc.)
- Compute resources (GPUs, training time)

**Data:**
- Dataset name, version, source
- Preprocessing steps
- Train/val/test split (random seed if applicable)
- Dataset statistics (size, class balance, etc.)

**Evaluation:**
- Exact metric definitions
- Evaluation protocol (how many runs, etc.)
- Statistical tests used

### Code Release

Strongly encouraged for top venues. Requirements:
- Code runs on a fresh machine
- README with setup instructions
- Links to weights/data (or instructions to obtain)
- Example script reproducing key results
- Dependencies pinned to versions

### Anonymization for Submission

- Remove author names from code
- Use anonymous GitHub or archive upload
- Remove identifying paths, comments
- Do not link to personal websites

## Types of Evidence

### Quantitative Evidence

**Strengths:** Objective, comparable, statistical tests applicable
**Weaknesses:** Can miss nuance, metrics may not capture what matters

**Requirements:**
- Define metrics precisely
- Report uncertainty (std, CI)
- Compare to appropriate baselines
- Show results across multiple conditions

### Qualitative Evidence

**Strengths:** Reveals nuance, catches unexpected behaviors, interpretable
**Weaknesses:** Cherry-picking risk, hard to generalize

**Requirements:**
- Report how examples were selected
- Include random samples alongside curated ones
- Acknowledge limitations of small samples
- Use to complement, not replace, quantitative evidence

### Ablation Evidence

**Purpose:** Show that components of your method are necessary and sufficient

**Requirements:**
- Systematic removal/addition of components
- Same evaluation protocol throughout
- Report all ablations, not just favorable ones

### Probing / Analysis Evidence

**Purpose:** Understand *why* something works, not just *that* it works

**Requirements:**
- Clear hypothesis being tested
- Controls for confounds
- Connect findings to main claims

## Handling Negative Results

### When Results Don't Support Claims

1. **Don't hide them.** Selective reporting is scientific misconduct.
2. **Understand why.** Is the claim wrong or the experiment flawed?
3. **Report honestly.** "Contrary to our hypothesis, we found..."
4. **Adjust claims.** Narrow or hedge based on actual evidence.

### Negative Results Papers

Negative results can be valuable contributions:
- Failed replications of published claims
- Hypotheses that didn't pan out despite reasonable expectation
- Methods that don't generalize as expected

Frame these constructively: "We tested X under conditions Y and found it fails because Z."

## Limitations Section Requirements

Every paper should explicitly discuss:

1. **Scope limitations:** Where don't your claims apply?
2. **Data limitations:** How might your data bias results?
3. **Method limitations:** What assumptions might fail?
4. **Evaluation limitations:** What don't your metrics capture?
5. **Uncertainty:** What are you least sure about?

**Honest limitations increase credibility.** Papers without limitations seem naive or deceptive. Reviewers will find the holes anyway—better you address them first.
