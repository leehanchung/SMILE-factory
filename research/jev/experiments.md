# Experiment plan

**Execution status:** the seed-78 pilot completed 1,045 Jev requests, the coin/threshold and two-dice experiments, and all three UCI comparisons, including supervised baselines and held-out recalibration. See the [calibration report](notebooks/04_jev_calibration_report.ipynb); individual results are in its appendix.

Open-weight model training and the ConfTuner comparison remain proposed. Treat the inspected pilot data as development evidence when selecting new methods, and reserve new confirmatory data. Links and supporting papers are indexed in [references](references.md).

## Sequence

1. Choose target tasks, deployment population, hardware, and numerical targets. Freeze definitions and data provenance.
2. Audit 200–500 generated field examples. Build the initial 5–10-family data pilot described in [training-data](training-data.md). The suggested 10,000 contexts is a planning target, not a calibration sample-size guarantee.
3. Freeze source-separated development, calibration, and final test partitions. Include unseen-schema families and realistic class prevalence.
4. Compare an untuned candidate-token scorer, Nimble-style LoRA candidate scoring, and GLiClass/GLiNER2. Restrict comparison to their common supported task types. Do not fabricate numerical capabilities for classification/extraction baselines.
5. Compare real-only supervision, schema augmentation, and added contrastive synthetic supervision. Use the same evaluation sets and report source counts separately from augmented field counts. Add the ConfTuner loss comparison below, using fixed answers for correctness confidence and separately labeled event-probability adaptations.
6. Fit held-out calibrators after freezing each model. Choose complexity on development data, then assess the untouched final test once the recipe is selected.
7. Sweep input length, field count, candidate count, and chunk size. Report backend, hardware, precision, warm/cold conditions, concurrency, latency percentiles, throughput, and peak memory. Single-field timing is not evidence of large-schema parallel speed.
8. Add isolated readouts or continuous numerical heads only when measured gaps justify the change.

## GLiNER2 baseline

Detailed execution protocol: [GLiNER2 benchmark and calibration](gliner2-benchmark.md), including score capture, split allocation, calibration arms, uncertainty, transfer tests, and proposed decision gates.

Parallel diagnostic: [Monte Carlo calibration study](monte-carlo-calibration.md) tests known event probabilities, choice/boolean agreement, multiple distributions, and calibrator robustness under controlled distortions and shift.

Include the [Fastino GLiNER2 repository](https://github.com/fastino-ai/GLiNER2) as an explicit implementation baseline. Its documented capabilities include schema-conditioned classification, entity extraction, structured records, and relations, with optional confidence scores. The repository now covers both GLiNER2 span models and GLiNER2.5 boundary models; keep these separate in results.

Proposed experiment:

1. Start with `fastino/gliner2-base-v1` (documented as 205M parameters, DeBERTa-v3-base). Pin the repository commit, package version, and checkpoint revision. Consider `fastino/gliner2-large-v1` as a later capacity comparison; treat GLiNER2.5 as a separate follow-up.
2. Run the pretrained checkpoint first, then a domain-fine-tuned variant using the same source-separated training data as the other baselines. Freeze schema descriptions on development data.
3. Compare categorical and boolean classification with GLiClass and Nimble on common tasks. Evaluate extraction separately with span/field F1 and exact-record accuracy. Extracting a number from text does not establish numerical forecasting support.
4. Check whether the pinned implementation exposes scores for every candidate needed for log loss, Brier score, and calibration. Record score semantics and any adapter work; returned confidence alone is not evidence of calibration.
5. Apply the existing schema/order/chunk stability tests and latency sweeps. Measure CPU and target-GPU performance separately, including preprocessing and decoding. Use local measurements to assess deployment fit.

Decision gate: retain GLiNER2 if it meets the predeclared quality, calibration, and deployment thresholds on supported tasks. Document unsupported fields and measured gaps before proposing custom heads.

## ConfTuner confidence-training comparison

[ConfTuner: literature review and experiment](conftuner-benchmark.md) records the NeurIPS 2025 evidence, loss derivation, pinned code audit, and planned study design. It changes the training comparison, not the proposed shared-input architecture.

1. Verify confidence-token values, loss/gradient behavior, disjoint source IDs, loaded weights, and parser failures before training. Resolve the released coarse-grid train/evaluation scale mismatch.
2. Freeze an answer bank and correctness labels. Compare untuned confidence, response-only training, tokenized Brier, Brier on mean confidence, binary log loss, and a scalar correctness scorer with matched data and training budgets. Fit held-out corrections for every model.
3. Keep answer-correctness confidence separate from event probability. Extend tokenized Brier to observed event outcomes only as our adaptation; retain all coin/threshold prompt conditions, dice, and UCI coverage on matching targets.
4. Use nested 500/2,000-example training pilots and seeds 78/79/80; evaluate post-hoc budgets of 60/120/250/500 separately. Inspect each seed rather than counting them as independent test records.
5. Make ordinary held-out Brier the primary measure, supported by log loss, reliability, accuracy, discrimination, failures, and compute. Evaluate regenerated answers separately so confidence gains cannot hide changed answer accuracy.

Begin with 2,000 training contexts, 120 calibration contexts, fixed answers, and the three grid losses with a common mean readout; expand only after development checks. The detailed protocol sets proposed advance rules and distinguishes a small paper-style reproduction from a domain adaptation. No ConfTuner training or inference has run.

## Proposed custom architecture

```mermaid
flowchart TD
    X[Input context] --> E[Shared encoder]
    E --> H[Reusable input memory]
    S[Runtime schema] --> P[Parser and field-path mapping]
    P --> Q[Question and candidate representations]
    H --> R[Question-isolated cross-attention readouts]
    Q --> R
    R --> C[Shared candidate scorer]
    R --> B[Binary scorer]
    R --> N[Numerical distribution heads]
    C --> T[Temperature and per-question softmax]
    B --> U[Binary calibration and sigmoid]
    N --> V[Distribution or quantile calibration]
    T --> J[JSON assembler]
    U --> J
    V --> J
```

This is our proposed model, not verified Jev or Nimble internals. Nimble instead uses the pretrained LM output rows for candidate-token scoring; its shared prefix includes the schema. See [architecture](architecture.md) and [working brief](README.md).

## Measures and decision gates

- Classification: accuracy and per-class errors, log loss, Brier score, and reliability plots with uncertainty estimates.
- Numerical forecasts: appropriate proper scores, quantile/interval coverage, and sharpness. Specify units and horizon.
- Generalization: known vs unseen schemas, option counts, populations, and chronological holdouts.
- Stability: unchanged questions under field permutation, unrelated-field addition, and chunk changes. Distinguish numerical tolerance from semantic changes in shared schema input.
- Scaling: compare identical workloads; separately report MLX cache reuse and CUDA full-prompt work where applicable.
- Dataset quality: human-reviewed label errors, shortcut checks, duplicate/source overlap, annotation provenance, and cost per accepted example.

Set numerical pass/fail thresholds before inspecting final-test results; they are not yet agreed. Preserve checkpoint, tokenizer/template, scorer, calibrator, data hashes, seeds, dependency versions, and source commits for each run. Existing research URLs point to mutable branches; pin them at experiment setup.

## Value-function extension

Start with a frozen continuation policy and completed episodes. Train on Monte Carlo returns from prefixes, conditioned on goal, remaining budget/horizon, and action for a Q-function. Use executable alternative-action continuations where resettable environments permit. Keep whole episodes/tasks together when splitting.

A probability-of-success head represents value only under the specified binary terminal-reward objective without extra costs or discounting. General return objectives need numerical/distributional outputs. Score each action independently; do not softmax action values. Evaluate return error, action ranking against repeated rollouts, calibration under the target policy, and actual achieved policy return. Policy improvement can exploit optimistic errors and shifts the critic's input distribution. See the distributional RL and CQL sources in [references](references.md).

## Execution status

The project-local uv environment and offline smoke checks are complete. The pilot collected 85 synthetic requests and 960 UCI requests with Jev 1.13.0 and seed 78: 63 binary-event scenarios (15 coins, 24 thresholds with probabilities supplied, and 24 thresholds with parameters only), 22 two-dice scenarios, and 320 records per UCI dataset. Each UCI comparison used 120 calibration and 200 test records, with logistic-regression/CatBoost baselines and held-out intercept-plus-slope probability corrections. Notebook 04 now reports the cached exploratory reanalysis without making API calls.

These are our pilot results, not a reproduction of [Valeriy M.'s study](https://x.com/predict_addict/status/2101404670488875042). Wider calibration-budget sweeps, open-weight model training, ConfTuner, and confirmatory transfer tests remain proposed. Repeated outcomes for a synthetic prompt do not add independent source contexts.

## Selected real-data experiments

The [UCI study](uci-calibration-plan.md) records the comparison design for South German Credit, Bank Marketing (`bank-additional-full.csv`), and Online Shoppers. The cached results are consolidated in [notebook 04](notebooks/04_jev_calibration_report.ipynb). For new method selection, use these inspected results as pilot evidence and reserve uninspected records or new datasets for confirmation; changing only the seed does not create an untouched test.
