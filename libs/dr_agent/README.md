# dr-agent

The **shared deep-research agent library** for SMILE-factory. This is the single
source of truth for the agent loop, the tools, the prompts, and the reward
scorers — so that **training, evaluation, and serving can never drift**.

It is imported by `training/rl_deepresearch/` today; `eval/` and `apps/` are the
next consumers, sharing the same loop so the three can never drift:

- `training/rl_deepresearch/` — the agent loop is the RL *environment*; the reward
  registry is the RL *reward*. **(imports it today)**
- `eval/` — the same agent loop generates rollouts; the same reward registry scores them. *(planned)*
- `apps/` — production serving runtimes call the same agent. *(planned)*

## Layout

```
src/dr_agent/
  agent/      ReAct loop (provider-agnostic) + AgentConfig
  tools/      search + visit implemented today; scholar, python, mcp planned
  rewards/    flat per-task scorer registry, dispatched by `data_source`
  prompts/    versioned prompt templates (jinja) — NOT hardcoded in code
```

## Why a shared lib (and not duplicated tools)

The deep-research repos we surveyed that skipped a shared lib (QUEST, Search-R1)
ended up with the same tool code copied 3–4× across stages, which drifts. The
ones that built one (DR-Tulu's `dr-agent-lib`, StepFun's `cortex`) are the ones
worth copying. Per the repo's CLAUDE.md, `libs/` is the *only* sanctioned
cross-project import surface — this package is exactly that.
