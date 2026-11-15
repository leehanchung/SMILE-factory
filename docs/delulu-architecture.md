# Discord Orchestrator — Architecture

## Overview

A lightweight system that lets users trigger Claude Code tasks from Discord. Modal provides ephemeral compute, Discord provides the conversational interface, and a persistent Modal Volume holds workspaces and session history.

```
┌──────────────┐         ┌──────────────────┐         ┌──────────────────┐
│   Discord    │         │   Bot Process    │         │  Modal Sandbox   │
│   (User)     │◄───────►│   (always-on)    │────────►│  (ephemeral)     │
│              │  d.py    │                  │  modal   │                  │
│  threads =   │  gateway │  - route msgs    │  spawn   │  - claude code   │
│  sessions    │         │  - map threads   │         │  - task exec     │
└──────────────┘         │  - post results  │         │  - stdout/stderr │
                         └──────────────────┘         └────────┬─────────┘
                                                               │
                                                      ┌────────▼─────────┐
                                                      │  Modal Volume    │
                                                      │  (persistent)    │
                                                      │                  │
                                                      │  /workspaces/    │
                                                      │    <thread-id>/  │
                                                      │  /claude-home/   │
                                                      │    .claude/      │
                                                      └──────────────────┘
```

## Components

### 1. Discord Bot (`apps/delulu_discord/`)

**Always-on process** running as a Docker container on a VPS droplet (journald logging, secrets in `/root/disco.env`). Responsibilities:

- Listen for messages via discord.py gateway connection
- **Thread-session mapping**: new channel message → create Discord thread + allocate session ID. Reply in thread → reuse session ID.
- Dispatch work to Modal via the client-side `dispatcher` wrapper
- Post results back into the originating thread
- Truncate long outputs to fit Discord's 2000-char limit (with file upload fallback)

Key files (under `src/delulu_discord/`):
- `main.py` — bot entrypoint, client setup, event registration
- `handlers.py` — message/command event handlers, attachment download
- `session_manager.py` — thread↔session mapping (workspace keyed on `thread_id`), TTL expiry
- `dispatcher.py` — `SandboxDispatcher`, a client-side wrapper around `modal.Function.from_name(...).remote()`
- `commands.py` — slash-command definitions + registration (`/setrepo`, `/commit`, admin repo commands)
- `repo_allowlist.py` — per-guild repo allowlist with public/private visibility (backed by a `modal.Dict`)
- `repo_config.py` — active-repo binding per thread/guild
- `streaming.py` — live status renderer that edits the Discord message as Claude's tool calls stream in
- `settings.py` — Pydantic Settings model, loads from env vars / .env

### 2. Modal Sandbox Function (`apps/delulu_sandbox_modal/`)

**Ephemeral containers** spun up per task. Each sandbox:

- Mounts the persistent volume at `/vol`
- Has Claude Code installed (via image build)
- Receives: thread_id, prompt, a continue flag, and any attachments the user uploaded
- Runs the `claude` CLI with `--output-format stream-json --verbose` (and `--continue` to resume)
- Streams stream-json events back to the bot; returns the final result
- Dies after completion (~4GB RAM, configurable)

Key files (under `src/delulu_sandbox_modal/`):
- `app.py` — Modal App definition, image build spec, volume config, `run_claude_code` function body, and the `--output-format stream-json` parser
- `events.py` — internal event dict shapes the stream-json parser emits
- `repo_provisioner.py` — repo validation (`git ls-remote`), clone/fetch, public/private classification

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Workspace content** | Git clone onto volume | User binds a repo with `/setrepo`; we clone into `/vol/workspaces/<thread_id>/` |
| **Streaming** | Live status message | The bot parses Claude's `--output-format stream-json` and edits the Discord message as tool calls stream in (`streaming.py`), with rate-limit backoff. |
| **Bot hosting** | Separate always-on process | Bot is lightweight (~50MB RAM), doesn't need Modal. Runs as a Docker container on a VPS droplet. |
| **Auth** | Modal Secret | Anthropic API key stored as a Modal Secret, injected into sandbox env. Discord token lives with the bot process. |
| **Session TTL** | 1 hour default | Replies in a thread within 1hr resume the Claude Code session. After that, new session, same workspace. |

## Session Lifecycle

```
1. User sends message in #claude channel
   → Bot creates Discord thread (titled from first ~50 chars)
   → Bot allocates a Session keyed on thread_id (workspace = /vol/workspaces/<thread_id>)

2. Bot dispatches to the sandbox (thread_id, prompt, resume=False)
   → Modal spins up sandbox
   → Sandbox runs: claude -p "<prompt>" --output-format stream-json --verbose
   → Sandbox streams events back; the bot renders them live and keeps the final result

3. Bot posts output to the thread
   → If > 1900 chars, uploads as file attachment

4. User replies in the thread
   → Bot looks up the Session from thread_id
   → If session age < TTL: resume=True (--continue flag)
   → If session age >= TTL: resume=False (fresh session, same workspace)
   → Dispatch again
```

## Volume Layout

```
/vol/
├── workspaces/
│   ├── <thread-id-1>/
│   │   ├── .git/
│   │   └── <repo contents>
│   └── <thread-id-2>/
│       └── ...
└── claude-home/
    └── .claude/
        └── projects/<cwd-hash>/   # Claude Code session history (HOME=/vol/claude-home)
```

## Shipped since this design

- **Live streaming output** via Discord message edits with rate-limit backoff (`streaming.py`).
- **File upload** — attachments in Discord are downloaded and placed in the workspace.
- **Repo provisioning** via slash commands: `/setrepo` binds a repo, `/commit` pushes, plus admin allowlist commands — including private repos via a `github-pat` Modal secret. See the PRDs under `apps/delulu_discord/prd/`.

## Future Enhancements

- **Workspace management** slash commands (`/workspace list`, `/workspace delete`, GC of stale workspaces)
- **Cost tracking** — log Modal compute seconds per user/session
- **GitHub webhook integration** — trigger Claude Code on PR events
