# ConfTuner: literature review and calibration experiment

Research-plan addition, 2026-09-21. **ConfTuner merits a controlled training comparison, but it does not directly recalibrate Jev's event probabilities.** It trains a language model to state the chance that an answer is correct. Our coin, dice, and UCI experiments estimate the chance that an event occurs. The target must be explicit before comparing scores.

This document records published evidence, an audit of the released implementation, and our proposed experiments. No ConfTuner model has been run locally. The existing [Jev report](notebooks/04_jev_calibration_report.ipynb) remains the completed pilot; the experiments below require new training and evaluation data.

## 1. Published evidence

Yibo Li, Miao Xiong, Jiaying Wu, and Bryan Hooi. **ConfTuner: Training Large Language Models to Express Their Confidence Verbally.** NeurIPS 2025, volume 38. [Proceedings and DOI](https://proceedings.neurips.cc/paper_files/paper/2025/hash/4d4f7cf206bb00f9a38a5b6ae92cf79a-Abstract-Conference.html), [paper](https://arxiv.org/abs/2508.18847), [official implementation](https://github.com/liushiliushi/ConfTuner). See R58–R59 in [references](references.md).

The method learns from binary answer-correctness labels rather than teacher-supplied confidence percentages. It applies a tokenized Brier loss to the model's scores for numerical confidence tokens. Training uses stored HotpotQA answers; evaluation covers HotpotQA, GSM8K, TriviaQA, StrategyQA, and TruthfulQA. The paper compares base models, Ensemble, LACIE, and SaySelf with ConfTuner.

The following are **author-reported averages across five datasets**, not our measurements. Expected calibration error (ECE) measures binned confidence–accuracy gaps; lower is better. Area under the receiver operating characteristic curve (AUROC) measures how well confidence ranks correct answers above incorrect answers; higher is better.

| Model | ECE, base → ConfTuner | AUROC, base → ConfTuner |
| --- | --- | --- |
| Llama-3.1-8B-Instruct | .2768 → .1082 | .5923 → .6740 |
| Qwen2.5-7B-Instruct | .3781 → .2872 | .6155 → .6861 |
| Ministral-8B-Instruct-2410 | .4393 → .1884 | .5216 → .6810 |

Source: paper Tables 1–2. Improvements vary by task; ConfTuner does not win every comparison. These ECE values are not Brier scores. The main tables do not establish improved event-probability forecasting or calibration on our UCI datasets.

The black-box experiment trains a separate Llama assessor of GPT-4o answers; it does not modify GPT-4o. This suggests a possible assessor for Jev's selected answers, with additional training and inference costs. Appendix F.3 also shows that answer accuracy can change after training. We therefore separate confidence assessment of fixed answers from experiments that regenerate answers. The theorem concerns an ideal population optimum; it does not guarantee finite-data calibration, preserved accuracy, or transfer to new populations.

## 2. What the loss means

Let `y=1` mean that the supplied answer is correct, and `y=0` mean it is incorrect. Let `c_j` be a confidence value, such as .60, and `w_j` the softmax probability of its token, normalized over the allowed confidence tokens. ConfTuner minimizes

\[
L_{\mathrm{TB}}(w,y)=\sum_j w_j(y-c_j)^2.
\]

The model can put all token probability on “60%” while reporting confidence .60. Certainty about which number to print is different from certainty that the answer is correct. The paper uses a 101-level grid and a ten-level alternative; the code audit below identifies a scale discrepancy in the latter.

**Our derivation.** For mean reported confidence `mu = sum_j w_j c_j`,

\[
L_{\mathrm{TB}}=(\mu-y)^2+\operatorname{Var}_{w}(c).
\]

Thus tokenized Brier differs from ordinary Brier on the mean: it also penalizes spread across confidence tokens. If the conditional correctness rate is `q`, then

\[
\mathbb E[L_{\mathrm{TB}}\mid q]
=q(1-q)+\sum_j w_j(c_j-q)^2.
\]

Its ideal solution puts weight on the nearest confidence level. On a grid spaced by `1/N`, rounding error is at most `1/(2N)`; exact midpoint ties allow mixtures of the two nearest levels. This is a statement about an unrestricted population optimum, not a bound on a fitted model's error.

**Do not apply this loss to outcome tokens as if they were confidence levels.** With only “no” and “yes”, interpreted as `c={0,1}`, and positive-token weight `p`, expected tokenized loss is `q + p(1-2q)`. At `q=.60`, it favors `p=1`. Ordinary binary Brier instead has expectation `q(1-q)+(p-q)^2`, minimized at `p=.60`. Confusing these objectives would reproduce the winner concentration our coin study was designed to detect.

This motivates a direct ablation: train the same confidence-token readout with tokenized Brier versus Brier on its mean. Any difference then tests the effect of the variance penalty, rather than a change of backbone or labels.

## 3. Define the target before training

| Evaluation | Model input and output | Label used for scoring |
| --- | --- | --- |
| Event probability | Context and event; output `p`, the chance the event occurs | Observed event `Y`, or its known generator probability `q` for analytic scoring |
| Answer correctness | Question and a fixed submitted answer; output `c`, the chance that answer is correct | Reviewed or executable correctness `Z` |
| Joint answer and confidence | Question; generate an answer and its confidence | Correctness of that model's newly generated answer |

Example: if a coin has heads probability .60, the numerical answer “.60” can be correct with confidence near 1. Its correctness confidence must not be compared with the next toss as though it were `P(heads)`.

For a fixed binary class answer, correctness confidence can be converted to a positive-event forecast: use `c` if the selected class is positive and `1-c` otherwise. This requires confidence about that exact selected class, not confidence in a numerical estimate or a concentration statistic. Validate the converted forecast against event outcomes, separately by selected class; aggregate correctness calibration alone is insufficient.

ConfTuner requires trainable weights. For Jev, retain the existing raw and held-out post-hoc calibration comparisons. A separate ConfTuner assessor would receive the context, question, and frozen Jev class answer; label this as a new model with access to those inputs. It cannot be presented as a correction using only Jev's original probability. Multiclass answer correctness does not recover probabilities for all unchosen classes.

## 4. Reproduction checks from the released code

Audit date: 2026-09-21. All code links below are pinned to commit `faedc8c1bf1dbd856a5146637247fe650eb3c4e3`. These findings describe the released paths; they do not establish how every published result was produced.

| Finding | Required action before a run |
| --- | --- |
| [Fine-grid loss](https://github.com/liushiliushi/ConfTuner/blob/faedc8c1bf1dbd856a5146637247fe650eb3c4e3/src/llama_recipes/utils/train_utils_uncertainty.py#L110-L174) takes the first token ID for each number and renormalizes only allowed-token logits. | Assert each confidence value has one unique token in the actual prefix context. Check the confidence position, whitespace, masks, loss, and gradients. Record total full-vocabulary mass on allowed tokens. |
| [Coarse training](https://github.com/liushiliushi/ConfTuner/blob/faedc8c1bf1dbd856a5146637247fe650eb3c4e3/src/llama_recipes/utils/train_utils_uncertainty_coarse.py#L106-L162) maps digits to `j/9`; [coarse evaluation](https://github.com/liushiliushi/ConfTuner/blob/faedc8c1bf1dbd856a5146637247fe650eb3c4e3/src/llama_recipes/utils/train_utils_uncertainty_coarse.py#L496-L547) uses `j/10`. | Start with the 101-level grid. For a ten-level ablation, use one declared map in prompts, training, decoding, and scoring. Keep any unchanged-code replication separate from our corrected implementation. |
| The default non-GPT [HotpotQA loader](https://github.com/liushiliushi/ConfTuner/blob/faedc8c1bf1dbd856a5146637247fe650eb3c4e3/src/llama_recipes/datasets2/hotpot_qa.py#L137-L188) takes 2,000 training records from a training file, but validation and test both take the first 1,000 rows of the same validation file. | Supply explicit disjoint source IDs and check overlap. This is a validation/test reuse risk in the default loader, not evidence of training/test overlap or a claim that the paper used this exact path. |
| The [README](https://github.com/liushiliushi/ConfTuner/blob/faedc8c1bf1dbd856a5146637247fe650eb3c4e3/README.md) references an absent requirements file. Its batch setting differs from [DeepSpeed configuration](https://github.com/liushiliushi/ConfTuner/blob/faedc8c1bf1dbd856a5146637247fe650eb3c4e3/src/llama_recipes/configs/ds_config.json); the GPT-answer recipe selects `sot`, not `brier`. | Build a locked project-local environment; set loss, microbatch, accumulation, world size, and effective batch explicitly. Do not infer the objective from a checkpoint name. |
| [Inference](https://github.com/liushiliushi/ConfTuner/blob/faedc8c1bf1dbd856a5146637247fe650eb3c4e3/src/llama_recipes/utils/train_utils_uncertainty.py#L596-L670) uses free-form generation and loads fine-tuned weights from `output_dir`. [Parsing](https://github.com/liushiliushi/ConfTuner/blob/faedc8c1bf1dbd856a5146637247fe650eb3c4e3/src/llama_recipes/utils/postprocess.py#L60-L118) can exclude missing confidence and replace malformed percentages with zero. | Verify the loaded revision. Preserve every requested row and explicit failure reasons. Compare free-form and constrained confidence decoding separately. Never silently turn parsing failure into confidence zero. |
| [Correctness processing](https://github.com/liushiliushi/ConfTuner/blob/faedc8c1bf1dbd856a5146637247fe650eb3c4e3/src/llama_recipes/utils/postprocess.py#L44-L118) can treat an unsuccessful judge result as an incorrect answer; the [GPT generation fallback](https://github.com/liushiliushi/ConfTuner/blob/faedc8c1bf1dbd856a5146637247fe650eb3c4e3/src/generate_response.py#L160-L177) points to `api.deepseek.com`. | Preserve unresolved judgments as missing, review them, and explicitly configure any judge endpoint before use. Prefer executable labels in the first pilot. |

The inspected repository and README do not provide the generated answer/correctness JSONL required by the loader; reconstructing and auditing that supervision is part of reproduction cost. The fine-grid code optionally adds response cross-entropy with coefficient 1. This term trains on stored answer text, including incorrect answers retained for confidence learning; it is an answer-retention control, not guaranteed answer-quality training. Pin the setting in every run.

Released checkpoint revisions inspected:

| Checkpoint | Revision |
| --- | --- |
| [ConfTuner-LLaMA](https://huggingface.co/liushiliushi/ConfTuner-LLaMA/tree/f4074f4ecfd7773e81ccd7e60b2a1d21d8ef367d) | `f4074f4ecfd7773e81ccd7e60b2a1d21d8ef367d` |
| [ConfTuner-Qwen](https://huggingface.co/liushiliushi/ConfTuner-Qwen/tree/dff6fa9a519470c040e3f1f11eda85193695afba) | `dff6fa9a519470c040e3f1f11eda85193695afba` |
| [ConfTuner-Ministral](https://huggingface.co/liushiliushi/ConfTuner-Ministral/tree/a2f5775b0d3a51b1c7bbbe4fd9b5cc2fea247be3) | `a2f5775b0d3a51b1c7bbbe4fd9b5cc2fea247be3` |

The artifacts contain both adapters and full model shards; adapter configs use author-local base paths. Resolve canonical base revisions and choose either base-plus-adapter or full weights, avoiding double application. The source snapshot has no root license; model cards differ in license detail. Record the relevant base and derivative terms before code or weight reuse. No source code or weights have been incorporated into this project.

## 5. Proposed experiment

**First gate:** one backbone, one frozen answer bank, 2,000 training contexts, one prespecified 120-context calibration subset, and seeds 78/79/80. Compare the three grid losses below with a shared mean readout, plus the untuned baseline and raw/post-hoc controls. Use development-only data for wiring and reproduction checks. Expand to retention, larger budgets, scalar heads, joint generation, and event transfer only after this gate; the full matrix is not the first run.

### 5.1 Questions and comparison groups

Primary question: **Does tokenized Brier improve held-out probability quality beyond ordinary Brier and post-hoc calibration when answers, data, backbone, and compute are matched?** Secondary questions concern event-probability transfer, changed answer accuracy, unseen task families, and cost.

Begin with Llama-3.1-8B-Instruct and a 101-level confidence grid to match the released fine-grid recipe. Pin the base revision and tokenizer before execution. Start LoRA at rank 8, alpha 32, dropout .05, targeting `q_proj` and `v_proj`, following the [released configuration](https://github.com/liushiliushi/ConfTuner/blob/faedc8c1bf1dbd856a5146637247fe650eb3c4e3/src/llama_recipes/configs/peft.py#L7-L15). Use the same trainable modules, examples, update budget, and development-search budget across loss comparisons. Qwen is a later backbone check; changing its published coarse recipe must be labeled an adaptation.

Generate and label one answer bank with the frozen base model before training any confidence method. At evaluation, every confidence method sees the same held-out question and stored answer. This isolates confidence quality from answer changes.

| Group | Training objective | Purpose |
| --- | --- | --- |
| Base | None; prompt for confidence in the fixed answer | Untuned confidence baseline |
| Response-only | Cross-entropy on the same stored responses | Isolate the optional answer-retention term |
| ConfTuner | Tokenized Brier | Published loss |
| Mean-Brier | Ordinary Brier on `mu = sum_j w_j c_j`, with the same confidence grid | Isolate the token-variance penalty |
| Mean-log-loss | Binary negative log likelihood on `mu` | Compare another proper objective with identical readout |
| Scalar scorer | One sigmoid correctness head, trained with binary log loss using the same backbone/LoRA budget | Test whether verbal confidence tokens add value over a direct probability head |

For the primary loss ablation, use `mu` for all three grid-loss groups and set response-loss weight to zero. A correct mean need not imply a correct argmax, so comparing only selected tokens would disadvantage objectives trained on the mean. Score a common constrained-argmax decoder separately to assess discrete confidence reporting; keep free-form answer-plus-confidence generation as a separately labeled paper-style evaluation. The primary mean-readout comparison is our controlled adaptation, not the paper's verbalized-output experiment.

Apply the response-retention ablation, weight 0 versus 1, equally across the three grid objectives. Keep the scalar scorer as a practical comparator with a different readout, not the isolation experiment for the token-variance penalty.

For every group, compare raw confidence with held-out intercept-plus-slope logistic calibration; include positive temperature scaling as a simpler control. Select calibrator type and regularization using source-grouped folds within development data, then fit on the separate calibration data. The primary comparator is the best simpler method selected on development data, including its calibrated version; do not choose it using final-test scores. Isotonic calibration is a later, data-supported sensitivity rather than a required small-budget fit.

Only after this comparison, let each model generate new answers. Relabel those answers and report accuracy, probability quality, and selective error together. Assessing frozen base answers does not establish that a model's new answers are well calibrated. A Jev-answer assessor is a separate extension with its own answer bank and deployment contract.

### 5.2 Data and split strategy

Use the [training-data plan](training-data.md), with an initial planning allocation of 10,000 independent source contexts: 5,000 train, 1,000 development, 2,000 calibration, and 2,000 final test. These are targets, not guaranteed available data or sufficient subgroup sample sizes. Audit 200–500 examples before expansion. Reserve whole task families for transfer testing; allocate familiar-family and held-out-family test counts before training. Families used to claim transfer without target-family labels must be absent from training, development selection, and calibration. A separate target-family recalibration arm may use new labeled records and must count their cost. Keep all descendants of each source in one split.

First verify a small paper-style QA run using HotpotQA training and designated development-only subsets of the paper's four transfer datasets, with source-separated partitions and documented answer judging. Exclude all inspected examples from later confirmation; domains used for development cannot be claimed as wholly unseen families. This checks that the mechanism behaves plausibly; it is not a claim to reproduce every published number. Then use the domain tasks for the matched study. Keep QA-correctness and event-probability results in separate tables.

For the event study, preserve our full experiment coverage: stated-probability coins; threshold events with either their probability supplied or only distribution parameters supplied; two dice; South German Credit; Bank Marketing; and Online Shoppers. Coin and threshold tasks share a binary-event target but retain their three prompt-condition rows. The existing dice pilot predicts binary sum events and tests coherence using shared multinomial outcomes. A proposed full dice-distribution arm requires a normalized multiclass head with ordinary multiclass Brier/log loss. Independent confidence-token outputs for dice events require separate sum/complement checks; do not silently renormalize them into a distribution.

Notebook 04's evaluated records and scenarios are development evidence for this new study. A different random seed does not make an inspected record an untouched test. Reserve new source records, parameter ranges, and templates; if a dataset has no adequate uninspected remainder, label its follow-up exploratory or add another confirmatory dataset. The 10,000-context allocation is across the study, not a requirement that each small UCI dataset supply 10,000 records. For the existing public datasets, document contamination risk and preserve their stated sampling populations rather than claiming deployment prevalence.

Fit training-budget curves at 500 and 2,000 contexts first, extending to 5,000 only if development results justify it. Reuse nested subsets and seeds 78, 79, and 80 across methods. Use 120 contexts as the primary post-hoc budget. For the later budget study, draw prespecified nested subsets of 60, 120, 250, and 500 from the reserved 2,000-context calibration pool; the remaining records support repeated draws, not extra model training. Record draw IDs and do not select a budget or subset using test performance. Training labels and calibration labels are distinct costs; “2,000 training examples” is not a substitute for the 120-record calibration comparison. Retain incorrect answers and natural correctness prevalence in evaluation. Missing judge outcomes remain missing, never negative labels.

### 5.3 Monte Carlo extension

This is **our adaptation**, because we replace answer correctness with an observed event outcome. Use the generators, probability populations, and independent random streams in the [Monte Carlo plan](monte-carlo-calibration.md). Start with Bernoulli outcomes whose `q` values follow uniform, central, extreme, rare-event, mixture, and logit-normal distributions. Add held-out distribution families and wording after the first controlled comparison.

Compare direct scalar Brier, scalar log loss, tokenized Brier on a confidence-value grid, and Brier on the grid mean. Include the two-outcome-token misuse from Section 2 as an analytic negative control, not a proposed production objective. Keep distortion-only calibrator simulations separate from actual trained-model results.

Train the main event arm using sampled `Y ~ Bernoulli(q)`. A separate oracle arm can use exact expected token loss `q(1-q) + sum_j w_j(c_j-q)^2` to remove label-sampling noise; it receives stronger supervision and must be labeled accordingly. Keep `q` out of parameter-only prompts. Explicit-probability prompts deliberately include it to test probability preservation.

Compare generator probabilities `q`, returned probabilities `p`, and sampled event frequencies on common bins. Show both their marginal distributions and a paired `p`-versus-`q` plot: matching histograms alone can hide wrong assignments to individual events. For a returned scalar probability,

\[
\mathbb E[(p-Y)^2]=(p-q)^2+q(1-q).
\]

Report oracle Brier `q(1-q)`, model expected Brier, and excess Brier `(p-q)^2`; then check sampled Brier against the analytic result. Do not compare the training tokenized loss directly with a competitor's ordinary evaluation Brier. For fixed predictions, begin with 100 independent outcome simulations and increase to 1,000 for prespecified cells if Monte Carlo error warrants it. Report simulation error separately from variation across independent prompts and training seeds.

### 5.4 Measures and decision rules

Primary outcome: paired change in ordinary held-out Brier score for the declared probability target. Lower is better. Brier measures overall probability quality, not calibration alone. Report per-family results and a prespecified equal-family mean; keep sample-weighted summaries as a sensitivity. Do not average QA correctness, binary event, and differently scaled multiclass scores into one leaderboard.

Also report:

- Negative log likelihood, with a declared numerical clipping rule and saturated-output counts.
- Reliability plots with bin counts and intervals; ECE at 5, 10, and 20 bins; signed bias and calibration intercept/slope.
- Accuracy and AUROC; risk–coverage curves, where risk is error among retained answers and coverage is the fraction retained. Fix any operational threshold on development data.
- Probability recovery against known `q`, coherence checks, and Brier skill against a training-estimated constant forecast.
- Invalid-output, abstention, unresolved-label, and fit-failure rates over all requested examples. Report valid-only probability metrics with their denominator; do not hide failures by dropping rows. Any deployment fallback is fixed on development data and scored separately over all requests.
- End-to-end latency, peak memory, training time, and label/judge cost on stated hardware. Separate answer generation, confidence assessment, and post-hoc correction; include the extra model call for a Jev assessor.

Use paired 95% bootstrap intervals over original source/question groups, retaining descendants together. For the primary training comparison, average paired losses across the three seeds within each source before bootstrapping sources; do not average predictions into an unplanned ensemble. Report each training seed and seed-to-seed variation separately; three seeds are a pilot, not strong evidence of stable training variance. Do not treat seed-by-example rows or repeated outcomes for one prompt as independent sources. Where a comparison has only one class, report AUROC as undefined.

Proposed advance rule: the Brier difference versus the development-selected simpler comparator has a 95% interval below zero on the confirmatory target. Also require the prespecified error/coverage and subgroup checks to pass. For joint generation, use a proposed accuracy noninferiority margin of one percentage point and report its interval; if the test cannot resolve that margin, the result is inconclusive. Set application-specific error and latency limits before final evaluation. A lower ECE alone does not pass the gate.

### 5.5 Execution and reporting

Before model training, verify loss identities and gradients, token/value alignment, split disjointness, parser failures, and checkpoint loading. Overfit 16 reviewed examples only as a wiring check, then run a 100-step resource pilot. A small overfit test says nothing about calibration. The released scripts request multiple GPUs; that is not a verified minimum hardware requirement. Measure memory before selecting bf16 or quantized LoRA, and label deviations from the paper recipe.

Keep dependencies, caches, data, checkpoints, and outputs under `research/jev`, using the existing uv wrapper. Validate CUDA dependencies on the target NVIDIA host in a separate project-local environment if required. The current Apple Silicon environment is not evidence that the upstream DeepSpeed/vLLM recipe will run unchanged. Keep credentials in ignored local `.env` files and exclude them from manifests and outputs.

Store split/source hashes, prompt and answer-policy versions, model/tokenizer revisions, loss/grid/decoder settings, train and calibration budgets, seeds, correctness evidence, predictions, failures, and metrics for every run. Pin any changes made to the audited upstream code. No new notebook is created during this literature update. An eventual experiment notebook must contain its own setup, EDA, execution code, abstract with numerical findings, unified summary comparisons, calibration figures, analysis, and per-experiment appendix, following the existing numbered-notebook convention.

## 6. How this changes the research plan

1. Add ConfTuner as a confidence-training baseline before custom architecture work; retain Nimble and GLiNER2 for their supported typed tasks.
2. Compare training objectives and held-out post-hoc corrections jointly. Training with a proper objective does not remove the need to measure calibration after fitting.
3. Add a fixed-answer correctness study, and mark event-probability use as an adaptation with its own labels and tests.
4. Add the confidence-grid, decoding, split, and parser checks above before attempting reproduction.
5. Require new confirmatory data for choices informed by notebook 04, preserving its completed results as pilot evidence.

The decision remains empirical: retain ConfTuner only if its held-out benefit survives simpler calibrated baselines, transfer checks, and the added compute cost.
