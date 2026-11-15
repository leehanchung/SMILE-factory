# Monorepo reorganization

**Status:** complete — waves 0–5 and 7 done; optional Wave 6 deferred

Plan to reshape the repo root from its two-era layout (LoRA-Instruct
files scattered at root + tidy `apps/` tree for delulu) into a
category-first monorepo structure that scales to many projects.

This was a *plan*; it is now essentially complete. Waves 0–5 and 7 are
done (see the per-wave notes and summary table below). The optional Wave 6
(`apps/delulu/` grouping) is deliberately deferred — see Q5.

## Context / problem

The root is two eras mashed together:

**LoRA-Instruct era** (still at repo root): `finetune.py`, `utils/`,
`templates/`, `dataset/`, `inference/`, `notebook/`, `poetry.lock`,
`pyproject.toml`, `tox.ini`.

**Delulu era** (already tidy under `apps/`): `apps/delulu_discord`,
`apps/delulu_sandbox_modal`.

**Unclassified**: `scripts/` (job scraping), `infra/managed-agents/`
(substantial — has its own pyproject, Dockerfile, deploy dir, and
harnesses; likely a third project, not a wrapper), `Research/` (empty),
`docs/`, `prd/`.

**Vestigial**: root `uv.lock` (52 bytes, just metadata header — orphan
from the dissolved `infra/discord-orchestrator/` wrapper), `tox.ini`
(py310/flake8 legacy; current toolchain is poetry + ruff for LoRA and uv
+ ruff for apps).

Three concrete pain points:

1. **The root README and `CLAUDE.md` one-liner still describe the repo
   as "LoRA-Instruct: LoRA fine-tuning".** The active work is the
   delulu Discord orchestrator and the intended future work is a
   category-first monorepo hosting many projects. The one-liner is a
   lie of omission.
2. **No home for growth.** Future LLM training projects, eval
   harnesses, shared libraries, and non-notebook research writeups
   have nowhere obvious to land. Each new project would have to invent
   its own layout.
3. **No agent guidance for multi-project work.** Claude Code (and
   humans) default to repo-root thinking, but most tasks are scoped to
   one project and should operate from that project's directory with
   its own deps, lockfile, and Makefile.

## Goals / non-goals

**Goals**
- A category-first layout at the root that has explicit homes for
  production services, training projects, shared data, shared evals,
  research writeups, shared infra, and shared libraries.
- Each project is self-contained (own deps, own lockfile, own Makefile,
  own `CLAUDE.md`) so it can be worked on from its own directory
  without repo-root tooling.
- Agent guidance baked into `CLAUDE.md` so future Claude Code sessions
  default to project-scoped work (cwd, search scope, PR boundaries).
- Every move happens as its own PR through the conventional-commits
  workflow — no big-bang reorg.
- No operational downtime for delulu during the migration.

**Non-goals**
- Rewriting any LoRA-Instruct code. Moves only.
- Introducing a uv workspace or poetry workspace. Each project stays
  independent.
- Adding cross-project shared code today. `libs/` gets a slot but
  starts empty.
- Extracting LoRA-Instruct or delulu into separate repos. The whole
  point is a monorepo.

## Target layout

```
apps/              # production services
  delulu/            # grouped by app name, not deployable
    discord/           ← apps/delulu_discord
    sandbox_modal/     ← apps/delulu_sandbox_modal
  <future-app>/

training/          # reusable training/SFT/RLHF recipes — each self-contained
  lora_instruct/
    finetune.py
    utils/
    templates/
    dataset/
    inference/
    notebook/
    evals/             # recipe-specific benchmarks
    pyproject.toml     # recipe-owned deps
    CLAUDE.md
    README.md
  <future-recipe>/

projects/          # research projects that produce experiment-shaped artifacts
  <future-project>/    # models, datasets, reports — investigations, not harnesses

data/              # cross-project datasets + scrapers only
  scrapers/          ← scripts/job_postings (if general-purpose)
  shared/              # datasets reused by 2+ projects

evals/             # cross-project eval harnesses + benchmarks
  harnesses/
  runs/                # output artifacts

research/          # long-form writeups, notes, exploratory scripts
  <topic>/             # one dir per investigation
                       # minimal notebook usage — markdown + small scripts

infra/             # shared infra (TBD: managed-agents classification)

libs/              # cross-project Python packages — empty slot, ready

docs/ prd/ .github/ CLAUDE.md README.md ARCHITECTURE.md
```

### Rule of thumb: `apps/` vs `training/` vs `projects/`

- **`apps/`** = runs as a production service with users hitting it.
  Deployables.
- **`training/`** = reusable training/SFT/RLHF recipes —
  parameterized harnesses you *run*, not experiments you *investigate*.
  Each recipe is self-contained with its own deps and entrypoints.
- **`projects/`** = research projects that produce experiment-shaped
  *artifacts* (models, datasets, reports). Investigations with a
  beginning and an end, not services and not reusable harnesses.

## Agent working rules

Land in `CLAUDE.md` as a "Working in the monorepo" section before the
structural moves, so Claude Code sessions during the migration already
know the target shape. Key rules:

- Identify the project before touching anything.
- Work from the project root, not the repo root — `cd` in or
  `make -C <path>`.
- Default `Grep`/`Glob` to the project dir; broaden only for
  genuinely cross-cutting work.
- No imports between projects. Shared code goes in `libs/` via a
  separate PR.
- One PR per project. Cross-cutting files (`.github/`, root docs,
  `prd/`, `.pre-commit-config.yaml`) can ship as their own PR.
- Per-project `CLAUDE.md` wins over root for project-specific
  commands and conventions.

## Open questions (blockers for specific waves)

| Q | Question | Blocks | Default if unanswered |
|---|---|---|---|
| Q1 | What is `infra/managed-agents/`? App, infra, or project? | Wave 5 | ✅ answered: infra — a self-deployed Firecracker/k8s agent platform, not wired into this repo's CI/CD. Stays in `infra/`. |
| Q2 | Is `scripts/job_postings` LoRA-owned or general? | Wave 4 | ✅ answered: general (AI-trainer job scrapers, unrelated to LoRA) → `data/scrapers/` |
| Q3 | Is LoRA-Instruct active or archived? | Wave 3 | ✅ answered: active → `training/lora_instruct/` |
| Q4 | Does LoRA get its own `pyproject.toml`? | Wave 3 | ✅ answered: yes (matches `apps/` pattern) |
| Q5 | Regroup `apps/delulu_*` into `apps/delulu/{discord,sandbox_modal}/`? | Wave 6 | ✅ answered: **defer**. Only two delulu apps today; the grouping mainly pays off at more apps, and it's the one change that rewires the bot's deploy path-filters. Risk > benefit now — revisit when a third delulu app lands. |

## Wave-by-wave plan

Each wave ships as its own PR (or small set). Waves are ordered by
dependency and risk — cheapest and safest first, operational risk last.

### Wave 0 — land what's already in flight

Not new work; gates everything downstream.

- **PR #20** (`ci: enforce conventional-commit PR titles`) merges.
- **PR #21** (`docs: update PRDs and add git workflow to CLAUDE.md`) merges.
- After #20 runs cleanly on a real PR, add `PR title / lint` to the
  required status checks on `main` via `gh api`.

### Wave 1 — cheap cleanups (no structural moves)

**Status: ✅ shipped.** Root `uv.lock` (orphan) and `tox.ini` (legacy)
deleted; the stale `tox.ini` mention in `docs/development.md` removed. The
`CLAUDE.md` and `README.md` monorepo-identity one-liners were already in
place. The `Research/`/`research/` dir is untracked + empty, so there is
nothing for git to delete.

All safe, all reversible, no path dependencies. Two PRs:

- **PR** — `chore: remove vestigial root files`
  - Delete root `uv.lock` (orphan from dissolved wrapper).
  - Delete `tox.ini` (py310/flake8 legacy).
  - Delete empty `Research/` directory.
  - *No effect on any project.*

- **PR** — `docs: update CLAUDE.md for monorepo identity`
  - Replace the "LoRA-Instruct: LoRA fine-tuning..." one-liner with a
    monorepo description.
  - *Standalone, doesn't depend on any moves.*

### Wave 2 — declare the target layout

**Status: ✅ shipped.** The "Working in the monorepo" section is in root
`CLAUDE.md`. The reorg being essentially complete, it was added without the
temporary "*reorg in progress*" caveat (which Wave 7 would only remove).

- **PR** — `docs: add monorepo working rules to CLAUDE.md`
  - Add the "Working in the monorepo" section to root `CLAUDE.md`.
  - Include a "*reorg in progress — not all directories exist yet*"
    note, removed in Wave 7.
  - No file moves, no stub directories.

Lands before structural moves so the agent rules are authoritative
during the migration window.

### Wave 3 — LoRA-Instruct into `training/`

**Status: shipped in PR <number-tbd>.** Destination changed from the
original plan (`projects/lora_instruct/`) to `training/lora_instruct/`
because LoRA-Instruct is a reusable training recipe, not a research
project. Q3 answered ✅ active; Q4 answered ✅ own pyproject. Body
preserved below for historical record.

- **PR** — `refactor: move LoRA-Instruct under training/lora_instruct`
  - `git mv finetune.py training/lora_instruct/finetune.py`
  - `git mv utils/ training/lora_instruct/utils/`
  - `git mv templates/ training/lora_instruct/templates/`
  - `git mv dataset/ training/lora_instruct/dataset/`
  - `git mv inference/ training/lora_instruct/inference/`
  - `git mv notebook/ training/lora_instruct/notebook/`
  - Move root `pyproject.toml` + `poetry.lock` →
    `training/lora_instruct/`.
  - Add `training/lora_instruct/CLAUDE.md` (recipe-scoped Quick
    Reference).
  - Add `training/lora_instruct/README.md` (split from root README's
    LoRA section).
  - Update imports: `from utils.X` → rooted in the new package layout.
    Simplest approach: make `training/lora_instruct/` the package root
    with `src/lora_instruct/` inside, or declare the recipe as a
    package in `pyproject.toml`.
  - Update `.pre-commit-config.yaml` if it references any moved paths.
  - Delete any LoRA-related targets from the root `Makefile`.
  - **Verification:** from `training/lora_instruct/`, `poetry install`
    + `poetry run ruff check .` pass. `python finetune.py --help`
    prints.

*High file-count, low runtime risk — LoRA isn't deployed from this
repo.*

### Wave 4 — data scrapers

**Status: ✅ shipped.** Q2 answered: the scrapers are general-purpose
job-posting scrapers (AI-trainer / annotation roles), not LoRA code.
`scripts/{scrape_ai_trainer_jobs,job_data}.py` moved to `data/scrapers/`;
the gitignore entry updated to `data/scrapers/job_postings/`; empty
`scripts/` removed.

Original plan (now executed):

- **PR** — `refactor: move job scrapers under data/scrapers`
  - `git mv scripts/job_postings/ data/scrapers/job_postings/`
  - `git mv scripts/scrape_ai_trainer_jobs.py data/scrapers/`
  - `git mv scripts/job_data.py data/scrapers/`
  - If `scripts/` is now empty, delete it.

### Wave 5 — `infra/managed-agents/` classification

**Status: ✅ resolved — stays put.** Q1 answered: `infra/managed-agents/`
is a self-contained managed-agents platform (Firecracker microVMs, its own
k8s/Helm control plane, Dockerfiles, harnesses) that deploys via its own
tooling and is **not referenced by this repo's CI, Makefile, or
pre-commit**. It is infra, not an app of this monorepo, and moving it earns
nothing while risking its self-deploy wiring. Left in place. The optional
hyphen→underscore rename is also unnecessary — it uses a `src/` layout and
isn't imported by directory name.

Original branches (not taken):

- **If app:** `refactor: move managed-agents to apps/` — add its own
  `CLAUDE.md`, verify deploy wiring still works.
- **If infra:** `refactor: tidy infra/managed_agents structure` —
  likely just rename the hyphen to underscore for import-friendliness
  and stop; it stays put.
- **If project:** `refactor: move managed-agents to projects/` — add
  its own `CLAUDE.md`.

Investigate the directory's Dockerfile, deploy scripts, and harnesses
before committing to a branch. The Dockerfile + deploy dir imply it's a
real deployable, leaning app.

### Wave 6 — `apps/delulu/` grouping layer

**Status: ⏸ deferred (Q5 = defer).** Optional, and the only wave that
rewires the bot's production deploy path-filters. With just two delulu
apps the grouping buys little; revisit when a third app lands. If taken
later, it's the full plan below — done as its own PR with the path-filter
verification step.

Higher-risk PR: touches workflows, Dockerfile contexts, PRDs, pre-commit
config. This is the only wave with real operational risk — deploys are
driven by path filters.

- **PR** — `refactor: group delulu apps under apps/delulu/`
  - `git mv apps/delulu_discord apps/delulu/discord`
  - `git mv apps/delulu_sandbox_modal apps/delulu/sandbox_modal`
  - Update `.github/workflows/delulu-deploy.yaml` path filters
    (`apps/delulu_*/**` → `apps/delulu/**`).
  - Update `.github/workflows/claude-review.yml` prompt — it mentions
    `apps/delulu_discord` and `apps/delulu_sandbox_modal` in two places.
  - Update the droplet deploy path in README / workflow
    (`/root/SMILE-factory/apps/delulu_discord` →
    `/root/SMILE-factory/apps/delulu/discord`).
  - Update remaining root `prd/` path references.
  - Per-app PRDs under `apps/<app>/prd/` (e.g.
    `apps/delulu_discord/prd/`, `apps/delulu_sandbox_modal/prd/`)
    move with their app during the regrouping —
    `apps/delulu/discord/prd/`, `apps/delulu/sandbox_modal/prd/`.
  - Update `.pre-commit-config.yaml` if it has `apps/delulu_*` globs.
  - Update the top-level dispatching `Makefile`.

- **Verification:** open a trivial PR that touches
  `apps/delulu/discord/README.md` and confirm the `delulu` workflow
  picks up the change via the new path filter before merging the
  reorg PR itself.

### Wave 7 — per-project CLAUDE.md + root cleanup

**Status: ✅ shipped.** Added `apps/delulu_discord/CLAUDE.md` and
`apps/delulu_sandbox_modal/CLAUDE.md` (project-scoped commands + gotchas);
root `CLAUDE.md` Quick Reference now points at them. The Wave 2 rules were
added without a "reorg in progress" caveat, so there's none to remove. Done
at the current `apps/delulu_*` paths since Wave 6 is deferred; the files
git-mv with their app if Wave 6 is taken later. `ARCHITECTURE.md` already
references current paths (`apps/delulu_discord`, `training/lora_instruct`),
so no layout rewrite was needed.

- **PR** — `docs: add per-project CLAUDE.md files`
  - Add `apps/delulu/discord/CLAUDE.md` and
    `apps/delulu/sandbox_modal/CLAUDE.md` (project-scoped commands and
    gotchas).
  - Tighten root `CLAUDE.md` Quick Reference to point at per-project
    docs instead of listing LoRA commands.
  - Remove the "*reorg in progress*" note from the Wave 2 section.
  - Update `ARCHITECTURE.md` if it still describes the old layout.

## Summary table

| Wave | PRs | Blocked on | Operational risk | Status |
|---|---|---|---|---|
| 0 | #20, #21 merge | — | none | ✅ |
| 1 | 2 | — | none | ✅ |
| 2 | 1 | — | none | ✅ |
| 3 | 1 | — | none | ✅ |
| 4 | 1 | Q2 ✅ | none | ✅ |
| 5 | 1 | Q1 ✅ | low–medium | ✅ stays in `infra/` |
| 6 | 1 | Q5 (optional) | medium (deploys) | ⏸ deferred |
| 7 | 1 | waves 3–6 done | none | ✅ (at current `apps/delulu_*` paths) |

**Total: ~8 PRs** once Q1–Q5 are answered. Waves 1 and 2 can start
immediately — they don't depend on any open question.

## Risks and mitigations

- **Deploy breakage in Wave 6.** Path filters in
  `delulu-deploy.yaml` drive bot redeploys. If the filter doesn't
  match the new paths, either (a) no deploy fires on bot changes and
  the droplet drifts, or (b) every unrelated change fires a deploy.
  Mitigation: test the filter on a trivial PR on a branch before
  merging the reorg PR. Verification step is listed above.
- **Import rewrites in Wave 3.** LoRA code has `from utils.X` and
  `from templates.X` imports that assume root-level packages. Moving
  them under `projects/lora_instruct/` requires either declaring a
  package root in the new `pyproject.toml` or rewriting imports.
  Mitigation: do it as a package-root move (one `pyproject.toml`
  change, one `__init__.py` if missing), not a sweeping import
  rewrite.
- **Stranded references in PRDs and docs.** Root `prd/` docs,
  per-app PRDs, `ARCHITECTURE.md`, and `README.md` may reference
  `apps/delulu_discord` paths. Each affected wave's PR must grep for
  and update these references in the same commit.
- **`.pre-commit-config.yaml` path patterns.** Must update in lockstep
  with any move that changes which directories `ruff` runs against.
  Mitigation: run `pre-commit run --all-files` on each reorg PR.
- **`poetry.lock` vs `uv.lock`.** LoRA uses poetry, apps use uv. The
  reorg doesn't unify these and shouldn't — each project's choice is
  independent. Just make sure the move keeps each project's toolchain
  intact.

## Out of scope — explicit parks

- **Second training project.** Structure is ready for it; no
  speculative scaffolding.
- **Cross-project shared eval harness.** `evals/harnesses/` starts
  empty; first real shared harness drives the first commit.
- **`libs/` population.** Empty slot now; first cross-project shared
  module drives it.
- **Monorepo-wide CI aggregation.** Each project keeps its own CI
  paths. Revisit if test runs become painful to coordinate.
- **Workspace tooling (uv or poetry workspaces).** Considered for the
  app-separation refactor and rejected; same rejection applies here
  until there's real shared runtime code.

## Effort estimate

- Wave 1: ~30 min (two trivial PRs).
- Wave 2: ~30 min (one doc PR).
- Wave 3: 2–3 hours (file moves, import rewrites, pyproject split,
  verification).
- Wave 4: ~30 min (if standalone).
- Wave 5: 1–2 hours (depends on branch taken after investigation).
- Wave 6: 2–3 hours (high touch count across workflows, Dockerfiles,
  PRDs, Makefiles; plus dry-run verification).
- Wave 7: 1 hour (per-project CLAUDE.md files + root tidy).

Call it a full day of focused work spread across several sessions, so
each PR can run through CI and get eyeballed independently.
