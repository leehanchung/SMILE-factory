# REA Astra — Silico research workspace

A local reconstruction of Silico's research workflows, using the recovered hosted
web client and an independently implemented Python backend. Research is executed
by the installed Codex CLI: planner turns, approved workers, continuation, and
artifact edits run real tools in persistent workspace directories.

The investigation follows the [REA skill](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/SKILL.md).
Desktop target: `/Applications/Silico.app` 0.137.0. Hosted target: the public
static application loaded by the installed app, acquired on 2026-11-10 UTC.
The original hosted server implementation was not recovered; the compatibility
service is derived from the client's consumed contracts and observed UI behavior.

## Run

Requires Python 3.11+, Node 20+ for legacy tests, and an installed, authenticated
`codex` CLI on PATH. No additional Python or npm dependencies are needed for the service. For the hosted preview, acquire the client assets locally using the steps in [Evidence and reproduction](#evidence-and-reproduction).

```sh
cd apps/rea_astra
make serve
```

Open [the local app](http://127.0.0.1:8744/), then choose **Open local workspace**.
The existing Codex login supplies inference; no Goodfire/GitHub login is needed.
The model selector reports the CLI default, not Silico's hosted model catalog.
`PORT=8750 make serve` selects another port. Stop with Ctrl-C.

For the current integration-test workspace, which contains actual completed runs:

```sh
python3 -m backend.app --port 8744 --data-dir .local/research-v2
```

The normal data directory is `.local/research`; SQLite stores threads, messages,
events, plans, checkpoints, settings, and publication revisions. Actual code and
attachments live under `workspaces/<thread-id>/`. Browser reloads and server
restarts retain these files and records. Interrupted processes are recorded as
interrupted, never silently reported as completed. A restarted run explicitly
resumes its recorded Codex session ID.

## Implemented workflows

- Create folders and threads, select planner/worker roles, rename, archive, pin,
  move, and export research.
- Run a real planner with streaming text and tool events. A generated
  `research-plan.json` becomes the original UI's plan approval card.
- Approve a plan or enable Auto-research to launch an independent worker with
  the approved instructions and copied input files.
- Execute code, register actual artifacts, inspect worker transcripts, view
  generated HTML/Markdown reports, inspect source and checkpoint diffs, and
  continue or interrupt execution.
- Fork completed research into an independent thread with copied files and history,
  then continue using a new provider session.
- Queue follow-up messages durably; use original report edit/chat flows to
  modify the real worker's report and record revisions.
- Upload actual file bytes, browse registered files, add public GitHub code,
  fetch arXiv PDFs, and attach public Hugging Face metadata.
- Save immutable local report publications and ZIP exports, restore revisions,
  revoke links, and browse published reports in the recovered Reports view.

The service binds to loopback. Publication links are **local URLs**, not internet
hosting. Codex uses its `workspace-write` sandbox with approval mode `never`;
requests that require a different permission fail rather than bypassing it.
Source downloads use bounded public endpoints. Generated HTML runs with a
sandboxed content policy. This is a single-user local application.

## Boundaries

This does not recreate Goodfire's managed GPU cluster, Slurm, W&B, billing,
organization access control, remote credential storage, or hosted model routing.
Those integrations require separate infrastructure and return explicit unavailable
states here. Private GitHub/Hugging Face access is not implemented. Hugging Face
selection acquires metadata; it does not silently download model weights or
large datasets. Uploads are bounded by the server's 20 MiB request limit.

Exact proprietary `.sil` import/export and provider-level rewind are unresolved.
Thread exports are explicitly ZIP files containing transcripts and real artifacts.
The UI has more routes than this service implements; unimplemented operations
return errors. See the validation report for flows exercised end to end and
remaining gaps; passing contract tests alone is not full hosted-service parity.

## Evidence and reproduction

Public artifacts and build outputs stay Git-ignored. Existing artifacts in this
worktree can be rebuilt with `make build`. To reacquire from an explicitly chosen
live workspace shell:

```sh
python3 scripts/acquire_hosted.py 'https://HOST/workspace/WORKSPACE/new'
make build
```

The acquisition follows literal static references, saves hashes/provenance, and
does not use browser tokens or request hosted research APIs. The build records
presentation-only local login substitutions and preserves source hashes.

| Document | Contents |
| --- | --- |
| [Hosted frontend](docs/hosted-frontend.md) | UI assets, boot, models, planner and source contracts |
| [Experiments and reports](docs/hosted-experiments.md) | Worker, checkpoint, file, report and library contracts |
| [Sources](docs/hosted-sources.md) | Live GitHub, arXiv and Hugging Face validation |
| [Backend](docs/backend-design.md) | Real executor, persistence and isolation |
| [Desktop main](docs/main-process.md) | Original desktop auth, IPC, gateway and SSH architecture |
| [Desktop renderer](docs/renderer.md) | Original shell state and forms |
| [Method](docs/method.md) | REA evidence, identifiers and analysis limits |
| [Validation](docs/validation.md) | Checks and observed end-to-end behavior |

`make check` runs project Python tests and legacy JavaScript tests. `make extract`
and `make analyze` reproduce the desktop investigation. `make legacy-preview`
serves the earlier simulated shell/workspace on port 8743 solely as an archived
UI experiment; it is not the default research app.
