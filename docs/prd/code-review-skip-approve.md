# Code-review bot: approve on skip instead of commenting

**Status:** shipped

Plan to fix a UX gap where the auto code-reviewer leaves a "skipped"
comment on doc-only PRs without leaving an approving review, so
GitHub still shows "Review required" and the human has to
self-approve a PR the bot already triaged as no-code-change.

> **Shipped.** This behavior is live in
> [`.claude/commands/review-pr.md`](../../.claude/commands/review-pr.md)
> — Step 1 submits an approving review on the doc-only skip path
> (`gh api .../reviews -f event=APPROVE`), with the `event=COMMENT`
> fallback for self-authored PRs. Kept for history; a delete candidate
> under the delete-on-ship convention.

## Symptom

On PRs whose only change is under a `prd/` directory, the bot posts:

> **claude Bot** left a comment
>
> Skipped — the only change is a planning document under prd/
> (`apps/delulu_discord/prd/private-repos.md`); no production code is
> affected.

This shows up in the PR's review history as a *comment*, not an
*approval*. The PR's mergeability still reads "Review required" if
branch protection asks for an approving review. The bot's verdict
("nothing here that needs review") is correct, but the PR sits in a
half-state until a human clicks Approve.

## Root cause

In `plugins/code-review/commands/code-review.md`, **Step 1 — Pre-flight**
says (current behavior):

> If skipping, write a one-line "skipped — reason" note to
> `/tmp/review.md` and submit a single `gh pr review <N> --comment
> --body-file /tmp/review.md`. Then stop.

`gh pr review --comment` produces a "commented" review, which does
not count as approval. **Step 6 — Submit exactly one review** in the
same file already distinguishes `--approve` (no issues) from
`--comment` (issues / observations) for the *normal* path; the skip
path was just never wired to the approve branch.

## Goals / non-goals

**Goals**
- For PRs that the pre-flight rules classify as "skip" (currently:
  draft/closed, `prd/`-only, doc-wording-only), leave an *approving*
  review so the green check appears and branch protection unblocks
  merge.
- Keep the skip body itself unchanged in spirit: a one-liner
  explaining why no real review was done.
- Preserve the existing self-approval fallback (Step 6) — if the bot
  can't approve because the OAuth token belongs to the PR author,
  fall back to `--comment` with the same body.

**Non-goals**
- Expanding the skip rules. The set stays exactly: drafts, closed,
  `prd/`-only, doc-wording-only.
- Changing branch protection settings.
- Changing the workflow file (`.github/workflows/claude-code-review.yml`).
  This is a plugin-content change.
- Changing the substantive review path (Steps 2–6) at all.

## Approach

Edit Step 1 in `plugins/code-review/commands/code-review.md` so the
skip path takes the same `--approve` / `--comment` fallback shape as
Step 6:

1. Write the one-line skip note to `/tmp/review.md` (unchanged).
2. Run `gh pr review <N> --approve --body-file /tmp/review.md`.
3. **Only** if that fails with the specific "cannot approve your own
   pull request" error, fall back to
   `gh pr review <N> --comment --body-file /tmp/review.md`.
4. Then stop. No retries on any other failure.

The skip body should explicitly say it's an approval-on-skip, not a
silent rubber-stamp, so the PR history is honest. Suggested phrasing:

> Approving without substantive review — the only change is a
> planning document under `prd/` (no production code).

## Risks

- **Bot rubber-stamps a class of PRs without reading them.** True by
  design — that's what "skip" means today. The risk is not new; only
  the UX changes. Mitigation: the skip rules are tight (drafts,
  closed, `prd/`-only paths, doc-wording-only) and live in the same
  file as the substantive review logic, so any future expansion of
  skip rules has to be reviewed on its own merits.
- **A PR that *appears* `prd/`-only but smuggles in a code change.**
  The pre-flight rule already says "the **only** changes are under
  `prd/`". As long as the rule stays literal (any non-`prd/` file →
  fall through to substantive review), an approval-on-skip is no
  weaker than today's comment-on-skip — the bot was already not
  reading the diff. Mitigation: keep "only" literal; do not add
  "mostly" or "primarily" variants.
- **Self-approval failures going unnoticed.** If the PR is authored
  by the OAuth token owner, `--approve` errors out and we fall back
  to `--comment`, which lands us back in the original state for that
  one PR. Acceptable — the human is the author and can self-approve
  if branch protection demands it.
- **Plugin self-validation gotcha.** Per
  `.github/workflows/claude-code-review.yml` (lines 87–91),
  `claude-code-action` fetches the plugin from `main`, not from the
  PR branch. The PR that lands this fix will itself be reviewed by
  the *old* Step 1 logic, so the new behavior is only observable on
  the *next* PR after merge. Documented, no mitigation needed beyond
  awareness.

## Testing / rollout

1. Land the plugin edit on a branch.
2. PR title uses `fix:` (review behavior fix, not docs/refactor).
   Per the repo's PR-title lint, `fix` is allowed.
3. The PR itself will be reviewed by the *old* skip logic (it's a
   non-`prd/` change so it falls through to substantive review,
   which is fine — Steps 2–6 are unchanged).
4. After merge, open a trivial `prd/`-only follow-up PR and confirm
   the bot lands an *approving* review with the new body. Repeat
   once for a doc-wording-only PR if convenient.

## Out of scope — explicit parks

- **Auto-approving non-`prd/` doc changes (e.g. `README.md` typo
  fixes).** The current skip rule covers "documentation wording
  fixes" but the boundaries are fuzzy; leave the rule as-is and let
  the bot's judgment apply.
- **Branch protection refactor.** If we ever want the *workflow
  status check* (`Claude PR review`) to satisfy the approval
  requirement on its own, that's a branch-protection change, not a
  plugin change. Different PRD if it comes up.

## Sources / attributions

- **Repo-local source of the bug:**
  `plugins/code-review/commands/code-review.md` Step 1 (skip path)
  vs. Step 6 (substantive path) — Step 6 already implements the
  `--approve` / `--comment` fallback shape this PRD proposes for
  Step 1.
- **Workflow context:**
  `.github/workflows/claude-code-review.yml` — pinned check name
  `Claude PR review`, plugin loaded from `main` of
  `leehanchung/SMILE-factory` (the self-validation note above).
- **Upstream prior art:** This plugin is adapted from the
  `code-review` plugin in `anthropics/claude-code` (per the file's
  own header). No upstream change is implied by this PRD — only the
  local fork needs the fix.
