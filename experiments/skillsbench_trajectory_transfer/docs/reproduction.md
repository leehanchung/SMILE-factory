# Reproduction

## CPU analysis reproduction

A clean checkout needs Python 3.12 and uv, but no GPU, model, network credential, or private
package:

```bash
cd experiments/skillsbench_trajectory_transfer
make check
make reproduce-analysis RUN=exp_01ky0ztpc9eqn9g67e30pjt5k9
make report RUN=exp_01ky0ztpc9eqn9g67e30pjt5k9
make verify-artifacts RUN=exp_01ky0ztpc9eqn9g67e30pjt5k9
```

The analysis command reconstructs paired aggregates and confidence intervals from
`data/normalized_paired_rows.jsonl`. It compares BFCL arm accuracies, three paired effects,
six confidence-interval endpoints, and exact IFEval/MMLU/restraint counts to the immutable
record. Reproduced analysis and report files are written under ignored `build/<EID>/` paths;
`runs/<EID>/reproduction.json` and `report/index.html` preserve the completed verification
and reviewed report without allowing routine commands to overwrite them. `make verify-run`
checks the SHA-256 manifest covering every committed run file.

`make verify-artifacts` compares every external object in `artifacts/manifest.json` against
the provider metadata captured in `artifacts/verified_snapshot.json`. It checks existence,
byte size, etag, and provider version without object downloads. The snapshot was produced by
a live authorized metadata probe; a fresh live probe requires access to the source Silico
workspace because `artifact://` is not a public URL scheme.

## GPU retraining

The public training stack is optional:

```bash
uv sync --extra train
uv run skillsbench-train \
  --config configs/qwen3_8b_lora.yaml \
  --dataset-dir /path/to/extracted/corpus-v7 \
  --condition with_skill_success \
  --output-dir /path/to/new/run
```

Use `Qwen/Qwen3-8B` at revision
`b968826d9c46dd6066d109eabc6255188de91218`. The exact LoRA recipe is in
`configs/qwen3_8b_lora.yaml`: rank 16, alpha 32, dropout 0.05, bf16, microbatch 1,
gradient accumulation 8, cosine LR 1e-4, one epoch, seed 17, and all attention/MLP projection
targets. W&B is optional in reusable code and activates only when configured with credentials;
the completed run identities are preserved in `provenance.json`.

The corpus is `benchflow/skillsbench-leaderboard` revision
`f104580363a9642563593c475620196ecd36687d`, transformed into the externally stored v7
Parquet objects. Adapter loading uses PEFT 0.19.1 on the pinned base model. The manifest also
records an SGLang 0.5.8 serving recipe.

## GPU evaluation

Install `uv sync --extra eval`. Pinned public sources are:

- BFCL/Gorilla `6ea57973c7a6097fd7c5915698c54c17c5b1b6c8`;
- lm-evaluation-harness v0.4.9.2, source revision
  `ad3f4d0cad1cfcdb815f1e795f7947e49ed9f2e9`;
- IFEval `966cd89545d6b6acfd7638bc708b98261ca58e84`;
- MMLU `c30699e8356da336a370243923dbaf21066bb9fe`;
- Toolathlon `3b647e60713703d653584c23ff185e3b6cd67722`.

The evaluation CLI deliberately keeps BFCL, lm-eval, and Toolathlon behind shell-free
passthrough boundaries: after the subcommand, supply the complete command for the pinned
upstream checkout. It does not reinterpret upstream flags or bundle benchmark code; the
resolved benchmark YAML files document the recorded invocation. Endpoint smoke,
tool-restraint scoring, and artifact verification have typed first-party arguments. Toolathlon
must be reported only after official preprocessing, execution, and verification complete.
The recorded run has no Toolathlon score because admission never succeeded.
