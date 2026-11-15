# Deep-research training + evaluation infrastructure

**Status:** `in-progress` — scaffold landed (empty skeletons + working reward
registry); rollout/agent loop, search backends, and data-gen stages are `NotImplementedError` stubs.

## Why

Turn SMILE-factory into training + evaluation infrastructure for a deep-research
agent (RL post-training + benchmark eval), without breaking the category-first
monorepo conventions. Design was driven by a survey of six deep-research
codebases: DR-Tulu, QUEST, Search-R1, DeepResearcher, StepDeepResearch, and
chroma context-1-data-gen.

## Key decisions (and the evidence behind them)

1. **One shared agent+tool+reward library in `libs/dr_agent`.** It is imported by
   `training/`, `eval/`, and `apps/`, so the agent loop and scorers are identical
   across train/eval/serve. The surveyed repos that skipped this (QUEST, Search-R1)
   duplicated tool code 3–4× and drifted; the ones that built it (DR-Tulu
   `dr-agent-lib`, StepFun `cortex`) are the ones worth copying. This is also the
   only sanctioned cross-project import surface per the root CLAUDE.md.

2. **Reward = a flat registry keyed by `data_source`**, living in the shared lib
   (`dr_agent.rewards`). RL reward and eval scoring both call `score(row)`. Add a
   task = add one scorer file. (Search-R1 `reward_score/`, DR-Tulu `search_rewards/`.)

3. **`eval/` is BenchFlow-run; a benchmark = a `tasks/` dir; agent + model are
   `--agent`/`--model` run-time knobs.** *(Updated 2026-06-23.)* The original plan
   was a standalone two-phase (generate → score) harness reusing `dr_agent`. In
   practice we standardized on **[BenchFlow](https://github.com/benchflow-ai/benchflow)
   as the sole eval runner**: a benchmark is a flat `tasks/` dir (the skillsbench
   model — one task = one input → one trajectory → one score), and the agent
   harness (pi / Claude Code / Codex / …) and model are runtime flags, so swapping
   them needs no code. This keeps eval reproducible outside a training run (the
   original concern) while making the harness pluggable. The two-phase
   `eval_harness` package was removed; `libs/dr_agent` survives and would re-enter
   eval as a future `--agent dr_agent` BenchFlow agent, not a parallel runner.

4. **Tools are an HTTP service in `services/` (`search_server`).** Heavy retrieval
   deps (bm25/faiss) are isolated from the lib and trainer; backends swap behind a
   stable `/search` `/retrieve` `/visit` contract; RL can hit a self-hosted index
   for reproducibility. `services/` (runtime services) is distinct from `infra/`
   (deployment). This is the most-copied pattern across all six repos.

5. **RL engine = slime (THUDM/slime), consumed as a Docker image, never vendored.**
   Every surveyed RL repo vendored its engine (verl/open-instruct) — flagged as the
   #1 smell. slime's plugin model lets us avoid that entirely: our whole
   contribution is two functions wired in by CLI flag, mirroring slime's
   `examples/search-r1/`:
   - `plugins/rollout.py::generate` → `--custom-generate-function-path` (drives the
     shared `dr_agent` loop, fills the slime `Sample` contract incl. `loss_mask`).
   - `plugins/reward.py::reward_func` → `--custom-rm-path` (shim to `dr_agent.rewards`).

6. **`data/datagen` = `core/` base stages + `domains/<name>/` subclasses**, stages
   as runnable modules with a `__main__.py` orchestrator, output written
   `raw/ → verified/ → final/` (not mutate-in-place). Generated tasks carry ground
   truth and conform to the `dr_agent` scoring schema, so data doubles as
   train + eval. (chroma context-1-data-gen, improved.)

## Layout delivered

```
libs/dr_agent/              shared agent loop + tools + reward registry + prompts
services/search_server/     tool/search HTTP service (bm25/dense/web backends)
data/datagen/               core/ + domains/<name>/ synthetic task generation
eval/                       BenchFlow-run: benchmarks/<name>/tasks/ + _tooling/ (driver, serving, scorers)
training/rl_deepresearch/   slime recipe: plugins/ + configs/ + launch/ + engine(README)
```

All new projects use uv + hatchling + `src/` layout + ruff (matching the active
delulu apps). Each owns its `pyproject.toml`, `Makefile`, and `CLAUDE.md`.

## What is NOT done yet

- `dr_agent.agent.loop.run_agent` — the ReAct loop (raises `NotImplementedError`).
- `search_server` endpoints + index builder backends.
- `datagen` web stages (explore/verify/distract/extend).
- `plugins/rollout.py` Sample-contract population (tokenization + `loss_mask`).
- slime image digest pin; HF→Megatron weight conversion step.
- Only `exact_match` + `f1` scorers exist; `rubric`/`citation` are TODO.

## Open questions / parked

- **slime via bind-mount vs. baked Dockerfile** — dev uses bind-mount; a pinned
  `engine/Dockerfile` (`FROM slimerl/slime@sha256:…`) may be wanted for CI/repro.
- **SFT recipe** — `training/lora_instruct` (uv) stays as-is; if a deep-research
  SFT cold-start is needed, add a sibling recipe rather than extending it.
- **PR strategy** — per "one PR per project," this scaffold should land as several
  PRs (one per new project) plus a cross-cutting PR for root `Makefile`/`CLAUDE.md`.
