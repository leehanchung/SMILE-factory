# Hosted source integrations

The recovered frontend calls `backend/sources.py` through `SourceService.route`.
Uploads and selected public inputs produce real files; no generated search hits,
repository checkouts, credentials, or downloaded datasets are substituted.

## Verification

Twelve offline unit tests in `tests/test_sources.py` passed. They cover binary
multipart preservation, path confinement, upload-to-planner copying, browse
envelopes, actual fixture checkout files, PDF acquisition, Hugging Face metadata,
credential rejection, and failed acquisition without a success record.
They also verify experiment/artifact uploads resolve to the worker thread and
deleted prepared inputs are not reported as still available.

An actual network smoke run also succeeded for all three services. It used
anonymous public endpoints, with no browser session or account tokens:

| Public input | Observed result |
| --- | --- |
| `octocat/Hello-World` | GitHub API metadata; real shallow HTTPS clone; README copied into the planner thread's source directory |
| arXiv `1706.03762v7` | Atom metadata and actual PDF, 2,215,244 bytes |
| Hugging Face `openai-community/gpt2` | Public model metadata, including 26 sibling-file records, stored as JSON in the planner thread |

Evidence is retained locally in ignored
`evidence/hosted-source-smoke/results.json` and its adjacent store. The fetched
README SHA-256 is
`03ba204e50d126e4674c005e04d82e84c21366780af1f43bd54a37816b6ab340`.
The PDF SHA-256 is
`bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697`.
The sorted Hugging Face metadata JSON SHA-256 recorded during that run is
`6e21f91076abb98eee5332085418bbac46a0128458974e302bdff64c280ce8d8`;
that API response is changeable. This verifies service acquisition and local
files, not a completed browser-driven research experiment.

## Original client contracts

Evidence references below are line numbers in the ignored formatted derivative
`evidence/hosted-static/index.formatted.js`; its original artifact identity is in
`hosted-frontend.md`.

| Endpoint | Request / response consumed by the client |
| --- | --- |
| `POST /api/upload` | Multipart `file`, optional `thread_id`, `project`, `experiment_eid`, `artifact_id`; client takes response `.path` |
| `GET /api/artifacts/browse` | Optional `path`, `offset`, `limit`, `cluster`; `{entries,total,truncated}` |
| `GET /api/artifacts/search` | `q`, optional `type`, `cluster`; `{results,truncated}` |
| `GET /api/artifacts/stat` | Comma-separated `paths`; `{results:[{path,exists,is_dir,size,modified}]}` |
| `GET /api/team/github/search` | `q`; plain array of GitHub repository records with `full_name`, description, timestamps |
| `GET /api/team/github/my-repos` | `{connected:false,repos:[]}` because no account is connected |
| `GET /api/team/github/branches` | `repo`, optional `q`; `{default_branch,branches:[string]}` |
| `POST /api/team/resources/preflight` | `{url}`; `{exists,detected_type:'github_repo',access_status:'ok'}` when anonymously verified |
| `GET /api/team/resources` | `workspace_id`, optional `thread_id`; `{resources:[...]}` |
| `POST /api/team/resources` | `workspace_id` query; `{url,type:'github_repo',visibility,description,name}`; `{resource,needs_github_connection:false}` after checkout |
| `POST /api/team/resources/:id/verify` | Rechecks public metadata, returns checkout/resource fields |
| `DELETE /api/team/resources/:id` | Removes the resource listing; retains acquired files |
| `GET /api/arxiv/search` | `q` title/query/URL/ID; plain array `{id,title,abstract,authors:[],year,categories:[],url,pdf_url}` |
| `GET /api/huggingface/search` | `type=model|dataset`, `query`; plain Hub API record array |
| `GET /api/huggingface/status` | `{token_set:false}` |
| `GET /api/huggingface/check` | `type`, `id`; `{accessible,reason}`; gated/private inputs are blocked |

Entry records for file browsing are `{name,path,size,modified,is_dir:false}`.
`modified` is the actual file mtime in Unix seconds; the renderer multiplies it
by 1,000 before constructing a JavaScript date (F:117167–117168).
Browsing lists registered local research files, rather than the user's entire
computer. Source directories from GitHub are selected through the GitHub
resource list. File retrieval is implemented separately through `/api/feed/file`
with the confined absolute path.

Relevant consumers: F:44092–44120 (files), F:46207–46216 (upload),
F:117765–117797 (arXiv), F:117945–117959 (GitHub), F:118300–118317 and
118590–118648 (repository attachment), F:119168–119192 (Hugging Face),
F:119251–119263 (HF reference), F:129320–129335 (upload prompt assembly).

## From picker to planner

The upload helper returns a path string, not a resource object. It appends:

```text
The user attached files. Use the Read tool to view them:
- /absolute/local/workspace/uploads/generated-name
```

A thread-specific upload is already inside that thread's working directory.
Experiment and artifact uploads resolve their IDs to the corresponding worker
thread, including the artifact-chat form that deliberately omits `thread_id`.
When upload precedes thread creation, the backend places it in a dedicated
workspace source-cache thread. `prepare_inputs(session, body)` recognizes only
registered paths in the submitted message and copies those files into the new
planner's working directory before execution. Its returned context lists the
actual copied paths. Repeated attachment preparation reuses those paths.

Picker references travel in `context_refs` and retain camelCase fields such as
`resourceType`, `resourceUrl`, `checkoutPath`, and `attachmentKind`. A GitHub
reference uses `type:'resource'`, `attachmentKind:'code'`, and its checkout path
as `value`, plus the public repository URL. The client enables attachment only
when `checkout_status === 'ok'`. The add request therefore performs an actual
shallow clone before returning success. Selecting it copies ordinary source
files into a new `source-*` directory in the planner thread. Symlinks and hidden
paths, including `.git`, are excluded from this copy; the original clone remains
in the cache.

arXiv references use the abstract-page URL and carry a display summary. On
submission, the backend fetches current metadata and the PDF into the planner
working directory. HF references use `hf://owner/name`, with `attachmentKind`
`model` or `data`; submission fetches live public model/dataset metadata into a
JSON file. Explicit `base_repo`/`base_ref` selections use the same public clone
and source-copy mechanism.

Root integration must call `prepare_inputs` before `runner.start`, passing both
the context fields and the complete submitted message, and append the returned
context to the prompt. The frontend supplies paths; the backend does not need a
synthetic tool response to expose them.

## Bounds and unsupported behavior

- Public HTTP requests allow only HTTPS `api.github.com`, `huggingface.co`,
  `export.arxiv.org`, and `arxiv.org`; generated URLs are provider-specific.
  Requests reject redirects, use no ambient proxy, cookies, or credentials,
  and cap metadata at 2 MiB and individual public downloads at 25 MiB.
- Git clone uses only validated `github.com/owner/repo` URLs, disables user and
  system Git config, credential helpers, hooks, prompts, recursive submodules,
  file protocol, redirects, and LFS smudging. Metadata rejects repositories
  above 50 MiB; clone is bounded by 90 seconds and a monitored 100 MiB checkout.
- File storage rejects traversal and symlinks and uses exclusive writes.
  SourceService caps an individual stored input at 100 MiB. At verification,
  the HTTP server's 20 MiB request-body limit was the effective upload limit
  including multipart overhead; the original frontend advertises 200 MiB.
- Private GitHub repositories, OAuth login, and account repository lists are
  unsupported. The connect endpoint returns an explicit error. Public search,
  branch discovery, preflight, and cloning work without claiming authentication.
- HF gated/private models require unsupported credentials. Metadata acquisition
  does **not** download model weights, whole datasets, or claim such files are
  available locally. Those metadata records identify the actual upstream files
  for a later explicitly requested bounded acquisition.
- Hosted cluster files, arbitrary filesystem browsing, GPU provisioning, and
  object-store multipart transfer are not implemented by this source service.
  Provider rate limits, missing repositories, and download failures are returned
  as errors, rather than successful empty placeholders.

## Reproducing the static frontend archive

`scripts/acquire_hosted.py` takes the exact operator-selected HTTPS entry URL as
its positional argument. It captures a static module shell, recursively follows
only explicit same-origin static references, and saves artifact hashes and
reference provenance. It never reads credentials or probes guessed APIs/maps.
An offline replay against the previously captured responses reproduced all 193
original static asset SHA-256 values; the one nonasset example path again
returned an HTML fallback and was discarded.
