# PRD index

Product-requirements docs for SMILE-factory. A PRD is a **plan**, not a spec of
shipped behavior — see each file's `**Status:**` header for where it actually
stands in the code. Cross-cutting PRDs live here under `docs/prd/`; app-specific
ones live under `apps/<app>/prd/`.

**Status vocabulary:** `not-started` (plan written, no code) · `in-progress` ·
`complete` (intended work landed; explicitly deferred options remain parked) ·
`v1-shipped · v2-parked` (core landed, extensions deferred) · `parked`
(deliberately deferred, has trigger conditions) · `bug-open` (defect tracker,
fix not yet applied) · `shipped` (fully landed — delete the PRD per the
delete-on-ship convention, e.g. the removed `streaming.md`).

> Reminder: a merged `prd:`-titled PR ships the **document**, not the
> implementation. Don't infer a feature is done from a merged PRD.

## Cross-cutting (`prd/`)

| PRD | Status | Scope |
|---|---|---|
| [monorepo-reorg.md](monorepo-reorg.md) | `complete` | Waves 0–5 and 7 landed; optional Wave 6 is deferred until a third delulu app exists. |
| [deep-research-training-eval-infra.md](deep-research-training-eval-infra.md) | `in-progress` | Training + eval infra for a deep-research agent: shared `libs/dr_agent`, `services/search_server`, `data/datagen`, `eval/`, slime RL recipe. Scaffold + reward registry landed; loops/backends are stubs. |
| [codex-ci-auth.md](codex-ci-auth.md) | `v1-shipped · v2-parked` | Codex CLI auth in CI via ChatGPT `auth.json` (not `OPENAI_API_KEY`). Core landed; API-key fallback + multi-identity parked. |
| [claude-action-install-flake.md](claude-action-install-flake.md) | `not-started` | Work around `claude-code-action` native installer reporting success while the binary is absent. |
| [code-review-skip-approve.md](code-review-skip-approve.md) | `shipped` | The code-review bot **approves** on the doc-only skip path instead of leaving a non-approving comment. Live in `.claude/commands/review-pr.md`; delete candidate. |
| [code-review-stale-context.md](code-review-stale-context.md) | `not-started` | Make the reviewer read context files from PR head, not base, to stop hallucinated findings. |

## delulu_discord (`apps/delulu_discord/prd/`)

| PRD | Status | Scope |
|---|---|---|
| [repo-provisioning.md](../../apps/delulu_discord/prd/repo-provisioning.md) | `v1-shipped · v2-parked` | **Anchor feature.** `/setrepo`, allowlist + admin cmds, bare-cache + worktree, `max_containers=1`, `/commit` push. v1 core shipped; large v2 list (per-repo Dict coordination, `/refresh`, workspace GC, auto-PR, GitHub App identity) parked. |
| [private-repos.md](../../apps/delulu_discord/prd/private-repos.md) | `v1-shipped · v2-parked` | Extends repo-provisioning to private repos (PAT clone/fetch, `🔒` subtitle, PAT-gated admin). v1 shipped (#72); multi-identity / per-user PATs / SSH / non-GitHub hosts parked. |
| [cancel-run.md](../../apps/delulu_discord/prd/cancel-run.md) | `not-started` | Cancel an in-flight dispatch from Discord (button → `task.cancel()`, no volume commit on cancel, self-only auth). |
| [setrepo-persistence-bug.md](../../apps/delulu_discord/prd/setrepo-persistence-bug.md) | `bug-open` | `/setrepo` binding lost after bot restart — `modal.Dict` `.aio` put-path may silently drop writes. |

## delulu_sandbox_modal (`apps/delulu_sandbox_modal/prd/`)

| PRD | Status | Scope |
|---|---|---|
| [commit-marker-and-smoke-test-bugs.md](../../apps/delulu_sandbox_modal/prd/commit-marker-and-smoke-test-bugs.md) | `bug-open` | Two bugs: `.commit-branch` marker leaks into commits; smoke test accepts `error` events as success. |
| [sandbox-non-root-user.md](../../apps/delulu_sandbox_modal/prd/sandbox-non-root-user.md) | `parked` | Run the Modal sandbox as a non-root user (security hardening). Followup to #53/#54; parked with explicit triggers. |

## Big-ticket items

Ranked by size × impact:

1. **Repo provisioning** (`repo-provisioning.md`) — XL, v1 shipped, hardening pending. The anchor feature spanning both delulu apps.
2. **Monorepo reorg** (`monorepo-reorg.md`) — XL, complete; optional app-grouping wave parked.
3. **Private GitHub repo support** (`private-repos.md`) — L, v1 shipped, v2 parked.
4. **Cancel in-flight runs** (`cancel-run.md`) — M, not started.
5. **Codex auth via ChatGPT account** (`codex-ci-auth.md`) — M, core shipped, v2 parked.
6. **Sandbox as non-root user** (`sandbox-non-root-user.md`) — M, parked.

Plus a cluster of small (S) bug fixes: `setrepo-persistence-bug`, `commit-marker-and-smoke-test-bugs`, and two open CI-review-reliability fixes (`code-review-stale-context`, `claude-action-install-flake`). A third, `code-review-skip-approve`, has shipped.

## Notes & known cross-refs

- `private-repos.md` and `repo-provisioning.md` are a **v1 → v1.5 pair** and share an
  identity-model decision (single shared PAT; *no* per-user PATs in a `modal.Dict`).
  The canonical statement lives in `repo-provisioning.md` §"Scope: single user / single team".
- The `RepoAllowlist` storage schema change in `private-repos.md` must land **after**
  the persistence fix in `setrepo-persistence-bug.md`, or the new `visibility` marker
  inherits the same silent-drop bug.
- The code-review plugin was retired; the auto-reviewer now runs `/review-pr`
  (`.claude/commands/review-pr.md`) from the PR checkout in `claude-code-review.yml`,
  so the old "plugin loaded from `main`, not the PR branch" self-validation caveat no
  longer applies. `code-review-skip-approve` shipped; `code-review-stale-context` is the
  one remaining open reviewer PRD.
- The streaming-renderer PRD was shipped and deleted (delete-on-ship convention); any
  lingering reference to `streaming.md` points at that now-removed doc.
