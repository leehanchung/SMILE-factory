# Delulu — usage guide

A hands-on guide to using the delulu Discord bot to run Claude Code
against a repo from inside Discord. If you want the *design* of the
bot, read [`docs/delulu-architecture.md`](delulu-architecture.md).
If you're setting up a fresh deployment for the first time, read
[`README.md`](../README.md) — this guide assumes the bot is already
running in your server.

## Quick command reference

| Command | Who | What it does |
|---|---|---|
| `@delulu <prompt>` | anyone | Creates a thread and runs Claude Code against the current channel's bound repo (or an empty workspace if no binding). Top-level channel messages only — replies inside a thread don't need the mention. |
| `/setrepo repo:owner/repo ref:HEAD` | anyone | Binds the current channel to a GitHub repo. Repo must be on the server's allowlist. |
| `/unsetrepo` | anyone | Clears the channel's repo binding. New `@delulu` mentions fall back to empty-workspace general Q&A. |
| `/commit message:<msg>` | anyone | Commits any pending changes in the current thread's workspace to a `claude/<thread-id>` branch and pushes to GitHub. Must be run inside an active thread. |
| `/admin_addrepo repo:owner/repo` | Manage Server | Adds a GitHub repo (public or private) to the server's allowlist. Validates it exists and is reachable via `git ls-remote` at add time. Private repos need the `github-pat` secret. |
| `/admin_removerepo repo:owner/repo` | Manage Server | Removes a repo from the allowlist. Existing channel bindings are NOT retroactively cleared. |
| `/admin_listrepos` | Manage Server | Ephemeral list of the current server's allowed repos. |

Admin commands are gated by Discord's `MANAGE_GUILD` permission —
users without it won't see them in autocomplete at all, so the
command surface for regular members is just `@delulu`, `/setrepo`,
`/unsetrepo`, and `/commit`.

## The mental model in three sentences

1. A server has an **allowlist** of repos that admins can curate.
   Regular users can only bind channels to repos on that list.
2. A **channel** is bound to at most one repo at a time. `@delulu`
   mentions in that channel run against the bound repo; `@delulu`
   mentions in an unbound channel run in an empty workspace for
   general Q&A.
3. Each `@delulu` mention creates a **thread**, and that thread
   stays attached to the same worktree until its session expires.
   Replies inside the thread auto-continue Claude Code's session,
   and `/commit` from inside the thread pushes whatever Claude left
   in the worktree to a branch on the upstream repo.

The allowlist is per-server. The binding is per-channel. The
workspace is per-thread.

## One-time server setup (admins)

Assuming the bot is already installed in your server and the
server admin has the `MANAGE_GUILD` permission (given to Discord
admins by default):

### 1. Add a repo to the allowlist

```
/admin_addrepo repo:leehanchung/SMILE-factory
```

Expected: `✅ leehanchung/SMILE-factory added to this server's
allowlist. Users can now /setrepo against it.`

The bot validates the repo by running `git ls-remote` against it
inside the sandbox — anonymously first, then with the `github-pat`
credential to classify it as public or private. If the repo doesn't
exist or isn't reachable (even with the PAT), the command refuses
with a specific error and the allowlist is unchanged.

### 2. Verify the allowlist

```
/admin_listrepos
```

Expected: an ephemeral reply listing every allowed repo. Only you
see it.

### 3. Share with the channel

That's all the admin has to do. Tell the channel members to
`/setrepo` against one of the allowed repos and they're off.

### Removing a repo

```
/admin_removerepo repo:leehanchung/SMILE-factory
```

The `repo:` argument autocompletes from the current allowlist, so
you don't have to remember or type the exact name — type `/admin_removerepo`
then pick from the dropdown.

**Heads up:** removing a repo from the allowlist does NOT
retroactively clear channels that were already `/setrepo`'d against
it. Those threads keep their binding until someone runs `/unsetrepo`
in those channels manually. Future `/setrepo` calls against the
removed repo will fail the allowlist check.

## Day-to-day usage (everyone)

### Bind a channel to a repo

Once a server admin has added a repo to the allowlist, anyone can
bind it to a channel:

```
/setrepo repo:leehanchung/SMILE-factory
```

Or, if you want to work against a specific branch rather than the
default:

```
/setrepo repo:leehanchung/SMILE-factory ref:my-branch
```

The `repo:` argument autocompletes from the server's allowlist, so
type `/setrepo` and pick from the dropdown — no need to type the
exact repo name. If you try to bind a repo that's not on the
allowlist, the bot replies with the current list and tells you to
ask an admin to add it.

**Where you run `/setrepo` matters.** Run it from the **top-level
channel view**, not inside an existing thread. Discord's
`interaction.channel_id` is whichever view you're in at the moment
you invoke the slash command, and if you run it from inside a
thread, the binding gets stored against the thread ID rather than
the channel ID. The bot will then look up the channel ID when
someone `@delulu` mentions it in the channel root, find nothing,
and fall back to empty-workspace mode.

If you think `/setrepo` worked but `@delulu` is running in an
empty workspace, that's the first thing to check.

### Run Claude Code against the repo

In the same channel:

```
@delulu summarize the top-level structure of the repo
```

Three things happen:

1. The bot creates a new Discord thread off your message, named
   after the first ~50 characters of your prompt.
2. A status message appears inside the thread. Line 1 is
   `💭 Thinking about your request...` (replaced by Claude's
   reasoning spoiler once it starts thinking). Line 2 is
   `📁 leehanchung/SMILE-factory@HEAD` — the active-repo
   subtitle, always visible right under the thinking header while
   the run is alive.
3. Claude Code starts running in the repo's worktree. Tool calls
   stream into the status message in place:
   `🔧 Glob *.md`, `🔧 Read README.md`, `🔧 Edit src/foo.py`, etc.
   Each one gets a `✓` or `✗` tick when it returns.

On completion the status message freezes with a
`✅ Done • N tools • Xs` footer appended to the end of the
transcript. The transcript stays visible — it doesn't collapse.

The first `@delulu` mention ever against a given repo is a **cold
start** — the bot clones the bare repo into a shared cache
(`/vol/repo-cache/github.com/<owner>/<repo>.git`) with
`--filter=blob:none` so file contents aren't fetched until someone
opens them. Expect ~8–15 seconds before Claude starts producing
tool calls, depending on repo size. Subsequent threads against the
same repo are a **warm start** — just a worktree creation, ~3–5
seconds.

### Follow up in the thread

Once the initial response arrives, reply in the thread **without**
`@delulu`:

```
now find the slowest test in the suite
```

The bot resumes Claude Code's session via `claude --continue`, so
the follow-up has the full context of the prior turn. The warm
path skips the worktree creation entirely via a marker file —
expect ~2–4 seconds before Claude starts.

Session continuity is per-thread and keyed on the thread ID.
Replies in the SAME thread continue the session; a new `@delulu`
mention at the channel root starts a fresh thread with a fresh
session, even if the new thread targets the same repo.

### Commit and push changes back

If Claude has made edits to the workspace (via `Edit`, `Write`, or
other file-mutating tools), you can push those changes back to
GitHub without leaving Discord. From inside the thread:

```
/commit message:fix: claude's proposed refactor
```

The bot makes a commit on a `claude/<thread-id>` branch (creating
it if it doesn't exist yet) and pushes to the upstream repo. On
success, you get a reply like:

```
✅ Committed `a1b2c3d` and pushed to branch `claude/1493821717049643058`.

Open a PR: https://github.com/leehanchung/SMILE-factory/compare/main...claude/1493821717049643058?expand=1
```

Click the compare URL to land on GitHub's "Open a pull request"
page, where you can review the diff, set a title and description,
and merge when you're ready. The commit author shows as `Claude
Code <claude@bot.local>` by default (configurable via Modal
secrets); the *pusher* shows as whoever owns the `github-pat`
token in the Modal secret — not whoever typed `/commit` in
Discord. See [README.md](../README.md) for how to set up the PAT
secret and customize the author identity.

Edge cases to know:

- **`/commit` with no pending changes** → `ℹ️ Nothing to commit
  — the workspace has no pending changes.` The command is
  idempotent; you can re-run it safely.
- **`/commit` with no PAT configured** → `❌ Can't commit —
  github-pat Modal secret missing or empty.` The bot shows you the
  exact `modal secret create` command to run. Your workspace is
  untouched — no hidden partial commit, nothing lost.
- **`/commit` in a channel (not a thread)** → `❌ /commit must be
  run inside a Claude Code thread.` Scroll into the thread first.
- **`/commit` in a thread with no repo binding** → `❌ This thread
  has no repo binding.` Can happen for legacy threads created
  before `/setrepo` was bound to the channel. Start a fresh
  `@delulu` mention in the now-bound channel.

### Clear the binding

If you want to stop running `@delulu` against a repo and fall back
to general Q&A mode in the channel:

```
/unsetrepo
```

Now `@delulu tell me a joke` in the same channel will create a
thread with no `📁` subtitle line and run Claude in an empty
workspace with no git operations. This is the legacy "Claude as a
general assistant" behavior the bot shipped with pre-repo-provisioning.

## The permission model, briefly

Discord enforces slash command permissions server-side via
`@app_commands.default_permissions`. Users without the required
permission don't even **see** the gated commands in autocomplete —
they're hidden, not just error-guarded.

- **`MANAGE_GUILD`** — the "Manage Server" permission, held by
  server owners, admins, and moderators with the role. This gates
  `/admin_addrepo`, `/admin_removerepo`, and `/admin_listrepos`.
- **No permission gate** — `/setrepo`, `/unsetrepo`, `/commit`, and
  `@delulu` are available to everyone who can see the bot. Bindings
  are per-channel, so anyone who can see a channel can rebind it;
  if you want to gate that further, lean on Discord's channel
  permissions rather than the bot.

The allowlist is the main access-control layer: even though any
channel member can `/setrepo`, they can only set to repos that an
admin put on the allowlist. If you trust your admins, you trust
the allowlist, you trust the bindings.

## Multi-thread / multi-channel usage

The binding is per-channel. If you have two channels — `#api-work`
bound to `alice/api-service` and `#frontend-work` bound to
`alice/frontend` — `@delulu` in each channel runs against the
right repo automatically, with the corresponding `📁` subtitle in
each thread's status message.

Each `@delulu` mention creates a new thread with its own workspace
under `/vol/workspaces/<thread-id>` on the Modal volume. Two
threads in the same channel don't share state — they're independent
checkouts of the same repo. You can have parallel threads working
on different parts of the same codebase without stepping on each
other.

If the same repo is bound in multiple channels and multiple
threads are dispatched at once, the **first** cold clone happens
in whichever thread gets there first; subsequent threads hit the
warm cache and skip the clone. The first-clone thread may feel
slower than usual (~8–15s vs ~3–5s).

## Troubleshooting

### `@delulu` replies but says "working directory is empty"

The channel's binding isn't being applied. Three things to check:

1. **Did `/setrepo` succeed in this channel?** Run `/setrepo` again
   at the **channel root** (not inside any thread) and confirm the
   ephemeral `✅ Channel bound…` reply.
2. **Are you in a new thread?** Bindings apply at thread-creation
   time. If you've already started a thread before `/setrepo`, that
   thread's session was created with no binding and won't
   retroactively pick one up. Start a fresh `@delulu` mention at
   the channel root.
3. **Did the bot restart recently?** There's a known bug tracked
   in [`apps/delulu_discord/prd/setrepo-persistence-bug.md`](../apps/delulu_discord/prd/setrepo-persistence-bug.md)
   where bindings can be lost across bot restarts. If you saw the
   bot container cycle recently, re-run `/setrepo` and try again.

### The repo subtitle is showing but Claude says files are missing

Check the `ref:` you bound to. If the branch or ref you specified
doesn't exist on the upstream, the cold clone step will fail and
you'll see an error in the thread. If the ref exists but is very
sparse (e.g. an unrelated orphan branch), that's what Claude will
see.

Fix: `/unsetrepo`, then `/setrepo` again with the correct ref (or
omit `ref:` entirely to use the default branch).

### `/commit` fails with `push_failed`

The local commit succeeded but the push was rejected. Most
commonly:

- **Expired PAT** — the `github-pat` Modal secret's token is past
  its expiration date. Rotate: generate a new fine-grained PAT,
  run `modal secret create github-pat GITHUB_TOKEN=<new> --force`,
  redeploy the sandbox app. Your prior `/commit` attempts are
  preserved on the `claude/<thread-id>` branch locally on the
  volume, so the next successful push will include everything.
- **Insufficient PAT scope** — the PAT needs `Contents: Read and
  write` on the specific repo. If you narrowed repo access when
  generating it, make sure the repo you're pushing to is in the
  selected list.
- **Branch protection** — `main` or `master` has branch protection
  rules that block the push. This shouldn't happen for a
  `claude/<thread-id>` branch (protection rules usually target
  `main`/`master`), but check if you've set up blanket rules.

The bot surfaces the git error message verbatim in the Discord
reply, so whatever git says is the starting point for debugging.

### Slash commands aren't showing up in autocomplete

Discord's global slash command sync takes a few minutes to
propagate after the bot starts. If it's been longer than ~10
minutes and commands still aren't showing:

```bash
ssh root@<droplet> 'journalctl CONTAINER_NAME=disco --since "1 hour ago" | grep commands.'
```

Look for `commands.registered count=6` and `commands.synced
count=6`. If either is missing or shows `count=0`, the bot didn't
successfully register commands — check the log lines just before
for a traceback and follow that.

### Everything looks right but `@delulu` just sits there

Check the bot is actually running:

```bash
docker ps --format '{{.Image}}\t{{.Status}}' | grep disco
```

If the container is missing or stopped, restart it from the
droplet's `/root/SMILE-factory` checkout:

```bash
make -C apps/delulu_discord deploy
```

If the container is running but not responding, tail the logs:

```bash
make -C apps/delulu_discord logs
# or directly: journalctl -f CONTAINER_NAME=disco
```

For a post-mortem after the container has been restarted (e.g.
investigating a cancellation that happened hours ago), query
journald with a time window — the logs survive `docker rm`:

```bash
journalctl CONTAINER_NAME=disco --since "2026-05-05 15:50" --until "2026-05-05 15:56"
```

Anything from a failed Modal dispatch (OAuth issues, sandbox
timeouts) will show up there as a traceback.

## Known limitations (v1)

Documented in the PRD at [`apps/delulu_discord/prd/repo-provisioning.md`](../apps/delulu_discord/prd/repo-provisioning.md)
under "Out of scope — park for v2":

- **Single shared PAT.** All commits go through one
  GitHub identity (whoever owns the `github-pat` secret). Real
  multi-user attribution via GitHub App installation tokens is a
  v2 project.
- **No workspace GC.** `/vol/workspaces/<thread-id>/` directories
  accumulate indefinitely. The volume is big enough to not care
  for now, but eventually a TTL or manual cleanup is needed.
- **`/setrepo` doesn't persist across bot restarts** — see
  [`apps/delulu_discord/prd/setrepo-persistence-bug.md`](../apps/delulu_discord/prd/setrepo-persistence-bug.md).
  Workaround: re-run `/setrepo` after the bot restarts.
- **Global provisioning serialization.** Cold clones on different
  repos queue up behind each other via `@app.function(max_containers=1)`
  on `provision_workspace`. Fine for a solo user; would need
  per-repo concurrency primitives for a larger deployment.

## Getting help

- **Architecture questions** → [`docs/delulu-architecture.md`](delulu-architecture.md)
- **Deployment questions** → [`README.md`](../README.md)
- **Design decisions** → the PRDs under [`apps/delulu_discord/prd/`](../apps/delulu_discord/prd/) and [`apps/delulu_sandbox_modal/prd/`](../apps/delulu_sandbox_modal/prd/)
- **Anything going wrong** → `journalctl -f CONTAINER_NAME=disco` on
  the droplet (or `make -C apps/delulu_discord logs`) is the single
  best source of truth for what the bot is doing. The bot ships
  stdout/stderr to systemd-journald so logs survive container
  rebuilds — query historical windows with `--since` / `--until`
