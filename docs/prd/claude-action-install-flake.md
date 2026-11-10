# `Claude PR review` flakes when claude-code-action's native installer reports success but doesn't actually install

**Status:** not-started

Plan to address an intermittent `Claude PR review` CI failure where
`anthropics/claude-code-action@v1` prints `Claude Code successfully
installed!` but the SDK then dies on launch with `Claude Code native
binary not found at /home/runner/.local/bin/claude`. The installer
even flags the failure in its own setup notes — but exits 0 anyway,
so the flake only surfaces when the SDK tries to spawn the binary.

This is a *plan*, not a fix. Nothing in this document has been
executed yet.

## Symptom

Observed on PR
[#81](https://github.com/leehanchung/SMILE-factory/pull/81). The
`Claude PR review` job logs:

```
Checking installation status...
Installing Claude Code native build 2.1.129...
Setting up launcher and shell integration...
⚠ Setup notes:
  ● installMethod is native, but directory /home/runner/.local/bin does not exist
  ● installMethod is native, but claude command not found at /home/runner/.local/bin/claude

✔ Claude Code successfully installed!

  Version: 2.1.129
  Location: ~/.local/bin/claude
```

The installer reports success and prints a `Location:` line for a
binary that — by its own admission two lines earlier — doesn't
exist. The Anthropic SDK then immediately fails:

```
ReferenceError: Claude Code native binary not found at
/home/runner/.local/bin/claude. Please ensure Claude Code is
installed via native installer or specify a valid path with
options.pathToClaudeCodeExecutable.
Error: Process completed with exit code 1.
```

The job fails at the SDK launch, before any review work runs.
Hitting `Re-run failed jobs` on the same PR usually succeeds, which
matches the user's observation that "this doesn't show up all the
time."

## Hypothesis

The installer's "directory does not exist" warning is the smoking
gun: something on the runner prevents `~/.local/bin` from existing
or being writable when the native install runs, and the installer
silently fails at the binary-placement step while still printing the
success banner. Plausible causes (in rough order of likelihood):

1. **Race / ordering inside the action.** A parallel setup step
   (Bun bootstrap, plugin marketplace fetch) creates and then
   removes `~/.local/bin` between the installer's `mkdir` and its
   binary-write, and the binary-write silently no-ops.
2. **Runner image variance.** Different `ubuntu-latest` images may
   ship without `~/.local/bin` on `PATH` and without `~/.local`
   pre-created. A regression in `claude-code-action`'s installer
   between the `mkdir` and the actual write would surface only on
   images that don't pre-create `~/.local/`.
3. **Underlying installer bug**, version-specific. The errored job
   used `Claude Code native build 2.1.129`. If a prior version's
   installer was silent about this codepath and `2.1.129`
   regressed, the flake correlates with the action's runtime
   version detection.

The "Internal error: directory mismatch for directory ...
tsconfig.json" line later in the log is a separate red herring (it's
a known cosmetic warning from `claude-code-action`'s Bun launcher
and is documented as harmless in upstream issues), so we shouldn't
chase it.

## Why this matters

`Claude PR review` is a required status check on this repo's branch
protection. Every flake of this kind:

- Blocks the PR until someone notices and clicks `Re-run failed
  jobs`.
- Eats engineer attention triaging an opaque "binary not found"
  error that has nothing to do with the PR's code.
- Erodes trust in the bot reviewer — when checks flake without
  pattern, real failures get ignored too.

The frequency is "occasional, not most" runs, so we don't need to
gate every PR on a workaround — but we do need a way to make the
flake (a) recoverable without human intervention, or (b) at least
unambiguously diagnosable when it happens.

## Goals / non-goals

**Goals**

- Make the `Claude PR review` job recover automatically from this
  specific install flake without a human re-run.
- When recovery isn't possible (binary really can't be installed),
  fail with a message that distinguishes the install issue from a
  review-content issue, so triage doesn't go down rabbit holes.
- Capture this transcript in a form that an upstream issue against
  `anthropics/claude-code-action` can be filed from.

**Non-goals**

- Replacing `anthropics/claude-code-action@v1`. The action does
  more than install — OIDC token exchange, allowed-bots filtering,
  plugin loading. Re-implementing it is out of scope.
- Pinning to an older Claude Code version unless we can prove a
  specific version regresses. The `Version: 2.1.129` line is
  printed by the installer, not chosen by us.
- Fixing the installer itself. We don't own that code.

## Open questions

| Q | Question | Blocks | Default if unanswered |
|---|---|---|---|
| Q1 | Does `anthropics/claude-code-action@v1` accept a `pathToClaudeCodeExecutable` input that bypasses its own install? | Approach — option A vs option B | assume **no**; design for the wrapper-step approach |
| Q2 | How often does this flake fire? Once per ~N PR-runs? | Whether mitigation is "auto-retry" or "pre-install + assert" | order of magnitude unknown — go with the cheaper auto-retry first |
| Q3 | Is this reproducible by triggering an empty re-run on a known-flaked SHA, or only on fresh `pull_request` events? | Whether the flake is image-state or schedule-related | assume image-state — empty re-runs usually pass, suggesting a per-image initial-state issue |

## Approach

Three reinforcing options, ordered cheapest first. The first that's
sufficient should ship; the others are fallbacks.

### Option A — pre-install + assert before the action runs (recommended)

Add a step **before** `anthropics/claude-code-action@v1` that runs
the same native installer ourselves and verifies the binary is
present and executable. If absent, retry once. If still absent,
fail with a loud, specific message. Then call the action; it
detects the existing install and skips re-installing.

```yaml
- name: Pre-install Claude Code (workaround for action's flaky native install)
  shell: bash
  run: |
    set -euo pipefail
    install_and_verify() {
      curl -fsSL https://claude.ai/install.sh | bash
      [ -x "$HOME/.local/bin/claude" ]
    }
    install_and_verify || install_and_verify || {
      echo "::error::Claude Code native install failed twice. ~/.local/bin/claude is missing."
      ls -la "$HOME/.local/bin/" || true
      exit 1
    }
    "$HOME/.local/bin/claude" --version
- uses: anthropics/claude-code-action@v1
  with:
    ...
```

**Pros**

- Fixes the flake at source: by the time the action runs, the
  binary exists and the action's own install step is a no-op (or
  at worst a redundant re-install that succeeds against an
  already-populated `~/.local/bin`).
- Explicit `claude --version` smoke check makes the failure mode
  unambiguous when it happens.
- One-retry budget catches transient races without masking real
  install regressions.

**Cons**

- Couples our workflow to the upstream installer URL. If the
  install script's URL or shape changes, this breaks the same
  way the action would.
- Adds ~5–10 s to every `Claude PR review` run (one curl + one
  bash exec) even when the action would have installed cleanly.

### Option B — set `pathToClaudeCodeExecutable` if the action exposes it (Q1-dependent)

The error message itself suggests this: *"specify a valid path
with `options.pathToClaudeCodeExecutable`"*. If
`anthropics/claude-code-action@v1` accepts an input that maps to
that SDK option, we can pre-install and pass the path explicitly,
bypassing the action's broken install logic entirely.

This is strictly cleaner than option A *if* the input exists.
Inspect the action's `action.yml` to confirm. If absent, fall back
to option A.

### Option C — auto-retry the job on this exact failure

GitHub Actions doesn't have first-class "retry only this specific
exit message" support. Workarounds:

- A `composite` step that wraps the action in a retry loop.
  `claude-code-action` doesn't expose a re-entry hook, so we'd
  need to call the action twice from a parent workflow, gating the
  second call on the first's failure. Awkward.
- An external job that polls the original job's logs, matches the
  "Claude Code native binary not found" string, and re-dispatches
  via `gh workflow run`. Heavyweight; introduces a separate flake
  surface.

Both are worse than option A or B. List for completeness; do not
ship by default.

## Risks

- **Workaround drift.** If the upstream installer is fixed but our
  pre-install step stays, we'd be running the install twice per
  PR forever. Mitigation: comment the pre-install step with an
  expiry condition ("delete this once `anthropics/claude-code-
  action@v2` ships with a verified install path" or similar) and
  link the upstream issue.
- **False sense of security.** A green pre-install verify is
  meaningful, but the action's own install can still re-run
  internally and corrupt the `~/.local/bin/claude` we just placed.
  Mitigation: the SDK error message already tells us what's
  missing — if the workaround stops being effective, the flake
  surfaces the same way and we know to investigate.
- **Curl-pipe-bash on a CI runner.** Standard CI hygiene says no.
  Mitigation: the same script is what `anthropics/claude-code-
  action@v1` already runs internally — we're not adding new trust
  surface, just running the same install one step earlier so we
  can verify it.

## Effort estimate

- Q1 spike (read action.yml + test option B): 15 min.
- Implementation (option A or B + smoke run on a draft PR): ~30 min.
- Upstream issue write-up against `anthropics/claude-code-action`:
  ~20 min, attached to the same branch as the workaround (so the
  issue link survives the eventual upstream fix and we can revert
  cleanly).

## Sources / attributions

- **Symptom transcript:** PR
  [#81](https://github.com/leehanchung/SMILE-factory/pull/81)
  `Claude PR review` failure on the SHA at the time this PRD was
  drafted. The user's paste captured the full installer + SDK
  error, including the "directory does not exist" + "claude
  command not found" warnings the installer itself prints right
  before declaring success.
- **Workflow context:**
  `.github/workflows/claude-code-review.yml` — the calling
  workflow. The failing step is the `anthropics/claude-code-
  action@v1` invocation; we have no other custom install logic.
- **SDK error verbatim:**
  `Claude Code native binary not found at
  /home/runner/.local/bin/claude. Please ensure Claude Code is
  installed via native installer or specify a valid path with
  options.pathToClaudeCodeExecutable.` — this is the canonical
  string to grep for in any future flake report.
