# SkillsBench trajectory-transfer study

This standalone project asks whether supervised fine-tuning (SFT) on successful agent
trajectories that used curated SkillsBench skills improves transfer to unfamiliar tool use.
It compares two task-, token-, and source-matched Qwen3-8B LoRA arms:

- **no-skill:** successful trajectories produced without the curated skill text;
- **with-skill:** successful trajectories produced with curated skills, after removing the
  skill documents themselves from the training record.

The unchanged Qwen3-8B checkpoint is the no-training baseline. The primary short-horizon
transfer measure is BFCL v4; IFEval, a fixed MMLU-500 sample, and paired tool-restraint
prompts check direct-response preservation. Toolathlon was predeclared for long-horizon
transfer but was unavailable before any task reached preprocessing.

## Result

The completed run is **inconclusive**, not evidence of a null effect. BFCL v4 accuracy was
63.2877% for base, 62.1005% for no-skill, and 61.2329% for with-skill over 2,190 paired
items. The primary with-skill minus no-skill effect was -0.8676 percentage points with a
paired 95% confidence interval of [-1.9178, +0.1826] points: no positive short-horizon
transfer was detected, while a small benefit is not excluded. Both LoRA arms were below the
base checkpoint in paired BFCL comparisons.

IFEval strict accuracy was 81.3309%, 80.9612%, and 80.9612%; MMLU-500 was 50.4%, 51.0%,
and 51.4%; unnecessary tool-call rate was 0% for all checkpoints over 120 paired prompts.
Each training arm contained 238 rows and 604,737 supervised tokens—12.0947% of the planned
cap—with one seed. Long-horizon Toolathlon transfer remains unmeasured after seven official
service-busy admissions.

The immutable record is under
[`runs/exp_01ky0ztpc9eqn9g67e30pjt5k9`](runs/exp_01ky0ztpc9eqn9g67e30pjt5k9/README.md),
including the completed [HTML report](runs/exp_01ky0ztpc9eqn9g67e30pjt5k9/report/index.html).

## Quick start

Requires Python 3.12 and [uv](https://docs.astral.sh/uv/).

```bash
cd experiments/skillsbench_trajectory_transfer
make check
make reproduce-analysis RUN=exp_01ky0ztpc9eqn9g67e30pjt5k9
make report RUN=exp_01ky0ztpc9eqn9g67e30pjt5k9
make verify-artifacts RUN=exp_01ky0ztpc9eqn9g67e30pjt5k9
```

`make reproduce-analysis` reads the committed 10,413-row normalized paired table, reruns
10,000 task-paired bootstrap replicates with seed 17, and requires all preregistered BFCL
accuracies, deltas, and interval endpoints to agree within `1e-10`; preservation counts are
exact. The runtime package exposes six side-effect-free CLIs—run any with `--help` without
model weights or credentials.

## GPU training and evaluation

Install optional public stacks only for the heavy stages:

```bash
uv sync --extra train
uv sync --extra eval
uv run skillsbench-train --help
uv run skillsbench-evaluate --help
```

The adapters and audited Parquet corpus are intentionally not committed. Their immutable
`artifact://` references, sizes, etags, provider versions, loading notes, and a verified
metadata snapshot are in
[`runs/.../artifacts/manifest.json`](runs/exp_01ky0ztpc9eqn9g67e30pjt5k9/artifacts/manifest.json).
Fresh live access to those references requires a Silico workspace authorized for the source
experiment; ordinary Git checkouts can still reproduce every committed CPU analysis and
validate the recorded metadata snapshot without downloading model-scale files.

## Layout

- `src/skillsbench_trajectory_transfer/`: typed corpus, overlap, training, evaluation,
  paired-analysis, and report APIs.
- `configs/`: immutable public source revisions and resolved benchmark/training recipes.
- `runs/<EID>/`: append-only compact run records and external-artifact manifests.
- `docs/methodology.md`: data construction, leakage controls, and statistics.
- `docs/reproduction.md`: CPU analysis versus GPU retraining/evaluation.
- `docs/adding-a-run.md`: contract for another immutable run.
