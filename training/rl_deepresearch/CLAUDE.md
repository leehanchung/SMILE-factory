# CLAUDE.md — rl_deepresearch (slime RL recipe)

A **thin recipe** over the slime RL engine. slime is the engine; we write only
two functions. Do not vendor or fork slime.

## The integration in one paragraph

slime (Megatron train + SGLang rollout, bridged by a Ray Data Buffer) runs as a
**Docker image** (`slimerl/slime`, pinned by digest via `SLIME_IMAGE` in the Makefile). It calls our code by CLI flag:
`--custom-generate-function-path plugins.rollout.generate` (the rollout, which
drives the shared `dr_agent` agent loop) and `--custom-rm-path
plugins.reward.reward_func` (a shim to the `dr_agent` reward registry). Both reuse
`libs/dr_agent`, so the RL environment and reward are identical to eval/serving.

## Commands

- `make check` / `make test` — lint + test our plugin code (runs outside the container)
- `make image` — `docker pull` the slime engine
- `make run` — launch a run inside the container (see `engine/README.md`)

## Conventions

- **Hyperparameters live in `configs/`** (one YAML per experiment), never inlined
  into `launch/run.sh`. The shell script only assembles arg blocks.
- **The Sample contract is the whole game** in `plugins/rollout.py`: set `tokens`,
  `response`, `response_length`, `loss_mask` (mask tool/observation tokens so only
  model tokens get a gradient), and `status`.
- **No engine edits.** If the default rollout loop can't express what you need,
  reach for `--rollout-function-path` (full override) before patching slime.
- **Reward logic does not live here** — it lives in `libs/dr_agent/rewards`.
  `plugins/reward.py` only adapts slime's `Sample` to a `dr_agent` `Row`.
