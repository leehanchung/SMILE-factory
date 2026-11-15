# Investigation method and reproduction

Investigation date: 2026-11-09 (America/Los_Angeles). Target: installed
`/Applications/Silico.app`, version 0.137.0, bundle `ai.goodfire.silico`.
Worktree: `codex/rea-astra`, based on `017f43d`; original checkout edits were
not copied or modified. No commit, push, or pull request was made.

## Hosted workspace follow-through

The initial desktop-only investigation and simulated preview below are historical.
The default application now uses the actual recovered hosted frontend and a real
local research service. See [hosted contracts](hosted-frontend.md),
[experiments](hosted-experiments.md), [sources](hosted-sources.md), and
[validation](validation.md). Public static acquisition preserved 193 original
asset hashes; the generated local build records presentation substitutions.
Original hosted backend internals remain inferred from client contracts.

## REA skill and tools

Applied the upstream [reverse-engineer-anything skill](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/SKILL.md)
(reported skill version 62), plus its JavaScript and connection-recovery guides.
No REA MCP tools were connected, so the skill's existing-CLI fallback was used.
The installed `rea-agents` package was version 6.8.0. Commands were run from a
temporary/trusted directory outside the target, using absolute target paths.
No global MCP registration or analysis-engine installation was performed.

The observed Node runtime was v24.2.0, older than the package's declared engine
range. The CLI did run and returned evidence; this environment discrepancy is
recorded, not treated as a supported-runtime certification or a proven cause of
the renderer timeout. For fresh reproduction use the Node range declared by
your installed REA package.

1. Read the bundle plist and ASAR index.
2. `scripts/extract.py` inventories all 5,797 members, checks declared file
   SHA-256 values, and extracts 17 non-dependency files. It rejects traversal,
   out-of-bounds members and mismatched integrity; links and unpacked members
   are listed but never followed. It does not execute packaged code.
3. An initial REA selection including CSS was rejected as unsupported; the
   selection was corrected to manifests/JavaScript/HTML.
4. REA analyzed the original ASAR with six selected files. The renderer hit
   its 300,000 ms per-source deadline. Complete returned partial evidence is
   retained in `evidence/rea-summary.json` (despite that historical filename,
   this is a large error envelope containing `details.partial_observation`).
5. A focused run against the extracted tree selected package.json, main, and
   both preloads. It finished successfully. Its complete evidence is
   `evidence/rea-core.json`, and the delivery summary is
   `evidence/rea-core-summary.json`. The directory digest differs from the ASAR
   digest; extracted member hashes establish their relationship.
6. Direct source inspection traced architecture and renderer behavior. The
   renderer already has readable names/comments/lines. Main was formatted
   into `evidence/main-analysis/main.js`; the report records that derivative's
   exact hash, so formatting changes cannot silently alter citation identity.
7. Read-only computer-use observation of the installed app confirmed a hosted
   research workspace. No research was submitted or lab lifecycle action taken.
   See `runtime-observation.md` for the exact scope.

## Evidence interpretation

`docs/evidence-ledger.json` is a compact projection of the saved evidence, with
file hashes and original REA IDs. The core run observed 77 literal IPC channels,
133 IPC operations, 55 renderer transmissions, 24 renderer listeners, and 54
main handlers. These are static syntax counts. A successful command does not
mean complete semantic recovery: the per-file semantic node ceiling and dynamic
expressions leave explicit unknowns. Zero automatically detected sender-validation
observations does **not** prove there are no checks: source inspection found the
wrapper checks documented in `main-process.md`.

The original-ASAR partial record is
`ev_673e8adf8c4594e03c381790adb3ea654af32abb36d1e80113e09589b9b646b0`.
The focused core record is
`ev_f71aae132f88a9225fd833b9e4bd0806249f13866d9684a79698549d01f46979`.
These IDs identify the saved records, not an active MCP session.

## Re-run

From this app directory:

```sh
make extract                          # refuses to overwrite an existing extraction
REA=/absolute/path/to/rea make analyze
python3 scripts/analyze.py --rea /absolute/path/to/rea --include-renderer
```

The first analysis command is the focused core run. The second is optional and
includes the renderer; expect greater resource use. Every run writes a new
timestamped evidence directory, including the command, exit status, progress,
and full output. The analyzer never automatically executes installer/setup or
target code. Review its help if a different REA release changes its schema.

To regenerate a compact ledger from the current evidence:

```sh
python3 scripts/summarize_evidence.py evidence/rea-summary.json evidence/rea-core.json --output docs/evidence-ledger.json
```

Extracted code, fonts, vendor material, generated preview, and complete large
evidence are ignored by Git; authored reconstruction sources, tools, compact
ledger and reports are reviewable files. Rebuilding the recovered shell requires
the locally installed app. The earlier workspace simulation uses authored source and remains only under `make legacy-preview`. The default hosted workspace uses recovered assets and an independently authored real backend.

## Checklist and limits

| Question | Status | Evidence |
|---|---|---|
| What is installed and what is bundled? | Answered | Plist, full index, hashes |
| How do shell, preload and main communicate? | Answered within static scope | REA core + source reports |
| How do auth, local, managed and SSH flows work? | Answered within static scope | Main-process source trace |
| What are the shell UI and state contracts? | Answered within static scope | Renderer source trace |
| What does the research workspace look like? | Hosted UI recovered; threads, reports, workers observed | Public static assets and read-only native UI |
| Can the desktop shell be exercised locally? | Implemented with fixtures | Recovered renderer + mock bridge |
| Can the visible workspace workflows execute locally? | Real planner/worker, inputs, reports and continuation implemented | Recovered hosted UI + Python service; see validation |
| What runs research/models/experiments? | Original server unknown; local replacement executes Codex and real subprocesses | Client contracts + local run records |
| Do real SSH/auth/security/update paths work end to end? | Not tested | Requires separate integration environment |

The reconstruction is a bounded local deliverable, not a claim to reproduce the
unavailable research backend. The legacy preview retains simulated answers and lab outcomes. The default research service executes real inference and experiments; it does not impersonate original authentication, SSH, billing or managed compute.
