# Reverse-engineering report: Silico.app 0.137.0

This document records **how** Rea Claude was derived from the shipped Silico
desktop app: the target, the tools, the evidence, the clean-room process, and
what is still unknown. The behavioral results live in [`spec/`](spec/); the
design of the rebuild lives in [`architecture.md`](architecture.md).

## 1. Target identification

| Fact | Value | Source |
|---|---|---|
| Bundle | `/Applications/Silico.app` | filesystem |
| Bundle id | `ai.goodfire.silico` | `Contents/Info.plist` |
| Version | `0.137.0` (`CFBundleShortVersionString` and `CFBundleVersion`) | `Info.plist` |
| Vendor | Goodfire (`NSHumanReadableCopyright`) | `Info.plist` |
| Runtime | Electron 43.8.3 / Chrome 150.0.7871.250 | `strings` on `Electron Framework` |
| App code | `Contents/Resources/app.asar`, integrity SHA-256 `26e4d4d1…6be703` (`ElectronAsarIntegrity`) | `Info.plist` |
| npm package | `silico-desktop`, "Silico desktop connection manager", `UNLICENSED` | `app.asar:/package.json` |
| Entry points | `out/main/index.js` (main), `out/preload/index.js` (shell bridge `window.silico`), `out/preload/lab.js` (Lab bridge `window.silicoDesktop`), `out/renderer/index.html` + one Vite chunk | asar listing |
| Runtime deps | `react`, `react-dom`, `@carbon/icons-react`, `electron-updater` | `package.json` |
| URL scheme | `silico://` (`CFBundleURLTypes`) | `Info.plist` |
| Update feed | generic provider, `https://ddtqf80bu4kgq.cloudfront.net/stable` | `Resources/app-update.yml` |

The bundle layout (`out/main`, `out/preload`, `out/renderer`) is the
electron-vite convention, which is why the rebuild uses electron-vite too.

## 2. Tooling: REA (Reverse Engineer Anything)

The investigation followed the [`reverse-engineer-anything`](https://github.com/morluto/rea)
skill (v61). Its routing rule for an ASAR or extracted Electron tree is
`analyze_javascript_application`. No REA MCP server was registered in this
environment, so the skill's documented CLI fallback was used:

```bash
npx -y rea-agents@latest analyze-javascript-application <dir> --json
```

Runs, in order:

| # | Input | Result |
|---|---|---|
| 1 | Whole extracted asar (incl. `node_modules`) | `provider_timeout` after the default 300 s per-source budget, while parsing `react-dom` development builds. Partial evidence only. |
| 2 | App code only (`out/**` + `package.json`, fonts removed), 900 s budget | `provider_timeout` on the 713 KB minified renderer chunk. |
| 3 | `--source-path out/main/index.js out/preload/index.js out/preload/lab.js` | **Complete.** Evidence `ev_4ae4b4f6…16839f97`, authority `shipped-artifact`. |

Run 3's summary (observed by AST static analysis, confidence `exact`):

- 4 `BrowserWindow` constructions, 9 explicit `webPreferences`, 3 preload entry points, 2 `contextBridge` APIs (`silico`, `silicoDesktop`).
- IPC: 133 operations over **77 literal channels**, 54 main handlers, 55 renderer transmissions (**all paired**, none ambiguous or unpaired), 24 renderer listeners, 1 dynamic channel operation (the `y(channel, fn)` registration wrapper).

The channel inventory is exported to
[`evidence/rea-ipc-inventory.json`](evidence/rea-ipc-inventory.json) and is
enforced by `tests/shared/rea-inventory.test.ts`. The rebuild's
`@shared/ipc` declares exactly those 77 channels: none missing, none invented.

REA's limitations, as it reported them: the three selected sources leave the
renderer chunk and package metadata outside relationship analysis, and the
dynamic channel expression is not paired by textual similarity. The renderer
was therefore analyzed manually (below).

## 3. Manual static analysis

The minified bundles were pretty-printed with Prettier (main 7.8k lines,
renderer 23k lines including React, CSS 2.6k lines) in a scratch directory
outside the repository. Eight analyst subagents then each traced one subsystem
end to end and wrote a spec with an evidence ledger (line-cited, every claim
marked **Observed** or **Inferred**, unknowns listed):

| Spec | Subsystem |
|---|---|
| [`auth.md`](spec/auth.md) | Loopback browser sign-in, refresh tokens, `identity.json`, sign-out revocation queue, signup view, deep links, return nonces |
| [`connections-ssh.md`](spec/connections-ssh.md) | `connections.json`, `~/.ssh/config` parsing/appending, host-key scan/accept, `lab:test`, ssh invocation |
| [`lab-lifecycle.md`](spec/lab-lifecycle.md) | Route modes (cluster / managed / local), remote `silico` CLI over SSH, tunnels, phases, cancel, discovery |
| [`windows-labview-menu.md`](spec/windows-labview-menu.md) | Windows, Lab `WebContentsView`, viewer windows, recovery/watchdog, compact mode, menu |
| [`lab-bridge.md`](spec/lab-bridge.md) | `window.silicoDesktop`: notifications, badges, shell events, OAuth/checkout returns, permissions, TLS key denylist |
| [`settings-updater-lifecycle.md`](spec/settings-updater-lifecycle.md) | `settings.json`, electron-updater state machine, bootstrap order, env vars, main.js module map |
| [`renderer-ui.md`](spec/renderer-ui.md) | React screens, copy, flows, polling, `window.silico` usage matrix |
| [`design-system.md`](spec/design-system.md) | Tokens, typography, component classNames, window chrome, motion |

Runtime observation (launching Silico, attaching to its Electron inspector,
capturing traffic) was **not** performed. All conclusions are static. The app
would have used the user's real Silico account and remote machines, and the
static evidence was enough for a reconstruction.

## 4. Clean-room process

1. **Analysis → specs.** Analysts read the original code and wrote behavior in
   their own words: TS interfaces, numbered flows, exact user-facing strings,
   command lines, and file formats. Those are the interoperability facts. They
   were told not to paste code blocks.
2. **Specs → contract.** An architect wrote `src/shared/*` (config, IPC types),
   `src/main/services.ts` (service interfaces), and the module skeleton, using
   the specs only.
3. **Contract → implementation.** Eight implementers wrote the modules from
   the specs. The original bundle was available only to resolve a specific
   ambiguity, never as a source to copy.
4. **No proprietary assets.** No fonts, icons, or images were copied from the
   app. Suisse Intl (commercial) is replaced by Inter. IBM Plex Mono and
   Newsreader (SIL OFL) come from `@fontsource`. The icon is an original
   placeholder.

## 5. Deliberate differences from the original

Rea Claude keeps the **interop surface** (IPC channel names, the
`window.silicoDesktop` bridge name Lab pages rely on, gateway endpoints, and
on-disk formats). It changes the following, all listed with rationale in
[`architecture.md` §7](architecture.md):

- Separate identity (name, app id, `userData` folder `rea-claude`), so it never reads or writes the real Silico's data.
- `silico://` is handled internally. OS registration is opt-in (`REA_CLAUDE_REGISTER_PROTOCOL=1`) so it doesn't hijack the real app.
- The updater is disabled unless `REA_CLAUDE_UPDATE_URL` is set. Silico's own feed would install Silico over the rebuild.
- Security fixes for gaps found during analysis: trusted-sender checks on three unguarded channels, host-key accept bound to the fingerprint the user saw, quoting of `IdentityFile` paths, `[::1]` localhost handling, corrupt-`connections.json` recovery, and `sandbox: true` for shell windows.

## 6. Open unknowns

Things the shipped desktop bundle cannot show, aggregated from the specs'
ledgers:

- What the remote `silico up / update / down` CLI and `<gateway>/install` script do on the host (docker vs. scheduler, images, files written).
- Full gateway response shapes and server-side semantics, for example HTTP 409 (claim) and 425 on lab session, and the activation/refresh signing (the client never verifies the proof signature).
- How a Lab page builds the external checkout / MCP OAuth / GitHub URLs around the desktop nonces, and the meaning of `manageReturn: true`.
- Where the Lab page sends drained shell-event telemetry.
- Internals of electron-updater's macOS `staging` handoff (inferred from the library, not this bundle).

## 7. Reproducing the analysis

```bash
# extract (untrusted data: keep it outside the repo)
npx -y @electron/asar@3.2.17 extract /Applications/Silico.app/Contents/Resources/app.asar /tmp/silico/app
# REA evidence for main + preloads
npx -y rea-agents@latest analyze-javascript-application /tmp/silico/app \
  --source-path out/main/index.js --source-path out/preload/index.js --source-path out/preload/lab.js \
  --format json > rea-main.json
```

The extracted bundle, pretty-printed sources and raw REA output are **not**
committed. They are proprietary code and large (REA output ≈ 77 MB). Only the
derived channel inventory is kept.
