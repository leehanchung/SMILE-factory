# GLiNER2 benchmark and calibration protocol

Proposed 2026-09-19. No benchmark has run. This protocol operationalizes the [experiment plan](experiments.md) and [calibration design](calibration.md). Start with `fastino/gliner2-base-v1`; larger GLiNER2 and GLiNER2.5 checkpoints are later, separately named experiments.

Published baseline: [Zaratiana et al., EMNLP 2025 System Demonstrations](https://aclanthology.org/2025.emnlp-demos.10/), discussed in the [literature survey](architecture.md#literature-survey-gliner2). Our calibration evaluation extends the questions addressed by that paper.

## Questions and scope

1. How useful are pretrained GLiNER2 probabilities on our tasks?
2. Does domain fine-tuning improve prediction quality while preserving or worsening calibration?
3. How much does post-hoc calibration help, and how many independent labeled contexts does it require?
4. Does that correction transfer to new schemas, candidate counts, and populations?
5. At a fixed error budget, how much work can the model accept automatically?

Begin with exclusive classification and boolean propositions. Add multilabel tasks and entity/record extraction as distinct tracks. Numerical forecasting remains outside this benchmark. The target domain and hardware are unresolved; the task examples and budgets below are proposed defaults, not approved deployment requirements.

## Phase 0: audit score semantics

The inspected [GLiNER2 runtime](https://github.com/fastino-ai/GLiNER2/blob/main/gliner2/inference/runtime.py) computes classification logits, applies softmax or sigmoid according to configuration, and then selects outputs. Single-label output retains only the winner. Multilabel output applies a threshold and falls back to the highest-scoring label if none passes. Span extraction applies sigmoid scores followed by decoding and filtering. These observations concern mutable `main`, reviewed 2026-09-19; verify against the pinned version before execution.

Build a read-only score adapter that captures logits and candidate identities before selection. Verify that reconstructing the default probabilities reproduces public output on 100 development requests. Capture explicit activation, masks, truncation, and decoder settings. `format_results=False` must not be assumed to expose full logits.

| Track | Probability target | Required capture |
| --- | --- | --- |
| Exclusive classification | Each mutually exclusive label is correct | Complete logits and one normalized distribution per field |
| Boolean | The defined proposition is true | Both exclusive labels; use the true-label probability, not winner confidence |
| Multilabel | Each label independently applies | Every label score, including unselected labels; no normalization across labels |
| Extraction | A returned span/value is correct under a fixed matching rule | Candidate identity, score, offsets, decoder decisions, and reviewed gold spans |

Represent insufficient evidence explicitly where the task calls for it. For a true/false/unknown schema, score all three classes; do not silently convert unknown into false. For multilabel data, only treat absent labels as negatives when annotation is exhaustive.

Fail this phase if candidate mapping, normalization, or score capture is unreliable. Top-label correctness calibration is still possible from winner confidence, but it cannot substitute for full-distribution NLL or multiclass Brier scores.

## Phase 1: data and leakage controls

Use the [training-data plan](training-data.md). Select 5–10 task families from real available labels, for example document category, evidence-supported rule decisions, issue tags, and entity/attribute extraction. Audit 200–500 fields, with blind second review of a subset and adjudication of disagreements. Keep synthetic diagnostics separate from the representative primary benchmark.

Proposed pilot allocation for 10,000 independent source contexts:

| Partition | Contexts | Allowed use |
| --- | ---: | --- |
| Training | 5,000 | Fine-tune predictor; estimate simple class-prior baseline |
| Development | 1,000 | Choose model, schema wording, calibrator family, and policy thresholds |
| Calibration | 2,000 | Fit selected post-hoc corrections with frozen predictor |
| Final test | 2,000 | One locked evaluation after all choices are frozen |

Keep all fields, paraphrases, contrastive siblings, and documents from the same source/entity group in one partition. Respect chronology when future deployment is the target. Counts may change to accommodate grouping; record actual independent groups, fields, class counts, and provenance. Preserve realistic prevalence in calibration and test. Do not balance those sets by silently resampling rare labels.

Reserve about 500 final-test contexts for task/schema families absent from training, development, and calibration. Use the remaining roughly 1,500 for familiar-family evaluation. Treat this as a coarse transfer screen, not sufficient evidence for every held-out family. Obtain additional time/source-shift sets if data permits; report them separately rather than blending them into the primary result.

For method selection, use grouped cross-validation within development data: fit trial calibrators on development folds and compare on held-out folds. After selection, fit the chosen calibrator on the untouched calibration partition. Select acceptance thresholds using out-of-fold calibrated development predictions, then freeze them. Do not revise them from final-test results.

## Phase 2: controlled experiment matrix

Run pretrained and domain-fine-tuned GLiNER2 with the same frozen inputs, schemas, and evaluation records. Use three fine-tuning seeds if feasible; report all, not just the best. Begin with real-only training; synthetic augmentation is a later ablation.

| Arm | Exclusive classification | Binary/multilabel or extraction correctness |
| --- | --- | --- |
| Raw | Native probabilities | Native scores |
| Pooled correction | One positive temperature per model | Logistic calibration with slope and intercept |
| Family correction | Regularized family temperatures with pooled fallback | Family logistic corrections with pooled fallback |
| Flexible sensitivity arm | Deferred until scalar methods are inadequate | Isotonic calibration when development evidence supports sufficient data |

For exclusive logits `z`, use `softmax(z / T)`, with `T > 0` fitted by NLL. A shared positive temperature preserves the argmax for a fixed choice set; it cannot improve classification accuracy. For binary logits use `sigmoid(a*z + b)` with a nonnegative slope. If only an interior probability is available, use its clipped log-odds and record the clipping constant. Do not sigmoid winner confidence or softmax independent multilabel probabilities.

For a two-logit true/false softmax, the binary logit is `z_true - z_false`. Keep true/false/unknown as a three-class problem.

Use pooled correction as the default. Choose family regularization on development folds; use the pooled transform for unseen families or inadequate class support. Do not fit a separate parameter for each arbitrary runtime label string. [Temperature scaling](https://proceedings.mlr.press/v70/guo17a.html) motivates the simplest arm; [scikit-learn calibration guidance](https://scikit-learn.org/stable/modules/calibration.html) describes sigmoid and isotonic alternatives and their limitations.

Include a smoothed training-prior predictor for known label sets and a uniform predictor for exclusive choices. These expose apparent reliability achieved by uninformative predictions. Run GLiClass and Nimble on common classification tasks when available, with equal data access and calibration budgets; report extraction on its own supported track.

## Phase 3: calibration metrics and uncertainty

Primary outcomes are paired changes in NLL and Brier score relative to each model's raw predictions. Both are proper scores of overall probabilistic quality, not pure calibration measures. Report task-family macro averages and deployment-weighted averages with weights fixed before test. Do not pool different task semantics into one unlabeled score.

- Exclusive NLL: mean `-log(p_true)`; multiclass Brier: mean `sum_k (p_k - y_k)^2`, without dividing by candidate count. Break out results by candidate count.
- Binary Brier: mean `(p - y)^2`; multilabel: binary metrics per label, then explicit macro and micro aggregation. State this convention because two-class multiclass Brier is twice binary Brier.
- Reliability: top-label confidence versus correctness for classification, plus classwise/true-event probability versus observed frequency. Report 10 fixed equal-width bins, counts, mean confidence, observed rate, and uncertainty; show 5- and 20-bin sensitivity. ECE is a secondary summary and depends on binning and sample size.
- Discrimination and utility: accuracy, macro F1, and binary/multilabel PR-AUC with prevalence. Include precision/recall for extraction. Calibration should not hide a weak predictor.
- Uncertainty: 2,000 paired bootstrap resamples of independent source groups, keeping all related fields together. Report 95% intervals for metric differences and reliability gaps. Report variation across training seeds separately; fields are not independent replications.

For high-confidence predictions, report the empirical error rate and group-aware uncertainty at confidence thresholds 0.8, 0.9, and 0.95, alongside accepted counts and coverage. Empty or sparse bins remain visibly unsupported. Report critical slices even when they look worse than the aggregate; avoid claims of significance from scanning many small slices.

## Phase 4: label budget and transfer

Add the [Monte Carlo calibration study](monte-carlo-calibration.md) as a parallel diagnostic: known-probability tasks across discrete and continuous distributions, controlled score distortions, repeated calibration fits, and distribution-shift experiments. Keep simulated findings separate from the real-domain test results.

Fit the selected correction with nested subsets of 100, 250, 500, 1,000, and 2,000 calibration contexts. Repeat subset selection with five fixed seeds; keep group boundaries and class support. Evaluate every predeclared point in the locked final report, without using the curve to retune that test. Count contexts and available labeled outcomes separately.

As a planning illustration, 400 independent Bernoulli outcomes at observed rate 0.9 have an approximate normal 95% half-width of 0.03; this is not a guarantee for correlated fields or rare slices. Base expansion on development-set uncertainty and event counts, not the nominal 10,000-context target alone.

Predeclare transfer panels:

| Panel | What changes | What stays frozen |
| --- | --- | --- |
| Schema robustness | Field/option order, reviewed paraphrases, unrelated fields | Context, label meaning, candidate identities, calibrator |
| Schema transfer | Entire unseen task/schema families | Predictor and pooled/family fallback rule |
| Candidate count | Legitimate 2-, 5-, 10-, and 20-option tasks | Outcome definition; relabel where choices change |
| Deployment shift | Later time period or different source population | All fitted parameters and policy thresholds |
| Runtime stability | Field packing, batch size, chunk boundaries | Logical questions and complete candidate sets |

Use paired development requests to characterize robustness before lock; keep final variants grouped with originals. Report maximum/median probability changes and label-flip rates. Separate semantic changes from numerical variation. Report truncation and unsupported workloads instead of silently dropping them.

## Phase 5: extraction and whole-object confidence

Freeze candidate generation, overlap resolution, and matching before fitting extraction calibrators. Label each returned span by exact boundaries and entity type, with one-to-one matching; report relaxed matching only as a separate metric. Evaluate binary correctness calibration conditional on this fixed output policy. Record false negatives through recall and candidate-generation coverage: good calibration among returned spans does not establish that missing values were found.

If studying pre-threshold candidates, declare the candidate universe and retain representative negatives. Do not report calibration from a balanced negative sample as deployment calibration without correcting sampling weights. Changing thresholds or decoder logic creates a new policy that must be revalidated.

Define record correctness as all required fields matching under a frozen rule. Report empirical exact-record accuracy by field count. Do not multiply marginal field confidences to claim record probability. A learned record-correctness scorer is a separate experiment with its own fitting and calibration data.

## Phase 6: acceptance policy and runtime

Plot risk versus coverage: accepted-prediction error against the fraction accepted. Proposed operational target: choose the highest development coverage whose one-sided 95% upper error bound is at most 5%, then assess the frozen threshold on test. Require at least 200 independent accepted contexts for this initial gate and report slice support. These are pilot defaults; domain error costs may require stricter criteria. For multiple fields per request, distinguish field acceptance from whole-request acceptance.

Proposed research gate: the selected correction improves NLL with a paired 95% difference interval below zero, while the upper bound on Brier degradation is no more than 0.005 under the stated scoring convention. Mark an inconclusive comparison as inconclusive; retain raw probabilities if correction provides no demonstrated benefit. Critical slices must meet their predeclared error budgets or be routed to abstention/review. Failure under shift limits the deployment claim to the evaluated population.

For the primary acceptance gate, preselect one target decision per independent source group and use a one-sided exact binomial upper bound at the frozen test threshold. Report all-field risk separately with cluster-aware uncertainty. A bootstrap sample containing no errors cannot justify a zero upper error bound. Development threshold search is exploratory; only the frozen test assessment supports the gate. If it fails, any revised policy requires fresh validation data.

Benchmark runtime independently of correctness: supported input lengths around 128/256/512 encoder tokens including schema, field counts 1/8/32, and batch sizes 1/8. Record actual token counts and truncation; skip unsupported cells explicitly. On each target CPU/GPU record precision, threads, concurrency, memory, 20 warm-up requests, and at least 200 timed requests per supported cell. Report cold start separately; include preprocessing, score extraction, calibration, decoding, and serialization in end-to-end p50/p95/p99 and throughput. Flag p99 as noisy at this sample size.

## Deliverables and execution order

1. Score-audit report, pinned environment, data manifest, split hashes, and label audit.
2. Raw pretrained score table and development diagnostics; resolve adapter/data defects before training.
3. Frozen model/calibrator selections, statistical conventions, policy thresholds, and run manifest.
4. Locked final report: raw/calibrated comparisons, reliability plots with counts, label-budget curves, transfer panels, risk–coverage plots, extraction results, and runtime table.

Store prediction rows with run/checkpoint/adapter/calibrator IDs, source group, split, schema version, candidate IDs, logits, raw and corrected probabilities, observed labels/masks, selected output, decoding configuration, and timings. Preserve failed requests with explicit status and report their rate. The first implementation milestone is score capture plus pretrained classification evaluation; training and broader baselines follow only after that path is validated.
