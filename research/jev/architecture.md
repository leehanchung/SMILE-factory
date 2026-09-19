# Schema-conditioned prediction architectures

Research follow-up to [Calibrated structured predictions](calibration.md). These are published precedents for an independent implementation, not verified Jev internals. Papers and source code were inspected; models were not executed.

## Published precedents

- 2026-09-18 update: [RE Jev working brief](README.md) adds Bespoke Nimble as a trained candidate-token scoring baseline and revises the experimental priority. Custom question readouts remain a proposal, not a prerequisite.

- [GLiClass](https://arxiv.org/abs/2508.07662): dynamic label classification. Its main design jointly encodes labels and input; the paper also describes separate-encoder and encoder–decoder variants.
- [GLiNER2 (EMNLP 2025 System Demonstrations)](https://aclanthology.org/2025.emnlp-demos.10/): schema-driven classification and extraction. Schema markers identify task, label, and field representations for shared prediction modules. See the literature note below and R13 in [references](references.md).
- [Perceiver IO](https://arxiv.org/abs/2107.14795): output queries reading shared latent memory provide a general architectural precedent for variable output layouts.

## Literature survey: GLiNER2

[Zaratiana et al. (2025)](https://aclanthology.org/2025.emnlp-demos.10/) provides the published baseline for our study. The [paper](https://aclanthology.org/2025.emnlp-demos.10.pdf) combines schema and text in an encoder, supporting classification, NER, and hierarchical extraction. It reports a 205M-parameter model trained on 254,334 examples.

Reported evidence: seven classification benchmarks average 0.72 accuracy; CrossNER averages 0.590 F1. Hierarchical extraction was not benchmarked. The evaluation reports accuracy, F1, and latency, without a probability-calibration study. These results are author-reported, not reproduced here.

Research implication: use this as an architecture and predictive-performance precedent; our [calibration benchmark](gliner2-benchmark.md) and [Monte Carlo study](monte-carlo-calibration.md) address separate probability-quality questions. Keep the published system distinct from subsequent repository changes, including GLiNER2.5.

## Literature survey: Laya

[Laya](https://laya.convaiinnovations.com/), by Nandakishor Mukkunnoth / ConvAI Innovations, is a related open implementation of typed decisions. Its [repository](https://github.com/NandhaKishorM/laya) describes bidirectional encoder models with `choice`, ordinal `score`, and boolean `noul` outputs, RLCD training, and routing between English, multilingual, and task-specialized checkpoints.

The author's research article reports domain-specific temperature calibration reducing ECE from 0.466 to 0.081. It also documents overconfidence under language/script shift and degraded performance with large candidate sets. The reported 0.766 typed-decisions accuracy uses a fine-tuned checkpoint; it is not the base model's zero-shot result. These are source-reported findings, not reproduced here. Comparisons assembled from separately published Jev results do not establish a controlled head-to-head benchmark.

Research implication: Laya motivates comparisons of raw versus calibrated probabilities, language-conditioned reliability, and routing decisions under shift. Before evaluating it, inspect score semantics, calibration splits, checkpoint revisions, and candidate truncation. Include routing and model loading in latency accounting. Our [benchmark](gliner2-benchmark.md) and [Monte Carlo study](monte-carlo-calibration.md) provide the evaluation protocol. Credit and provenance are recorded in [R54 and attributions](references.md#attributions); no Laya code or weights have been incorporated.

## Code entry points

- GLiNER2 schema packing: [`SchemaTransformer`](https://github.com/fastino-ai/GLiNER2/blob/main/gliner2/processor.py).
- GLiNER2 encoder and shared classifier: [span model](https://github.com/fastino-ai/GLiNER2/blob/main/gliner2/models/span/model.py), including `_encode_batch` and `_compute_sample_loss`.
- GLiClass cross-attention implementation: [`GLiClassEncoderDecoder`](https://github.com/Knowledgator/GLiClass/blob/main/gliclass/model.py). Its decoder uses bidirectional attention over supplied label tokens; it is not an autoregressive label-generation loop.

## Value-function extension

Proposed RE Jev extension, 2026-09-18: use state/history as shared input and action, goal, remaining budget, and return definition as query conditioning. Train on trajectory returns under an identified continuation policy. A state critic estimates expected return under that policy; an action critic conditions additionally on the first action. See [Clippings/On Optimal Value Functions](https://amreis.github.io/ml/reinf-learn/2017/12/21/optimal-value-functions.html). Architecture suitability is a hypothesis, not measured value-estimation performance.

Use independent return estimates per candidate action, not a softmax across actions. A binary head represents value only for an appropriate binary terminal-reward objective without additional costs or discounting. For richer objectives, numerical/distributional heads can predict return distributions; [distributional RL](https://arxiv.org/abs/1707.06887) supplies a precedent.

Start with completed rollouts and Monte Carlo returns; hold out complete episodes/tasks. Obtain alternative-action continuations from resettable environments where possible rather than labeling unexecuted actions with imagined outcomes. Evaluate value error, action ranking, actual achieved return, and policy-specific calibration. Policy improvement changes the data distribution and can exploit optimistic errors; [CQL](https://arxiv.org/abs/2006.04779) studies this offline-RL problem. Action coverage, policy identity, and observable state/history matter more than JSON flexibility. Calibration of logged predictions alone does not establish a reliable critic for a new policy.

## Implementation implications

Engineering inference: jointly encoding schema and text makes cached input representations schema-dependent. Arbitrary question chunking can therefore change predictions. For an implementation requiring question isolation, evaluate a separate input encoder and question readouts with block-isolated attention, trained with the same masking and position conventions used at inference. Allow candidate interaction within each question while isolating unrelated questions.

The reviewed sources do not establish calibrated mixed numerical forecasting. Treat numerical distribution heads, suitable supervised losses, deployment-specific calibration, and held-out schema evaluation as additional work. Extracting a number appearing in text is a different target from predicting a future numerical outcome.

Exclude [Qwen-2.5-1B-RLCD](https://huggingface.co/harshatheg/Qwen-2.5-1B-RLCD) from architectural candidates, as requested. Its model card describes shared-prefix constrained decoding around Qwen; it does not establish the proposed schema-conditioned discriminative architecture.
