---
description: Review a pull request
allowed-tools: Bash(gh api:*),Bash(gh pr diff:*),Bash(gh pr view:*),Write
---

# PR review — SMILE-factory

You are reviewing a pull request in the SMILE-factory monorepo.
Coordinate three specialist subagents, filter their output for
genuinely noteworthy findings, and submit one atomic review with
inline comments via the GitHub Reviews API.

## Repository context

The active project is the **delulu Discord orchestrator**:

- `apps/delulu_discord` — Discord bot, runs in Docker on a VPS.
  Changes here require a bot container rebuild.
- `apps/delulu_sandbox_modal` — Modal sandbox function that runs
  Claude Code. Changes here require a Modal redeploy.

The repo root also contains archived LoRA-Instruct fine-tuning code.
Lower review priority unless the PR explicitly touches it.

**Boundary invariants** (treat violations as correctness bugs):

- `delulu_discord` must never import from `delulu_sandbox_modal`.
- `delulu_sandbox_modal` must never import bot-side Discord types.

## Step 1 — Pre-flight

**Skip review** if any of these are true:

- The PR is a draft or closed
- The only changes are under a `prd/` directory — `docs/prd/` or a per-app `apps/<app>/prd/` (planning docs)
- The only changes are documentation wording fixes

If skipping, there is no production code to object to, so the PR is
fine to merge as far as this reviewer is concerned. **Submit an
approving review** (not a bare comment) so it counts toward the
required approvals instead of leaving the PR stuck on "Review
required":
`gh api repos/{owner}/{repo}/pulls/<N>/reviews --method POST -f event=APPROVE -f body="Approving — skipped detailed review (<reason>; prd/docs only)."`
If that fails with "cannot approve your own pull request", retry once
with `event=COMMENT`. Then stop.

## Step 2 — Gather context

Run `gh pr view <N>` and `gh pr diff <N>` to collect metadata,
title, body, and the full diff. Note any `CLAUDE.md` files at the
repo root and in directories touched by the PR — they define
conventions to check against.

## Step 3 — Delegate to subagents

Launch all three subagents **in parallel**, passing each the PR
diff and relevant context:

1. **code-quality-reviewer** — correctness, boundary invariants,
   clean code
2. **security-reviewer** — credential handling, injection,
   sandbox blast radius
3. **test-coverage-reviewer** — missing tests, untested paths

Each subagent returns a list of findings. Only provide noteworthy
feedback — do not speculate or pad.

## Step 4 — High-signal filter

From the combined subagent output, **only keep findings that clear
all of these bars:**

- The code will fail to compile, parse, or run correctly
  **regardless of inputs**, OR
- There is a **clear, quotable violation** of a rule in a scoped
  `CLAUDE.md` file, OR
- The change introduces a **specific, demonstrable security
  regression**

**Filter OUT:**

- Style nits that ruff would catch (ruff runs in pre-commit)
- Documentation wording unless factually wrong
- General "code quality" concerns
- Potential issues that depend on unknown inputs or external state
- Subjective suggestions
- Pre-existing issues on the base branch

If you are not certain an issue is real, **do not include it.**
False positives erode trust.

## Step 5 — Write the review payload as ONE JSON file

Use the `Write` tool (never shell heredoc) to create a single
`/tmp/review.json` holding the **entire** Reviews API body — `event`,
`body`, and `comments` together. It must be one file: GitHub needs
`event` *in the request body*, and the submit step sends this file as
the whole body (Step 6 explains why splitting it silently breaks).

```json
{
  "event": "APPROVE",
  "body": "## Review summary\n\n<verdict>\n\n## Deployment\n\n<which side needs a rebuild/redeploy, if any — omit this line when neither app is touched>",
  "comments": [
    {
      "path": "relative/file/path.py",
      "line": 42,
      "body": "**Correctness:** Brief description of the issue."
    }
  ]
}
```

- `event` — `APPROVE` or `COMMENT` (never `REQUEST_CHANGES`); pick per
  Step 6.
- `body` — the summary as a JSON string (escape newlines as `\n`).
  Verdict: `"LGTM"` / `"minor non-blocking notes"` (both approve) or
  `"flagging N issue(s) for human review"` (comment).
- `comments` — inline findings, or `[]` if none. Each: `path`
  (repo-relative, matches the diff exactly), `line` (line number in the
  NEW file, visible in a diff hunk; last line for a range), `body`
  (prefix with the category).

## Step 6 — Submit exactly one review

**Advisory only — never `REQUEST_CHANGES`.**

**Default to APPROVE.** `main` requires approving reviews, so a clean
review that only COMMENTs forces a needless human self-approval. Set
`"event"` from your *findings*, not your tone:

- **APPROVE** — `comments` is `[]` **and** the body raises no blocking
  concern. "LGTM" and "minor non-blocking notes" both approve.
- **COMMENT** — there is at least one inline finding, **or** you are
  putting a substantive concern a human must weigh in the body.

Submit with a **single `gh api` command**. Two hard rules, each of which
has silently eaten a review before:

1. It MUST start with `gh api` — the sandbox only allows
   `Bash(gh api:*)` and rejects anything it can't statically analyze:
   no leading `VAR=...` assignment, no `$(...)`, no `jq`/`cat` pipeline.
2. It MUST send the whole payload via `--input` with **no `-f`/`-F`
   field flags**. With `--input`, any `-f`/`-F` flags are pushed to the
   query string instead of the body, so `event` is dropped and GitHub
   creates an unsubmitted **pending** review that never appears.

```bash
gh api "repos/{owner}/{repo}/pulls/<N>/reviews" --method POST --input /tmp/review.json --jq '.html_url'
```

**One attempt, one outcome — never retry**, with one exception: if it
fails with "cannot approve your own pull request", change `"event"` to
`"COMMENT"` in `/tmp/review.json` and run the command once more.
