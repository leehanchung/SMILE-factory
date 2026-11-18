# Input types

Use the relevant subsection as a content check. These are decision rules; source the actual explanation for each new task.

## Paper excerpts, including GLM-5

Identify the exact paper and version, then one mechanism or result. Do not replace GLM-5 with another version merely because it is newer or easier to find. If only a model name is supplied, find the actual report, propose a bounded subsection, and state the choice. Ask if several interpretations would produce materially different explanations.

Separate the authors' reported results from your illustrative example and from untested interpretation. Carry model sizes, datasets, units, conditions, baseline definitions, and uncertainty into any result comparison. Do not turn a named component into an invented architecture. Distinguish training-time machinery from inference-time machinery. Use an architecture flow only when the source actually specifies the flow.

For dense sections, make a mechanism overview and leave derivations or the full result table in the companion note. One selected subsection often fits; an entire technical report generally needs a series.

## Likert items and scales

Check whether the subject is an individual ordered response item or a composite multi-item scale. Label the distinction in accessible language. A good concrete example is a clearly stated survey question with every response option written out.

Do not imply that equal graphic spacing establishes equal psychological or numerical intervals. If showing an average, justify the interpretation in the source/context; do not universally prescribe or forbid means for every Likert-style dataset. Use a response distribution when it answers the question without additional assumptions. Distinguish neutral, missing, and not-applicable responses. Mark invented counts as illustrative and verify totals and percentages.

## Bradley–Terry model and preference loss

Define what the scores represent and which candidate is observed to be preferred. Distinguish a probability model from the negative log-likelihood used to fit it. Do not call all Bradley–Terry reward fitting DPO.

With log-strength scores `s_A` and `s_B`, the model probability that A is preferred is:

```tex
p(A \succ B) = \frac{e^{s_A}}{e^{s_A}+e^{s_B}} = \sigma(s_A-s_B)
```

For one observation preferring A, using natural logarithms:

```tex
\ell = -\ln p(A \succ B) = \ln(1+e^{-(s_A-s_B)})
```

For arbitrary binary labels, define the target and use the appropriate binary cross-entropy. Do not silently assume every row prefers A. In the score parameterization above, equal scores give probability 0.5; swapping candidates complements the probability. Adding a common constant changes neither probability nor loss. A positive score gap for the observed preferred candidate reduces that observation's loss; that does not prove dataset-wide improvement or justify unlimited score growth.

Calculate illustrative probabilities and losses before rendering. Use approximate signs for rounded values. Keep score direction, sign of the exponent, logarithm, and observed winner consistent in every panel.

Reference for the reward-model form: Rafailov et al., *Direct Preference Optimization: Your Language Model is Secretly a Reward Model*, [Section 3, equations 1–2](https://arxiv.org/html/2305.18290v3#S3). A graphic about this section's Bradley–Terry loss is not automatically an explanation of the paper's later DPO objective.

## Conway's law and other conceptual relationships

Distinguish laws/theorems with mathematical assumptions from empirical generalizations, heuristics, and management advice. Keep wording faithful to the source rather than strengthening the claim with a persuasive graphic.

For Conway's law, map communication relationships to corresponding system boundaries using a concrete labeled example. Clarify whether an arrow means influence, observed correspondence, or a proposed design action. Do not claim that reorganizing teams guarantees a desired architecture. Mark invented org charts and systems as illustrations. If an inverse Conway maneuver is discussed, identify it as a design strategy and separately support its expected effects.

## Style references are not subject-matter evidence

Use the bundled example and any user-supplied reference for visual direction. Do not transfer their topic, equations, assumptions, or technical simplifications into a new subject. Verify the new explanation against its own sources and use a layout that represents its actual relationships.
