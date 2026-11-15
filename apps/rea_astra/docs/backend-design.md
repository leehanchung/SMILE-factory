# Real research backend: feasibility and protocol

## Current evidence

The existing authenticated **Codex CLI is the first real engine** for the local research backend. It supports actual tool use, structured progress, file changes, and conversation continuation without adding an API key to this application. The installed CLI and the implemented `RunManager` have now both completed real isolated research smoke tests, including native-session continuation.

Observed on 2026-11-10 UTC (2026-11-09 local):

| Check | Result |
|---|---|
| Codex executable | `/opt/homebrew/bin/codex`, resolving to the installed Caskroom binary |
| Codex version | `codex-cli 0.147.0` |
| `codex login status` | Exit 0; reports logged in with ChatGPT |
| Claude executable | `/Users/han/.local/bin/claude` |
| Claude version | Claude Code `2.1.321` |
| `claude auth status --json` | Exit 1; `loggedIn: false`, `authMethod: none`, provider `firstParty` |
| Python | `3.13.5`, with standard-library SQLite, HTTP server, and subprocess support |

Authentication outputs were filtered to status/provider enums before display. No credential files, token values, keychain contents, email, or account identifiers were read into the investigation. CLI login status establishes local configured authentication; it does not prove network reachability, remaining quota, or successful inference. The sandbox emits a nonfatal Codex PATH-alias warning even for help/status; preserve failures from an actual run separately.

The initial feasibility pass used help/status only. Implementation validation subsequently invoked the existing Codex login, executed a standard-library Python experiment in new isolated app workspaces, and resumed its explicit provider session. No new login, root configuration change, provider installation, package install, or external research request was performed in those arithmetic tests.

## Implemented and independently checked

The later hosted-UI integration adds planner/worker approval, source acquisition,
report editing/publication, persistent queues/settings and independent forks.
See [validation](validation.md) for actual UI-driven runs; the design sketch
below is retained as the initial proposal, not the current API reference.

`backend/store.py`, `backend/runner.py`, and `backend/server.py` implement durable SQLite state, per-thread workspaces, real JSONL execution, bounded output, process-group timeout/cancellation, artifact indexing, same-origin HTTP APIs, and resumable SSE. Native provider events are stored as `{id, run_id, kind, payload, created_at}`; IDs are SQLite cursors. The hosted UI adapter can project them without discarding originals.

Two real tests used the standard-library mean/population-variance calculation over `[1,2,3,4,5]`:

- Direct CLI test: `.local/workspaces/engine-smoke-20261110/`, exit 0 and `turn.completed`; actual `experiment.py`, `results.csv`, and `report.md` created and inspected.
- Backend test: `.local/backend-smoke/`, thread `3e20eb47-ce2a-4c0e-b65f-a5449022e875`; initial run `2efdec40-a0e4-4643-be5b-53c80301b99e` completed with real command/file-change events and three registered artifacts. A second run `eef1182b-60cf-4923-8564-7a3d4def6fc1` resumed the stored provider UUID, read the existing CSV, and correctly reported mean **3** and population variance **2**. No synthetic fallback was used.

These tests prove a working local coding/research execution path and continuation. They do not establish a full internet literature-review run, proprietary Silico backend parity, remote GPU execution, or production isolation.

## Installed CLI contracts

### Codex 0.147.0

Locally inspected: `codex --help`, `codex exec --help`, `codex exec resume --help`, `codex login --help`. Parsing `codex -a never --search exec --ignore-user-config --sandbox workspace-write --json --help` succeeded without running a model.

- `codex exec [OPTIONS] [PROMPT]` runs noninteractively. Prompt `-` reads stdin.
- `--json` emits JSONL on stdout; keep stderr separate.
- `-C/--cd` sets the working root. `--skip-git-repo-check` permits a fresh isolated directory.
- `--sandbox` supports `read-only`, `workspace-write`, and `danger-full-access`. Use `workspace-write` for code-writing research; do not use the last option.
- Top-level `-a never` denies actions that would require approval; it does not grant unrestricted execution. Blocked tool operations must remain visible to the user.
- Top-level `--search` enables the native live web-search tool. Omit it for a deterministic arithmetic/code smoke test; enable it for actual research runs whose request requires browsing.
- `--ignore-user-config` skips the user's Codex configuration while retaining authentication through the existing CODEX_HOME. This avoids inheriting configured external MCP integrations into the new app. It does not promise all user context or filesystem reads are isolated.
- `--output-schema PATH` supplies a JSON Schema for the final answer; `--output-last-message PATH` saves that final answer. Structured final answers and stream events are separate contracts.
- `--ephemeral` avoids persisted Codex sessions, so it is appropriate for a disposable smoke test, not native-session continuation.
- `codex exec resume SESSION_ID -` resumes an explicit Codex UUID; never use global `--last` in this backend. Retain `thread.started.thread_id` from the initial run and persist it against the app thread. Preserve the same workspace and policies on continuation.
- Provider/model selection can be overridden with `--model`; initial smoke should use the CLI's supported default rather than inventing a model identifier or assuming account entitlement.

The application should launch an argument array with `shell=False`, pass prompt text through stdin, and set the working directory explicitly. User input must not become a shell command or CLI flag. Existing authentication stays owned by Codex; the app should not copy it into SQLite, the workspace, HTTP responses, exports, or logs.

### Exact Codex event types

The installed version's tagged upstream source is available at [exec_events.rs, rust-v0.147.0](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/exec/src/exec_events.rs). Its tagged schema is a better reference than the current TypeScript SDK's narrower union. This is source evidence, not an observed live event capture.

| `type` | Relevant fields |
|---|---|
| `thread.started` | `thread_id: string` |
| `turn.started` | No additional required payload |
| `item.started`, `item.updated`, `item.completed` | `item: {id, type, ...type-specific fields}` |
| `turn.completed` | `usage: {input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}` |
| `turn.failed` | `error: {message}` |
| `error` | `message` |

Relevant item variants:

- `agent_message`: `text`. This is visible assistant output. A structured final response is JSON encoded in this field when requested.
- `command_execution`: `command`, `aggregated_output`, nullable `exit_code`, `status` (`in_progress`, `completed`, `failed`, or `declined`). Preserve item ID and replace its latest snapshot; do not concatenate repeated aggregate output.
- `file_change`: `changes: [{path, kind: add|delete|update}]`, `status` (`in_progress`, `completed`, `failed`). File-change declarations are signals to inspect workspace artifacts, not authority to serve arbitrary paths.
- `web_search`: `query`, `action`, and search ID. Preserve the raw variant because action details may vary.
- `mcp_tool_call`: `server`, `tool`, `arguments`, optional/nullable result/error, and status. No external MCP server should be added implicitly.
- `collab_tool_call`: tool, sender and receiver thread IDs, prompt, agent states, and status. Disable/avoid delegation by task instruction unless the app explicitly supports and owns its cancellation lifecycle.
- `todo_list`: `items: [{text, completed}]`.
- `reasoning`: a reasoning **summary** field. Do not request or manufacture hidden chain-of-thought. The UI can show concise public progress summaries and tool events without exposing this field by default.
- `error`: nonfatal item message; distinct from the top-level terminal error.

Treat unknown types/fields as retained raw events with a neutral UI fallback. Do not fail an otherwise valid run solely because the CLI adds a field. Bound JSONL line size and stored output. A process exiting with code 0 but no `turn.completed` is not automatically a successful research result; cancellation, EOF, provider failure, and a completed turn must have distinct states.

### Claude fallback

Installed `claude --help` supports `--print --output-format stream-json --verbose`, `--include-partial-messages`, `--input-format stream-json`, `--json-schema`, `--session-id`, `--resume`, `--max-budget-usd`, tool lists, and `--permission-prompts none`. Its `--safe-mode` skips customizations while preserving ordinary auth. `--restricted` constrains file tools to working directories and removes code-running tools unless explicitly named. `--bare` skips OAuth/keychain and requires other auth, so it is **not** the correct way to reuse an existing Claude subscription login.

Claude is not authenticated in the observed shell. Do not silently fall back to it, create a login, or ask for a key while Codex is viable. Add a provider adapter later only if needed, with a fresh status check and an authenticated smoke test.

## Existing monorepo patterns worth reusing

The repository already contains a real Claude invocation and JSONL parser in [delulu_sandbox_modal/app.py](../../delulu_sandbox_modal/src/delulu_sandbox_modal/app.py):

- Lines 120–218 normalize assistant text, tool-use, and tool-result blocks. The parser is defensive about content block types and malformed JSON.
- Lines 644–712 construct the actual Claude command with stream JSON, verbose output, and continuation. Its broad allowed-tools list is justified by an ephemeral **Modal container**; do not copy that policy onto the user's host.
- Lines 751–835 use subprocess pipes, drain stderr concurrently to avoid deadlock, impose a wall-clock timer, and guarantee cleanup in `finally`.
- The existing code terminates one process and matches some tool results only by name. For this backend, retain exact item IDs and kill the owned process group on cancellation so shell children do not survive.

[events.py](../../delulu_sandbox_modal/src/delulu_sandbox_modal/events.py) defines a transport-level event union; retain that separation between provider-specific raw events and the browser's stable event contract. [streaming.py](../../delulu_discord/src/delulu_discord/streaming.py) coalesces display updates instead of rendering every event immediately. [session_manager.py](../../delulu_discord/src/delulu_discord/session_manager.py) uses persistent SQLite state and WAL mode so sessions survive process restarts.

The repository's [stream parser tests](../../delulu_sandbox_modal/tests/test_stream_parsing.py) explicitly distinguish synthetic fixtures from live provider captures. Preserve that distinction in the new backend's test report.

## Initial architecture proposal (historical)

Use Python's existing standard-library HTTP server plus SQLite and a bounded subprocess runner, keeping the current static UI delivery. This avoids adding runtime dependencies merely to turn on genuine agent execution. This is a proposed design, not recovered Silico backend source.

1. Persist application threads, messages, folders/workspaces, runs, events, and artifacts in an ignored local SQLite database. Enable foreign keys, WAL, and a busy timeout; use short transactions and one connection per worker/request rather than sharing an unchecked connection across threads.
2. Allocate an app-owned directory for each thread. It contains user-provided files, generated scripts/data/reports, and an explicit workspace instruction file. Do not run agents in the monorepo root or `/Applications/Silico.app`.
3. A thread has at most one active run. Guard run creation transactionally and return HTTP 409 for a concurrent send rather than interleave two agents in one workspace. A small global concurrency limit keeps CLI processes bounded.
4. Each run records provider, model request, provider thread UUID, state, timestamps, exit code, final message, usage, and error. Recommended state machine: `queued → running → completed|failed|cancelled|interrupted`. A terminal state must be written once under a transaction/compare-and-set check.
5. Run Codex in an owned process group (`start_new_session=True` on macOS/Linux), read stdout and stderr concurrently, ingest JSONL, persist ordered event rows, and broadcast normalized updates. Cancel with SIGTERM to that process group, allow a short grace period, then SIGKILL and `wait()`. Never kill a process found by an unverified PID after a restart.
6. At startup mark abandoned `running`/`queued` rows `interrupted`; do not auto-resubmit costly research. User can inspect saved output and retry. A disconnected browser does not automatically cancel the process; explicit Cancel does.
7. Stream via SSE with monotonically increasing SQLite event IDs and resume from `Last-Event-ID`/cursor. Persist before sending; heartbeat while idle; close after a terminal event. Refreshing the browser must retrieve the same run rather than create another one.
8. After a successful run, verify generated artifacts within the owned workspace. Record relative path, MIME/type, size, SHA-256, producing run, and timestamps. Reject symlinks/escaped paths and skip private/config/temp files; never expose an unrestricted filesystem browser. Serve active HTML/SVG as downloads or with isolation, not trusted same-origin executable content.
9. Tell the agent to save reproducible scripts, actual command outputs/data, and a Markdown research report with source links and uncertainty. Label real research as completed only after the provider finishes; distinguish generated prose from executed experiment evidence. Do not manufacture missing files, citations, or success results.

Suggested tables:

```text
workspaces(id, name, root_relative, created_at)
folders(id, name)
threads(id, workspace_id, folder_id, title, provider, provider_thread_id,
        created_at, updated_at)
messages(id, thread_id, run_id, role, content, created_at)
runs(id, thread_id, provider, model, status, started_at, finished_at,
     return_code, final_text, usage_json, error)
events(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id, kind, item_id,
       payload_json, created_at)
artifacts(id, thread_id, run_id, relative_path, media_type, size, sha256,
          created_at)
```

API sketch (final implementation may consolidate routes):

```text
GET    /api/status                  Installed providers and sanitized auth state
GET    /api/threads                 Persistent thread list
POST   /api/threads                 Create an isolated thread workspace
GET    /api/threads/{id}            Messages, runs, artifacts
PATCH  /api/threads/{id}            Title/folder
DELETE /api/threads/{id}            Refuse while running; remove owned state only
POST   /api/threads/{id}/runs       Save user prompt and start a real run
GET    /api/runs/{id}/events        SSE with cursor replay
POST   /api/runs/{id}/cancel        Cancel the owned run
GET    /api/artifacts/{id}          Download a verified workspace artifact
```

Bind only `127.0.0.1`. Before enabling state-changing endpoints, validate Host and same-origin requests, require JSON content type plus a per-server anti-CSRF token for mutations, and emit no wildcard CORS. A malicious remote page should not be able to trigger an agent run against the user's login. Change the UI's current `connect-src 'none'` CSP to `connect-src 'self'` for the same-origin API/SSE only.

The CLI workspace-write sandbox limits writes but is not a complete confidentiality boundary for all host reads. Use application-owned workspaces, minimize inherited environment, and avoid broad SSH/cloud/repository access or copied unrestricted tool grants. Stronger untrusted multi-user isolation would need a separate OS/container boundary; this proposed first backend is a single-user local app.

## Initial smoke-test plan (historical)

These commands are **proposed, not executed in this pass**. Run from a new app-owned smoke directory with an absolute path, under host permissions that allow the installed Codex launcher and its sandbox helper. Keep the wrapper timeout around 120 seconds initially. Do not pass secrets or the user's existing research files.

First, verify auth/network and event delivery with a no-tools prompt:

```text
argv = ["/opt/homebrew/bin/codex", "-a", "never", "exec",
        "--ignore-user-config", "--sandbox", "read-only",
        "--skip-git-repo-check", "--ephemeral", "--json",
        "-C", ABSOLUTE_SMOKE_DIRECTORY, "-"]
stdin = "Reply with exactly REA_ASTRA_ENGINE_OK. Do not use tools or read files."
```

Then verify genuine coding/tool execution and artifact production:

```text
argv = ["/opt/homebrew/bin/codex", "-a", "never", "exec",
        "--ignore-user-config", "--sandbox", "workspace-write",
        "--skip-git-repo-check", "--ephemeral", "--json",
        "-C", ABSOLUTE_NEW_EXPERIMENT_DIRECTORY, "-"]
stdin = "Within this empty directory only, create experiment.py using Python's standard library to calculate the mean and population variance of [1,2,3,4,5]. Execute it. Save the real output as results.json and explain the method and observed values in REPORT.md. Do not use the network or read outside this directory. Do not delegate. Report the actual file paths and whether execution succeeded."
```

Validate exit status and `turn.completed`, inspect recorded `command_execution`/`file_change` events, parse `results.json` (expected mean 3 and population variance 2), check files exist inside the selected directory, and retain sanitized fixture events. A successful final sentence alone does not prove experiment execution. Next exercise provider-session continuation, cancellation during a real run, and browser SSE reconnect using these owned smoke workspaces.

An internet research test should be separate: enable top-level `--search`, request a small primary-source lookup, capture web-search evidence and source URLs, and show any auth/network/permission failure honestly. Do not present synthetic responses as the research fallback.

## Outstanding evidence before claiming a working backend

- Actual inference success and the account's accessible default model.
- Observed JSONL shape from this installed binary and exact resume command behavior under the selected sandbox.
- Real experiment execution and verified generated artifacts.
- Process-group cancellation, timeout, and server-restart recovery.
- Browser integration, persistent threads after reload, and SSE reconnection.
- Any capability beyond the local CLI workspace, including remote clusters, billing, provider hosting, and Silico's proprietary lab backend, remains separate scope and must not be claimed as reconstructed from this plan.
