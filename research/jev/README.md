# RE Jev research project

Compact research handoff. No model has been trained or benchmarked in this investigation. Our proposed implementation is not a reconstruction of verified Jev internals.

## Documents

- [Design criteria](design-criteria.md)
- [Architecture and value-function extension](architecture.md)
- [Training data plan](training-data.md)
- [Calibration and evaluation](calibration.md)
- [Experiment plan](experiments.md)
- [GLiNER2 benchmark and calibration protocol](gliner2-benchmark.md)
- [Monte Carlo calibration study](monte-carlo-calibration.md)
- [Model-family background](model-families.md)
- [References and attributions](references.md)
- [Source-note provenance](provenance.json)

This folder is an independent Python/uv project inside the monorepo. Research protocols remain proposed; the environment smoke check is not a model benchmark.

## Local Python environment

Use the project wrapper to keep Python, dependencies, and caches inside this folder. It ignores an active virtual environment and does not install into system Python or modify shell startup files. The project `uv.lock` records exact dependencies; `.venv` and `.cache` are ignored by Git.

```sh
cd /Users/han/projects/SMILE-factory/research/jev
make setup                         # sync the locked environment
make check                         # lint, formatting, offline training/calibration smoke check
sh scripts/uv.sh run python         # project Python with local cache settings
make notebook                      # optional local JupyterLab; no global kernel registration
```

Always use `sh scripts/uv.sh` (or these Make targets) for project commands, including `add`, `sync`, and `run`. Plain `uv` or directly activating `.venv` does not set all model/library cache paths. The wrapper works from other directories when invoked with its absolute path.

Included: PyTorch, GLiNER2 training support, Transformers, Datasets, Accelerate, PEFT, tokenization/serialization libraries, NumPy, SciPy, scikit-learn, pandas/Arrow, and plotting tools. Ruff and pytest are development dependencies; notebooks are optional. GLiNER2 package version 2.0.0 is distinct from GLiNER2.5 model checkpoints. The planned first checkpoint remains `fastino/gliner2-base-v1`.

Python 3.12 is downloaded into `.cache/python`; `.venv` uses that private runtime. Hugging Face, Torch, matplotlib, and notebook caches are project-local. Store datasets in `data/`, model weights in `checkpoints/`, and experiment outputs in `runs/` or `artifacts/`; these paths are ignored. Put reusable Python code in `src/jev_research/`.

The offline smoke check imports model/trainer classes, runs a tiny optimizer loop on CPU and any available MPS/CUDA device, and fits a temperature on synthetic calibration labels before scoring a separate synthetic test split. It does not download pretrained weights, run the research benchmark, or establish GLiNER2 training compatibility with every accelerator operation. On this Apple Silicon host, use CPU or available MPS; validate a CUDA environment separately on an NVIDIA machine.

To rebuild, recreate the local environment with `make setup` using the lockfile. To remove the installed environment, remove this folder's `.venv` and `.cache`; preserve `uv.lock`, source files, and research documents. No root-level monorepo configuration is required.

## First Jev notebook

Open [01_jev_off_the_shelf_calibration.ipynb](notebooks/01_jev_off_the_shelf_calibration.ipynb) with `make notebook`. The `Jev (.venv)` kernel is registered only inside this project's `.venv`.

The local `.env` is owner-readable/writable only and ignored by Git, along with `.env.*` variants (the empty `.env.example` is safe to track). Set `TYPESAFE_API_KEY` there using an editor, not a shell command containing the key. Never paste the key in chat, notebook cells, output, or a command line. The client reads `.env` directly without exporting the key into the notebook's environment.

The initial grid contains 63 synthetic scenarios and three typed questions per request. API calls are off by default: set `RUN_LIVE=True` in the setup cell to collect missing scores, or leave it false to analyze the local cache. There is an 80-request cap and no automatic retry. Results resume from `runs/jev-off-the-shelf/jev-1.13.0/`; no raw response bodies or authorization headers are saved. The Monte Carlo calculation runs locally over cached predictions. It evaluates raw Jev probabilities without fitting a calibrator.

Run `sh scripts/uv.sh run --group notebook pytest -q` to include the complete offline notebook analysis/plot check. Its oracle fixtures are test data, not Jev benchmark results. The live API benchmark still requires the local key.

## Objective

Predict many runtime-defined categorical, boolean, ordinal, and numerical fields against shared input. Return JSON assembled in code and evaluate probability quality against relevant outcomes. Preserve explicit distinctions between schema validity, predictive accuracy, calibration, and joint consistency.

## Evidence and architecture choices

[Schema-conditioned prediction architectures](architecture.md) records GLiClass and GLiNER2 as published baselines. Our custom alternative uses shared input memory, question-isolated cross-attention, and shared prediction heads by type. Head count is not field count. Question chunk invariance requires unchanged inputs, masks, and positions; it must be tested.

New source supplied by Han: [madiator post](https://x.com/madiator/status/2100990591215783946). Direct X retrieval failed; an indexed reproduction tracker associated the exact status with Bespoke Nimble. The findings below were checked against the first-party repository and source, not the inaccessible post text.

[Bespoke Nimble](https://github.com/bespokelabsai/nimble) is an additional implementation baseline. Its reported result is 292/324 synthetic reference-label matches, not agreement with Jev; the holdout comprises 162 pairs from six source families. These are author-reported results, not independent verification. Its documentation explicitly states probabilities have not been calibrated.

[Training guide](https://github.com/bespokelabsai/nimble/blob/main/docs/NIMBLE_TRAINING.md): Qwen3.5-9B with LoRA and candidate-logit cross-entropy against hard labels. The published model used 2,676 examples; the retained training file has 2,826. Teacher probability distillation is not the published objective.

[Prompt compiler](https://github.com/bespokelabsai/nimble/blob/main/nimble/scoring/parallel_schema.py): the context and full schema form a shared prefix, followed by a requested-field suffix. Answer codes must each tokenize to one token. [CUDA scorer](https://github.com/bespokelabsai/nimble/blob/main/nimble/scoring/cuda_scorer.py): score selected existing output-embedding rows rather than introducing a new scalar head; this path repeats full-prompt processing per field. The [scoring guide](https://github.com/bespokelabsai/nimble/blob/main/docs/PARALLEL_SCORING.md) describes MLX prefix reuse. Inference: independent answer branches do not establish invariance to changing the schema in the shared prefix.

Decision proposal: benchmark Nimble-style candidate-token scoring before investing in custom readouts. Keep GLiNER2/GLiClass as discriminative alternatives. The specifically excluded harshatheg/Qwen-2.5-1B-RLCD remains excluded; that does not exclude every design using token logits.

## Data

Follow [RE Jev training data plan](training-data.md): real labels, reviewed annotations, executable synthetic tasks, and historical outcomes for forecasting. Split source families before augmentation. Preserve independent calibration and final-test sets.

Add Nimble-inspired contrastive pairs: change one decisive fact, keep the rule/question fixed, and verify that the label changes. Use evidence-deletion checks to detect shortcuts; missing evidence is not a false label. Retain provenance and review synthetic labels. [Curation guide](https://github.com/bespokelabsai/nimble/blob/main/docs/TRAINING_EVAL_CURATION.md)

## Calibration and value functions

Follow [Calibrated structured predictions](calibration.md): freeze the predictor, fit held-out calibration, test by schema/population/time, and distinguish probability correction from conformal coverage. Contrastive discrimination alone does not establish calibration.

Value-function use remains an extension: condition on history, action, goal, horizon, and continuation policy; supervise with rollout returns. Estimate each action's return independently, without softmax across action values. Evaluate actual policy return in addition to prediction error and calibration.

## Next experiment

Use a fixed dataset and evaluation protocol to compare base-model candidate scoring, Nimble-style fine-tuning, and a GLiClass/GLiNER2 baseline. The [GLiNER2 experiment](experiments.md#gliner2-baseline) starts with `fastino/gliner2-base-v1` from the [Fastino repository](https://github.com/fastino-ai/GLiNER2), comparing pretrained and domain-fine-tuned variants. Test schema/order/chunk stability and latency as field count grows. Add custom readouts and continuous-return heads only when measured gaps justify them. Open specifications: target domain, hardware, context/schema limits, numerical support, and quantitative acceptance thresholds.
