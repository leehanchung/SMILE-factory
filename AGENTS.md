# AGENTS.md

SMILE-factory is a multi-project monorepo. The active project is **delulu**, a Discord -> Claude Code orchestrator that dispatches tasks to ephemeral Modal sandboxes (under `apps/delulu_discord` and `apps/delulu_sandbox_modal`). It also hosts a **LoRA-Instruct** SFT training recipe (HuggingFace PEFT + LoRA) under `training/lora_instruct/`.

## Quick Reference

Each project owns its own Makefile and tooling -- there is no repo-wide `poetry`/`pytest`. Use the per-project entrypoints:

- **Delulu (active)**: `make -C apps/delulu_discord check` (lint + test), `make -C apps/delulu_discord deploy`, `make -C apps/delulu_sandbox_modal modal-deploy`. Top-level shortcuts: `make check`, `make deploy-bot`, `make deploy-modal`, `make deploy-all`.
- **LoRA-Instruct training**: see [`training/lora_instruct/CLAUDE.md`](training/lora_instruct/CLAUDE.md) for setup, lint, test, and training commands -- they no longer live at the repo root.

## Docs

All docs live under [`docs/`](docs/README.md) (reference + plan docs; cross-cutting PRDs under `docs/prd/`):

- [Docs index](docs/README.md) -- full map of what lives where
- [Delulu architecture](docs/delulu-architecture.md) -- the active orchestrator's design (Discord -> Claude Code -> Modal sandboxes)
- [Monorepo conventions](docs/monorepo-conventions.md) -- how pre-commit, CI, branch protection, and per-app Makefiles interact in this multi-pyproject layout. Read this before touching `.pre-commit-config.yaml`, `.github/workflows/delulu-deploy.yaml`, or any root-level tooling
- [Development](docs/development.md) -- setup, linting, testing, training, and code conventions
- [LoRA-Instruct architecture](docs/architecture.md) -- the SFT recipe's design (`training/lora_instruct`)

## Git workflow

- Never commit to `main` -- always branch, push, open a PR.
- Branch: `<type>/<slug>` (e.g. `feat/streaming-renderer`, `fix/dispatcher-timeout`).
- Commits + PR titles: [Conventional Commits](https://www.conventionalcommits.org/) (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`, `perf`, `style`, plus a local `prd` type for changes under a `prd/` directory -- cross-cutting `docs/prd/` or per-app `apps/<app>/prd/`). Squash-merge uses the PR title, so it must be conventional.
- Only commit, push, or open PRs when explicitly asked. Never merge PRs -- that's a human call.

## Imported Claude Cowork project instructions
