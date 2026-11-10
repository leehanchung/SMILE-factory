# Monorepo conventions

How linting, testing, CI, and deploys work across the two (and a half)
independent Python projects that share this git tree. Written because
the "multi-pyproject monorepo" pattern has some non-obvious gotchas,
and they will bite you the first time a ruff drift or a skipped CI
job blocks a merge.

## The layout

```
SMILE-factory/
├── apps/
│   ├── delulu_discord/        ← Python project #1 (VPS bot)
│   │   ├── pyproject.toml     ← own deps, own ruff rules, own .venv
│   │   ├── uv.lock
│   │   ├── Dockerfile
│   │   ├── Makefile
│   │   ├── src/
│   │   └── tests/
│   └── delulu_sandbox_modal/  ← Python project #2 (Modal sandbox)
│       ├── pyproject.toml     ← own deps, own ruff rules, own .venv
│       ├── uv.lock
│       ├── Makefile
│       ├── src/
│       └── tests/
├── training/
│   └── lora_instruct/         ← Python project #3 (LoRA code)
│       ├── pyproject.toml     ← own deps, own ruff rules, own .venv
│       ├── uv.lock
│       ├── finetune.py
│       ├── utils/, templates/, dataset/, inference/, notebook/
│       ├── CLAUDE.md
│       └── README.md
├── docs/                       all repo docs (this file lives here)
│   └── prd/                    repo-wide plan docs (per-app plans live under apps/<name>/prd/)
├── .pre-commit-config.yaml
├── .github/workflows/delulu-deploy.yaml
├── .github/workflows/pr-title.yml   (Conventional Commits on PR titles, all projects)
└── Makefile                    thin dispatcher, `make -C apps/X ...`
```

The important non-obvious thing: **there is no workspace root** — there
is no top-level `pyproject.toml` at all. Nothing declares the `apps/*`
or `training/*` directories as workspace members; each is a standalone
project. There is nothing useful to `uv sync` at the repo root.

Each `apps/*` directory is an **independent Python project**: own
`pyproject.toml`, own `uv.lock`, own `.venv`, own `Makefile`, own
`tests/`, own ruff rules (target-version, line-length, rule set).
You could `cp -r apps/delulu_discord /some/other/repo` and it would
build there untouched. The only thing the monorepo actually shares is
the git history and the CI workflow file.

## Four layers, four scopes

The mental model that makes everything else fall into place:

| Layer | Scope | How it identifies "this app" | Config source |
|---|---|---|---|
| `pre-commit` (local) | One file, at commit time | `files:` / `exclude:` globs in `.pre-commit-config.yaml` | Hook version pinned in pre-commit config; ruff itself reads the **nearest** `pyproject.toml` walking up from the file |
| `make -C apps/X` (local) | One whole app directory | Explicit `cd` via `make -C` | The app's own `pyproject.toml` + `uv.lock` + `.venv` |
| GH Actions CI | Changed files across a PR | `dorny/paths-filter` → `changes` job outputs → per-app job `if:` + `defaults.run.working-directory` | The app's own `pyproject.toml` (same as local, on a fresh runner) |
| Branch protection | The PR as a whole | Required status checks by name | GitHub's branch-rule UI |

Each layer answers "what work does this file belong to?" differently,
and they all have to agree for the pipeline to be coherent.

## pre-commit in this monorepo

`pre-commit` is a git hook runner. It doesn't know about venvs or
`uv run`. When you `git commit`:

1. Git calls `.git/hooks/pre-commit` (installed by
   `pre-commit install` — **one-time setup per clone, not
   automatic**).
2. That script hands the list of **staged files** to pre-commit.
3. pre-commit walks `.pre-commit-config.yaml` top-to-bottom. For each
   hook, it filters the file list by `files:` / `exclude:` globs.
4. If any files match, it invokes the hook binary with those files
   as arguments.

Our config has a single ruff setup (`v0.15.10`, `ruff` + `ruff-format`)
scoped by path to the active Python projects:

- `files: ^(apps|training)/.*\.py$` — runs on everything under `apps/`
  and `training/`. Both trees are uv-managed and share this one modern
  ruff pin. (LoRA used to be linted by a separate legacy ruff hook at
  the repo root; the Poetry→uv migration folded it into this one.)

The key detail: pre-commit's ruff binary lives in its own isolated
env, managed by pre-commit. It is NOT the ruff from
`apps/delulu_discord/.venv`. But when that ruff runs on a file, **ruff
itself** walks up from the file looking for a `pyproject.toml`, finds
`apps/delulu_discord/pyproject.toml` (or
`training/lora_instruct/pyproject.toml`), and uses THAT config
(`target-version`, `line-length`, `[tool.ruff.lint]`, etc.). So the
ruff *version* is shared across all projects, but the *rules* are
per-project.

### The version-drift trap

`.pre-commit-config.yaml` pins `rev: v0.15.10`. Each `apps/*` and
`training/*` project's `pyproject.toml` pins `ruff>=0.15` in its dev
extras. Today they agree. Tomorrow someone bumps one project to
`ruff>=0.16` without touching `.pre-commit-config.yaml` and you'll see:

- Local `uv run ruff` (from the project's venv) uses `0.16.x`
- Local `pre-commit run` uses `0.15.10` (from the pre-commit pin)
- Same file, different opinions, mysterious CI flakes

**Rule:** when bumping the ruff pin in any app's `pyproject.toml`,
bump `.pre-commit-config.yaml` in the same commit. Same for any other
tool that's pinned in both places.

## GH Actions CI in this monorepo

CI doesn't share pre-commit's per-file model. It operates at the
**job** level, and each job has a `working-directory`.

The workflow at `.github/workflows/delulu-deploy.yaml` has one job
per app per phase:

- `delulu-discord-ci` — ruff + pytest, `working-directory: apps/delulu_discord`
- `delulu-sandbox-modal-ci` — ruff + pytest, `working-directory: apps/delulu_sandbox_modal`
- `delulu-sandbox-modal-deploy` — `modal deploy`, same working-dir
- `delulu-discord-deploy` — SSH droplet + rebuild container (no working-dir, SSH script does its own `cd`)

A `changes` job running `dorny/paths-filter` decides which of the
CI/CD jobs actually run via `if:` conditions on their respective
filter outputs. That's the path-filter mechanism — it's what makes a
docs-only PR skip both CI jobs and a bot-only PR skip the sandbox
jobs.

The per-app `working-directory` is how CI avoids the pre-commit
"walks upward looking for pyproject" trick: CI just `cd`s into the
app before it does anything, so `uv run ruff check .` picks up the
right config automatically.

## Branch protection + the skipped-job gotcha

GitHub's "Require status checks to pass before merging" rule expects
each listed check to have a success conclusion. The subtle thing:

- A check that **ran and passed** → satisfies the gate
- A check that **ran and failed** → blocks the merge
- A check that **was skipped** (paths filter said no) → does NOT
  satisfy the gate

So if you branch-protect `delulu-discord-ci` directly, a
sandbox-only PR can never merge: the discord CI skips because the
paths filter didn't match, and the gate never sees a passing check.

The standard fix is a **pass-through success job**:

```yaml
ci-complete:
  needs: [delulu-discord-ci, delulu-sandbox-modal-ci]
  if: always()
  runs-on: ubuntu-latest
  steps:
    - name: gate
      run: |
        if [[ "${{ needs.delulu-discord-ci.result }}" == "failure" ]]; then exit 1; fi
        if [[ "${{ needs.delulu-sandbox-modal-ci.result }}" == "failure" ]]; then exit 1; fi
        echo "CI complete"
```

Branch-protect only `ci-complete`. It always runs, it fails if any
required CI failed, and it passes if any combination of success and
skipped. That's the pattern for path-filtered monorepo CI.

(Not wired up yet; flagged as a follow-up for when branch protection
becomes important enough to bother with.)

## Commit messages and PR titles

main is squash-merge only and GitHub uses the PR title as the commit
subject, so the PR title is what lands in main's history. Two checks
enforce [Conventional Commits](https://www.conventionalcommits.org/):

| Check | Where | What it checks | Blocks |
|---|---|---|---|
| `conventional-pre-commit` | `.pre-commit-config.yaml`, `commit-msg` stage | Each local commit message | The local commit (skip with `--no-verify`) |
| `pr-title-lint` | `.github/workflows/pr-title.yml` | The PR title, re-checked on title edits | The merge (required status check on main) |

Allowed types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`,
`build`, `perf`, `style`, `revert`, and the local `prd` type for plan
docs. The list lives in three places — the hook `args`, the workflow
`types`, and the root `CLAUDE.md` — and they must match.

Merge commits and `fixup!`/`squash!` commits pass the local hook, so
rebasing and autosquash keep working.

Branch names follow `<type>/<slug>`. Agent tools create branches like
`claude/<name>`; rename them with `git branch -m <type>/<slug>` before
the first push.

## Walkthrough: a file edit, end-to-end

Edit `apps/delulu_discord/src/delulu_discord/handlers.py`:

```
# LOCAL — pre-commit catches lint at commit time (if installed)
git add handlers.py
git commit -m "fix: handle edge case"
  ↓ git invokes .git/hooks/commit-msg → conventional-pre-commit checks the message
  ↓ git invokes .git/hooks/pre-commit
  ↓ pre-commit runs modern ruff hook (matches apps/.*\.py)
  ↓ ruff reads apps/delulu_discord/pyproject.toml for rules
  ↓ auto-fixes what it can, blocks commit on what it can't

# LOCAL (optional) — reproduce CI before pushing
cd apps/delulu_discord && make check && make test
  ↓ runs the exact commands GH Actions runs
  ↓ uses apps/delulu_discord/.venv + its ruff + its pytest config

# REMOTE — push triggers the workflow
git push && gh pr create
  ↓ pull_request event fires delulu-deploy.yaml
  ↓ changes job: bot=true, sandbox=false
  ↓ delulu-discord-ci runs
    ↓ (cd apps/delulu_discord)
    ↓ uv sync --extra dev
    ↓ uv run ruff check .
    ↓ uv run ruff format --check .
    ↓ uv run pytest
  ↓ delulu-sandbox-modal-ci skipped (no sandbox changes)
  ↓ pr-title.yml: pr-title-lint runs (separate workflow, all PRs)
  ↓ CD jobs skipped (pull_request event, not push)

# MERGE — branch protection decides
merge → main push → same workflow fires
  ↓ CI jobs run against the merge commit
  ↓ delulu-sandbox-modal-deploy skipped (sandbox_runtime filter says no)
  ↓ delulu-discord-deploy runs → SSH droplet → rebuild → restart
```

Four layers, same file, each with its own scope and its own config
resolution rules.

## Practical rules of thumb

1. **Install pre-commit once per clone:** `uvx pre-commit install`.
   This installs both the file hooks and the commit-msg hook
   (`default_install_hook_types`). Without it, none of the local
   checks run — the config is dead config. Clones that installed
   before the commit-msg hook existed need to run it again.
2. **Keep tool versions aligned across layers.** When bumping ruff
   in an app's `pyproject.toml`, bump `.pre-commit-config.yaml` in
   the same commit.
3. **Run locally what CI runs.** `cd apps/X && make check && make test`
   is the same four commands CI runs. Use it before pushing to avoid
   the CI-caught-it-first feedback loop.
4. **Don't put cross-app imports between `apps/delulu_discord/` and
   `apps/delulu_sandbox_modal/`.** They're independent Python
   projects, they can't import each other. Data crossing the
   boundary crosses via Modal function calls (runtime) or via a
   shared schema (design). If you need genuinely shared code, the
   right move is a third `apps/delulu_shared/` package that both
   depend on, not cross-reaching.
5. **There is no root `pyproject.toml`.** Every project (`apps/*`,
   `training/*`, …) owns its own. Don't run `uv sync` at the repo root
   and expect any app to work — `cd` into the project first.
6. **Per-app Makefiles are the source of truth** for "how do I
   check/test/build/deploy this app". The top-level `Makefile` is
   just a thin dispatcher that calls them.

## When this model breaks down

- **Genuinely cross-app refactors** (rare today — we've stayed
  strictly split). The fix is usually a shared package, not
  sidestepping the boundary.
- **Root-level CI checks that need to see multiple apps at once**
  (e.g. a license-header check, a cross-reference link checker).
  Add them as a separate job that doesn't `cd` into any app, and
  write them to be app-aware manually.
- **Shared tool versions drift silently.** The drift trap from
  "pre-commit in this monorepo" above. Catch it by occasionally
  running `grep -rn "ruff>=" apps/*/pyproject.toml training/*/pyproject.toml .pre-commit-config.yaml`
  and checking they agree. Not automated today.

## Related docs

- [`README.md`](../README.md) — the public-facing project landing page
- [`CLAUDE.md`](../CLAUDE.md) — repo-level instructions for AI assistants
- [`docs/prd/`](prd/) — repo-wide plan docs (per-app plans live under [`apps/delulu_discord/prd/`](../apps/delulu_discord/prd/) and [`apps/delulu_sandbox_modal/prd/`](../apps/delulu_sandbox_modal/prd/))
- [`docs/architecture.md`](architecture.md), [`docs/development.md`](development.md) — archived LoRA-era docs
