# Calibrated structured predictions

For a concrete experiment, see the [GLiNER2 benchmark and calibration protocol](gliner2-benchmark.md): score semantics, held-out fitting, sample-size curves, distribution shift, and risk–coverage evaluation.

Schema-valid JSON and calibrated probabilities are separate requirements. [Generation architecture](model-families.md) alone does not establish calibration on a particular task. Calibration must be measured against observed outcomes: predictions assigned probability 0.8 should be correct approximately 80% of the time in the relevant population. The historical [Clippings/Introducing SimpleQA](https://openai.com/index/introducing-simpleqa/) evaluation found overconfidence in the models it tested; it does not rank current models.

## Candidate designs

These are engineering starting points, not a ranking of demonstrated calibration on an unspecified dataset:

- For fixed labels from text, fine-tune a text model with classification heads, calibrate the scores, and serialize results with code. [Qwen3 supports sequence classification](https://huggingface.co/docs/transformers/model_doc/qwen3); multiple heterogeneous fields require appropriate custom heads or separate classifiers.
- For tabular inputs, compare [CatBoost](https://catboost.ai/docs/en/concepts/python-reference_catboostclassifier_predict_proba) and [TabPFN](https://docs.priorlabs.ai/capabilities/interpretability), then calibrate and evaluate per target. Their probability outputs are not a task-specific calibration guarantee.
- For open-ended extraction, a structured-output LLM can generate candidates, with a separately validated correctness scorer. [Claude structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) supports schema-constrained generation; schema compliance does not establish semantic accuracy or probability calibration.

## Jev by TypeSafe AI

Checked 2026-09-15 after Han identified this model. Jev is a more directly relevant candidate for mixed structured predictions than a generic chat model. Its [documentation](https://docs.typesafe.ai/introduction) describes parallel, isolated evaluation of multiple typed questions against the same input state. This is an interface-level description, not enough evidence to infer a specific internal transformer or diffusion architecture.

The [AI primer](https://docs.typesafe.ai/introduction/machine-learning-primer) presents RLCD as a post-training path from pretrained language models. This supports interpreting Jev as language-model-derived, but the reviewed public materials do not identify the base checkpoint, parameter count, detailed network architecture, or whether its starting weights were trained internally. Parallel output alone does not establish diffusion or depth recurrence. TypeSafe's claim of a new architecture is not a published architectural specification.

- [Choice](https://docs.typesafe.ai/primitives/choice): categorical selection and a distribution across the supplied options.
- [Noul](https://docs.typesafe.ai/primitives/noul): a probability for a boolean proposition.
- [Score](https://docs.typesafe.ai/primitives/score): a distribution over 2–10 descriptive rubric levels and its expected level index. This is not an unrestricted continuous regression output or a predictive interval.

The [confidence documentation](https://docs.typesafe.ai/confidence) defines `confidence` as a statistic derived from the probability distribution's concentration. Do not interpret this field directly as probability of correctness. Evaluate the underlying probabilities against outcomes.

TypeSafe's [launch post](https://typesafe.ai/blog/introducing-system-one-models-and-jev) describes Reinforcement Learning for Calibrated Decisions (RLCD). Its [workflow evaluation](https://evals.typesafe.ai/) compares against consensus answers from other models. This does not by itself establish calibration against observed outcomes in Han's domain. Treat calibration as a vendor claim pending task-specific validation. Independent question evaluation also does not establish a coherent joint distribution across fields.

Recommendation: benchmark Jev for categorical labels, boolean events, and ordinal judgments; retain a dedicated probabilistic forecasting model for unrestricted numeric targets. Forecast bins could be posed as Choice questions, but that is an adaptation requiring validation rather than documented continuous forecasting functionality.

## Proposed model implementation

This is an independent engineering proposal, not a claim about Jev's internals.

Research follow-up: [Schema-conditioned prediction architectures](architecture.md) compares GLiClass and GLiNER2 with this proposal and identifies concrete source-code entry points. Their joint-encoder designs do not provide the schema-independent input cache assumed below.

Encode the input once with a pretrained text backbone. Add question-conditioned readout blocks that cross-attend to the shared input representations. Each field receives its description, type, and candidate labels or numeric support. Batch these readouts without attention between unrelated questions. For a stable schema, simpler fixed output heads are a useful baseline; arbitrary runtime schemas require a shared scorer conditioned on label descriptions.

Use softmax over candidate scores for exclusive classes, sigmoid for binary or multilabel outputs, and distribution-parameter or quantile heads for numerical forecasts. Enforce numerical support in the parameterization, such as positive scales via softplus. Serialize tensors to JSON in ordinary code. Parallel predictions remove sequential output-token decoding, but work still grows with the number of questions, options, and input length.

Train with observed labels and proper scoring objectives: categorical or binary negative log likelihood, and numerical negative log likelihood or CRPS as appropriate. Normalize and balance losses across fields and mask missing labels. Ground-truth outcomes must anchor calibration; teacher outputs can supply useful initialization or distillation without establishing real-world calibration. A differentiable prediction task does not require reinforcement learning. Rewarding only sampled-label correctness instead encourages concentration on the most likely class; that reward alone does not elicit the full conditional distribution.

Split training, calibration, and final testing by time or entity where needed. Assess held-out schemas as well as familiar fields. Independently calibrated marginals do not specify a joint distribution. If dependencies matter, add an explicit joint model or predict consistent primitive outcomes and derive other fields in code; any inference-time constraint adjustment should be included when validating calibration.

Supporting references: [temperature scaling](https://proceedings.mlr.press/v70/guo17a.html), [probabilistic regression](https://arxiv.org/abs/1910.03225), and [deep ensembles](https://papers.neurips.cc/paper_files/paper/2017/hash/9ef2ed4b7fd2c810847ffa5fa85bce38-Abstract.html).

## Dynamic schemas and question chunking

Independent design proposal, added 2026-09-16. A learned scoring head is a shared parameterized function, not a fixed output slot. One scalar candidate scorer can process arbitrarily many question–candidate pairs in batches. Keep parameter count, runtime query count, transformer attention-head count, and question microbatch size separate. Use a small family of output modules determined by probability semantics (categorical candidate scores, binary probabilities, numerical distribution parameters), adding specialization only when held-out losses justify it.

For shared input memory H with shape [L,d], construct candidate queries U with shape [R,d], where R is the sum of candidate counts. Shared cross-attention followed by an MLP maps each query to a scalar logit. Group logits by question and normalize within each exclusive choice set. This compact query representation is a baseline; richer question token sequences or multiple readout tokens may be required. [Perceiver IO](https://arxiv.org/abs/2107.14795) is a relevant precedent for variable output queries, not evidence for this proposed system's calibration.

Chunk by estimated candidate/query token work and memory, rather than a fixed number of JSON fields. Encode the input once and reuse its projected keys and values. With question-isolated attention, unchanged per-question positions, tokenwise normalization, and evaluation-mode stochastic layers disabled, chunking should preserve predictions up to floating-point differences. Full-schema self-attention, chunk-dependent positions, truncation, or batch-dependent operations can break that property.

Keep a question's candidate set together initially. If candidate scores are independent of the other candidates, candidates may also be chunked, but collect all raw logits and apply one softmax across the complete option set. Separate chunk softmaxes are not a distribution over the original choices. A set-aware scorer can compare overlapping alternatives more effectively, but changing the candidate set it sees changes the model input; keep that set fixed when chunking. Question independence is computational isolation, not a claim that target outcomes are statistically independent.

During training, randomize question counts, question order, candidate order, and microbatch boundaries. Use valid-option masks and per-question losses with deliberate task weighting. Accumulate the sum of losses across question chunks and divide by the intended total count or weight, rather than giving a small final chunk equal weight to a large one. Sharing an encoder graph means decoder chunking alone may not reduce encoder training memory; use appropriate recomputation or checkpointing if needed.

Fit and evaluate calibration on held-out tasks and schemas, including different option counts, near-duplicate labels, and absent-answer cases. Verify that changing chunk boundaries or adding unrelated questions leaves a fixed question's probabilities unchanged. Shared head weights allow new schemas; they do not guarantee transfer of calibration.

## Conformal prediction

Conformal calibration fits a threshold on held-out nonconformity scores to construct prediction sets or intervals. It does not generally recalibrate individual class probabilities. Standard split conformal gives marginal coverage under exchangeability of calibration and test examples, with the predictor fixed independently of conformal calibration data. See [conformal tutorial](https://arxiv.org/abs/2107.07511), [classification sets](https://arxiv.org/abs/2006.02544), and [conformalized quantile regression](https://arxiv.org/abs/1905.03222).

For this proposed system, add conformal thresholds after the shared scorers. Chunking remains a computational choice if it leaves scores unchanged. Pooled calibration over changing questions does not establish coverage for each new schema. Likewise, per-field coverage does not imply simultaneous coverage of an entire JSON object. A proposed object-level design calibrates the maximum of suitably scaled field errors on complete labeled objects, then applies that threshold to all fields. This requires comparable calibration and deployment objects and a fixed scoring procedure.

## Transfer across populations and use cases

Calibration is relative to an outcome definition and deployment distribution. Overall calibration can hide subgroup errors; [multicalibration](https://proceedings.mlr.press/v80/hebert-johnson18a.html) addresses calibration across specified families of subpopulations. A hypothetical equal-sized pair of groups with realized rates 0.9 and 0.5 among predictions scored 0.7 averages to 0.7 overall while failing within both groups. [Dataset-shift research](https://arxiv.org/abs/1906.02530) shows that uncertainty quality can degrade away from the evaluated distribution.

For the proposed dynamic-schema system, validate calibration by task, outcome horizon, customer population, and time. Transfer is possible, not automatic. Changing a user's error costs changes the appropriate action threshold, not necessarily the outcome probability. Changing whose preferences define the label can change the target itself. Recalibration may suffice for a systematic probability distortion; weak predictive discrimination or changed feature–outcome relationships may require additional features or retraining. Standard conformal coverage also requires the relevant exchangeability assumptions after transfer.

## RE Jev calibration implementation

Implementation proposal, 2026-09-17: freeze the trained predictor and fit a small post-hoc transformation on held-out labeled requests. Preserve input/entity grouping across splits rather than randomly splitting correlated fields from the same JSON object. Keep an untouched final test set, and use separate validation or cross-validation within development data to choose calibrator complexity.

Start exclusive-choice tasks with positive scalar temperature scaling, minimizing held-out negative log likelihood after masking padding options. A shared temperature accommodates variable option counts but does not guarantee calibration for new schemas. Compare pooled calibration with task-family temperatures and, when enough labels exist, schema-specific calibration. For a proposed hierarchical version, regularize schema-specific log-temperatures toward their family value; choose regularization without using the final test set. For unseen schemas, a family fallback is an estimate whose transfer must be evaluated, not a calibration guarantee. See [Guo et al.](https://proceedings.mlr.press/v70/guo17a.html).

For numerical forecasts, choose between a constrained parametric correction of location/scale and monotone predictive-CDF recalibration, depending on the base predictive distribution and labeled data. Assess quantile coverage and forecast sharpness on untouched outcomes. [Kuleshov et al.](https://arxiv.org/abs/1807.00263) provide a regression recalibration precedent. If the product instead requires coverage-controlled intervals, consider [conformalized quantile regression](https://arxiv.org/abs/1905.03222) with an appropriate independent conformal calibration split and exchangeability assumptions.

Version the calibrator together with the predictor, schema semantics, and preprocessing. Reassess after model changes or deployment shift. Evaluate probability quality and reliability by task family, population, candidate count, and unseen schema; pooled performance alone is insufficient for a per-field claim.

## Evaluation measures

Use separate training, calibration, and final test data, with temporal or group splits where appropriate. Fit temperature scaling, sigmoid calibration, or isotonic regression as appropriate to the score type and data volume. Report reliability diagrams per field or defensibly pooled field family, alongside Brier score and log loss. The latter two measure overall probabilistic prediction quality, not calibration alone. See [scikit-learn calibration documentation](https://scikit-learn.org/1.8/modules/calibration.html) and [Guo et al.](https://proceedings.mlr.press/v70/guo17a.html).

Distinguish class probabilities, probability that an extracted value is correct, and probability that the entire object is correct. Even if 100 field errors were independent and each field had a true correctness probability of 0.99, the probability that all fields were correct would be only 0.99^100, approximately 0.366. Real fields can be dependent, so multiplying field probabilities is generally unjustified without an appropriate joint model.

Token likelihood measures a token given its prefix; it is not automatically a calibrated probability that the field is true. In a long autoregressive JSON object, later values also condition on earlier generated values. For marginal field predictions, a proposed design is shared input encoding with separate output heads; for joint predictions, explicitly model dependencies and validate joint outcomes.
