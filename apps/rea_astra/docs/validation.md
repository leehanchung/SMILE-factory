# Validation

The default app is now the recovered hosted UI plus a real local execution
service. The earlier synthetic preview is retained under `make legacy-preview`
and its JavaScript tests are separate from real-service validation.

## Actual model and browser runs

Tested on 2026-11-10 UTC using the installed Codex CLI (0.147.0, existing ChatGPT
login), Python, SQLite, and the recovered frontend at `http://127.0.0.1:8744/`.
The test database and actual output files are under `.local/research-v2/`.
No hosted research task was submitted to Goodfire; native Silico observation was
read-only. Public static assets and selected public source content were acquired.

| Flow | Observed result |
| --- | --- |
| Open local workspace | Original frontend boots against local API; workspace IDs and folder contracts validated |
| Planner → approval | Real Codex tools wrote `research-plan.json`; original UI displayed an approval card; card survived server restart |
| Approve → independent worker | UI Launch started separate persistent worker directory; Python generated code, CSV, Markdown and HTML |
| Worker continuation | Original Worker composer resumed the recorded native session, executed updated code, and added sample variance to both reports |
| CSV upload → Auto-research | Original uploader submitted actual 39-byte CSV; planner and worker retained byte-identical inputs; auto plan launched a real worker |
| Generated report and code | Original Report iframe rendered actual HTML/SVG; Code listed and displayed generated Python and data; worker transcript showed real tool events |
| Public GitHub input | Original source picker acquired `octocat/Hello-World`; real agent read exact README bytes and computed the matching SHA-256 |
| Local publication | Original Share control created immutable local report URL; independent tab rendered saved content; Reports inventory reopened the report |
| Persistence | Threads, inputs, plan, experiments, continuation, files and reports survived server restarts and browser reloads |
| Report editor agent request | Original Ask for edits composer resumed the worker, changed the actual HTML/Markdown/generator, preserved all measured values, and automatically refreshed the report iframe on the next edit; immutable publication retained its original contents |
| Independent fork | Original Fork dialog copied nine files plus transcript/checkpoints into `verification`; real continuation used a different provider session and correctly read slope 2/intercept 1/count 8 without rerunning |
| Folder creation | Original New folder control created a durable `verification` workspace and navigated its composer |

The first actual computation returned mean **3.0** and population variance
**2.0** for `[1,2,3,4,5]`. A real continuation returned sample variance **2.5**.
The second computation fitted the uploaded data: **8 observations, slope 2,
intercept 1, R² 1, SSE 0**. We independently recomputed the fit with
`statistics.linear_regression`, compared every CSV row and residual, and compared
the input file bytes; this verification does not rely on the model's own success
claim. Records: `evidence/end-to-end/regression-verification.json` and
`evidence/end-to-end/report-edit-verification.json`.

Uploaded data SHA-256:
`48e688cd2789b016e612a63614fd8da902c2b7bb6971f7e4447123da1fb6f118`.
GitHub README SHA-256:
`03ba204e50d126e4674c005e04d82e84c21366780af1f43bd54a37816b6ab340`.
Live public arXiv metadata/PDF and Hugging Face metadata checks are recorded in
[hosted-sources.md](hosted-sources.md).

## Automated verification

`make check` passed **98 Python service tests and 14 legacy JavaScript tests** on
2026-11-10 UTC. The
Python integration fixtures launch real deterministic subprocesses to exercise
process and storage contracts; those fixtures are explicitly not model-quality
benchmarks. The actual Codex runs above are independent of those fixtures.

Coverage includes:

- Native event projection/replay, actual file registration, exact provider-session
  resume, failed turns, timeout, output bounds, cancellation and orphan cleanup.
- One active turn per thread, global capacity, durable FIFO, retry deduplication,
  interrupted dispatch, callback finalization, and deletion/movement races.
- Real generated-plan parsing, review/revision/acceptance, persistent state,
  selected-source failure propagation and cross-workspace ownership checks.
- Multipart bytes, registered-file confinement, symlink rejection, no-follow
  reads, bounded public downloads, source snapshots and worker input copies.
- Report bridge health, SHA-guarded full-document saves, lease expiry and unsafe
  write rejection; independent forks preserve evidence and reset provider identity.
- Checkpoints, report revisions, immutable local publication, nested report
  assets, restore/revocation, real diffs/deletions, exports and library routing.
- Host/Origin protection, CSP, static SPA serving, MIME handling, actual model
  settings, instructions, folders and audited local UI presentation patches.

## Remaining boundaries

This verifies a local end-to-end research implementation, not equivalence to the
original hosted server. Managed GPU/Slurm/W&B, organization permissions, billing,
private-provider credentials and internet publication are not implemented.
Provider-level exact rewind and proprietary `.sil` archives remain unresolved;
thread exports are honest ZIP files. Unsupported operations return explicit
errors; they do not report synthetic execution or remote success.

The browser-control file chooser stalled during automation even though it
ultimately selected the file. Actual submission and byte preservation were
verified afterward. Not every visible settings/control has a browser-level
interaction test. Test coverage and observed behavior are distinguished above.
