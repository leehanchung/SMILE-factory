# Hosted Silico frontend: recovered artifacts and contracts

The desktop bundle is a connection manager. The actual workspace UI comes from
the hosted lab origin selected in the running app. This report analyzes that
frontend, not the earlier offline approximation.

## Acquisition and evidence

The selected `/workspace/<workspace-id>/new` URL returned HTTP 200 without
supplying credentials. Its HTML contains a static loading shell and asset
references, rather than workspace records. Only that HTML and explicitly
referenced same-origin frontend assets were acquired. No API endpoint was
called, and no token, browser profile, or private conversation was read.

Saved under ignored `evidence/hosted-static/`:

- `entry.html`: 10,483 bytes; SHA-256
  `e2c295c34ed9d9bfd63bda0317efa523b71920021fbc052be59f35ade5826c6b`.
- `assets/index-DjNr8Oca.js`: 6,128,655 bytes; SHA-256
  `28e0100e8579039a34456e8aa2cbb27284a3863d1fb72a8c4a3d860ccebeb4b4`.
- `assets/jsx-runtime-Bg_NI1en.js`: 8,526 bytes; SHA-256
  `b5cd1d6bcdf3830dcde6cfc7c94089b81c964164b3427a68f28b35da6fa85c09`.
- `assets/index-COWSwU4d.css`: 221,790 bytes; SHA-256
  `c46fd2b03f4e789b4a47c69197b55f7a0561ce7d516ac13c608031d5e72f1ca2`.
- `manifest.json`: 193 assets, 9,869,105 total bytes, including 125 JavaScript
  files and one CSS file. Each entry records path, SHA-256, length, content type,
  and reference parent where discovered recursively.
- `api-candidates.json`: 263 literal/template API call-site occurrences with
  original UTF-8 byte offsets and bounded surrounding source. These include
  third-party telemetry code; they are candidates, not 263 verified product APIs.
- `index.formatted.js`: derived readable main bundle, produced using installed
  Prettier with `--parser babel --no-config` on stdin. **F:** line references
  below point into this derived file, whose unchanged source hash is above.
- `acquire.py`: acquisition procedure; `acquisition-errors.json` records a single
  literal example image path that returned SPA fallback and was discarded.

No declared source-map URL was found in the acquired sources. No source maps
were guessed. External font-provider stylesheets referenced by HTML were not
acquired by the same-origin collector. The local font assets include Suisse
Intl. Telemetry chunks were inventoried as references; they were not executed.

These are ordinary parser/source-inspection observations, not REA Evidence
records. The REA workflow's source identity, bounded coverage, and explicit
unknowns are retained. For this large bundle, direct source inspection provided
the exact consumer contracts without pretending that a full semantic graph or
server implementation was recovered.

## Boot contract

All fields below are observed frontend consumption or construction. They are
not independently verified server responses. The local implementation must
compute real state rather than return fixed successful fixtures.

| Request | Frontend consumption | Evidence |
| --- | --- | --- |
| `GET /api/config` | `local_dev`, `artifact_store_configured`, `reporting_enabled`, `zero_data_retention`, `cluster_id`, `deployment_id`, `lab_login`, `sentry_dsn`, `sentry_environment` | `Fbe`, `XS`, F:42410 onward |
| `GET /api/auth/config` | `auth_required`, `auth_url`, `auth_origins`, `tenant_id`, `pinned_login`, `user_id`, `username`, `avatar_url` | `A_`, `Ibe` |
| `POST /api/feed/session` | Establish stream/file session; JSON request wrapper expects a JSON success response | `X_` |
| `DELETE /api/feed/session` | Clear session; response body unused | `Z_` |
| `GET /api/feature-flags` | **Requires** `providers` object and `models` array; reads `flags`, `capabilities`, `default_model`, `roles`, `role_models`, `role_defaults` | F:45559–45580 |
| `GET /api/orgs` | `{orgs: [...], orgs_active: boolean}`; organization identity key is `organization_id` | F:98800–98877 |
| `GET /api/workspaces` | `{workspaces:[...]}`; workspace records use `workspace_id`, `name`, optional `display_name`, `archived` | F:122282–122306 and `nKt` consumer |
| `GET /api/workspaces/:id` | Direct workspace object, including `name`; 403/404 marks invalid | F:223507–223570 |
| `GET /api/workspaces/:id/threads` | `{ok:true, threads:[...]}` | F:227733–227745 |
| `GET /api/plan/sessions` | Array of session records; sidebar checks archived/unread/awaiting-input/workspace identity | F:45733–45735 and callers |
| `GET /api/workspaces/:id/experiments` | `{ok:true,running:[...],completed:[...]}` | F:85976–86003 |
| `GET /api/orgs/:id/sidebar` | `folders`, `folder_threads`, `folder_archived_threads`, `folder_publications`; maps keyed by folder/workspace ID | F:227256–227272 |
| `GET /api/skills` | `{display_names:{...}}` for display labels | F:120662–120672 |

The frontend already supports `auth_required:false`. Its login branch creates
a development identity with subject `local:dev`, login `dev`, tenant `local`,
admin role, developer flag, and a one-day expiry. This is a shipped local-dev
path, not recovery of an existing user's credential. A locally running backend
can implement local auth without redirecting to Goodfire's identity service.

Model objects are `{value,label,provider,rolesOnly?}`. Provider flags are booleans
under `claude`, `codex`, `modal`, and `byo-model`. `roles` is a list of role-name
strings; `role_models` is another model list; `role_defaults` maps role names to
model IDs. The UI explains `planner` as main-thread replies and `worker` as
launched experiments/tasks. Other named roles include critic, tasks, experiments,
apps/explorers, and summaries. F:45450–45580, 46248 onward.

Sidebar thread records use `session`, `label`, `created_at`,
`last_user_message_at`, `has_pending_question`, `can_write`, `can_delete`,
`folder_id`, `archived`/`status`, `pinned`, `pin_rank`, and `unread` where available.
Sorting uses last-user-message time versus creation time. Workspace/folder
display uses `display_name || name`. F:226680–226753, 227029–227083.
Thread-route consumers additionally use `last_activity_at`, `awaiting_input`,
`experiments:[{eid,display_label}]`, `next_thread_label`, `private`, and
`workspace_id`. The thread ID field here is **`session`**, not `id` or
`thread_id`. F:224804–224904.

## Planner thread lifecycle

`POST /api/workspaces/:workspace/plan/start` accepts this optional-field object:

```text
session_uuid, message, label, client_message_id, private, base_sha,
model, role_models, auto_accept, base_repo, base_ref, link_public_base,
display_text, context_refs, surface_context
```

The wrapper reads `session_uuid` or legacy `session_id`, `provider`, and `model`.
`{ok:false,error}` is an application failure. Startup has a 60-second client
deadline. `POST .../plan/reserve-thread` sends `{}` and requires `session_id`,
allowing uploads before sending the first message. F:45755–45831.

`POST /api/plan/send` sends required `session` and `message`, optionally
`project`, `display_text`, `client_message_id`, `interrupt`, `context_refs`, and
`surface_context`. User echoes carry `client_message_id` so the frontend can
reconcile optimistic messages. `POST /api/plan/cancel-queued` uses
`{session,client_message_id}`. F:45832 onward.

Other state-changing requests observed in the same wrapper module:

| Request | Body |
| --- | --- |
| `POST /api/plan/answer` | `{session,answers,request_id?}` or a dismiss form |
| `POST /api/plan/decide` | `{session,accept,feedback}` |
| `POST /api/plan/interrupt` | `{session,preserve_queued}` |
| `POST /api/plan/skip-agent` | `{session,agent_id}` |
| `POST /api/plan/resync` | `{session}` |
| `POST /api/plan/resume` | `{project,session,include_snapshot?:false}` |
| `POST /api/plan/thread-snapshot?offset=N` | `{project,session}` |
| `POST /api/workspaces/:w/threads/:t/rewind` | `{cursor_event_id?,cursor_turn_id?}` |
| `POST /api/workspaces/:w/threads/:t/model` | `{model}` or `{role,model}` |
| `POST /api/workspaces/:w/threads/:t/auto-accept` | `{enabled}` |
| `POST /api/workspaces/:w/threads/:t/archive` | `{archived}` |
| `DELETE /api/workspaces/:w/threads/:t` | No body |

A resumed session returns `ok`, `mode` (`live` or `readonly`), `provider`,
`model`, optional `snapshot`, and optional `experiment_states`. Snapshot/poll
responses contain `events` and stream-state fields below. The UI first tries a
durable thread snapshot, then resume, then replay, then subscribes. Failure of
one transport is not evidence that a session is missing. F:131479–131590.

A compatible durable snapshot is a direct object containing `ok`, `mode`,
`events`, `offset`, `durable_cursor`, stream state, and optional
`experiment_states`; it is not wrapped in a `thread` field. Resume optionally
wraps that object in `snapshot`. The readonly thread-transcript path instead
advances via `next_offset`. F:131249–131268, 131479–131590.

## Durable event stream

The client uses `fetch` plus a streaming `ReadableStream`, not native
`EventSource`, for `/api/plan/stream?session=<id>&offset=<cursor>`. It sends
`Accept: text/event-stream` and a bearer header only when it has a token.
Decoder: `I5e` and `L5e`, F:128982–129166.

```text
event: event
id: 0
data: {"type":"text_delta","text":"...","turn_id":"..."}

event: state
data: {"busy":true,"durable_cursor":1,"provider":"...","model":"..."}

```

Frame semantics:

- `event: event`: durable JSON event, optional numeric `id`; accepted ID advances
  cursor to `id + 1`.
- `event: transient`: JSON event without advancing the durable cursor.
- `event: state`: JSON runtime state; `durable_cursor` advances cursor, or replaces
  it when `durable_cursor_reset:true`.
- `event: error`: `error` or `message` terminates this stream and triggers fallback.
- Lines beginning `:` are comments. Blank lines delimit frames. Multiline data
  fields are joined. CRLF is normalized. A reconnect uses the retained cursor.

State fields consumed include `busy`, `has_pending_question`,
`inflight_subagents`, `inflight_workflows`, `plan`, `plan_phase`,
`auto_accept_deadline`, `auto_accept_paused`, `auto_continue_deadline`, `warning`,
`provider`, `model`, `durable_cursor`, and `durable_cursor_reset`.

Polling fallback is `GET /api/plan/poll?session=<id>&offset=N`, expecting
`events:[...]`, `offset`, the state above, and optionally `session_epoch`.
`offset` is a cursor, not an event timestamp. Returning an empty events array is
different from omitting `events`, which the client can interpret as missing
runtime/session. F:131350–131478.

## Event payloads and frontend transformations

The event-to-feed converter around F:106148–106615 establishes these concrete
payload fields. All are static contracts; the server's persistence semantics and
ordering guarantees still require independent runtime validation.

| `type` | Fields consumed |
| --- | --- |
| `text`, `text_snapshot`, `text_delta` | `text`, `turn_id`; durable text may have `id` |
| `user_text` | `text`, `id`, `client_message_id`, `context_refs`, `source` |
| `thinking`, `thinking_progress` | Progress optionally supplies `tokens` |
| `tool_use` | `tool`, `tool_use_id`, `input`, `activity_only`, optional experiment/redaction metadata |
| `tool_result` | `tool_use_id`, `output`, `is_error`, optional redaction/web-page metadata |
| `agent` | `agent_id`, `agent_profile`, `description`, `prompt_preview` |
| `agent_activity` | `agent_id`, `tool`, `input`, `description`/`text`, `tokens` |
| `agent_done` | `agent_id`, `status`, `output`, `tokens` |
| `workflow_started` | `workflow_id`, `name`, `title` |
| `workflow_progress` | `workflow_id`, `agents:[{agent_id,label,state,result_preview}]`, `phases:[{index,title}]` |
| `workflow_done` | `workflow_id`, `status`, `summary` |
| `ask_user` | `question_id`/`request_id`, `questions`, `answered`, `answer_labels`, `dismissed`, `auto_accept`, `expired`, `tool_use_id` |
| `plan_start` | `plan_id`, `title`, `summary`, `kind` |
| `plan_delta` | `plan_id`, `title`, `body` |
| `plan_paused` | `plan_id`, `title`, `body`, `kind` |
| `plan_ready` | `plan_id`, `title`, **`plan`** (body string), `plan_file_path`, `kind`, `summary`, `launched`, `experiment_eid`, `display_label`, revision/dismissal flags |
| `page_start`, `page_delta` | `title`, `html`/`body`, `figure_id`, `auto_open` |
| `artifact_revision` | `revision_id`, `prev_revision_id`, `commit_sha`, `summary`, `changed_paths`, `delete_paths`, `files`, `author` |
| `checkpoint` | Nested `checkpoint` including optional `sequence` |
| `model_changed`, `model_fallback` | Model-change/fallback metadata |

The outer session handler also consumes `plan_launch_requested` (`title`, `body`,
`plan_id`), plan/page/result diffs, and credential/repository state. F:130979 onward.

**Plan review requires two related shapes.** A durable `plan_ready` event uses
`plan` for its Markdown body, whereas the state/snapshot's nested `plan` object
uses `{plan_id,title,body,file_path,kind,launch_block?}`. `launch_block`, when
present, contains `reason` and `error_code`. Set `plan_phase:"review"` while
approval is pending and retain that nested plan in subsequent idle state frames:
an idle state with `plan:null` clears the review panel. A writing phase uses
`plan_start` followed by cumulative `plan_delta.body`. Acceptance is represented
by `plan_accepted` and clearing pending state; dismissal by `plan_dismissed`.
F:129961–130170, 131203–131245. A proposal file therefore needs an actual durable
projection into these fields; merely creating the file does not render a plan.

## Experiments and worker execution

Launching an accepted plan uses
`POST /api/workspaces/:workspace/plan/submit` with:

```text
session_uuid, plan_id, title, body, check_in_steps, max_gpus, qos
```

Successful response requires `{ok:true,eid:<string>,display_label:<number>}`.
Failure uses `error` and optional `error_code`. A 504 retry is made only when a
plan ID exists, indicating that local implementation should make launch
idempotent by that ID. F:45996–46032.

Worker routes observed include `/api/worker/:workspace/:eid/message`,
`interrupt`, `model`, `rewind`, `edit-session`, `artifact-chat`,
`artifact-chat/transcript`, and `artifact-chat/handoff`. Worker/agent event
streaming also has `/api/agent/:id/stream?offset=N`. Slurm jobs/logs, interactive
processes, and W&B metrics/tables are distinct APIs: returning successful empty
fixtures would not implement those integrations.

Workspace and organization event subscriptions use
`/api/workspaces/:id/events` and `/api/orgs/:id/events`, also fetch-based SSE.
Here the **SSE event name** is the domain event, including `experiment_created`,
`experiment_deleted`, `experiment_renamed`, `status_changed`, `outcome_changed`,
`eta_changed`, `worker_alive_changed`, `checkpoint`, and thread attention/busy/plan
changes. They are not wrapped in the planner stream's `event: event` envelope.
F:85758–86015.

## Files, repositories, reports, and terminals

Uploads use multipart `POST /api/upload` with `file`, optional `thread_id`,
`project`, `experiment_eid`, and `artifact_id`; the consumer takes the returned
`path`. The frontend enforces a 200 MiB individual attachment limit.
F:45720–45731, 46220–46234.

File retrieval is `/api/feed/file?path=<encoded>` with optional `raw`, `download`,
`probe`, and scope/ref query arguments. Artifact-store upload/transfer/import
APIs and local artifact browsing/search/stat are separate paths. The rebuilt
backend needs path containment and actual file reads rather than an unrestricted
filesystem proxy.

Per-thread repository base is `/api/workspaces/:w/threads/:t/repo`. It supports
metadata, `/tree?ref=&path=`, `/file?ref=&path=`, `/changes`, `/publish`, `/charter`,
`/pr-status`, `/merge-tracking`, `/push`, `/reseed`, `/sync-preview`,
`/upstream-status`, `/sync`, and `/archive`. `ref=main` tree/file calls add
`working_tree=true`. F:109340–109432. These wrappers establish the UI contract,
not a recovered Git implementation or authorization to push remotely.

Resource inputs use `/api/team/resources?workspace_id=&thread_id=` and support
POST `{url,type,visibility,description,name}`, DELETE by ID, verification, and
preflight. GitHub/HuggingFace/arXiv search routes are visible in the artifact
index. Local acquisition did not call them. F:109289–109336.

Report/library routes are separate from the desktop shell:

- `GET /api/papers` returns a plain array (the consumer stores the response
  directly as its report list), with optional status/org/query/limit; publish via
  `POST /api/papers/:id/publish` with optional `version`; access via POST
  `{access}`; delete by ID.
- `GET /api/library/artifacts` with kind, visibility, scope, query, cursor, limit.
- `GET /api/library/reports/:id`; report-public import via POST `{url}`.
- `GET /api/library/artifacts/:id/app` may return `{kind:"app",url}` and the
  consumer probes the returned app with HEAD for PDF/source headers.
- Report records use `pub_id`, `title`, `status`, `publication_kind`,
  `fronted_artifact_kind`, `owner_user_id`, `updated_at`, `access`,
  `published_version`, and `has_unpublished_changes` where present.

Evidence: F:98407–98436, 245856–246013.

Terminal routes are `/api/terminal/:workspace/sessions` and
`/api/terminal/:workspace/:session/{transcript,command,close,stream}`.
Command POST sends `{command,timeout_seconds?}`; close uses POST. Streaming is
another fetch-based SSE decoder. These calls must run a real bounded local
process to count as implemented terminal behavior. F:123106–123150 onward.

## Reconstruction implications and unknowns

The original hosted frontend can be served locally from the acquired artifact
tree. Root-relative paths require a local SPA fallback for its actual routes and
local `/assets`, `/fonts`, and image handling. Serving the archive alone is not
end-to-end functionality: the API contract must connect to persistent workspaces,
durable events, real agent execution, files, experiments, and reports.

Observed frontend contract does not establish backend source, prompts, hidden
tools, scheduler internals, production schemas, or hosted GPU provisioning.
Runtime conformance tests must distinguish implemented local behavior from any
unsupported service. The captured build is independent of desktop version
0.137.0; no claim is made that the hosted build's release version equals it.
