# Codex CLI auth in CI/CD via ChatGPT account

**Status:** v1-shipped · v2-parked

Plan to authenticate the Codex CLI inside this repo's GitHub Actions
workflows using a ChatGPT account session (`auth.json`) rather than an
`OPENAI_API_KEY`. The motivation is cost: usage on a ChatGPT
subscription is included in the plan, while API-key calls are metered
per-token.

This is a *plan*, not a spec of implemented behavior. Nothing in this
document has been executed yet.

## Relationship to PR #61

PR [#61](https://github.com/leehanchung/SMILE-factory/pull/61) (`ci:
add Codex reviewer and migrate Claude review to subagent
architecture`) introduces the **first concrete CI consumer of
Codex** in this repo: a new `.github/workflows/codex-code-review.yml`
that runs `openai/codex-action@v1` to post APPROVE/COMMENT reviews
on every PR. That workflow is wired today for **API-key auth**:

```yaml
- uses: openai/codex-action@v1
  with:
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
    prompt: |
      ...
```

This PRD scopes the swap of that auth path from `OPENAI_API_KEY` to
a ChatGPT-account `auth.json`. Concretely:

- **Resolves Q1.** The first (and currently only) Codex CI consumer
  is PR #61's workflow. No need to invent a use case.
- **Sequencing.** Two reasonable orders:
  1. Land #61 as-is (API-key) → follow up with a swap PR per this
     plan. Lower risk to #61's review feature shipping.
  2. Block #61 on this swap and ship account auth from day one.
     Cheaper if Q4 below resolves cleanly.
  Default: **(1)** — don't hold up the reviewer feature on auth
  arbitrage.
- **Surfaces Q4** (new): does `openai/codex-action@v1` actually
  support running without an `openai-api-key` if `auth.json` is
  seeded into its `codex-home` input directory? See open questions.

## Context / problem

We want to run `codex` from CI (first concrete use case is the
Codex PR review workflow added in PR #61 — see "Relationship to PR
#61" above). Two auth paths exist:

1. **API key** (`OPENAI_API_KEY`). Standard pattern, trivially seeded
   into `secrets.OPENAI_API_KEY`. Billed per-token against the API
   account.
2. **ChatGPT account session** (`auth.json` produced by `codex login`).
   Usage counts against the user's ChatGPT plan instead of API
   billing. The OpenAI docs describe this path as "use this guide
   only if you specifically need to run the workflow as your Codex
   account" — i.e. it's the non-default route, but it's the right one
   for cost reasons here.

This PRD covers path (2). API-key fallback is intentionally out of
scope.

## Goals / non-goals

**Goals**
- Authenticate `openai/codex-action@v1` (the action introduced in
  PR #61's `.github/workflows/codex-code-review.yml`) using a
  ChatGPT-account `auth.json` instead of `OPENAI_API_KEY`. Keep the
  pattern reusable for any future Codex job in this repo.
- Survive the ChatGPT session refresh cycle (~8-day token rotation,
  per OpenAI docs) without manual reseeding on every run.
- Operational hygiene: `auth.json` mode `600`, `$CODEX_HOME` mode
  `700`, never logged, never committed.
- Single source of truth for the auth file — no concurrent jobs racing
  on the same `auth.json`.

**Non-goals**
- Replacing the existing droplet/Modal deploy paths.
- Adding Codex usage to any specific feature. This PRD lands the
  *capability*; the first real use case ships in its own PR.
- Supporting both API-key and account auth in parallel. Pick one.
- Self-hosted runners. The plan stays on `ubuntu-latest`.

## Open questions (must resolve before implementation)

| Q | Question | Blocks | Default if unanswered |
|---|---|---|---|
| ~~Q1~~ | ~~What is the first concrete CI job that calls `codex`?~~ | — | **Resolved:** PR #61's `codex-code-review.yml`. |
| Q2 | Where do we persist the refreshed `auth.json` between ephemeral runs? | Approach — see "Persistence options" below | Option A (droplet stash) — infra already exists |
| Q3 | Do we accept the rate-limit coupling between CI and interactive ChatGPT use? | Risk acceptance | yes — flag in PRD, revisit if it bites |
| Q4 | Does `openai/codex-action@v1` actually skip its API-key requirement when `auth.json` is present in the directory passed via `codex-home`? Docs only mention API-key auth, but the action exposes `codex-home` and wraps the `codex` CLI (which itself supports `auth.json`). | Approach — picks Path A (wrap the action) vs. Path B (replace with bare `codex exec`) | Smoke test: run the action with a seeded `codex-home` and no `openai-api-key`; if it errors, fall back to Path B |

## Approach

Per the OpenAI CI/CD auth guide, the lifecycle is:

1. Run `codex login` once on a trusted local machine. This writes
   `~/.codex/auth.json` (OAuth bundle).
2. Store that file as a GitHub repo secret (`CODEX_AUTH_JSON`,
   contents pasted verbatim — it's already JSON).
3. On each CI run: write the secret to a `CODEX_HOME` directory
   with mode `600`, run Codex, then **persist the refreshed file
   back** to whichever store we picked (Q2). Codex auto-refreshes
   tokens older than ~8 days and on `401` retries; if we don't
   persist the refresh, the seeded copy goes stale and one day
   stops working mid-run.
4. If refresh ever fails (manual reseed): rerun `codex login`
   locally, replace the stored copy.

How step 3 wires into PR #61's workflow forks on Q4.

### Path A — `codex-action` accepts seeded `auth.json` (Q4 = yes)

Wrap the existing `openai/codex-action@v1` step with restore/persist
steps and drop `openai-api-key`. The action's `codex-home` input
points at the directory we just seeded. Smallest possible diff
against PR #61.

```yaml
- name: Restore auth.json
  env:
    CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}
  run: |
    set +x
    mkdir -p "$RUNNER_TEMP/codex-home" && chmod 700 "$RUNNER_TEMP/codex-home"
    printf '%s' "$CODEX_AUTH_JSON" > "$RUNNER_TEMP/codex-home/auth.json"
    chmod 600 "$RUNNER_TEMP/codex-home/auth.json"

- uses: openai/codex-action@v1
  id: run_codex
  with:
    codex-home: ${{ runner.temp }}/codex-home
    # openai-api-key intentionally omitted — auth.json drives auth
    prompt: |
      ...

- name: Persist refreshed auth.json
  if: always()
  run: |
    set +x
    # Q2-dependent — see "Persistence options" below
```

### Path B — `codex-action` requires API-key (Q4 = no)

Replace the action with a direct `codex exec` step. We lose the
action's review-submission glue, but PR #61's existing flow already
parses Codex's `final-message` and posts via `gh api`, so the loss
is recoverable by reusing that submit step.

```yaml
- name: Install codex
  run: npm i -g @openai/codex@<pin>

- name: Restore auth.json
  env:
    CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}
  run: |
    set +x
    export CODEX_HOME="$HOME/.codex"
    mkdir -p "$CODEX_HOME" && chmod 700 "$CODEX_HOME"
    printf '%s' "$CODEX_AUTH_JSON" > "$CODEX_HOME/auth.json"
    chmod 600 "$CODEX_HOME/auth.json"

- name: Run codex
  id: run_codex
  run: |
    codex exec --json "..." > "$RUNNER_TEMP/codex-out.json"

- name: Submit review
  # reuse PR #61's existing submit-review step, fed from codex-out.json

- name: Persist refreshed auth.json
  if: always()
  run: |
    set +x
    # Q2-dependent — see "Persistence options" below
```

Both paths share the seeding, persistence, and operational rules
below; only the middle (action vs. CLI) changes.

### Concurrency interaction with PR #61

PR #61's workflow already declares
`concurrency: { group: codex-review-${{ pr.number }},
cancel-in-progress: true }`, which is per-PR and cancels older runs
when a new push lands — good for cost.

The OpenAI doc requires "one `auth.json` per runner or serialized
workflow stream", which is **at odds with parallel per-PR runs**:
two PRs reviewed at the same time would each refresh and race on
write-back. Two ways to resolve:

1. **Add a second serialization layer at the auth step.** A file
   lock on the persisted `auth.json` location (Option A on the
   droplet → `flock`; Option C in GH Secrets → naturally serialized
   by API, but with the PAT downsides). Per-PR cancellation stays.
2. **Accept the race.** Concurrent refreshes both succeed against
   OpenAI; the last write-back wins. The "lost" refresh is harmless
   because the discarded token is also valid for the next ~8 days
   — the *next* run will just refresh again. Document and revisit
   only if it bites.

Default: **(2)** until it bites. The overhead of (1) is high for a
risk that self-heals.

## Persistence options (Q2)

Three candidates, ranked by cost-to-implement against this repo:

### Option A — Stash on the droplet (recommended default)

The `delulu-discord-deploy` job already SSHes into a DigitalOcean
droplet via `appleboy/ssh-action` with `secrets.DROPLET_SSH_KEY`.
That host has stable disk and is already trusted for deploy
credentials.

- **Restore:** `scp` (or inline cat over SSH) `auth.json` from
  `/root/.codex-ci/auth.json` on the droplet onto the runner.
- **Persist:** `scp` the refreshed file back after the run.
- **Bootstrap:** first-run seed comes from `secrets.CODEX_AUTH_JSON`
  if the droplet copy is missing.

Pros: no new dependency; same trust boundary as the existing CD path.
Cons: the droplet becomes the source of truth for an OAuth token; if
the droplet is rebuilt, reseed from the secret.

### Option B — External secret manager

1Password CLI, Doppler, AWS Secrets Manager, etc. Workflow reads on
entry, writes on exit.

Pros: cleanest separation; rotation/audit out of the box.
Cons: new infra and a new secret to manage. Overkill for a one-user
repo.

### Option C — Rewrite the GitHub secret via PAT

`gh secret set CODEX_AUTH_JSON --body @auth.json` from inside the run,
authed with a fine-scoped PAT (or a GitHub App) that has
`secrets: write`.

Pros: no external state; everything stays in GitHub.
Cons: requires a long-lived PAT with secret-write scope, which is a
notably higher-blast-radius credential than the OAuth bundle it's
protecting. Probably not worth it.

**Default if Q2 unanswered:** Option A.

## Operational rules (from the OpenAI docs)

- One `auth.json` per workflow stream — see "Concurrency interaction
  with PR #61" above for how this lands against per-PR review jobs.
- `auth.json` mode `600`; `$CODEX_HOME` mode `700`.
- Never `cat` `auth.json` to logs; never commit it; never include it
  in artifacts.
- On `401` failures or refresh errors, rerun `codex login` locally
  and overwrite the stored copy. Don't try to debug expired tokens
  from CI logs.

## Risks

- **Rate-limit coupling.** ChatGPT plans have usage limits. A noisy
  CI loop could degrade the owner's interactive ChatGPT experience or
  trip plan limits. Mitigation: gate the Codex job tightly (specific
  paths, `workflow_dispatch`, or scheduled with a low cadence) and
  monitor first uses before scaling up.
- **Token drift on ephemeral runners.** If persistence (Q2) silently
  fails, the stored `auth.json` ages out and the next run breaks at
  some unpredictable future date. Mitigation: the persist step is
  `if: always()` and any non-zero exit must fail the job loudly, not
  just warn.
- **Concurrency races.** Two simultaneous Codex jobs writing back
  different refreshed tokens race on the persistence store. PR
  #61's per-PR `concurrency.group` does *not* serialize across PRs.
  Mitigation: see "Concurrency interaction with PR #61" — default
  is to accept the race because the discarded token is still valid
  for the next ~8 days; lock the persistence store only if it
  bites.
- **Secret leakage via shell expansion.** `printf '%s' "$VAR"` is
  safe; `echo $VAR` and herestring patterns can mangle JSON or leak
  via `set -x`. Mitigation: explicit `set +x` around auth handling
  and a review checklist when this lands.
- **TOS posture.** Using a ChatGPT account session for automated CI
  is what the OpenAI doc explicitly enables, so this is sanctioned —
  but it's worth re-reading the ChatGPT plan terms once before
  scaling beyond the first use case.

## Out of scope — explicit parks

- **API-key fallback path.** Not building both. If account auth
  proves operationally painful, that's a future PRD.
- **Multiple Codex identities.** One account, one `auth.json`.
- **Self-hosted runner pattern.** The OpenAI doc covers this; we
  don't need it.

## Effort estimate

- **Q4 smoke test** (run `openai/codex-action` against a seeded
  `codex-home` with no `openai-api-key` and observe whether it
  errors): ~30 min on a throwaway PR or `workflow_dispatch`.
- **Implementation** (Path A or B against PR #61's workflow, plus
  Q2 persistence wiring): ~1 evening once Q4 is resolved.
- Sequencing default: land PR #61 first (API-key), follow up with
  the swap PR per this plan.

## Sources / attributions

- **OpenAI Codex docs — "Authenticating Codex CLI in CI/CD
  pipelines":** <https://developers.openai.com/codex/auth/ci-cd-auth>.
  Source for: the `auth.json` / `CODEX_HOME` mechanism, the ~8-day
  refresh window, the `401`-triggered refresh-and-retry path, file
  mode requirements (`600` / `700`), the explicit guidance that this
  path is for running as your Codex account rather than the default
  API-key flow, and the "one auth.json per runner / serialized
  workflow stream" rule. Workflow snippets in this PRD are adapted
  from the ephemeral-runner pattern in that doc.
- **Repo-local context:**
  - PR [#61](https://github.com/leehanchung/SMILE-factory/pull/61)
    introduces `.github/workflows/codex-code-review.yml`. That file
    is the concrete target of this PRD's auth swap.
  - Existing droplet SSH path (`appleboy/ssh-action` step in
    `.github/workflows/delulu-deploy.yaml`), which Option A reuses.
- **`openai/codex-action` documented inputs:**
  <https://github.com/openai/codex-action> — confirms `codex-home`
  is exposed as an input but documents only API-key auth. Q4 above
  exists because the action wraps the `codex` CLI, which itself
  reads `auth.json` from `CODEX_HOME` per the OpenAI CI/CD auth
  guide; whether the wrapper bypasses its own API-key check when
  `auth.json` is present is undocumented.
