<p align="center">
  <img src="assets/smile-factory-banner.png" alt="SMILE Factory" width="100%">
</p>

# SMILE-factory

> *人造悪魔の実 ―「SMILE工場」* — the Artificial Devil Fruit "SMILE Factory"

A **playground** for **artificial / synthetic data**. In *One Piece*, the SMILE
Factory mass-produces *artificial* Devil Fruits — synthetic stand-ins for natural
powers, churned out by the vat-load from SAD. SMILE-factory is the analog: one
factory for **manufacturing synthetic data to push AI further** — generate tasks,
run them through agents, score the trajectories, feed the signal back into
training. Raw questions in, model capability out.

It's all one thing — eight zones of the same factory:

| Zone | Where | What |
|------|-------|------|
| Task generation | [`data/datagen`](data/datagen/) | synthetic deep-research task gen |
| Eval | [`eval`](eval/README.md) | BenchFlow agentic eval harness |
| Agent loop | [`libs/dr_agent`](libs/dr_agent/) | shared loop / tools / reward registry (imported everywhere) |
| Tool service | [`services/search_server`](services/search_server/) | search/tool HTTP server |
| RL training | [`training/rl_deepresearch`](training/rl_deepresearch/) | slime RL recipe |
| SFT training | [`training/lora_instruct`](training/lora_instruct/) | LoRA + PEFT instruct recipe |
| Orchestrator | [`apps/delulu_discord`](apps/delulu_discord/) · [`apps/delulu_sandbox_modal`](apps/delulu_sandbox_modal/) | Discord → Claude Code → ephemeral Modal sandboxes |
| Infra | [`infra`](infra/) | shared managed-agents platform |

The deep-research loop is the spine: `data/datagen` → `eval` → `training/rl_deepresearch`,
all over the shared `libs/dr_agent`. Architecture + rationale in
[docs/prd/deep-research-training-eval-infra.md](docs/prd/deep-research-training-eval-infra.md).
Two zones have their own walkthroughs below: **[Delulu](#delulu)** (the active
orchestrator) and **[LoRA-Instruct](#lora-instruct)**.

---

# Delulu

Discord bot that dispatches Claude Code tasks to ephemeral Modal Sandboxes.

## How it works

1. User `@mentions` the bot in any channel it can see
2. Bot creates a Discord thread off that message and a new Claude Code session
3. Bot dispatches the task to a Modal Sandbox (ephemeral container with Claude Code installed)
4. Sandbox runs the task against a per-thread workspace on the Modal Volume, returns output, dies
5. Bot posts the result in the thread
6. Replies inside the thread auto-continue the same session via `claude --continue` — no need to re-mention the bot

The bot process itself is tiny (~50MB RAM) and just dispatches jobs — all
heavy lifting (and all Claude Code execution) happens inside Modal sandboxes.

See [docs/delulu-architecture.md](docs/delulu-architecture.md) for the full design.

### Architecture

```mermaid
flowchart LR
    U([User])

    subgraph Discord
      Ch["any channel<br/>(@mention gated)"]
      Th["thread"]
    end

    subgraph Droplet["DO Droplet"]
      Bot["disco<br/>(bot container)"]
      SM["session_manager<br/>thread_id → session"]
      Bot --- SM
    end

    subgraph Modal["Modal"]
      App["discord-orchestrator App"]
      Fn["run_claude_code<br/>(ephemeral sandbox)"]
      Vol[("claude-workspaces<br/>Volume")]
      Sec["claude-oauth<br/>Secret"]
      App --- Fn
    end

    subgraph Anthropic["Anthropic"]
      API["Claude API<br/>(Pro/Max OAuth)"]
    end

    U -->|@mention| Ch
    Ch -->|gateway event| Bot
    Bot -->|create| Th
    Bot -->|Function.from_name.remote| Fn
    Sec -.->|seeds /vol/claude-home/.claude| Vol
    Vol <-.->|HOME=/vol/claude-home<br/>cwd=/vol/workspaces/<thread_id>| Fn
    Fn -->|claude -p --continue| API
    Fn -->|stdout| Bot
    Bot -->|reply| Th
    Th --> U
```

**Runtime request flow** — an `@mention` in any channel triggers the bot
to open a thread, look up or create a session, and call the deployed Modal
function via `Function.from_name(...).remote(...)`. Modal spins up an
ephemeral container from a pre-baked image (Node + Claude Code), runs
`claude --print` with `HOME=/vol/claude-home` and `cwd=/vol/workspaces/<thread_id>`,
captures stdout, and exits. Because both Claude Code's state directory
(`~/.claude/`) and the workspace are on the persistent Modal Volume,
follow-up replies in the same thread can resume via `claude --continue`
— which keys off cwd — even across ephemeral sandbox invocations and bot
restarts.

**Key invariants worth knowing:**

- **The bot never runs Claude Code itself.** It only holds a Discord
  WebSocket connection and a hydrated Modal function reference. Any VPS
  with Docker can host it.
- **Sandboxes are ephemeral but the volume is not.** Workspaces
  (`/vol/workspaces/<thread_id>`) and Claude Code's entire home
  (`/vol/claude-home/.claude/` — credentials, settings, session history)
  survive across invocations. That's what makes session resume,
  refresh-token rotation, and `--continue` all work.
- **Auth is one-way from laptop → Modal Secret → Volume.** The secret only
  seeds the volume on first run; after that, the volume's copy is the
  source of truth. The droplet never stores Claude credentials at rest.
- **`workspace_path` is deterministic per `thread_id`.** The in-memory
  session map is a convenience; even if it's wiped by a bot restart, the
  same Discord thread always maps to the same volume directory.

## Prerequisites

- Python 3.14 and [uv](https://docs.astral.sh/uv/)
- A Discord account
- A [Modal](https://modal.com/) account (`uv tool install modal` or `pip install modal`)
- A Claude Pro or Max subscription (Claude Code authenticates via OAuth, no API key needed)
- *(For deployment)* a server to run the bot — anything that can run Docker. A
  $4–6/mo Digital Ocean droplet is plenty.

---

## Setup

The setup has three parts:

1. **Discord** — create a bot application and invite it to your server.
2. **Modal** — authenticate, upload Claude OAuth credentials as a secret, deploy the sandbox app.
3. **Bot host** — run the bot process (locally or on a server).

### 1. Create the Discord bot

1. Go to https://discord.com/developers/applications → **New Application**.
2. Left sidebar → **Bot**. Scroll to **Privileged Gateway Intents** and enable
   **Message Content Intent**. Save changes.
3. At the top of the **Bot** page, click **Reset Token** → **Copy**. This is
   your `DISCORD_BOT_TOKEN` — save it somewhere, you only see it once.
4. Left sidebar → **OAuth2 → URL Generator**:
   - Scopes: `bot`
   - Bot permissions: `View Channels`, `Send Messages`, `Create Public Threads`,
     `Send Messages in Threads`, `Read Message History`
5. Open the generated URL, pick your server, **Authorize**.

### 2. Set up Modal

```bash
cd apps/delulu_sandbox_modal
uv sync

# Authenticate Modal (opens a browser)
uv run modal setup
```

Now generate dedicated Claude Code OAuth credentials for the bot. Using a
throwaway `HOME` keeps this session isolated from your daily `claude login`,
so nothing you do on your laptop later can invalidate the bot's auth:

```bash
HOME=/tmp/claude-bot-home claude login
# follow the browser flow

uv run modal secret create claude-oauth \
  CLAUDE_CREDENTIALS_JSON="$(cat /tmp/claude-bot-home/.claude/.credentials.json)"

rm -rf /tmp/claude-bot-home
```

The sandbox points `HOME` at `/vol/claude-home` so Claude Code's entire
state directory (credentials, settings, and session history under
`~/.claude/projects/`) lives on the Modal Volume. Rotated refresh tokens
and `--continue` history both persist across ephemeral sandbox
invocations. The secret only seeds the volume on first run — after that
the volume copy is the source of truth. If auth ever breaks, delete
`claude-home/` from the volume and re-create the secret.

#### `github-pat` Modal secret (required for deploy, optional for /commit)

The sandbox app's `commit_workspace` Modal function references a
`github-pat` secret to enable `/commit` push-back to GitHub. The
secret **must exist** for `modal deploy` to succeed (Modal's
`Secret.from_name` doesn't have an optionality flag). If you don't
have a real PAT yet, create the secret with a placeholder value:

```bash
uv run modal secret create github-pat GITHUB_TOKEN=placeholder
```

This is enough for the app to deploy. `/commit` will refuse with a
clear "configure your PAT" message until you replace the placeholder
with a real token.

When you're ready to enable `/commit`, generate a fine-grained PAT
at https://github.com/settings/tokens?type=beta with **Contents:
Read and write** scoped to the specific repos you want the bot to
push to (matching your allowlist). Then update the secret:

```bash
uv run modal secret create github-pat GITHUB_TOKEN=ghp_xxxxxx --force
```

Optional: override the git author identity used for bot commits
(defaults to `Claude Code <claude@bot.local>`):

```bash
uv run modal secret create github-pat \
    GITHUB_TOKEN=ghp_xxxxxx \
    GIT_AUTHOR_NAME="Han Lee" \
    GIT_AUTHOR_EMAIL="han@example.com" \
    --force
```

Commits made by `/commit` will be authored under that name/email and
pushed under the PAT owner's GitHub identity. The two don't have to
match — the author field is cosmetic, the PAT is what GitHub
authenticates against. For a single-user setup where you want
commits to look like they came from you, set both to your own
GitHub name/email and use a PAT scoped to your account.

Deploy the sandbox app (from the repo root):

```bash
make deploy-modal
# — or, scoped to the sub-project —
make -C apps/delulu_sandbox_modal modal-deploy
```

### 3. Run the bot

Configure the bot's environment:

```bash
cp apps/delulu_discord/.env.example apps/delulu_discord/.env
# Edit the copy and paste DISCORD_BOT_TOKEN
```

#### Option A — locally

```bash
cd apps/delulu_discord
uv run delulu-discord
```

#### Option B — Docker (any host)

```bash
make -C apps/delulu_discord deploy   # = image + restart
make -C apps/delulu_discord logs     # tail the container
```

The bot Makefile expects `/root/disco.env` for the bot env file and
`/root/.modal.toml` for the Modal credentials. Override via env vars if
your paths differ:

```bash
make -C apps/delulu_discord deploy ENV_FILE=$PWD/apps/delulu_discord/.env MODAL_TOML=$HOME/.modal.toml
```

The Modal credential mount is what lets the bot dispatch sandboxes —
without it every dispatch fails with an auth error.

---

## Deploying to a Digital Ocean droplet

The bot only needs Python + Docker — no Node, no Claude Code CLI, nothing else.
A $4–6/mo basic droplet (Ubuntu 24.04, 512MB+) is plenty.

```bash
ssh root@<droplet-ip>
apt update && apt install -y docker.io git
systemctl enable --now docker

git clone https://github.com/<you>/SMILE-factory.git
cd SMILE-factory
cp apps/delulu_discord/.env.example apps/delulu_discord/.env
nano apps/delulu_discord/.env   # paste DISCORD_BOT_TOKEN
```

Then from your **laptop**, copy your Modal credentials up:

```bash
scp ~/.modal.toml root@<droplet-ip>:/root/.modal.toml
```

Create the bot env file at the path the Makefile expects:

```bash
cat > /root/disco.env <<'EOF'
DISCORD_BOT_TOKEN=your-discord-bot-token-here
EOF
chmod 600 /root/disco.env
```

Then build and run the container via the bot sub-project's Makefile:

```bash
cd /root/SMILE-factory
make deploy-bot                        # = make -C apps/delulu_discord deploy
make -C apps/delulu_discord logs       # tail to confirm it connected to Discord
```

The container runs with `--restart=unless-stopped`, so it survives
crashes and reboots.

The Claude OAuth credentials are **never** stored on the droplet — they
live only as a Modal Secret and inside the Modal Volume. The droplet only
holds the Discord bot token and Modal client credentials.

---

## Testing it

The bot only responds to explicit `@mentions`, so invite it to any
channel you like — `#general` works. Send a message mentioning the bot:

```
@corchestra tell me a joke
```

Within ~10 seconds the bot should open a thread off your message (named
after the prompt, e.g. `"tell me a joke"`) and post Claude Code's
response inside it. Reply in the thread without mentioning the bot —
it'll auto-continue the same Claude Code session, so follow-ups can
reference earlier context.

If nothing happens:

```bash
make -C apps/delulu_discord logs
```

Common failure modes:
- **No reaction to your mention** — Message Content Intent not enabled,
  or the bot isn't allowed to see / post in that channel.
- **Modal auth error** — `/root/.modal.toml` not mounted into the container.
- **Claude auth error** — `claude-oauth` secret missing, or `/vol/claude-home/.claude/.credentials.json` is stale (delete it on the volume and re-seed).
- **`--continue` starts a new session** — usually means `HOME` isn't pointed at the volume inside the sandbox; check `sandbox.exec` logs in Modal.

---

## Local development

### Lint and format

Ruff (lint + formatter) is the only style tooling. Each sub-project
owns its own `[tool.ruff]` config under `apps/delulu_discord/pyproject.toml`
and `apps/delulu_sandbox_modal/pyproject.toml`. Ruff is installed as a
dev extra in each, so run `make sync-dev` inside the sub-project once
(or whenever you `uv sync` fresh).

```bash
# top-level, runs ruff across both apps
make check

# or scoped to one sub-project
make -C apps/delulu_discord check
make -C apps/delulu_discord lint      # ruff check --fix
make -C apps/delulu_discord fmt       # ruff format (writes)
```

### Pre-commit hook

The repo-root [`.pre-commit-config.yaml`](.pre-commit-config.yaml)
includes a ruff + ruff-format hook scoped to files under `apps/`. To
enable it on your laptop:

```bash
uv tool install pre-commit   # one-time
pre-commit install           # installs the git hook
```

After this, every `git commit` runs trailing-whitespace, EOF, TOML/YAML,
ruff lint (with auto-fix), and ruff-format on the staged files.
If ruff rewrites anything you'll need to re-stage and commit again.

To run manually across all changed files without committing:

```bash
pre-commit run --all-files
```

---

## Updating manually

```bash
cd ~/SMILE-factory && git pull
make deploy-bot              # rebuild image + restart bot container
```

If you changed anything under `apps/delulu_sandbox_modal/`, also
redeploy the Modal sandbox:

```bash
make deploy-modal            # or: make deploy-all to do both in order
```

`make help` (at the top level or inside either sub-project) lists
available targets.

---

## CI/CD (GitHub Actions)

> For the full mental model of how pre-commit, CI, branch protection,
> and per-app Makefiles interact across `apps/delulu_discord` and
> `apps/delulu_sandbox_modal` — including the "skipped-check" gotcha
> and the ruff-version drift trap — see
> [`docs/monorepo-conventions.md`](docs/monorepo-conventions.md).

The workflow at
[`.github/workflows/delulu-deploy.yaml`](.github/workflows/delulu-deploy.yaml)
handles both continuous integration and continuous deployment in five
jobs. PR titles are checked separately by
[`.github/workflows/pr-title.yml`](.github/workflows/pr-title.yml)
(`pr-title-lint`, Conventional Commits, every PR in the repo); see
[`docs/monorepo-conventions.md`](docs/monorepo-conventions.md#commit-messages-and-pr-titles).

- **`changes`** — a `dorny/paths-filter` job that emits four outputs
  (`bot` / `bot_runtime` / `sandbox` / `sandbox_runtime`) driving
  which CI and deploy jobs run. The `_runtime` variants exclude
  `tests/**` so test-only edits run CI but don't redeploy.
- **`delulu-discord-ci`** — runs `ruff check`, `ruff format --check`,
  and `pytest` inside `apps/delulu_discord`. Fires on pull requests
  and on pushes to main.
- **`delulu-sandbox-modal-ci`** — same for `apps/delulu_sandbox_modal`.
  Runs on a separate parallel runner so a failure in one suite doesn't
  hide regressions in the other.
- **`delulu-sandbox-modal-deploy`** — runs `uv run modal deploy`
  directly on the GitHub runner using a dedicated CI-only Modal token
  (`MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` repo secrets). Gated on
  sandbox CI passing AND the event not being a `pull_request`.
- **`delulu-discord-deploy`** — SSHes into the droplet, `git pull`s,
  and runs `make -C apps/delulu_discord deploy` to rebuild and restart
  the bot container. Gated on discord CI passing, the sandbox deploy
  being done or skipped (so a combined sandbox+bot push never restarts
  the bot against a stale Modal function), and the event not being a
  `pull_request`.

CI runs on every PR; CD runs only on push to main.
Modal deploys happen on the GH runner with a dedicated CI-only token,
not the droplet's runtime token — the droplet's role is now narrowed
to rebuilding the bot container.

### One-time droplet prep

The workflow assumes the droplet is already set up as described in
[Deploying to a Digital Ocean droplet](#deploying-to-a-digital-ocean-droplet)
above — i.e.:

- Docker installed
- `/root/SMILE-factory` checked out (the workflow runs `git pull` inside it)
- `/root/disco.env` containing `DISCORD_BOT_TOKEN=...`
- `/root/.modal.toml` as a real file (from `uv run modal token new` on
  the droplet) — this is the *runtime* token the bot uses to call
  `Function.from_name(...).remote()`, **not** the deploy token. The
  deploy token lives in GitHub Actions secrets now, not on the droplet

The droplet no longer needs `uv` installed — `uv run modal deploy`
runs on the GitHub runner, not the VPS. If you can run `docker` and
`git pull` as root, the bot-deploy side of the workflow will work.

### One-time GitHub setup

Generate a dedicated SSH deploy key (don't reuse your personal key):

```bash
# On your laptop
ssh-keygen -t ed25519 -f ~/.ssh/disco_deploy -N "" -C "github-actions-disco"

# Install the public half on the droplet
ssh-copy-id -i ~/.ssh/disco_deploy.pub root@<droplet-ip>

# Test the key works
ssh -i ~/.ssh/disco_deploy root@<droplet-ip> 'echo ok'

# Print the private half — you'll paste this into GitHub
cat ~/.ssh/disco_deploy
```

Add these as **Repository secrets** under **Settings → Secrets and variables
→ Actions** on GitHub:

| Secret | Value |
|---|---|
| `DROPLET_HOST` | The droplet's public IPv4 address |
| `DROPLET_SSH_KEY` | Full contents of `~/.ssh/disco_deploy` (including the `-----BEGIN`/`-----END` lines) |
| `MODAL_TOKEN_ID` | From Modal dashboard → Settings → Tokens → **New token**. The `ak-...` value |
| `MODAL_TOKEN_SECRET` | Same token's `as-...` value. Use a dedicated CI-only token so it can be revoked independently of your dev token |

### Testing the workflow

The workflow has a `workflow_dispatch` trigger, so you can run it manually
without pushing a commit:

1. GitHub → **Actions** tab → **delulu** → **Run workflow** → pick
   `main` → **Run workflow**.
2. Watch the five jobs run in order:
   - `changes` classifies which files changed
   - `delulu-discord-ci` and `delulu-sandbox-modal-ci` run in parallel
     on their own runners
   - `delulu-sandbox-modal-deploy` runs after its CI, pushing the
     Modal app from the GH runner
   - `delulu-discord-deploy` chains after discord CI and the Modal
     deploy, SSHing into the droplet to rebuild the bot container
3. On the droplet, `docker ps` should show the `disco` container running,
   and `journalctl CONTAINER_NAME=disco --since "5 minutes ago"` (or
   `make -C apps/delulu_discord logs`) should show a clean startup.
   The bot uses the journald log driver so logs survive container
   rebuilds — `docker logs disco` still works for the current run.

Each job's logs are viewable independently in the Actions UI — no need
to SSH in to debug unless the failure is in the droplet-side step.
Common failure modes:

- **`delulu-sandbox-modal-deploy` fails with an auth error** — the
  `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` secrets are missing or wrong.
  Test locally with
  `MODAL_TOKEN_ID=ak-... MODAL_TOKEN_SECRET=as-... modal app list`
  to verify the token has deploy permissions before re-adding.
- **"Permission denied (publickey)"** in `delulu-discord-deploy` —
  `DROPLET_SSH_KEY` is wrong, or the public key isn't in
  `/root/.ssh/authorized_keys` on the droplet.
- **"error: unable to connect to Docker"** in `delulu-discord-deploy` —
  `systemctl status docker` on the droplet, `systemctl enable --now docker`
  if it's not running.

### Rollback

Preferred: forward-revert via `git revert` on `main`. The same workflow
that deployed the bad commit will redeploy the reverted state:

```bash
git checkout main && git pull
git revert --no-edit <bad-sha>    # or the merge sha for a PR
git push
```

This drives both the Modal deploy and the bot redeploy back to the
prior state in one pipeline run (~2–4 minutes). No SSH required.

If you need to unstick prod *faster* than a full pipeline run — e.g.
the bot is crashing on every message — you can force the droplet's
bot container back to a known-good image manually:

```bash
ssh root@<droplet-ip>
cd /root/SMILE-factory
git log --oneline -10             # find the commit you want to roll back to
git reset --hard <good-sha>
make -C apps/delulu_discord deploy
```

The sandbox side stays on the previously deployed Modal function
until the next `delulu-sandbox-modal-deploy` run fires. If the bad
code is in the sandbox and the bot needs a matching rollback,
pair the above with a manual `modal deploy` from your laptop using
the pre-bad commit's `apps/delulu_sandbox_modal/src/delulu_sandbox_modal/app.py`,
or trigger `workflow_dispatch` on the reverted `main` once it's pushed.

Then still push the `git revert` on the remote after the manual
rollback, so the next main push doesn't redeploy the broken version.

---

## Project structure

```
SMILE-factory/
├── apps/
│   ├── delulu_discord/                     # VPS-hosted Discord bot
│   │   ├── pyproject.toml                  # discord.py, modal (client), pydantic, structlog
│   │   ├── uv.lock
│   │   ├── .python-version
│   │   ├── .env.example                    # bot environment template
│   │   ├── Dockerfile                      # bot image only — no sandbox deps
│   │   ├── Makefile                        # VPS targets: sync / check / image / deploy / logs
│   │   ├── prd/                            # bot-scoped plan docs
│   │   └── src/delulu_discord/
│   │       ├── main.py                     # Bot entrypoint + @mention gating
│   │       ├── handlers.py                 # Message routing + attachment download + result posting
│   │       ├── session_manager.py          # Thread ↔ session mapping with TTL
│   │       ├── dispatcher.py               # SandboxDispatcher (client-side Function.from_name wrapper)
│   │       └── settings.py                 # Pydantic Settings from env vars
│   │
│   └── delulu_sandbox_modal/               # Modal-deployed sandbox function
│       ├── pyproject.toml                  # modal, structlog — nothing else
│       ├── uv.lock
│       ├── .python-version
│       ├── Makefile                        # Modal targets: sync / check / modal-deploy
│       ├── prd/                            # sandbox-scoped plan docs
│       └── src/delulu_sandbox_modal/
│           └── app.py                      # Modal App, image, volume, secret, run_claude_code
│
├── training/                               # LLM training recipes (lora_instruct SFT + rl_deepresearch RL)
├── Makefile                                # top-level dispatcher (check / deploy-bot / deploy-modal / deploy-all)
├── README.md                               # this file
├── docs/                                   # all repo docs: delulu-architecture.md (design), usage, conventions, + prd/ plan docs
│   └── prd/                                # repo-wide planning docs (per-app plans live under apps/<name>/prd/)
├── .claude/                                # Claude Code config: commands/ agents/ hooks/ settings.json
└── infra/managed-agents/                   # sibling infra work (unrelated to delulu)
```

---

# LoRA-Instruct

LoRA-Instruct (HuggingFace PEFT + LoRA SFT recipe, originally targeting Stanford Alpaca on RedPajama-INCITE) has moved to [`training/lora_instruct/`](training/lora_instruct/) as part of the monorepo reorg. See that directory's README for setup, training commands, and supported models — it's the source of truth for that project.
