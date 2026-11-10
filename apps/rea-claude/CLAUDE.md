# CLAUDE.md: apps/rea-claude

Rea Claude is a clean-room TypeScript reimplementation of the Silico desktop
connection manager (Goodfire, Electron, v0.137.0), derived with REA-assisted
reverse engineering. Node/npm project (not uv), independent of the rest of the monorepo.

## Commands (run from this directory, or `make -C apps/rea-claude <target>`)

- `make install`: `npm ci`
- `make dev`: run the app with hot reload (`electron-vite dev`)
- `make test`: vitest (main-process tests in `tests/main`, renderer tests in `tests/renderer` with jsdom, contract tests in `tests/shared`)
- `make typecheck`: `tsc` for the node (main/preload/shared) and web (renderer) projects
- `make check`: typecheck, then test, then build. Run this before declaring work done.
- `make package`: unsigned macOS `.app` in `dist/` (electron-builder `--dir`)

## Layout

- `src/shared/`: **contract**. `ipc.ts` (every channel and payload type, `SilicoApi`, `SilicoDesktopApi`) and `config.ts` (endpoints, timeouts, identity). Channel names must stay identical to the original; `tests/shared/rea-inventory.test.ts` enforces this against `docs/evidence/rea-ipc-inventory.json`.
- `src/main/`: main process. `index.ts` bootstraps a lazy `MainContext` (`services.ts`). One folder per area (`auth`, `connections`, `ssh`, `lab`, `windows`, `bridge`, `settings`, `updater`, `app`). Areas never import each other; they call `ctx.<service>`.
- `src/main/ipc/trust.ts`: the only way to register IPC (`handleShell` / `handleLab` / `onLab`). Never call `ipcMain` directly.
- `src/preload/`: `index.ts` exposes `window.silico` to the shell UI; `lab.ts` exposes `window.silicoDesktop` to remote Lab pages. Sandboxed: import only `electron` and `@shared`.
- `src/renderer/`: React 19 UI. Hash picks the root (`#settings-modal/<tab>`, `#viewer`, else `App`). Pure logic lives in `src/lib/`, styles in `src/styles/`.

## Rules

- **Behavior source of truth is `docs/spec/*.md`.** When changing behavior, check the spec's evidence ledger. Intentional deviations are listed in `docs/architecture.md` §7. Add any new one there.
- **Clean room:** never paste code or assets from the original Silico bundle into this tree.
- **Never touch the real Silico's data:** userData is `rea-claude`. The updater stays off unless `REA_CLAUDE_UPDATE_URL` is set. Don't register `silico://` with the OS unless `REA_CLAUDE_REGISTER_PROTOCOL=1`.
- Tests must not spawn real `ssh`/`docker`, touch `~/.ssh`, or hit the network. Inject runners, clocks, and fs roots.

## Docs

- [`README.md`](README.md): what it is, how to run it
- [`docs/reverse-engineering.md`](docs/reverse-engineering.md): target, REA runs, evidence, clean-room process, unknowns
- [`docs/architecture.md`](docs/architecture.md): process model, services, ownership, startup order, decisions/deviations
- [`docs/spec/`](docs/spec/): eight behavioral specs with line-cited evidence ledgers
