# Annotated Abstract Examples

This document provides annotated examples showing how to structure effective abstracts.

## Abstract Structure Template

```
[CONTEXT: 1 sentence] Situate the subfield, establish what's known
[PROBLEM: 1 sentence] What's unknown, problematic, or needed
[CONTRIBUTION: 1-2 sentences] Your key claims—be specific
[EVIDENCE: 1-2 sentences] Key results with concrete numbers
[IMPACT: 1 sentence] Why this matters, implications
```

---

## Example 1: Mechanistic Interpretability Paper

**Annotated Version:**

> **[CONTEXT]** Understanding how language models represent and process information internally is crucial for ensuring their safe deployment.
>
> **[PROBLEM]** However, the mechanisms by which models implement complex behaviors like refusing harmful requests remain poorly understood.
>
> **[CONTRIBUTION]** We demonstrate that refusal behavior in large language models is mediated by a single direction in activation space, which we identify and characterize across 13 models ranging from 1B to 70B parameters.
>
> **[EVIDENCE]** Ablating this direction reduces refusal rates from 98% to 2% without significantly affecting other capabilities (average task performance drops <3%). We further show that this direction can be identified with only 32 examples and transfers across model families.
>
> **[IMPACT]** These findings suggest that safety behaviors may be more brittle than previously thought and highlight the need for more robust alignment techniques.

**What works:**
- Context is general enough that non-experts understand
- Problem clearly motivates the work
- Contribution is specific: "single direction," "13 models," "1B to 70B"
- Evidence includes concrete numbers (98%→2%, <3%, 32 examples)
- Impact is honest about concerning implications

---

## Example 2: Methods Paper

**Annotated Version:**

> **[CONTEXT]** Large language models require significant compute for inference, limiting their deployment in resource-constrained settings.
>
> **[PROBLEM]** Existing compression techniques sacrifice either quality or generality, requiring task-specific calibration or significant accuracy drops.
>
> **[CONTRIBUTION]** We introduce QuantPrune, a unified framework that combines 4-bit quantization with structured pruning to achieve 8× compression with minimal quality loss.
>
> **[EVIDENCE]** Across 7 benchmarks, QuantPrune achieves 97.2% of full-model accuracy while reducing inference latency by 6.4× and memory by 7.8× on consumer GPUs. Unlike prior methods, QuantPrune requires no task-specific calibration and applies to any transformer-based model.
>
> **[IMPACT]** Our approach enables running models previously requiring A100 GPUs on RTX 3080 hardware, democratizing access to high-quality language models.

**What works:**
- Clear practical motivation (resource constraints)
- Method name introduced early (QuantPrune)
- Specific claims: "8× compression," "4-bit quantization"
- Results across multiple benchmarks (7)
- Concrete improvements (97.2%, 6.4×, 7.8×)
- Practical impact framed concretely (A100 → RTX 3080)

---

## Example 3: Empirical Analysis Paper

**Annotated Version:**

> **[CONTEXT]** Chain-of-thought prompting has become a standard technique for improving language model reasoning.
>
> **[PROBLEM]** Despite its widespread adoption, whether models' stated reasoning actually reflects their computational process—their "faithfulness"—remains contested, with conflicting findings across prior studies.
>
> **[CONTRIBUTION]** We present a systematic study of chain-of-thought faithfulness across 6 model families, 3 reasoning domains, and 4 experimental paradigms. We find that faithfulness varies dramatically: models are highly faithful on arithmetic (92% of reasoning steps causally influence output) but unfaithful on commonsense reasoning (only 23% causal).
>
> **[EVIDENCE]** Through intervention experiments on 12,000 reasoning chains, we identify two key factors explaining this variance: (1) whether intermediate steps are independently verifiable, and (2) the presence of reasoning shortcuts in training data. We release our evaluation framework and dataset.
>
> **[IMPACT]** Our results suggest that chain-of-thought should not be assumed faithful by default and provide actionable criteria for predicting when to trust model explanations.

**What works:**
- Addresses apparent contradiction in prior work
- Scope is clear: 6 families, 3 domains, 4 paradigms
- Key finding is nuanced (not just "it works" or "it doesn't")
- Concrete numbers (92% vs 23%, 12,000 chains)
- Identifies explanatory factors (independently verifiable, shortcuts)
- Practical takeaway for practitioners

---

## Example 4: Dataset/Benchmark Paper

**Annotated Version:**

> **[CONTEXT]** Evaluating language models' ability to follow complex instructions is critical for assessing their real-world utility.
>
> **[PROBLEM]** Existing instruction-following benchmarks either test narrow capabilities or rely on subjective human judgments that are expensive and irreproducible.
>
> **[CONTRIBUTION]** We introduce INSTRUCT-HARD, a benchmark of 5,000 instruction-following tasks with automatically verifiable success criteria. Tasks span 12 categories including formatting constraints, logical conditions, and multi-step requirements, with difficulty calibrated so that current models achieve 20-60% accuracy.
>
> **[EVIDENCE]** We evaluate 15 models and find that instruction-following ability correlates weakly with general capabilities (r=0.34). Notably, models struggle most with negation constraints (18% avg accuracy) and multi-step logical conditions (24% avg accuracy).
>
> **[IMPACT]** INSTRUCT-HARD provides a reproducible benchmark that reveals fine-grained differences between models masked by existing evaluations. We release all data and evaluation code.

**What works:**
- Clear gap in existing benchmarks
- Specific scale: 5,000 tasks, 12 categories, 15 models
- Design choices justified (20-60% accuracy = calibrated difficulty)
- Surprising/useful finding (weak correlation with general capability)
- Identifies specific failure modes (negation, multi-step)
- Releases resources

---

## Common Abstract Mistakes

### Too Vague

❌ "We present a new method that achieves good results on several benchmarks."

✓ "We present XYZ, which achieves 94.2% accuracy on SQuAD, outperforming prior work by 3.1 points."

### Missing Motivation

❌ "We study the internal representations of language models."

✓ "Understanding internal representations is crucial for [X]. However, [Y] remains unknown. We study..."

### No Concrete Results

❌ "Our method significantly outperforms baselines across tasks."

✓ "Our method achieves 12% average improvement across 5 tasks, with gains from 8% (task A) to 18% (task B)."

### Overclaiming

❌ "We solve the problem of hallucination in language models."

✓ "We reduce hallucination rates by 45% on factual QA while maintaining 98% of task performance."

### Underselling

❌ "We attempt to investigate whether X might potentially be true in some cases."

✓ "We demonstrate that X holds across [conditions], providing evidence that [implication]."

### Missing Impact

❌ [No final sentence about why it matters]

✓ "These findings suggest [implication] / enable [application] / call into question [prior belief]."

---

## Self-Check Questions

Before finalizing your abstract, verify:

1. **Can a non-expert understand what you did?** (Test: explain to a friend in another field)
2. **Would someone in your subfield know what's novel?** (Test: what would they learn they didn't know?)
3. **Is there at least one concrete number?** (If not, add one)
4. **Does the last sentence explain why anyone should care?** (If not, add impact)
5. **Is every sentence necessary?** (Cut fluff)
6. **Does it fit the word limit?** (Typically 150-250 words)
