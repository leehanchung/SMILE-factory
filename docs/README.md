# Docs

All SMILE-factory documentation lives here — one tree for **reference docs**
and **plan docs**. There is no separate top-level `prd/`; cross-cutting PRDs
now live under [`prd/`](prd/README.md) inside this folder. App-specific plans
still live next to their app under `apps/<app>/prd/`.

## Reference

| Doc | What |
|---|---|
| [delulu-architecture.md](delulu-architecture.md) | Design of the active orchestrator — Discord → Claude Code → ephemeral Modal sandboxes. |
| [delulu-usage.md](delulu-usage.md) | Hands-on guide to driving the delulu bot from Discord. |
| [monorepo-conventions.md](monorepo-conventions.md) | How pre-commit, CI, branch protection, and per-app Makefiles interact in this multi-pyproject layout. Read before touching `.pre-commit-config.yaml`, `.github/workflows/delulu-deploy.yaml`, or root tooling. |
| [development.md](development.md) | Setup, linting, testing, training, and code conventions. |
| [architecture.md](architecture.md) | LoRA-Instruct SFT recipe design (`training/lora_instruct`). |
| [plan-deep-agent-rl.md](plan-deep-agent-rl.md) | Architecture + rationale for the deep-research training/eval infra (shared `libs/dr_agent`, `services/search_server`, `data/datagen`, `eval/`, slime RL recipe). |

## Plans

| Doc | What |
|---|---|
| [prd/README.md](prd/README.md) | Index of cross-cutting PRDs with status vocabulary. A PRD is a **plan**, not a spec of shipped behavior. |

## Claude Code usage in this repo

Repo-local Claude Code config lives under [`.claude/`](../.claude/), structured
after [`anthropics/claude-code`](https://github.com/anthropics/claude-code):

- `.claude/commands/` — slash commands (e.g. `/review-pr`, the CI reviewer).
- `.claude/agents/` — specialist subagents the reviewer coordinates.
- `.claude/hooks/` — hooks (e.g. `git-sync.sh`, keeps PR branches current with `main`).
- `.claude/settings.json` — checked-in hook wiring.

The GitHub-side wiring lives in `.github/workflows/` (`claude.yml` for `@claude`
mentions, `claude-code-review.yml` for the auto review that runs `/review-pr`).
