# UCI calibration study

**Execution update:** the fresh seed-78 pilot completed 1,045 requests and all three UCI comparisons. See the [summary report](notebooks/04_jev_calibration_report.ipynb); the plan below records the original design. Individual results are in the report appendix.

**Figure 1. Normalized calibration penalty for the completed synthetic experiments.** Bars use exact event probabilities and ten equal-width forecast groups. They are descriptive values for the fixed grids, without population confidence intervals. Lower is better; the table preserves raw Brier loss, resolution, and grouping residuals. Dataset composition and event prevalence differ between panels.

## 2. Selected UCI datasets

| Dataset | Version | Binary target | Why include it? |
|---|---|---|---|
| [South German Credit](https://archive.ics.uci.edu/dataset/522/south+german+credit) | 1,000 rows, 20 predictors | Credit contract not complied with (`kredit=0`) | Corrected coding for the German credit task; 300 bad-credit records. |
| [Bank Marketing](https://archive.ics.uci.edu/dataset/222/bank+marketing) | `bank-additional-full.csv`, 41,188 rows, 20 original predictors | Deposit subscription (`y=yes`) | Rare positive outcome and ordered records for a time-based test. |
| [Online Shoppers](https://archive.ics.uci.edu/dataset/468/online+shoppers+purchasing+intention+dataset) | 12,330 rows, 17 original predictors | Purchase (`Revenue=True`) | Session-level purchase behavior with mixed numeric and categorical features. |

**Dataset checks.** UCI identifies coding errors in the original German Credit dataset; we selected the corrected South German version. Bad credits were oversampled, so the 30% event rate describes this benchmark, not a lending population. Translate categorical codes using its supplied code table; do not infer meanings from integer values.

For Bank Marketing, exclude call `duration` from the main pre-call feature set; a completed call's length is unavailable before that call. Freeze any additional timing exclusions during feature review. For Online Shoppers, exclude `PageValues` from the main comparison because its transaction-related construction requires a separate leakage audit. Session summaries support retrospective classification, not a claim about early-session forecasting.

Downloaded files are local; no UCI rows have been sent to Jev. The following profile verifies the actual versions, labels, counts, missing values, duplicates, and file hashes.

## 3. Real-data experiment protocol

**Partitioning.** Use seed 78. Reserve 60% for baseline training and prompt development, 20% for calibration, and 20% for final testing. Keep duplicate feature records in one partition and flag contradictory labels. Use chronological blocks for Bank Marketing; assign cross-boundary duplicates to the earlier partition and remove later copies. Customer identifiers are absent, so repeated-person leakage cannot be fully excluded. Use grouped, class-stratified partitions for the other datasets, preserving their sampled prevalence as closely as possible.

**Pilot budget.** Select 120 calibration records and 200 test records per dataset from those partitions without class rebalancing. This requires at most **960 Jev requests** for raw Choice, Noul, and opposite-event scores packed per record. This is a pipeline pilot, not a high-precision calibration estimate; rare-event tests may contain few positives. Save selected row identifiers before any inference. Preserve the remaining test records for a later locked evaluation.

**Comparison arms.** Plot raw Jev Choice and Noul, each corrected using the 120 separate calibration labels, a training-prevalence constant, logistic regression, and CatBoost. Fit supervised baselines only on their training records and report their label counts. Use an intercept-and-slope correction as the prespecified pilot calibration method. Never fit or select it on test labels. An optional Jev few-shot arm supplies eight fixed training examples in each prompt and incurs additional API calls; it is distinct from fitting a correction to saved scores.

**Evaluation.** On the same held-out records, report raw Brier score, log loss, ECE (Expected Calibration Error), signed mean error, and the normalized reliability chart. Use ten equal-width probability groups, with five and fifteen as sensitivity checks. Plot paired bootstrap intervals from 1,000 resamples of independent test groups, reporting undefined ratios for single-class resamples. Chronological dependence requires block resampling when time information permits; otherwise label intervals as conditional on record independence. Report bin counts and fit failures. Keep dataset panels separate; do not average unrelated prevalences into one calibration claim.

**Figure layout.** Use one bar group per UCI dataset, consistent colors for each model, and separate panels for normalized reliability, Brier skill against the training-prevalence baseline, and mean probability versus observed event rate. A later cross-validation study can pool one out-of-fold prediction per record, but this pilot is a held-out split and must not be labeled “pooled test folds.”

**Status.** Dataset selection, download, profiling, and the synthetic comparison figure are complete. UCI prompt mapping, split freezing, model fitting, and Jev inference remain to be executed. Public benchmark contamination and historical sampling limit generalization. See [the protocol](../uci-calibration-plan.md) and [references](../references.md).
