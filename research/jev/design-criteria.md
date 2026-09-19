# Design criteria

Status: proposed specification consolidated 2026-09-18. Core capabilities originated in the user request; implementation choices remain hypotheses. See [architecture](architecture.md), [calibration](calibration.md), and [references](references.md).

## Core capabilities

- Shared context with many runtime-defined prediction fields.
- Categorical labels and numerical forecasts, returned as valid typed JSON.
- Variable field and candidate counts within explicit resource limits.
- Empirically assessed probabilities on relevant observed outcomes.

## Proposed interface

- Explicit field descriptions, candidate semantics, units, forecast horizons, and numerical support.
- Boolean, multilabel, and ordinal predictions in addition to exclusive classification.
- Distributions, quantiles, or intervals alongside numerical point predictions.
- Explicit handling of unsupported schemas, missing evidence, absent answers, and unresolved outcomes.
- Distinguish outcome probabilities, extraction correctness, and whole-object correctness.
- Decide whether cross-field consistency requires derived fields, constraints, or a joint model.

## Architecture and execution

- Parse field definitions and retain stable mappings to output JSON paths.
- Batch learned scoring operations; keep learned head count separate from runtime field count.
- Reuse context computation where possible, measuring the actual backend behavior.
- Compare Nimble-style existing LM-head candidate scoring with GLiClass/GLiNER2 and custom readouts.
- For the custom isolated-readout design, allow within-question candidate interactions while blocking unrelated-question interactions.
- For that design, preserve predictions across question chunking, adding unrelated questions, and field reordering, within numerical tolerance.
- Test candidate-order robustness after remapping candidate identities.
- Batch by token/candidate work and memory; preserve positions, context, masks, and normalization.
- Keep complete candidate sets together unless independent scoring allows splitting; apply one final softmax over each full exclusive set.
- Serialize outputs in code. Never confuse action values with a probability distribution over actions.

## Training and evaluation

- Train on outcome-grounded labels using appropriate distribution-sensitive losses.
- Vary schemas, question counts, candidate counts, order, and wording; verify semantics after augmentation.
- Mask absent supervision and balance task losses, including across microbatches.
- Split by source family/entity and time as appropriate, before augmentation.
- Keep training, development, calibration, and final test data distinct.
- Evaluate unfamiliar task families separately from paraphrases of known schemas.
- Validate calibration across tasks, populations, option counts, horizons, and time.
- Evaluate the final postprocessed probabilities, not only raw scorer outputs.
- Treat conformal sets/intervals as an optional coverage feature with explicit assumptions.
- Report prediction quality, reliability, schema validity, stability, latency, and memory separately.

## Open specifications

Target domain and label availability; model/backbone; hardware; latency and throughput budgets; maximum input/schema size; numerical distributions; calibration sample sizes; cross-field dependencies; quantitative acceptance thresholds. RL, diffusion, recurrent depth, and custom heads are not prerequisites. No universal zero-shot calibration guarantee is assumed.
