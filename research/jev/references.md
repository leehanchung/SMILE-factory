# References and attributions

Consolidated 2026-09-18 from the RE Jev research conversation and five source notes. Links on repository main branches are mutable. No commits or checkpoint artifacts were downloaded/pinned; pin them before experiments. This is a record of sources considered, not a claim that every endpoint was successfully fetched today.

Evidence classes: papers and inspected code support specific mechanisms; vendor documentation supports interface claims; experiment proposals are ours. Source-reported results have not been reproduced.

## Attributions

Credit Nandakishor Mukkunnoth and ConvAI Innovations for [Laya](https://laya.convaiinnovations.com/) and its accompanying [open implementation](https://github.com/NandhaKishorM/laya). Its discussion informs our review of typed decisions, calibration under language shift, and model routing. This acknowledges related work; it does not establish historical priority over other systems or imply collaboration. No Laya source code, weights, figures, or datasets have been copied into this project. See R54 for source details.

2026-09-19 addition: the [GLiNER2 benchmark protocol](gliner2-benchmark.md) uses R34, R45, R47, and the runtime source R50 below. Pilot allocations and acceptance gates are proposed experiment choices.

## R01 — Clippings/On Optimal Value Functions

[Clippings/On Optimal Value Functions](https://amreis.github.io/ml/reinf-learn/2017/12/21/optimal-value-functions.html)


Used in: [architecture.md](architecture.md)

## R02 — distributional RL

[distributional RL](https://arxiv.org/abs/1707.06887)


Used in: [architecture.md](architecture.md)

## R03 — Kuleshov et al.

[Kuleshov et al.](https://arxiv.org/abs/1807.00263)

Regression calibration primary paper.

Used in: [calibration.md](calibration.md)

## R04 — conformalized quantile regression

[conformalized quantile regression](https://arxiv.org/abs/1905.03222)


Used in: [calibration.md](calibration.md)

## R05 — Dataset-shift research

[Dataset-shift research](https://arxiv.org/abs/1906.02530)


Used in: [calibration.md](calibration.md)

## R06 — probabilistic regression

[probabilistic regression](https://arxiv.org/abs/1910.03225)


Used in: [calibration.md](calibration.md)

## R07 — classification sets

[classification sets](https://arxiv.org/abs/2006.02544)


Used in: [calibration.md](calibration.md)

## R08 — CQL

[CQL](https://arxiv.org/abs/2006.04779)


Used in: [architecture.md](architecture.md)

## R09 — conformal tutorial

[conformal tutorial](https://arxiv.org/abs/2107.07511)


Used in: [calibration.md](calibration.md)

## R10 — Perceiver IO

[Perceiver IO](https://arxiv.org/abs/2107.14795)


Used in: [architecture.md](architecture.md), [calibration.md](calibration.md)

## R11 — Geiping et al.

[Geiping et al.](https://arxiv.org/abs/2502.05171)


Used in: [model-families.md](model-families.md)

## R12 — Nie et al.

[Nie et al.](https://arxiv.org/abs/2502.09992)


Used in: [model-families.md](model-families.md)

## R13 — GLiNER2 (EMNLP 2025 System Demonstrations)

Urchade Zaratiana, Gil Pasternak, Oliver Boyd, George Hurn-Maloney, and Ash Lewis. 2025. [GLiNER2: Schema-Driven Multi-Task Learning for Structured Information Extraction](https://aclanthology.org/2025.emnlp-demos.10/). *Proceedings of EMNLP 2025: System Demonstrations*, pp. 130–140. Association for Computational Linguistics. DOI: [10.18653/v1/2025.emnlp-demos.10](https://doi.org/10.18653/v1/2025.emnlp-demos.10).

[Published PDF](https://aclanthology.org/2025.emnlp-demos.10.pdf); [arXiv version](https://arxiv.org/abs/2507.18546). Metadata and PDF reviewed 2026-09-19. Citation title follows the Anthology record; the PDF uses a different title. R16 retains the earlier HTML source for provenance, not a separate study.

Used in: [literature survey](architecture.md#literature-survey-gliner2), [gliner2-benchmark.md](gliner2-benchmark.md)

## R14 — GLiClass

[GLiClass](https://arxiv.org/abs/2508.07662)


Used in: [architecture.md](architecture.md)

## R15 — The Million-Label NER: Breaking Scale Barriers with GLiNER bi-encoder

[The Million-Label NER: Breaking Scale Barriers with GLiNER bi-encoder](https://arxiv.org/abs/2602.18487)

Secondary architectural lead explored during research; not evaluated.


## R16 — GLiNER2 paper

[GLiNER2 paper](https://arxiv.org/html/2507.18546v1)

Earlier HTML version; use R13 for the published conference citation.

Used in: [training-data.md](training-data.md)

## R17 — CatBoost

[CatBoost](https://catboost.ai/docs/en/concepts/python-reference_catboostclassifier_predict_proba)


Used in: [calibration.md](calibration.md)

## R18 — TabPFN

[TabPFN](https://docs.priorlabs.ai/capabilities/interpretability)


Used in: [calibration.md](calibration.md)

## R19 — confidence documentation

[confidence documentation](https://docs.typesafe.ai/confidence)

Vendor/interface material; does not establish undisclosed internals or deployment calibration.

Used in: [calibration.md](calibration.md)

## R20 — documentation

[documentation](https://docs.typesafe.ai/introduction)

Vendor/interface material; does not establish undisclosed internals or deployment calibration.

Used in: [calibration.md](calibration.md)

## R21 — AI primer

[AI primer](https://docs.typesafe.ai/introduction/machine-learning-primer)

Vendor/interface material; does not establish undisclosed internals or deployment calibration.

Used in: [calibration.md](calibration.md)

## R22 — Choice

[Choice](https://docs.typesafe.ai/primitives/choice)

Vendor/interface material; does not establish undisclosed internals or deployment calibration.

Used in: [calibration.md](calibration.md)

## R23 — Noul

[Noul](https://docs.typesafe.ai/primitives/noul)

Vendor/interface material; does not establish undisclosed internals or deployment calibration.

Used in: [calibration.md](calibration.md)

## R24 — Score

[Score](https://docs.typesafe.ai/primitives/score)

Vendor/interface material; does not establish undisclosed internals or deployment calibration.

Used in: [calibration.md](calibration.md)

## R25 — workflow evaluation

[workflow evaluation](https://evals.typesafe.ai/)

Vendor/interface material; does not establish undisclosed internals or deployment calibration.

Used in: [calibration.md](calibration.md)

## R26 — GLiClass repository

[GLiClass repository](https://github.com/Knowledgator/GLiClass)

Published implementation baseline.


## R27 — `GLiClassEncoderDecoder`

[`GLiClassEncoderDecoder`](https://github.com/Knowledgator/GLiClass/blob/main/gliclass/model.py)


Used in: [architecture.md](architecture.md)

## R28 — Bespoke Nimble

[Bespoke Nimble](https://github.com/bespokelabsai/nimble)


Used in: [README.md](README.md)

## R29 — Training guide

[Training guide](https://github.com/bespokelabsai/nimble/blob/main/docs/NIMBLE_TRAINING.md)


Used in: [README.md](README.md)

## R30 — scoring guide

[scoring guide](https://github.com/bespokelabsai/nimble/blob/main/docs/PARALLEL_SCORING.md)


Used in: [README.md](README.md)

## R31 — Curation guide

[Curation guide](https://github.com/bespokelabsai/nimble/blob/main/docs/TRAINING_EVAL_CURATION.md)


Used in: [README.md](README.md)

## R32 — CUDA scorer

[CUDA scorer](https://github.com/bespokelabsai/nimble/blob/main/nimble/scoring/cuda_scorer.py)


Used in: [README.md](README.md)

## R33 — Prompt compiler

[Prompt compiler](https://github.com/bespokelabsai/nimble/blob/main/nimble/scoring/parallel_schema.py)


Used in: [README.md](README.md)

## R34 — GLiNER2 repository

[GLiNER2 repository](https://github.com/fastino-ai/GLiNER2)

First-party README reviewed 2026-09-19 following Han's supplied link. Documents schema-conditioned classification and extraction, span and boundary model families, confidence outputs, and training support. Interface and model-size claims are source-reported; quality, calibration, and latency have not been reproduced here.

Used in: [README.md](README.md), [GLiNER2 experiment](experiments.md#gliner2-baseline)


## R35 — span model

[span model](https://github.com/fastino-ai/GLiNER2/blob/main/gliner2/models/span/model.py)


Used in: [architecture.md](architecture.md)

## R36 — `SchemaTransformer`

[`SchemaTransformer`](https://github.com/fastino-ai/GLiNER2/blob/main/gliner2/processor.py)


Used in: [architecture.md](architecture.md)

## R37 — Bespoke Nimble checkpoint

[Bespoke Nimble checkpoint](https://huggingface.co/bespokelabs/Bespoke-Nimble-9B)

Referenced; direct model-card retrieval failed in this investigation.


## R38 — Qwen3 supports sequence classification

[Qwen3 supports sequence classification](https://huggingface.co/docs/transformers/model_doc/qwen3)


Used in: [calibration.md](calibration.md)

## R39 — Qwen-2.5-1B-RLCD

[Qwen-2.5-1B-RLCD](https://huggingface.co/harshatheg/Qwen-2.5-1B-RLCD)

EXCLUDED by user; retained solely for provenance, not a candidate.

Used in: [architecture.md](architecture.md)

## R40 — Jev reproduction tracker

[Jev reproduction tracker](https://huggingface.co/spaces/multimodalart/jev-reproductions-tracker/discussions/1/files)

Discovery only: associates the exact madiator status with Nimble; do not use its summaries as technical evidence.


## R41 — Clippings/Transformer Inference Arithmetic

[Clippings/Transformer Inference Arithmetic](https://kipp.ly/transformer-inference-arithmetic/)


Used in: [model-families.md](model-families.md)

## R42 — Clippings/Introducing SimpleQA

[Clippings/Introducing SimpleQA](https://openai.com/index/introducing-simpleqa/)


Used in: [calibration.md](calibration.md)

## R43 — deep ensembles

[deep ensembles](https://papers.neurips.cc/paper_files/paper/2017/hash/9ef2ed4b7fd2c810847ffa5fa85bce38-Abstract.html)


Used in: [calibration.md](calibration.md)

## R44 — Claude structured outputs

[Claude structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)


Used in: [calibration.md](calibration.md)

## R45 — temperature scaling

[temperature scaling](https://proceedings.mlr.press/v70/guo17a.html)


Used in: [calibration.md](calibration.md)

## R46 — multicalibration

[multicalibration](https://proceedings.mlr.press/v80/hebert-johnson18a.html)


Used in: [calibration.md](calibration.md)

## R47 — scikit-learn calibration documentation

[scikit-learn calibration documentation](https://scikit-learn.org/1.8/modules/calibration.html)


Used in: [calibration.md](calibration.md)

## R48 — launch post

[launch post](https://typesafe.ai/blog/introducing-system-one-models-and-jev)

Vendor/interface material; does not establish undisclosed internals or deployment calibration.

Used in: [calibration.md](calibration.md)

## R49 — madiator post

[madiator post](https://x.com/madiator/status/2100990591215783946)

User-supplied lead; direct post retrieval failed. Technical findings verified against Nimble repository instead.

Used in: [README.md](README.md)

## R50 — GLiNER2 extraction runtime

[GLiNER2 runtime](https://github.com/fastino-ai/GLiNER2/blob/main/gliner2/inference/runtime.py)

Reviewed 2026-09-19: classification activation and output selection, multilabel fallback, and span-score decoding. Mutable source; pin and recheck before implementing the score adapter.

Used in: [gliner2-benchmark.md](gliner2-benchmark.md)

## R51 — John Berryman's Jev probability diagnostic

[User-supplied LinkedIn post](https://www.linkedin.com/feed/update/urn:li:activity:7506796921362030593/)

Read through the browser on 2026-09-19 after direct retrieval failed. Author reports winner-concentrated Choice probabilities for a stated biased coin and a closer but biased Noul response. Motivation, not independently reproduced results or evidence about GLiNER2.

Used in: [monte-carlo-calibration.md](monte-carlo-calibration.md)

## R52 — Jev 1.13 limitations

[TypeSafe model jaggedness documentation](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

Vendor source reviewed 2026-09-19; documents numerical limitations and differences between Choice and Noul. Version-specific interface context, not independent validation.

Used in: [monte-carlo-calibration.md](monte-carlo-calibration.md)

## R53 — Simulation-study methodology

[Morris, White, and Crowther: Using simulation studies to evaluate statistical methods](https://arxiv.org/abs/1712.03198)

Methodological basis for declaring data-generating mechanisms, estimands, comparisons, performance measures, and Monte Carlo uncertainty. Our distribution grids and budgets are proposed design choices.

Used in: [monte-carlo-calibration.md](monte-carlo-calibration.md)

## R54 — Laya research article and implementation

Nandakishor Mukkunnoth / ConvAI Innovations. 2026. [Laya research article](https://laya.convaiinnovations.com/). [Source repository](https://github.com/NandhaKishorM/laya); [model hub](https://huggingface.co/convaiinnovations/laya).

Article read in the browser and repository README reviewed 2026-09-19. First-party engineering article and implementation documentation, not a peer-reviewed evaluation. Calibration, speed, and comparative results remain author-reported. The website's historical-priority claims were not independently established. Recheck repository and artifact licenses before any future reuse; this entry records scholarly attribution only.

Used in: [Laya literature survey](architecture.md#literature-survey-laya), [attributions](#attributions)
