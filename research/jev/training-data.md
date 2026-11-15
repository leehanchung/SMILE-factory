# RE Jev training data plan

Proposed implementation for [Schema-conditioned prediction architectures](architecture.md) and [Calibrated structured predictions](calibration.md), not a description of Jev's actual training data.

## Data sources

Combine existing labeled records, real documents with reviewed annotations, programmatic synthetic tasks, and historical outcome records for forecasting. Use LLMs to propose schemas and annotations while distinguishing observed, human-adjudicated, teacher-proposed, and simulator labels. GLiNER2 combines real documents with synthetic examples and LLM annotation; this is a training precedent, not evidence of probability calibration. [GLiNER2 paper](https://arxiv.org/html/2507.18546v1)

Use executable validators for synthetic tasks where feasible. Simulators with known conditional distributions support uncertainty checks, but cannot establish deployment calibration. Historical forecasts require as-of feature snapshots, explicit horizons, and matured outcomes. Missing or censored outcomes remain masked unless an appropriate censoring model is used.

## Records and splits

Store source/entity identifiers, cutoff time, context, schema version, descriptions, field types, candidates, units, horizons, targets, label masks, provenance, evidence references, and split assignment. Keep targets and annotation evidence out of model-visible inputs unless genuinely available at prediction time.

Deduplicate and split source records before augmentation; keep descendants together. Separate training, development, calibration, and final test partitions. Hold out complete schema families as well as familiar-schema examples; paraphrases alone are not new task families.

## ConfTuner answer-correctness records

The [ConfTuner study](conftuner-benchmark.md) needs a frozen answer bank in addition to outcome records. Store the source/question ID, question/context, submitted answer, answer-model revision, prompt and decoding policy, reference/evidence, correctness label, and validator or judge version. Keep correctness labels and reference answers out of assessor inputs. Separate event outcome `Y` from answer correctness `Z`; a correct numerical forecast need not predict the realized event with certainty.

Generate answers once for the fixed-answer comparison and retain both correct and incorrect answers. Use executable checks first, human review for ambiguous cases, and audited judges where necessary. Unresolved judgments are missing labels, never automatic errors. Audit 200–500 examples, including disagreements and a random sample; report excluded-label counts and their potential bias.

Split original sources before answer generation or augmentation, keeping all answer variants and related fields together. The proposed 10,000-context allocation is 5,000 train, 1,000 development, 2,000 calibration, and 2,000 test, including prespecified held-out families absent from training, development selection, and calibration for the transfer test. Use nested training budgets and count post-hoc calibration labels separately. This is a study-wide planning target, subject to available independent records and outcome prevalence. Notebook 04's inspected data cannot serve as a new untouched test for methods chosen from its findings.

If fine-tuning changes the answer policy, regenerate and relabel answers for a separate joint-generation evaluation. Labels for an old answer do not establish correctness of a new one.

## Generation and validation

2026-09-18 update: [RE Jev working brief](README.md) adds Bespoke Nimble's contrastive-pair curation as a concrete method to test: alter one decisive fact, verify the changed label, and check that required evidence cannot be removed without making the proposition unknown. This augments the plan without establishing calibration.

Generate explicit schemas, annotate input–question pairs, and validate types, exclusive-choice semantics, target membership, numerical support, and provenance. Use teacher disagreements for review, not ground-truth probability estimates. Audit random samples as well as difficult cases.

Create semantics-preserving schema paraphrases, field renamings, candidate permutations, and nested paths. Relabel when candidate sets, rubrics, or question meanings change. Include confusing alternatives and legitimate absent-answer cases. Unknown event outcomes are not negative outcomes.

Pack only questions about the same context into multi-field requests; randomize field counts and order. Count independent source records separately from augmented field examples. Preserve deployment prevalence and difficulty in calibration/test sets rather than filtering to teacher-approved easy cases.

## Proposed pilot

Planning target: 5–10 task families and roughly 10,000 independent labeled contexts, subject to cost and event prevalence. Audit 200–500 generated fields before expansion. Begin with classification, boolean, and ordinal tasks; evaluate numerical forecasting separately. Compare real-only, real-plus-schema-augmentation, and added-teacher-data runs against fixed evaluation sets. Scale based on learning curves, probability quality, and held-out schema generalization.

Train with observed labels and appropriate prediction losses, not invented teacher confidence targets. Freeze the predictor and fit corrections on representative held-out outcomes following the existing calibration plan. Sample-size targets are not calibration guarantees; assess rare outcomes and subgroup counts explicitly.
