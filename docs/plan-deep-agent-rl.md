# Deep-research agent: training + evaluation architecture

> SMILE-factory as full-stack infrastructure for training and evaluating a
> **deep-research agent** (multi-turn search → read → synthesize) via RL, plus the
> data generation and evaluation that surround it.

> **History:** this document replaces an earlier Tinker→prime-rl plan that
> predated the monorepo reorg. The chosen RL backend is now **slime**
> (THUDM/slime), and the layout follows the repo's category-first monorepo
> conventions rather than the old single-project `lora_instruct/` tree. The
> earlier "evaluation as the stable core" principle survives; the backend and
> directory structure do not.

## 1. Goals

Evolve the repo into infrastructure that can:

1. **Train** a deep-research agent with RL (GRPO) on slime.
2. **Evaluate** it on deep-research benchmarks with a standalone, reproducible
   harness.
3. **Generate** synthetic training/eval data with ground truth baked in.
4. Do all of the above **without train/eval skew** — the agent loop, the tools,
   and the scorers are *one shared library* used by training, eval, and serving.

## 2. How the design was chosen

The layout was driven by a survey of six deep-research codebases — DR-Tulu,
QUEST, Search-R1, DeepResearcher, StepDeepResearch, and chroma
context-1-data-gen. The convergent patterns we adopted (and the anti-patterns we
avoided):

| Pattern | Source | Decision |
|---|---|---|
| Top level = pipeline stage (data → train → serve → eval) | QUEST, DR-Tulu | **Adopt** |
| One shared agent+tool library, reused as RL env **and** eval/serve runtime | DR-Tulu `dr-agent-lib`, StepFun `cortex` | **Adopt — the linchpin** |
| Tools as an HTTP service behind one contract, own dep env | Search-R1, DeepResearcher, QUEST (FAISS) | **Adopt** (`services/search_server`) |
| Reward = flat per-task registry, dispatched by `data_source` | Search-R1, DR-Tulu | **Adopt** (`dr_agent.rewards`) |
| Two-phase eval: generate rollouts → JSON → score offline | DeepResearcher, StepFun | **Adopt** (`eval/`) |
| One folder per benchmark + shared `samplers/` | DR-Tulu, QUEST | **Adopt** |
| `core/` base + `domains/<name>/` subclasses for data-gen | chroma | **Adopt** (`data/datagen`) |
| Vendoring the whole RL engine into the tree | Search-R1, DeepResearcher, DR-Tulu | **Avoid** — slime is a pinned Docker image |
| Tool code duplicated 3–4× across stages | QUEST | **Avoid** — `libs/` is the single source |
| Hyperparameters in giant `.sh` override blobs | most | **Avoid** — versioned YAML configs |
| Prompts hardcoded in Python | StepFun, chroma | **Avoid** — templates under `prompts/` |

## 3. Layout

Category-first, one project per directory (each owns its `pyproject.toml`,
`Makefile`, `CLAUDE.md`; uv + hatchling + `src/` layout):

```
libs/dr_agent/              shared agent loop + tools + reward registry + prompts
                           (imported by training, eval, apps — the only legal
                            cross-project import surface)
services/search_server/     tool/search HTTP service (/search /retrieve /visit);
                           heavy retrieval deps (bm25/faiss) isolated here
data/datagen/               core/ stage base-classes + domains/<name>/ pipelines;
                           output conforms to the dr_agent scoring schema
eval/                       standalone two-phase harness (generate → score);
                           benchmarks/<name>/ + shared samplers/
training/rl_deepresearch/   thin slime recipe: plugins/ (rollout + reward),
                           configs/ (YAML), launch/, engine/ (README only)
training/lora_instruct/     existing SFT recipe (uv)
```

Data flow:

```
data/datagen ──tasks(jsonl, w/ ground truth)──► training/rl_deepresearch ──► policy
       │                                              │  (slime: Megatron+SGLang)
       │                                              ▼
       └──────────────────────────────────────► eval/ (generate → score)
                          both call ▲
                                    │
                       libs/dr_agent (agent loop + tools + rewards)
                                    │
                       services/search_server (HTTP tools)
```

## 4. Key decisions

### 4.1 One shared library (`libs/dr_agent`) — no train/eval skew
The agent loop, tools, prompts, and reward scorers live once and are imported by
training (RL env + reward), eval (rollout + scoring), and apps (serving). The
surveyed repos that skipped this duplicated tools and drifted; the ones that
built it are the ones worth copying. Per the root CLAUDE.md, `libs/` is the only
sanctioned cross-project import surface, so this is on-convention.

### 4.2 Reward = one registry, dispatched by `data_source`
`dr_agent.rewards.score(row)` looks up a scorer by the row's `data_source` tag.
RL reward (`plugins/reward.py`) and eval scoring (`harness/score.py`) both call
it. Add a task type = add one scorer file + register it. Currently `exact_match`
and `f1` are implemented; `rubric` and `citation` are TODO.

### 4.3 `eval/` is standalone and two-phase
Generate rollouts → JSON, then score offline. Decoupling makes re-scoring cheap
and auditable, and forces eval to use the *same* agent loop + scorers as
training. Search-R1/DeepResearcher folded eval into the trainer (val batches +
reward); that makes eval irreproducible outside a training run — we don't.

### 4.4 Tools are an HTTP service in `services/`
`services/search_server` exposes `/search`, `/retrieve`, `/visit` behind a stable
contract. Heavy retrieval deps (bm25/faiss/sentence-transformers) stay out of the
lib and trainer, backends swap freely, and RL can hit a self-hosted index for
reproducibility. `services/` (runtime services) is intentionally distinct from
`infra/` (deployment/infrastructure).

### 4.5 RL engine = slime, consumed as a Docker image (never vendored)
slime wires Megatron (training) ↔ SGLang (rollout) through a Ray Data Buffer. It
is consumed as `slimerl/slime:latest` (pin a digest for repro), not forked. Our
entire contribution is two functions wired in by CLI flag, mirroring slime's own
`examples/search-r1/`:

| Our file | slime flag | Role |
|---|---|---|
| `plugins/rollout.py::generate` | `--custom-generate-function-path` | runs the shared `dr_agent` loop; fills the slime `Sample` contract |
| `plugins/reward.py::reward_func` | `--custom-rm-path` | shims slime's `Sample` to `dr_agent.rewards` |

**The Sample contract is the whole integration surface.** `generate(args, sample,
sampling_params)` must set `sample.tokens` (prompt+response ids),
`sample.response`, `sample.response_length`, `sample.loss_mask` (0 for
prompt/tool-observation tokens so only model-generated tokens get a gradient),
and `sample.status`. `reward_func(args, sample, **kwargs) -> float` reads ground
truth from `sample.label`.

Install/launch: pull the image, run the container with this recipe bind-mounted
and GPUs attached, `pip install -e libs/dr_agent --no-deps`, then `bash
launch/run.sh` (or `ray job submit ... -- python3 train.py ...` for multi-node).
HF→Megatron weight conversion is a pre-step. See
`training/rl_deepresearch/engine/README.md`.

### 4.6 Data-gen = `core/` + `domains/<name>/`
Stage base-classes in `core/` (explore/verify/distract/extend); each domain
subclasses them with an identical, stage-named file layout and a `__main__.py`
orchestrator. Stages write to separate `raw/ → verified/ → final/` dirs (not
mutate-in-place) for clean partial reruns. Generated tasks carry ground truth and
match the `dr_agent` scoring schema, so the data doubles as train + eval.

## 5. Status

Scaffold landed; the reward registry is implemented and tested (5 tests pass).
The following are `NotImplementedError` stubs awaiting implementation:

- `dr_agent.agent.loop.run_agent` — the ReAct loop (highest leverage: training,
  eval, and serving all block on it).
- `search_server` endpoints + index builder backends.
- `datagen` web stages (explore/verify/distract/extend).
- `plugins/rollout.py` Sample-contract population (tokenization + `loss_mask`).
- slime image-digest pin + HF→Megatron conversion wiring.
- `rubric` / `citation` reward scorers.

## 6. Suggested order of implementation

1. `dr_agent.agent.loop.run_agent` (unblocks everything).
2. `search_server` `/search` + `/visit` against one backend (bm25), so the loop
   has real tools.
3. `eval/` end-to-end on one benchmark (proves the generate→score path).
4. `datagen` web pipeline (produces training/eval data).
5. `plugins/rollout.py` Sample contract + a first slime GRPO run.

## 7. References

- [slime (THUDM)](https://github.com/THUDM/slime) — RL engine (Megatron + SGLang)
- Surveyed repos: [DR-Tulu](https://github.com/rlresearch/DR-Tulu),
  [QUEST](https://github.com/OSU-NLP-Group/QUEST),
  [Search-R1](https://github.com/PeterGriffinJin/Search-R1),
  [DeepResearcher](https://github.com/GAIR-NLP/DeepResearcher),
  [StepDeepResearch](https://github.com/stepfun-ai/StepDeepResearch),
  [context-1-data-gen](https://github.com/chroma-core/context-1-data-gen)
- PRD (status tracker): [docs/prd/deep-research-training-eval-infra.md](prd/deep-research-training-eval-infra.md)
