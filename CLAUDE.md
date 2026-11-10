# CLAUDE.md

SMILE-factory is a multi-project monorepo. The active project is **delulu**, a Discord → Claude Code orchestrator that dispatches tasks to ephemeral Modal sandboxes (under `apps/delulu_discord` and `apps/delulu_sandbox_modal`). It also hosts a **LoRA-Instruct** SFT training recipe (HuggingFace PEFT + LoRA) under `training/lora_instruct/`.

## Quick Reference

Each project owns its own Makefile and tooling — there is no repo-wide `poetry`/`pytest`. Use the per-project entrypoints:

- **Delulu (active)** — two apps, each with its own project `CLAUDE.md`: [`apps/delulu_discord`](apps/delulu_discord/CLAUDE.md) (the bot) and [`apps/delulu_sandbox_modal`](apps/delulu_sandbox_modal/CLAUDE.md) (the Modal sandbox). Quick: `make -C apps/delulu_discord check`, `make -C apps/delulu_sandbox_modal modal-deploy`. Top-level shortcuts: `make check`, `make deploy-bot`, `make deploy-modal`, `make deploy-all`.
- **LoRA-Instruct training**: see [`training/lora_instruct/CLAUDE.md`](training/lora_instruct/CLAUDE.md) for setup, lint, test, and training commands — they no longer live at the repo root.
- **Deep-research training + eval** (uv-based, `make dr-check` to lint all): the shared agent/tool/reward lib [`libs/dr_agent`](libs/dr_agent/CLAUDE.md) (imported by training, eval, apps), the [`services/search_server`](services/search_server/CLAUDE.md) tool HTTP service, [`data/datagen`](data/datagen/CLAUDE.md) synthetic task generation, the BenchFlow-run [`eval`](eval/README.md) (benchmarks under `eval/benchmarks/<name>/tasks/`, driven from `eval/_tooling`; agent/model are `--agent`/`--model` knobs), and the slime RL recipe [`training/rl_deepresearch`](training/rl_deepresearch/CLAUDE.md). Architecture + rationale: [docs/prd/deep-research-training-eval-infra.md](docs/prd/deep-research-training-eval-infra.md).

## Working in the monorepo

The repo is category-first: `apps/` (production services), `training/`
(reusable SFT/RLHF recipes), `data/` (cross-project datasets + scrapers +
data-gen), `services/` (runtime application services, e.g. the search/tool HTTP
server), `infra/` (shared infra/deployment, e.g. the managed-agents platform),
`libs/` (shared cross-project packages, e.g. `dr_agent`), plus `docs/` (all
reference + plan docs, including cross-cutting PRDs under `docs/prd/`) and
`eval/` (the deep-research evaluation harness). Note `services/` (runtime
services) is distinct from `infra/` (deployment/infrastructure). Most tasks are
scoped to a single project — work from that project's directory, not the repo
root:

- **Identify the project first.** Almost every task lives inside one
  project (`apps/delulu_discord`, `training/lora_instruct`, …).
- **Work from the project root**, not the repo root — `cd` in or use
  `make -C <project>`. Each project owns its deps, lockfile, and Makefile.
- **Scope `Grep`/`Glob` to the project dir**; broaden only for genuinely
  cross-cutting work.
- **No imports between projects.** Shared code goes in `libs/` via its own PR.
- **One PR per project.** Cross-cutting files (`.github/`, `docs/` — including
  `docs/prd/`, `.pre-commit-config.yaml`) ship as their own PR.
- **A project's own `CLAUDE.md` wins** over this file for its commands and
  conventions.

## Docs

All docs live under [`docs/`](docs/README.md) (reference + plan docs; cross-cutting PRDs under [`docs/prd/`](docs/prd/README.md)):

- [Docs index](docs/README.md) — full map of what lives where
- [Delulu architecture](docs/delulu-architecture.md) — the active orchestrator's design (Discord → Claude Code → Modal sandboxes)
- [Monorepo conventions](docs/monorepo-conventions.md) — how pre-commit, CI, branch protection, and per-app Makefiles interact in this multi-pyproject layout. Read this before touching `.pre-commit-config.yaml`, `.github/workflows/delulu-deploy.yaml`, or any root-level tooling
- [Development](docs/development.md) — setup, linting, testing, training, and code conventions
- [LoRA-Instruct architecture](docs/architecture.md) — the SFT recipe's design (`training/lora_instruct`)

## Git workflow

- Never commit to `main` — always branch, push, open a PR.
- Branch: `<type>/<slug>` (e.g. `feat/streaming-renderer`, `fix/dispatcher-timeout`).
- Commits + PR titles: [Conventional Commits](https://www.conventionalcommits.org/) (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`, `perf`, `style`, plus a local `prd` type for changes under a `prd/` directory — cross-cutting `docs/prd/` or per-app `apps/<app>/prd/`). Squash-merge uses the PR title, so it must be conventional.
- Only commit, push, or open PRs when explicitly asked. Never merge PRs — that's a human call.
