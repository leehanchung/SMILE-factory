# RE Jev training data plan

Proposed implementation for [Schema-conditioned prediction architectures](architecture.md) and [Calibrated structured predictions](calibration.md), not a description of Jev's actual training data.

## Data sources

Combine existing labeled records, real documents with reviewed annotations, programmatic synthetic tasks, and historical outcome records for forecasting. Use LLMs to propose schemas and annotations while distinguishing observed, human-adjudicated, teacher-proposed, and simulator labels. GLiNER2 combines real documents with synthetic examples and LLM annotation; this is a training precedent, not evidence of probability calibration. [GLiNER2 paper](https://arxiv.org/html/2507.18546v1)

Use executable validators for synthetic tasks where feasible. Simulators with known conditional distributions support uncertainty checks, but cannot establish deployment calibration. Historical forecasts require as-of feature snapshots, explicit horizons, and matured outcomes. Missing or censored outcomes remain masked unless an appropriate censoring model is used.

## Records and splits

Store source/entity identifiers, cutoff time, context, schema version, descriptions, field types, candidates, units, horizons, targets, label masks, provenance, evidence references, and split assignment. Keep targets and annotation evidence out of model-visible inputs unless genuinely available at prediction time.

Deduplicate and split source records before augmentation; keep descendants together. Separate training, development, calibration, and final test partitions. Hold out complete schema families as well as familiar-schema examples; paraphrases alone are not new task families.

## Generation and validation

2026-09-18 update: [RE Jev working brief](README.md) adds Bespoke Nimble's contrastive-pair curation as a concrete method to test: alter one decisive fact, verify the changed label, and check that required evidence cannot be removed without making the proposition unknown. This augments the plan without establishing calibration.

Generate explicit schemas, annotate input–question pairs, and validate types, exclusive-choice semantics, target membership, numerical support, and provenance. Use teacher disagreements for review, not ground-truth probability estimates. Audit random samples as well as difficult cases.

Create semantics-preserving schema paraphrases, field renamings, candidate permutations, and nested paths. Relabel when candidate sets, rubrics, or question meanings change. Include confusing alternatives and legitimate absent-answer cases. Unknown event outcomes are not negative outcomes.

Pack only questions about the same context into multi-field requests; randomize field counts and order. Count independent source records separately from augmented field examples. Preserve deployment prevalence and difficulty in calibration/test sets rather than filtering to teacher-approved easy cases.

## Proposed pilot

Planning target: 5–10 task families and roughly 10,000 independent labeled contexts, subject to cost and event prevalence. Audit 200–500 generated fields before expansion. Begin with classification, boolean, and ordinal tasks; evaluate numerical forecasting separately. Compare real-only, real-plus-schema-augmentation, and added-teacher-data runs against fixed evaluation sets. Scale based on learning curves, probability quality, and held-out schema generalization.

Train with observed labels and appropriate prediction losses, not invented teacher confidence targets. Freeze the predictor and fit corrections on representative held-out outcomes following the existing calibration plan. Sample-size targets are not calibration guarantees; assess rare outcomes and subgroup counts explicitly.
