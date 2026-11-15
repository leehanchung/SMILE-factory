# Hosted experiment, worker, report, and file contracts

This document records **static observations** from the hosted frontend recovered on 2026-11-10 UTC. It does not claim access to the hosted backend implementation or that the local replacement already implements every route. No backend requests, profile reads, or token inspection were used for this analysis.

Evidence files, relative to this app:

| File | SHA-256 |
| --- | --- |
| `evidence/hosted-static/assets/index-DjNr8Oca.js` | `28e0100e8579039a34456e8aa2cbb27284a3863d1fb72a8c4a3d860ccebeb4b4` |
| `evidence/hosted-static/index.formatted.js` | `8e0d7fe0a51a4d9ae780e6eb7d366ca049a18daad82429b81bb9a95a5ffced88` |

All source locations below refer to the formatted file at that hash. Line ranges identify function definitions and their consumers. JSON examples describe consumed fields; they are not captured backend responses. Unknown fields and server behavior remain unknown.

The client validates experiment IDs as `exp_` followed by 26 lowercase Crockford base-32 characters, with the first character in `0`–`7` (133972 onward). An arbitrary UUID hex suffix is therefore not route compatible. The local allocator uses a compatible 26-character suffix; `ExperimentService.migrate_legacy_ids()` is an explicit, transactional repair for early local IDs and refuses running workers.

## Minimal genuine execution path

The observed frontend supports this implementation without fabricated research results:

1. A real planner run produces a plan; its proposal is accepted through `POST /api/workspaces/{ws}/plan/submit`.
2. Submit persists an experiment, assigns its numeric display label, starts a real worker in its own filesystem workspace, and returns `{ok:true,eid,display_label}`.
3. Worker executions append durable text/tool events and checkpoint records. The client observes worker events through polling or SSE and experiment state through a workspace SSE channel.
4. The worker writes code, data, and a real report. Serve those bytes through the file API; expose an HTML report through the experiment app route. Markdown may be rendered to HTML locally, but no completed report should be supplied before a real run has produced it.
5. Persist checkpoint, report revision, and file state. A completed worker emits a completion checkpoint and a completed status, after which the results view survives reloads.

Steps above are an **implementation recommendation**, not proof of the original server's internal design. Remote GPU execution, W&B, GitHub publication, and public hosting are separate integrations; do not synthesize their success.

## Launch, list, and lifecycle

Base: `/api/workspaces/{ws}/experiments/{eid}`. Path components are URL encoded.

| Method and route | Request / observed response |
| --- | --- |
| POST `/api/workspaces/{ws}/plan/submit` | `{session_uuid,plan_id:null|string,title,body,check_in_steps:null|value,max_gpus:null|number,qos:null|string}`. Success is strictly validated as `{ok:true,eid:string,display_label:number}`. Failure reads `error`, `error_code`. A 504 with a plan ID triggers bounded retries. |
| GET `/api/workspaces/{ws}/experiments` | `{ok:true,running:Experiment[],completed:Experiment[]}` |
| GET `/api/experiments/recent?workspace_id={ws}&limit=15` | Optional `pinned_eids`, `before_eid`, `query`; pinned lookup also uses `include_recent_resources=false`. Full response not resolved here. |
| GET `/api/workspaces/{ws}/experiment-preferences` | Response not resolved here. |
| POST `{base}/rename` | `{title}` |
| POST `{base}/stop` | No body in the helper. |
| POST `{base}/resume` | `{prompt,client_message_id?,for_chat?:true}` |
| DELETE `{base}` | Delete experiment. |
| POST `/api/experiments/archive` | `{repo:ws,eid}` |
| POST `/api/experiments/archive-artifact` | `{repo:ws,key,archived}` |
| GET `{base}/status` | Consumer reads `experiment_kind`, `number`, `fabric_id`. |

Source: 45996–46030 (submit), 85975–86000 (snapshot), 109171–109290 (lifecycle), 248482 onward (status).

Snapshot reducer consumes the following experiment fields (85540–85582):

```json
{
  "eid": "exp_local_id",
  "display_label": 1,
  "number": 1,
  "title": "Research title",
  "created_at": "ISO-8601 timestamp",
  "status": "running",
  "experiment_kind": "research",
  "outcome": null,
  "eta": null,
  "dispatched_by": "planner",
  "worker_alive": true,
  "checkpoint_count": 0,
  "last_summary": null,
  "last_seq": 0,
  "user_id": "local-user",
  "allowed_actions": []
}
```

`display_label` falls back to `number`; `experiment_kind` defaults to `research`. The reducer treats `completed` and `stopped` as terminal states for ETA clearing. The full set of allowed action names is not established here.

## Experiment feed and workspace events

GET `{base}/feed?after={ISO timestamp}` returns:

```json
{"feed": [], "worker_alive": false, "background_tasks": [], "fabric_id": "local"}
```

`feed` must be an array. Entries are deduplicated by `feed_id` and sorted by `timestamp`. Responses with `category:"response"` and `checkpoint_sequence` settle a checkpoint's pending state. The UI retains up to 1,000 items and preferentially preserves checkpoints. Source: 212940–213245.

Checkpoint consumed fields (209399–209421):

```json
{
  "feed_id": "chk_001",
  "category": "checkpoint",
  "type": "completion",
  "sequence": 1,
  "timestamp": "ISO-8601 timestamp",
  "plan_step": 1,
  "title": "Run finished",
  "summary": "Actual outcome summary",
  "body": "Actual detailed result",
  "artifacts": [{"path": "/supported/workspace/report.md"}],
  "visualizations": [{"path": "/supported/workspace/plot.svg", "title": "Measured result"}],
  "metrics": {},
  "delta": {"sequence": 1, "status": "no_commit", "files": []}
}
```

Optional `preview` is HTML. Other observed types include `plan`, `progress`, `decision_request`, `report_back`, `budget_pause`, `decision_taken`, `plan_deviation`, and `plan_extension`. A completion is recognized specifically by `type:"completion"` or `"complete"` (203436). The latest-completion calculation scans backward and marks results stale after intervening non-critic, non-artifact-revision, non-flowback checkpoints (203439–203451).

GET `{base}/latest-completion` returns a checkpoint object directly, or `{}`/`null` for absent. The fallback converts it to category checkpoint and a `chk_###` ID (109224 onward; 213535 onward).

GET `/api/workspaces/{ws}/events` is the workspace SSE route. Reducer event names and payload fields (85584–85695):

| Event | Payload fields consumed |
| --- | --- |
| `experiment_created` | `eid,display_label,title,created_at,status,experiment_kind,eta,dispatched_by,user_id,allowed_actions` |
| `experiment_deleted` | `eid` |
| `experiment_renamed` | `eid,title` |
| `status_changed` | `eid,status,allowed_actions?` |
| `worker_alive_changed` | `eid,alive` |
| `outcome_changed` | `eid,outcome` |
| `eta_changed` | `eid,eta,anchor_shift?` |
| `checkpoint` | `eid,sequence,checkpoint_type,summary,body,timestamp,plan_step`; feed refresh also examines `rendered` |

Feed invalidation additionally subscribes to `narration`, `result_page_revised`, and `background_tasks_changed`. Worker transcript invalidation subscribes to `worker_conversation_changed`. Their complete payload schemas were not established; experiment ID is used for routing.

## Worker conversation, streaming, and control

Worker base: `/api/worker/{ws}/{eid}`.

| Method and suffix | Request |
| --- | --- |
| GET `/feed?offset=N&source=&session=` | Cursor-based worker transcript; response below. |
| POST `/message` | `{message,interrupt:false,client_message_id?,context_refs?}` |
| POST `/interrupt` | `{}` |
| POST `/model` | `{model}` |
| POST `/rewind` | `{event_id}` |
| POST `/artifact-chat` | Start artifact chat; response not resolved here. |
| GET `/artifact-chat/transcript?since=&variant=` | Artifact transcript. |
| POST `/artifact-chat/handoff` | Caller passes an object; complete fields not resolved here. |
| POST `/edit-session` | Begin edit session. |
| DELETE `/edit-session` | End edit session. |

Source: 129169–129248; worker polling 213255–213465.

Worker poll response:

```json
{
  "session_id": "worker-session-id",
  "events": [],
  "offset": 0,
  "source": "buffer",
  "mode": "snapshot",
  "rewind_generation": 0,
  "alive": false,
  "busy": false,
  "model": "configured model"
}
```

`mode:"snapshot"` replaces rather than appends. Rewind generation changes rebuild conversation state. A session change closes the previous stream. The UI caps worker events at 5,000. It opens `/api/agent/{session_id}/stream?offset=N` when `source === "buffer"` and `alive` is true, otherwise polls. Do not report a worker alive unless it actually is.

The shared streaming parser requires **named** SSE frames (129098–129168):

```text
event: event
id: 0
data: {"type":"text","text":"Actual agent output","id":"event-id"}

event: state
data: {"busy":false,"model":"configured model","durable_cursor":1}

```

`event:event` uses the numeric `id` as the durable event index and advances to index+1. `event:transient` is nondurable. `event:state` can include `durable_cursor_reset:true`; otherwise cursor only advances. `event:error` reads `error` or `message`.

Normalized conversation events consumed by the UI (106149–106219):

- `{type:"text"|"text_delta"|"text_snapshot",text,turn_id?,id?}`.
- `{type:"tool_use",tool,tool_use_id,input,experiment_eid?}`. `input` can be a JSON object or string. `activity_only:true` suppresses visible tool cards.
- `{type:"tool_result",tool_use_id,output,is_error?}`. Output must contain the real execution result.
- Optional result visibility/redaction fields are forwarded by both tool events.

The worker uses the shared conversation normalizer but filters internal tools and user roles (209027–209048). Coordinate user-text role mapping with the planner contract; this document does not redefine it.

## Report rendering and exports

The report surface is the experiment app, not necessarily a paper publication.

| Method and route | Behavior |
| --- | --- |
| HEAD `{base}/app/` | Live client checks existence and metadata headers. |
| GET `{base}/app/{path}` | Actual content bytes, with each path segment URL encoded. Base GET loads entry HTML. |
| GET `{base}/app-download` | Download current app package; optional `revision_id` or `expect_unsealed=true`. Archive format not established here. |

Headers read by `FI` (109245–109290):

- `X-Silico-App-Entrypoint`: report entry filename.
- `X-Silico-App-Pdf`, `X-Silico-App-Source`: optional companion paths.
- `X-Silico-App-Revision`: revision identifier.
- `X-Silico-App-Bridge`: edit integration enabled only when equal to `ready-v1`.
- `X-Silico-App-Portable-Html`: true only when equal to `true`.

Do not advertise the edit bridge before implementing its protocol. Real HTML may be served with no bridge. Results check app existence, preserve an iframe view, and fall back to registered completion widgets if available (211870–212075). The completion widget is recognized only for a registered `widget_kind` and supported payload version, defaulting to version 1 (196058–196070); arbitrary widget data is not enough.

## Files, code, and checkpoint diffs

GET `{base}/changeset` response consumed at 197620–197632:

```json
{
  "changes": [{
    "path": "/supported/workspace/research.py",
    "rel_path": "research.py",
    "in_worktree": true,
    "change_type": "added",
    "size": 120,
    "diff_available": true,
    "additions": 5,
    "deletions": 0,
    "internal": false
  }],
  "experiment_dir": "/supported/workspace",
  "worktree_root": "/supported/workspace",
  "tracked_files": [],
  "truncated": false,
  "worktree_scan_failed": false,
  "tracked_files_truncated": false
}
```

`_etag` is used for cache comparison. A record may have `fabric_id`. File UI maps `change_type`, `diff_available`, and size; relative path is used when `in_worktree` is true (197396). Non-worktree `rel_path` beginning `app/`, or `importance:"results_page"`, groups under results; others group under artifacts (199478).

- GET `{base}/file-diff?path=...&checkpoint=N` → `{diff:unifiedDiffString,truncated:false}` (43380, 196774–196785).
- GET `{base}/checkpoint-delta?checkpoint=N` → `{sequence,status,files:[{path,additions,deletions,internal,kind}]}`. `status:"no_commit"` or empty files hides the delta. Checkpoint artifact paths determine which changed files receive emphasis (203164–203315).
- GET `/api/feed/file?path=...` returns file bytes. Optional `raw=true`, `download=true`, `fabric_id`, `v=<revision>` (43256–43330). This must resolve only files the local workspace actually exposes.
- GET `/api/artifacts/browse?path=&offset=&limit=&cluster=`; GET `/api/artifacts/search?q=&type=&cluster=`; GET `/api/artifacts/stat?paths=<comma-list>&cluster=` (44090–44120). Full browse response schema remains unresolved.

Thread code repo base is `/api/workspaces/{ws}/threads/{thread}/repo` (109340–109430): GET base; GET `/tree?ref=&working_tree=true&path=`; GET `/file?ref=&path=&working_tree=true`; GET `/changes?path=&ref=&base=`; GET `/pr-status`, `/merge-tracking?after=`, `/sync-preview`, `/upstream-status`; GET `/archive?ref=`. Mutation helpers are POST `/publish` `{name?,make_public?:true}`, `/charter` `{edited_text}`, `/merge-tracking/sync` `{operation_id}`, `/push` `{}`, `/reseed` `{}`, `/sync` `{ref?}`. Presence of UI helpers does not authorize publishing or pushing during local rebuilding.

## Reports, publication, and sharing

Routes at 98406–98496:

| Method and route | Body / response |
| --- | --- |
| GET `/api/papers?status=&org_id=&q=&limit=` | **Direct array**, not `{papers:[]}` (246083). |
| DELETE `/api/papers/{pub_id}` | Delete paper publication. |
| POST `/api/papers/{pub_id}/publish` | `{}` or `{version}`. |
| POST `/api/papers/{pub_id}/access` | `{access}`. |
| GET `/api/papers/discovery/threads/{thread}/inventory` | Array of records containing `kind,id,label,diagrams:[],experiments:[]`; diagrams read `figure_id,title`; experiments read `eid,number,exp_title` (220551). |
| GET/PUT `{base}/artifacts/primary/sharing` | PUT `{visibility,revision_id?,restore_revision_id?,title?}`. |
| POST `{base}/artifacts/primary/versions` | `{label:null|string}`. |
| GET `/api/artifact-sharing/{artifact_id}` | Sharing metadata. |
| GET/PUT `/api/threads/{thread}/figures/{figure}/sharing` | Same PUT shape. |
| POST `/api/threads/{thread}/figures/{figure}/versions` | `{label:null|string}`. |

Paper rows (245980–246012) consume `pub_id,title,status,owner_user_id,updated_at,access,published_version,has_unpublished_changes,publication_kind,fronted_artifact_kind?`. Published state is `status:"published"`; publication routes are `/reports/{pub_id}`. Artifact index rows separately consume `artifact_id,kind,title,owner_user_id,updated_at,visibility`; routes are `/artifacts/{artifact_id}`.

The Reports route resolves publications through GET `/api/library/reports/{pub_id}` → `{artifact_id,is_owner}`, then loads `/artifacts/{artifact_id}/read` (247766–247872). GET `/api/library/artifacts` returns `{artifacts:[],next_cursor:null,truncated:false}` and accepts repeated `kind`, repeated `visibility`, `scope`, `q`, `cursor`, `limit`. GET `/api/library/artifacts/{id}` returns the artifact metadata including `store_kind`, `can_edit`, `workspace_id`, and `created_from:{thread_id,eid}`. GET `/api/library/artifacts/{id}/app` returns `{kind:"app",url}` (245862–245902); the reader probes that URL with HEAD and embeds it. DELETE `/api/library/artifacts/{id}` deletes the report. `fronted_artifact_id` on paper rows links publication and artifact rows for deduplication (246276–246303).

Sharing response consumed at 100207–100337:

```json
{
  "artifact_id": "artifact-id",
  "kind": "report",
  "visibility": "private",
  "can_publish": false,
  "publication": null,
  "pinned_revision_id": null,
  "diverged": false,
  "versions": []
}
```

Observed visibility values are `private`, `org`, `link`. Publishing to `link` must produce `publication.url`; the UI explicitly errors if no public URL arrives. `can_publish:false` disables publishing on a deployment. Version restore submits the chosen `revision_id`. `/api/view/{share-id}/experiments/{eid}` is the read-only public experiment base; it uses worker `/transcript`, files under `/file?path=`, and no experiment code-data access (43256–43330). This is not evidence that a local machine has a reachable public origin.

## Compute and training metrics

- GET `/api/slurm/experiment/{ws}/{eid}/jobs` returns at least `{jobs:[],discovered_jobs:0}`. The UI checks `jobs.length` and `discovered_jobs`; feed records may carry `slurm_jobs:[{job_id}]` (205787, 213490–213532).
- GET `/api/slurm/logs/{job}/info`; GET `/api/slurm/logs/{job}?stream=`; stream suffix `/stream?tail=&stream=`. Full log response schema not resolved here.
- GET `/api/wandb/experiment/{ws}/{eid}/metrics` accepts repeated `metrics` and optional `force=true`; GET `/table?run=&name=` (207310–207324).
- Metrics response consumers read `{available,reason,runs:[],key_metrics:[],series:{},source:{url,project}}`. Run entries read `metric_names:[],summary:{},media_names:[]`; full time-series and table schemas remain unresolved (208025–208095).

For a local backend without a GPU scheduler or W&B connection, return truthful unavailability and empty jobs. A real CPU process, its logs, and its produced metrics are still real execution, but must not be labeled as a remote Slurm allocation or a W&B run.

## Artifact transfer routes and remaining unknowns

Observed upload base `/api/artifact-store/uploads` (44120–44200): GET `?active_only=true`; POST `{destination,files}`; GET `/{id}`; POST `/{id}/resume` `{files}`; POST `/{id}/parts/sign` `{parts}`; POST `/{id}/parts/record` `{parts}`; POST `/{id}/empty/complete`; DELETE `/{id}`. Transfer base `/api/artifact-store/transfers`: POST `{destination}`, GET list, GET `/{id}/status`, DELETE `/{id}`. Imports support POST `/api/artifact-store/imports/{id}/resume` and `/links` `{links}`. Multipart descriptor and signed-URL response fields were not established.

The static bundle proves client route construction, required consumed fields, and frontend state transitions. It does not prove backend persistence layout, scheduler configuration, original worker prompts, source retention policies, idempotency rules, report sealing internals, or exact authorization checks. Those should be implemented explicitly in the rebuild and tested against the recovered frontend, rather than presented as recovered server source.

## Local implementation and verification

`backend/experiments.py` implements the executable subset described above against the actual local runner and SQLite store. It launches independent workers with the approved plan and copies registered input attachments and source trees before execution. It persists experiment state, actual checkpoints, workspace SSE, registered-file reads and diffs, completion cards, report editing through the worker session, immutable local report versions, explicit publication/revocation, and the Reports library navigation APIs. User edits execute the real runner and report revisions are emitted only when the actual report inventory changes. Saved revisions restore the displayed report and its assets without overwriting the worker's live research files.

Publication URLs are **localhost URLs**, not internet hosting. GPU scheduler/W&B endpoints truthfully report no connection. Outcome classification is persisted through the local extension `POST|PUT {base}/outcome` with `{outcome:null|"null"|"signal"|"partial_signal"|"inconclusive"}`; the recovered frontend instead shows an MCP `mcp__experiments__record_outcome` tool with those labels (110873–110893), and no corresponding original HTTP mutation was found. This extension must not be described as a recovered original route.

`tests/test_experiments.py` verifies actual deterministic child-process execution and files, independent worker creation and idempotency, compatible IDs and transactional legacy migration, source attachment copying, persisted reloads, named SSE events, file confinement and symlink refusal, real added/deleted-file diffs, report escaping, loopback HTTP HEAD/feed/publication/library contracts, immutable snapshots and restore with nested assets, revocation, and actual report-edit continuation. These are execution/protocol tests, not a claim that a model run or the entire recovered UI was validated by these tests. Root integration work separately validates the installed model and recovered UI.

### Report editing bridge

The recovered full-screen report editor requires a real document reference from `POST /api/worker/{ws}/{eid}/edit-session` and `GET /api/docs/state?ref=report:{ws}:{eid}`. The latter exposes actual HTML `content`, its SHA-256 `sha`, `revision_id`, and ownership through `can_edit` (136588–136643, 198790, 248438). The agent composer is gated on both the document reference and `X-Silico-App-Bridge: ready-v1` (199020–199067). A header alone does not implement the bridge.

`backend/report_bridge.py` injects a local implementation into served reports, while stored/exported reports remain uninjected. It answers the observed `silico-app-health-check` nonce with actual document/runtime health via `silico-app-ready`, reports height, reads text for search, sends selected quotes, and handles `silico-print` with the browser's print dialog (94214, 134197, 198950). CSP keeps the report in an opaque-origin sandbox with scripts and print modals, without same-origin or network access. The original PDF button is a browser print path for HTML reports, not a missing backend PDF generator.

Stable documents support native text editing, capture, undo/redo, revert, and the observed full-content save branch. Script-generated reports refuse inline editing and retain the actual worker chat instead. POST `/api/docs/lease`, `/heartbeat`, and `/release` use an expiring local single-user lease. POST `/api/docs/edits` checks the actual current SHA and worker inactivity, atomically writes the report source without following symlinks, registers its new hash, and preserves immutable before/after versions. Markdown wrapper edits are converted back to actual Markdown source. Concurrent stale saves return `stale_base`; lost leases and active workers return their observed error reasons (137295–137520). Whole-document saves are supported; proprietary per-block operations and inline turn-diff decorations are explicitly unavailable, with version restoration as the alternative. The source protocol supports both forms (136615–136637); this implementation does not invent block anchor semantics.

### Independent forks

`backend/forks.py` implements the observed POST `/api/workspaces/{ws}/threads/{thread}/fork` and GET job status routes (98929, 122767). It copies actual transcript, execution evidence, registered files, experiment checkpoints and private report versions into fresh application identifiers. Provider resume IDs are cleared; continuation reads a durable copied-context file and starts a fresh provider session. The chosen message/turn cursor truncates the planner transcript. Files are explicitly a snapshot at fork time, not reconstructed historical files; unavailable or changing files appear in the copy manifest. Publications are not inherited. Four deterministic subprocess tests cover cursor selection, independent continuation, actual experiment copying, and missing/symlink input confinement. The opaque original `.sil` import format remains unestablished from client source, so no invented compatible import is claimed.
