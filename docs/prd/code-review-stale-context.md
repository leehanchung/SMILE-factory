# Code-review bot: read context files from PR head, not main

**Status:** not-started

Plan to fix a happy-path failure where the auto code-reviewer flags
hallucinated "Priority 1 — Correctness" findings on PRs that
*modify* `CLAUDE.md` (or any other context file), because the bot
reads the file's **base-branch** content as authoritative and ignores
that the PR is changing the very text it's quoting.

This is a *plan*, not a spec of implemented behavior. Nothing in this
document has been executed yet.

## Symptom

PR [#66](https://github.com/leehanchung/SMILE-factory/pull/66)
(`refactor: move LoRA-Instruct under training/lora_instruct`)
replaced the root `CLAUDE.md` Quick Reference (poetry / finetune.py
commands) with `make -C ...` per-project commands. On the first
review, the bot left a `--comment` review with this finding:

> **Priority 1 — Correctness:** CLAUDE.md Quick Reference commands
> fail from the repo root (CLAUDE.md, lines 7–10)
>
> ```
> - **Setup**: `poetry install`
> - **Lint**: `poetry run ruff check .` (fix with `--fix`)
> - **Test**: `poetry run pytest`
> - **Train**: `python finetune.py --base_model '<model>' --output_dir '<dir>'`
> ```
>
> After this PR pyproject.toml lives at training/lora_instruct/...

The quoted lines are **main's** `CLAUDE.md` lines 7–10, not the PR
branch's. The PR replaces those exact lines with the make-based
commands. The bot quoted the pre-PR text and flagged it as a defect
in the PR.

The author pushed back in a PR comment. After a `Merge branch
'main'` commit triggered a re-review, the bot approved cleanly
(`LGTM — clean reorganization`). The end state was correct, but the
happy path took a human round-trip and a forced re-run that
shouldn't have been needed.

## Root cause

In the post-#61 reviewer (`.claude/commands/review-pr.md`):

- **Step 2 — Gather context** says "Note any `CLAUDE.md` files at
  the repo root and in directories touched by the PR — they define
  conventions to check against." It does not say *which version* of
  `CLAUDE.md` to read (PR head vs. base branch).
- The frontmatter declares
  `allowed-tools: Bash(gh api:*),Bash(gh pr diff:*),Bash(gh pr view:*),Write`.
  **`Read` is not in the allowed list**, so the agent cannot read
  the locally-checked-out file. Its only paths to file content are
  `gh pr diff` (which returns hunks, not full files) and `gh api`.
- A naked `gh api repos/{owner}/{repo}/contents/CLAUDE.md` returns
  the **default branch** copy. The PR head SHA must be passed as
  `?ref=<sha>` to get the post-PR version. The skill never tells
  the agent to do this.
- **Step 4 — High-signal filter** has a "**Filter OUT:** Pre-existing
  issues (things that already exist on the base branch)" rule. That
  rule should have caught this — the offending lines are the base
  branch — but only if the agent realizes the lines it's quoting
  *are* the base branch. With no diff-vs-content cross-check, it
  doesn't.

The pre-#61 plugin file (`plugins/code-review/commands/code-review.md`)
has the same gap; it instructs reading via WebFetch against
`api.github.com/repos/<owner>/<repo>/pulls/<N>/files` for the diff
but never specifies how full file content is retrieved.

## Goals / non-goals

**Goals**
- When the reviewer needs to read a context file (`CLAUDE.md`,
  `pyproject.toml`, etc.) to evaluate a PR, the file content it
  reads is the **PR head** version, not the base branch's.
- When the reviewer flags a finding, "I quoted lines that the PR is
  itself replacing" cannot happen on the happy path.
- The fix lands in **`.claude/commands/review-pr.md`** (the post-#61
  source of truth). The pre-#61 plugin file gets the same fix only
  if PR #61 is delayed — by default we follow #61's source of truth.

**Non-goals**
- Re-reviewing past PRs.
- Switching the reviewer to a different model or harness.
- Touching the Codex reviewer (`codex-code-review.yml` from #61) —
  that one uses the action's checkout (`refs/pull/<N>/merge`) and
  reads the working tree, so it doesn't have this bug. Verify before
  closing this PRD.
- Loosening the high-signal filter. The filter is fine; it just
  needs accurate inputs.

## Approach

Two non-exclusive fixes. Recommend doing **both** — they reinforce
each other.

### Fix 1 — Read context files from the local checkout

`.github/workflows/claude-code-review.yml` already does
`actions/checkout@v4` against the PR (default behavior on
`pull_request` events checks out the merge ref). The post-PR file
content is on disk.

Add `Read` to the reviewer's `allowed-tools`:

```yaml
---
description: Review a pull request
allowed-tools: Bash(gh api:*),Bash(gh pr diff:*),Bash(gh pr view:*),Read,Write
---
```

Update Step 2 to be explicit:

> When you need to read a context file (`CLAUDE.md`,
> `pyproject.toml`, a referenced source file), use the `Read` tool
> against the local working tree. The workflow has already checked
> out the PR's merge commit, so what you read is the **post-merge**
> state. Do not use `gh api .../contents/...` for file content —
> that returns the default branch by default and silently produces
> false positives when the PR modifies the file.

### Fix 2 — Diff-aware sanity check before flagging

Add a new sub-step at the end of Step 4 (high-signal filter):

> **Diff-vs-content cross-check.** For every finding that quotes
> file content (lines, code blocks, identifiers), verify the quoted
> text appears in the **post-PR** version of that file (via
> `gh pr diff <N>` or local `Read`). If the quoted text is in the
> diff's **removal hunk** (lines starting with `-`), the PR is
> already fixing it — drop the finding. If the file itself isn't
> in the diff, the finding is about base-branch state — drop it
> per the pre-existing-issues filter.

This is the belt to Fix 1's suspenders: even if the agent does
read the wrong file version, this check catches "I'm flagging
something the PR is removing."

## Risks

- **`Read` widens the agent's surface area.** The reviewer can now
  read any file in the checkout, including files outside the diff.
  Mitigation: the checkout is already public (it's the PR's source
  tree); `Read` is no broader than what `gh pr diff` already
  exposes.
- **Diff-vs-content check is interpretive.** "Does the quoted text
  appear in the post-PR file?" requires the agent to reason about
  diff hunks. Cheap mistakes (whitespace differences, partial-line
  quotes) could over- or under-trigger the drop. Mitigation: phrase
  the rule as "if you're not sure the quoted text is present in
  the post-PR file, drop the finding" — false negatives (missed
  real bugs) are cheaper than false positives in this reviewer.
- **Plugin self-validation gotcha (recap).** The reviewer command
  is loaded from `main` per `.github/workflows/claude-code-review.yml`
  (post-#61: from the checked-out tree, since PR #61 removes
  `plugin_marketplaces`). After #61 lands, this fix takes effect on
  the *first* PR that includes it; before #61 lands, the fix only
  matters on `main`. Sequencing-wise, this PRD should land **after**
  #61.
- **Interaction with PR #70.** Both PRDs touch the reviewer command
  file. Whichever lands first, the second has to rebase. The
  changes don't conflict semantically — #70 fixes Step 1 (skip
  path), this PRD fixes Step 2 + Step 4 (substantive path).

## Testing / rollout

1. Land PR #61 first (introduces `.claude/commands/review-pr.md` as
   source of truth). Already required by other PRDs in flight.
2. Branch this fix from post-#61 `main`. Edit
   `.claude/commands/review-pr.md` per Fix 1 + Fix 2.
3. **Smoke test** by opening a trivial PR that modifies the root
   `CLAUDE.md` (e.g. tighten a sentence). The reviewer should:
   - Not flag any line of the file as "violating" `CLAUDE.md`
     (since the file is itself the rule and is being changed).
   - Either approve or comment with `LGTM` / `minor observations`.
4. If smoke test passes, close this PRD. If the bot still flags a
   stale-content issue, iterate on Fix 2's wording.

## Out of scope — explicit parks

- **Re-running the bot on past PRs.** Not worth it.
- **Changing the high-signal filter.** Already correct; just needs
  accurate inputs.
- **Coupling diff and content reads more aggressively** (e.g.
  forcing the agent to fetch every quoted file via a specific
  helper). Adds complexity for a problem the two simple fixes
  above already address.

## Sources / attributions

- **Symptom evidence:** PR
  [#66](https://github.com/leehanchung/SMILE-factory/pull/66) —
  comment thread on the first review (false-positive on
  `CLAUDE.md` lines 7–10) and the second review (LGTM after
  merge-main-in).
- **Reviewer source of truth (post-#61):**
  `.claude/commands/review-pr.md` (introduced by PR
  [#61](https://github.com/leehanchung/SMILE-factory/pull/61)).
  Step 2 (gather context), Step 4 (high-signal filter), and the
  `allowed-tools` frontmatter are the touch points.
- **Workflow context:**
  `.github/workflows/claude-code-review.yml` — checks out the PR
  ref, so the local working tree is already the post-PR state. Fix
  1 leverages this directly.
