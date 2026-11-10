# Silico desktop: settings, persistence, auto-update, lifecycle, and main-process map

Source: Silico.app v0.137.0 (`ai.goodfire.silico`, package `silico-desktop`, build string `"2026-10-23 · 047c31d"`).
Evidence comes from the prettified bundle `pretty/main.js` (7803 lines), `pretty/preload-index.js`, `pretty/renderer.js`, `Info.plist`, and `Resources/app-update.yml`. Line numbers (`L123`) point into `main.js` unless another file is named.
This is a clean-room behavioral spec. Identifiers in backticks are the original minified names, kept only so you can trace them back to the source.

---

## 1. Overview

The main process is a single bundled CommonJS file. It does six things:

- **Persistence.** Small JSON files under `app.getPath("userData")`:
  - `settings.json`, `connections.json`, `last-opened.json`, and `identity.json` are written with a write-to-`.tmp`-then-rename pattern.
  - `window-state.json` and `update-exit-marker.json` are written with plain sync writes.
  - `updater.log` is append-only.
- **Settings.** A flat object with 5 booleans plus a `notifications` sub-object.
  - Reads always sanitize field by field.
  - A write is a shallow merge of the renderer's patch over the sanitized current settings. The merged object is broadcast to every window as `settings:changed`.
  - **There are no login-item, theme, or other OS-level settings.** No call to `setLoginItemSettings` or `nativeTheme` exists anywhere in main.js (verified by grep).
- **Self-update.** Uses `electron-updater` with a generic feed on CloudFront.
  - It auto-downloads, and installs either on quit or on demand.
  - On macOS it tracks an extra `staging` phase while Squirrel.Mac (Electron's native `autoUpdater`) stages the bundle.
  - An exit marker detects installs that failed.
  - It detects when the app runs from a location it can't write to (a DMG or an admin-owned folder).
  - On Windows it adds an extra Authenticode/CA-pinning check on top of electron-updater's own signature check.
- **Bootstrap.** Runs these steps in order before `whenReady`:
  - refuses dangerous Chromium switches;
  - relaunches onto the bundle on disk if it is newer than the running one;
  - takes the single-instance lock (packaged builds only);
  - installs the global handlers;
  - registers the `silico:` protocol.

  `whenReady` then sets up TLS pinning, shell-env import, telemetry sinks, permissions, IPC, menus, the first window, the updater, and background watchdogs.
- **Environment.** There are two hard-coded origins:
  - prod `https://my.silico.run`
  - staging `https://my-staging.silico.run`

  The `staging` setting picks the origin at sign-in time. After that, the signed-in session's `gatewayUrl` is the source of truth (`gn`/`se`, L1712-1717).
- **Logging and telemetry.** Everything goes to stdout/stderr through `console.*` with `[tag]` prefixes. The updater also writes its own file.
  - "Telemetry" is local only. Structured `desktop_shell` and `app_foreground` events go to a ring buffer and are handed to the Lab web page over IPC.
  - There are no third-party analytics SDKs and no `crashReporter`.

---

## 2. Module map of main.js

Ranges are approximate boundaries between logical modules in the single bundle. A reimplementation should split them into separate files.

| Lines | Module | Responsibility |
|---|---|---|
| 1-15 | imports | Loads electron, path, child_process, fs, os, util, crypto, http, net, electron-updater, plus `node:` variants. |
| 16-63 | `util/connection-model` | `openExternal` restricted to http(s) (`Ee`). Route-mode normalization `managed`/`local`/`cluster` (`Ms`, `at`, `jr`). Managed key formatting. Reach-timeout clamp (`xs`: default 3000, range 1000-120000). Lab version-drift calculation (`Ps`, `Ws`, 40-hex SHA test `Vt`). |
| 64-150 | `telemetry/shell-events` | Ring buffer of 100 `desktop_shell` events (`te`, `Hs` drain, `Ns` trim). Identity provider hook (`Vs`). Dedup of `gateway-transport-failure`. Also `Gs`, which parses `docker ps` output for local stacks. |
| 151-163 | `util/serial-queue` | `on()` factory: a promise-chain mutex that runs tasks one after another and isolates errors. |
| 164-206 | `store/connections` | `connections.json` read, upsert, and remove. Writes go through the serial queue. |
| 207-256 | `env/origins` | Prod and staging gateway origins, legacy alias origins (`bo`), beta-signup URLs, CLI name `silico`/`silico-dev`, remote state dir `state` vs `state/_dev`, and the `-dev` deployment-id suffix. Also notification defaults `pe`. |
| 257-330 | `store/settings` | Defaults `Xe`, `notifications` sanitizer `qs`, read `ne`, write `Ys`, change-listener registry `Qr`/`ei`. |
| 331-480 | `window/compact-geometry` | Main-window size constants and "compact" (Lab-switcher) resize logic (`rr`, `ir`, `ti`, `ni`, `oi`, and so on). |
| 481-511 | `store/last-opened` | `last-opened.json` keyed by account, with a serial queue. |
| 512-626 | `telemetry/foreground` | `app_foreground` attribution: why the app came to the foreground (`D` marks a cause, `qe` marks recent activity, `wa` installs the listeners). Initial-window tracking (`jt`, `di`, `ma`). |
| 627-698 | `env/shell-env` | Spawns the login shell (`$SHELL -ilc`, 5 s timeout) to import `PATH` and `SSH_AUTH_SOCK` into `process.env` (`Co`, memoized). Skipped on Windows. |
| 699-1000 | `ssh/exec` | Resolves the OpenSSH binary (Windows System32 fallback). `ssh` and `ssh-keyscan` exec helpers, maps ssh errors to friendly text, host-key scan and accept (appends to `~/.ssh/known_hosts`). |
| 947-1052 | `lab/reachability` | Probes `/api/cluster/version` and `/healthz/dataplane`, and runs the managed-Lab wake loop (`yi`: 90 s budget, polls every 1.5 s). |
| 1052-1235 | `auth/codec` | Builds the loopback login URL. Parses the callback. Decodes JWT payloads. Parses `silico://signup` and `silico://signup-resume` deep links. Serializes and deserializes `identity.json` (`za`/`vi`). Picks the safeStorage mode (`Ka`, `qa`). Launch-switch guard (`Xa`). Test-mode detection (`_o`). |
| 1236-1716 | `auth/session` | In-memory session `S`. Load, persist, and clear `identity.json`. Pending-revocation queue. Proof refresh (`ac`, `Et`). Sign-in orchestration (`cc`, `lc` activation, `uc`). Developer-flag listeners (`oc`, `pn`). |
| 1716-1860 | `auth/loopback` | Signup identity adoption (`dc`). Local HTTP callback server on 127.0.0.1 with a random port for desktop login (`fc`). |
| 1860-2015 | `net/gateway-fetch` | Classifies transport errors (`_i`). Gateway fetch with an origin allow-list and legacy-origin fallback (`ue`). JWKS probe. |
| 2015-2136 | `api/labs` | `/labs` discovery (`It`), `/labs/session`, `/labs/claim`, `/labs/setup-bearer`, and signup continue (`hc`). |
| 2136-2290 | `lab/url-policy` | Maps discovery rows (`wc`). Inline HTML for the sign-in result page. Lab-URL classification (auth-wall, open-document, in-app or browser). Renderer crash-loop guard (`Mi`: at most 3 crashes per 60 s). |
| 2288-2400 | `lab/watchdog` | Liveness watchdog for revealed Lab views (`Bc`). Ticks every 15 s and on focus and resume. Probes `/healthz`. |
| 2399-2512 | `window/chrome` | Title-bar options per platform (`Oi`). Viewer-path rules (`wr`). Injected page scripts. |
| 2513-2545 | `auth/signin-coordinator` | One in-flight sign-in per environment (`zc`). Rejects an environment switch while a sign-in is open. |
| 2545-3027 | `viewer/recovery` | Restores shared or deep-linked Lab pages after auth changes (`Zc`, `el`). |
| 3027-3400 | `labview/host` | `WebContentsView` per window on partition `persist:silico`, plus `preload/lab.js`. Navigation guards. Viewer windows (`Ni`, `ll`, `ul`). |
| 3400-3700 | `labview/registry` | Visibility, zoom, invalidate (`to`), destroy-all (`wl`), memory shedding (`ml`), and nav state. |
| 3695-3875 | `labview/open` | `Bo`: opens a Lab in a window and handles its load and fail events. |
| 3875-3935 | `notify/badge` | Aggregates per-Lab attention and unread counts into the dock badge or Linux badge count (`$l`, `kr`). |
| 3936-4150 | `ssh/tunnel` | Per-connection `ssh -L` tunnels with reconnect backoff (`Hl`, `Zi`). Kill-all (`Xi`). |
| 4149-4250 | `lab/cluster-status` | Staging/dev CLI checks and `lab:status`/`lab:test` (`Qi`, `Gl`). |
| 4250-4440 | `lab/open-flow` | `Ge`: managed, local, and cluster open with token handoff via `/auth/callback#token=`. |
| 4439-4610 | `lab/reauth` | Re-authenticates a Lab in place (`rs`, `xt`). |
| 4609-4672 | `lab/claim` | Binds the route on first use of a cluster (`Ql`). |
| 4673-4895 | `lab/lifecycle` | Connect (`tu`), update (`oo`), cancel (`nu`), and down (`ou`) over SSH. |
| 4896-4974 | `ssh/config` | Parses `~/.ssh/config` (`ru`, `ss`). Appends a host block (`iu`, file mode 0600). |
| 4975-5236 | `updater/support` | Pure decision helpers (`au`, `cu`, `lu`, `uu`, `du`, `Ir`, `fu`, `hu`). Plist and YAML scraping. `updater.log` writer (`L`). Bundle path and writability checks. Disk-bundle relaunch (`En`). Feed URL (`ds`). `latest-mac.yml` fetch (`Eu`). Exit marker (`Iu`, `Ru`, `mt`). ShipIt log tail (`_u`). |
| 5237-5300 | `signup/url-policy` | URL trust classes for signup: `blocked`, `system-auth`, `embedded`, `external`. Parses `silico://signup-ready`. |
| 5290-5486 | `signup/window` | Signup overlay (`persist:silico-signup` partition) and adopting the new Lab (`hs`, `Uu`, `Ue`). |
| 5486-5555 | `net/tls-pin` | Certificate verify proc for all sessions. Rejects as revoked (-206) any chain containing a blocked SPKI hash; otherwise defers to Chromium (-3) (`Vu`). |
| 5556-5649 | `updater/win-signature` | PowerShell Authenticode chain extraction plus pinned SSL.com CA check (`ju`, `qu`, `Ju`, `Yu`). |
| 5650-6105 | `updater/core` | Update state machine, dialogs, install, and wiring (`ud`). |
| 6106-6246 | `notify/native` | Native notifications from the Lab page (`silico:notify`), with dedupe and coalescing of finished events. |
| 6247-6400 | `oauth/returns` | Nonce registries for the checkout, MCP-OAuth, and GitHub-connect deep-link returns. |
| 6400-6440 | `ipc/trust` | `Le` safe send. `Cs` trusted-sender check. `y` handler wrapper. `oe` (sender uses the Lab partition). |
| 6441-6479 | `window/attention`, `local/docker` | Focus or bounce after sign-in (`Kd`). `docker ps` for local stacks (`Yd`). |
| 6480-6720 | `ipc/register` | `Zd`: registers every `ipcMain.handle`/`on` used by the shell (see section 3). |
| 6722-6800 | `deeplink/parse`, `sys/memory` | `silico://welcome` and `silico://open?url=`. macOS `kern.memorystatus_level` threshold of 15. |
| 6806-6830 | `store/window-state` | `window-state.json` read, validate, and debounced write. |
| 6829-6877 | `bootstrap/move-to-apps` | macOS offer to move the app to /Applications. |
| 6878-6953 | `security/permissions` | Permission request and check handlers. Only `clipboard-sanitized-write` and `fullscreen` are allowed. Microphone dictation is allowed after a dialog. |
| 6954-6998 | `ui/context-menu` | Spell-check and edit context menu. |
| 6999-7097 | `bootstrap/toplevel` | Top-level statements that run at module load (see section 6). |
| 7098-7267 | `deeplink/dispatch` | `Xo` routes `silico:` URLs. Signup, welcome, share, OAuth returns, checkout. |
| 7268-7372 | `window/main` | Creates the main shell window (`Z`) and classifies the focused window (`Ef`). |
| 7373-7515 | `window/settings-sheet` | Modal settings sheet window (`Qo`). Menu navigation (`xn`). Devtools toggle. Zoom. |
| 7516-7649 | `menu/app` | Application menu (`Br`) and dock menu (`Rf`). |
| 7650-7803 | `bootstrap/whenReady` | Ready sequence, watchdog timers, power events, quit hooks. Exports `createWindow`. |

---

## 3. IPC contract (this analyst's area)

All `invoke` channels below are registered through the `y(channel, fn)` wrapper (L6428).

- **Trust check.** The sender frame URL must be `file:`, or its origin must equal `new URL(process.env.ELECTRON_RENDERER_URL).origin` (`Cs`, L6418).
- **Failure.** If the check fails, the wrapper logs `[ipc] blocked '<ch>' from untrusted sender` and throws `Error("Blocked '<ch>': untrusted sender.")`. The renderer's promise rejects.
- **Preload.** `preload/index.js` exposes these channels as `window.silico.*`.

```ts
type SettingsPatch = Partial<Settings> & Record<string, unknown>; // not validated on write
```

| Channel | Direction | Args | Returns | Behavior / errors |
|---|---|---|---|---|
| `ping` | R→M invoke | none | `"pong"` | Liveness check (L6481). |
| `app:isDevBuild` | R→M invoke | none | `boolean` | `!app.isPackaged` (L6482). The renderer uses it, together with `staging`, to show local docker stacks. |
| `settings:get` | R→M invoke | none | `Settings` | Calls `readSettings()` (sanitized). On any read or parse error, returns a copy of the defaults (L6585, L286). |
| `settings:set` | R→M invoke | `patch: SettingsPatch` | the merged object | Runs `writeSettings(patch)`. Afterwards, `settings:changed` is sent to **every** non-destroyed BrowserWindow with the same object (L6586-6591). If the write rejects (an fs error), the error propagates and nothing is broadcast. |
| `settings:changed` | M→R send | `Settings` (merged, unsanitized) | n/a | The preload exposes it as `settings.onChanged(cb)`, which returns an unsubscribe function. |
| `lastOpened:get` | R→M invoke | `account: string` (the GitHub login) | `string \| null` | Returns the stored value **only** if the sender's BrowserWindow is the *initial* window and this is the first `lastOpened:get` since that window became initial (`ma`, L628). Otherwise returns `null`. The value is a connection id. |
| `lastOpened:set` | R→M invoke | `account: string, connId: string` | `void` | Serialized write (`la`, L509). There is no type validation on write. Non-string values are dropped on the next read. |
| `update:get-state` | R→M invoke | none | `UpdateState` | Current state snapshot (`td`, L5668). |
| `update:install` | R→M invoke | none | `void` | If the phase is `downloaded`, quits and installs (see section 5). Otherwise shows the warning dialog "The update couldn’t be applied" and clears the "already prompted" version (`Yo`, L5968). |
| `update:state` | M→R send | `UpdateState` (full) | n/a | Sent to all windows on **every** state merge (`ed`, L5664). The renderer shows "Update ready / Restart to update" when `phase === "downloaded"` and shows `currentVersion` in the side rail (renderer.js L22634-22680). |
| `app:navigate` | M→R send | `string`, for example `"connections"`, `"settings:notifications"`, `"settings:developer"`, `"settings:profile"` | n/a | Comes from the menu, the settings sheet, and deep links (L7395, L7489, L7239). |
| `window:open-settings-sheet` | R→M invoke (raw `ipcMain.handle`, **not** wrapped) | none | `void` | Opens the settings sheet only if the sender is a main shell window's own webContents (L7462). |
| `silico:open-desktop-settings` | Lab→M `on` | none | n/a | Opens the settings sheet on the Notifications tab for the window that hosts the Lab view (L7443). |

Cross-area channels that also live in `Zd` (L6480-6720) are listed for completeness and specified elsewhere: `window:is-initial`, `window:set-compact`, `local:detectStacks`, `silico:recover-session`, `viewer:retry`, `auth:*`, `signup:*`, `labs:list`, `dialog:pickFile`, `dialog:confirm`, `connections:*`, `ssh:*`, `lab:*`, `silico:notify`, `silico:badge-counts`, `silico:begin-*`, `silico:take-*-return`, `silico:shell-events:drain`, and the unwrapped `labs:held-elsewhere`, `labs:focus-held`, and `silico:open-lab-switcher`. The `silico:*` channels from the Lab page are checked by `oe()`, which tests whether the sender's session is `persist:silico`, rather than by `Cs`.

---

## 4. Settings schema and persisted files

### 4.1 Settings

```ts
interface NotificationSettings {
  enabled: boolean;            // default true  – master switch (notifications + badge)
  needsInput: boolean;         // default true
  experimentFinished: boolean; // default true
  sound: boolean;              // default true
  notifyWhenActive: boolean;   // default false
  badge: boolean;              // default true
}
interface Settings {
  staging: boolean;          // default false
  verbose: boolean;          // default false
  previewBuilds: boolean;    // default false
  notifications: NotificationSettings;
  developerMode: boolean;    // default false
  skipVersionCheck: boolean; // default false
}
// On disk: settings.json = { version: 2, ...Settings }  (pretty JSON, 2-space indent)
```

| Key | Default | Read sanitization (`ne`, L286) | Consumers and side effects |
|---|---|---|---|
| `staging` | `false` | Uses the stored boolean. Otherwise, the legacy migration applies: `staging = (file.gatewayUrl === "https://my-staging.silico.run")`. | The renderer passes it to `auth:signIn(staging, force)` (renderer L22447), which picks the gateway origin (`vt`). Main reads it when resuming signup from a deep link (L7244) and for the default signup URL (L5371). The renderer's toggle asks for confirmation, writes the setting, then signs out (renderer L22722-22733). It is also one of the inputs to developer-menu visibility. |
| `verbose` | `false` | Stored boolean, else the default. | Main does not read it directly. The renderer passes it as the 2nd argument of `lab:connect`, and main then runs `silico up --verbose` (L4740). Also a developer-menu input. |
| `previewBuilds` | `false` | **Honored only if the file's `version >= 2`.** Otherwise it falls back to the default. This is a v1 to v2 migration that resets old values. | When connecting, a stale Lab is auto-updated only if `!previewBuilds && !skipVersionCheck` (L4726). The pinned or preview update decision is at L4764-4770. **It does not affect the desktop app's own update channel.** Also a developer-menu input. |
| `notifications` | see the interface | `qs`: each field is a boolean or else its default. A non-object becomes all defaults. | Read on every native notification (`Cd`, L6215) and every badge recompute (`kr`, L3906). A settings change triggers a badge recompute (`Ul` registers a change listener, L3942). |
| `developerMode` | `false` | Stored boolean, else the default. | Developer-menu input. Otherwise only the renderer uses it. |
| `skipVersionCheck` | `false` | Stored boolean, else the default. | Skips the Lab version pin and the update-before-open step (L4726, L4765). Developer-menu input. |

**Write semantics** (`Ys`, L316):

1. The write runs on a dedicated serial queue.
2. It computes `merged = { ...await readSettings(), ...patch }`. This is a **shallow** merge with no validation. A partial `notifications` object would replace the whole sub-object; the renderer always sends the full object (renderer L22716). Unknown keys get written too, and are dropped on the next read.
3. It runs `mkdir -p userData`, writes `settings.json.tmp` with `JSON.stringify({version: 2, ...merged}, null, 2)`, then renames it over `settings.json`.
4. It calls each registered change listener with `merged`, then returns `merged`.

Legacy keys, such as `gatewayUrl`, are dropped on the first write, because `readSettings` returns only the known keys.

**Change listeners** (registered with `ei`):

- (a) Developer-menu visibility (L7706-7713).
- (b) Badge recompute (L3942).

**Developer-menu rule** (L7691-7713).

```ts
devVisible = anyOf(s.developerMode, s.staging, s.previewBuilds, s.verbose, s.skipVersionCheck)
          || (authStatus === "signed-in" && session.developer === true)
```

When `devVisible` changes:

- The application menu is rebuilt (`Br(devVisible)`).
  - It adds the "Developer settings" item.
  - It adds the "Toggle Developer Tools" item. That item is shown when `devVisible` is true **or** the build is unpackaged.
- If `devVisible` becomes false in a packaged build, every open DevTools is closed.

The renderer applies the same visibility rule to the Developer tab (renderer L23085-23090).

### 4.2 Files under `userData`

On macOS the default `userData` is `~/Library/Application Support/Silico`. This follows from `app.setName("Silico")` at L7014 (inferred). The `SILICO_E2E_USER_DATA` environment variable overrides it.

| File | Shape (TS) | Write strategy | Read behavior |
|---|---|---|---|
| `settings.json` | `{ version: 2 } & Settings` (v1 = no `version`, may contain `gatewayUrl`) | tmp+rename, serial queue | Missing or corrupt: defaults. |
| `connections.json` | `{ version: 1; connections: Connection[] }` | tmp+rename (L174-187), serial queue `Jr`. Upsert assigns `id = crypto.randomUUID()` when it is missing and replaces by `id` (L192-200). | ENOENT: `[]`. A non-array `connections` value: `[]`. **Other errors (for example corrupt JSON) are thrown** (L167-176). Connection field semantics belong to the connections spec. Fields seen in main include `id`, `routeMode`, `gatewayUrl`, `owner`, `ssh{host,user,port,identityFile,jump}`, `deploymentId`, `labUrl`. |
| `last-opened.json` | `{ version: 1; byAccount: Record<login, connId> }` | tmp+rename, serial queue `ca` | Any error: `{}`. Non-string values are filtered out. |
| `identity.json` | `{ version: 1; gatewayUrl; sub; login; exp: number; developer?: true; encrypted: boolean; proof: string; refreshToken?: string; backend?: string }`. When `encrypted` is true, `proof` and `refreshToken` are base64 safeStorage ciphertext. | tmp+rename with mode `0o600`, on the auth serial queue `lt` (L1328-1351) | Parsed by `vi`. It is rejected if the `gatewayUrl` is not one of the two known origins, if `exp` is non-finite, or if decryption fails. |
| `pending-revocations/<ms>-<24hex>.json` | same as `identity.json` | `rename` of `identity.json` into this dir on sign-out (dir mode `0o700`) | Retried, at most once per 30 s, by POSTing to `<gateway>/labs/logout`. The file is deleted on success, 401, or 404 (L1500-1543). Auth spec. |
| `window-state.json` | `{ x: number; y: number; width: number; height: number }` (raw `getBounds()`) | `writeFileSync`, debounced 250 ms, on main-window `resize` and `moved`. Skipped while the window is in compact mode (L7316-7318, L6820-6828). | Read only when **no** windows exist at creation. It must have finite numbers, positive size, and intersect some display's workArea (L6782-6818). |
| `update-exit-marker.json` | `{ fromVersion: string; toVersion: string; at: number /* epoch ms */ }` | `writeFileSync` (L5177-5185) | See section 5.4. |
| `updater.log` (+ `updater.log.old`) | text lines `ISO8601 <msg>` | `appendFileSync`. On the first write of each process, if the file is larger than 1 MiB it is renamed to `.old` (L5059-5092). | Never read by the app. |
| `Partitions/silico`, `Partitions/silico-signup` | Chromium storage | Electron manages these, from `persist:silico` and `persist:silico-signup`. | n/a |

### 4.3 Files outside `userData`

| Path | Access |
|---|---|
| `~/.ssh/known_hosts` | Append, mode `0o644`. Parent dir created with mode `0o700` (L923-944). |
| `~/.ssh/config` | Read and parse. Append a host block with mode `0o600` (L4896-4972). |
| `<process.resourcesPath>/app-update.yml` | Read for the `url:` line (`ds`, L5153). |
| `<bundle>/Contents/Info.plist` | Read via `/usr/bin/plutil -extract <key> xml1 -o - <path>` with a 5 s timeout (`ls`, L5118). Keys read are `CFBundleShortVersionString` and `CFBundleIdentifier`. |
| `~/Library/Caches/<bundleId>.ShipIt/ShipIt_stderr.log` | Read for the last 25 lines after a failed install (`_u`, L5211). |
| `<appPath>/resources/{icon.png, goodfire-icon.png}` | Window, dock, and dialog icons. Also inlined as a data URI in the sign-in HTML. |

---

## 5. Updater

### 5.1 Configuration

- **Feed** (`Resources/app-update.yml`). The `provider: generic` URL is `https://ddtqf80bu4kgq.cloudfront.net/stable`, with `useMultipleRangeRequest: false` and `updaterCacheDirName: silico-desktop-updater`.
- **Channel.** No `channel`, `allowPrerelease`, `allowDowngrade`, or `setFeedURL` is set anywhere (verified by grep), so electron-updater's defaults apply. That means the `latest*.yml` files under `/stable`. **The app has no desktop preview channel**; `previewBuilds` concerns Labs only.
- **Download and install.** `autoDownload = true`, `autoInstallOnAppQuit = true`. The logger is `Su`: info, warn, error, and debug go to `updater.log`, except debug lines that start with `download range:` or are longer than 4096 characters, which go only to the console.
- **Enablement** (`Ho`, L4978). The updater is wired only when `app.isPackaged` **and** either the platform is not linux or `process.env.APPIMAGE` is set. A `.deb` install has no self-update.
- **Windows.** If the updater is an `NsisUpdater`, `verifyUpdateCodeSignature` is wrapped (`Yu`). electron-updater's own check runs first. If that passes, a second check runs:
  - PowerShell (`-EncodedCommand`, 60 s timeout, `PSModulePath` stripped, the file passed via the env var `SILICO_SIGNED_FILE`) returns `{status, embedded, chain[]}`.
  - The check requires `status === "Valid"`.
  - Each certificate in the chain must be issued and signed by the next one.
  - No certificate may have its SPKI-sha256 in the blocklist `ys`.
  - Some non-leaf certificate must have its SPKI-sha256 in the pinned SSL.com CA set `Hu`, which has 2 hashes.
- **Timers.**
  - The first check runs 3 s after `ud()`.
  - After that, every 30 min (`Zu`, `unref`).
  - Also 2 s after `powerMonitor.resume`, if the machine was suspended for at least 60 s (`hf`, L7756-7770).
- **Constants.** `Xu` = 10 min (patience for staging). `Lr` = 30 s (grace after an install exit). `Qu` = 1 s (poll interval during that grace).

### 5.2 State

```ts
type UpdatePhase = "idle" | "checking" | "not-available" | "available"
                 | "downloading" | "staging" | "downloaded" | "error";
interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;              // app.getVersion(), set at module load
  newVersion?: string;
  percent?: number;                    // Math.round(progress.percent); 100 on downloaded/staging
  message?: string;                    // error text
  blocked?: "needs-move" | "needs-admin";
}
```

`setState(patch)` **merges** the patch into the state (`E = {...E, ...patch}`) and broadcasts the result. Fields are therefore sticky. For example, `message` survives into later phases, and `blocked` is cleared only by the `checking` transition. The initial state is `{phase: "idle", currentVersion}`.

### 5.3 Transitions (electron-updater `O`, native `a.autoUpdater`)

| Event | Effect |
|---|---|
| `O` `checking-for-update` | `{phase: "checking", blocked: undefined}` |
| `O` `update-not-available` | `userInitiated = false`; `{phase: "not-available"}` |
| `O` `update-available(info)` | `downloadCycle++`; `{phase: "available", newVersion: info.version}` |
| `O` `download-progress(p)` | `{phase: "downloading", percent: round(p.percent)}` |
| `O` `update-downloaded(info)`, non-darwin | `{phase: "downloaded", newVersion, percent: 100}`, then `offerRestart()` |
| `O` `update-downloaded(info)`, darwin | If native staging was already confirmed for this download cycle (`uu`): go to `downloaded` and call `offerRestart()`. Otherwise set `nativeStaged = false` and `stagingStartedAt = now`, then go to `{phase: "staging", newVersion, percent: 100}`. |
| native `update-downloaded` | Set `nativeStaged = true` and `confirmedCycle = downloadCycle`. If the phase is `staging`, go to `{phase: "downloaded", percent: 100}` and call `offerRestart()`. Otherwise only log it. |
| `O` `error(err)` | Remember `wasUser = userInitiated`, then set `userInitiated = false`. Set `{phase: "error", message: err.message, blocked: /read-only volume/i.test(msg) ? "needs-move" : undefined}`. If `wasUser`, show the dialog "Couldn’t download the update". |

**`check()`** (`ze`, L5688):

1. Do nothing if the build is not packaged, if self-update is not supported, if the previous install is still being verified (`In`), or if the phase is `downloaded`.
2. Compute `du(phase, now, stagingStartedAt, 10 min)`:
   - `wait`: return.
   - `stalled`: log, reset `stagingStartedAt`, and call the **native** `autoUpdater.checkForUpdates()` to restart Squirrel. Return.
3. Run the location check `bs()`. On macOS, if the parent of the `.app` is not writable:
   - set `{phase: "error", blocked, message}`, where `blocked` is `needs-move` on `EROFS` and `needs-admin` otherwise;
   - log it once per state;
   - call `surfaceBlocked(blocked)` (`od`): fetch `<feed>/latest-mac.yml` with a 10 s timeout and parse its `version:` line. If that version differs from the running version and has not been surfaced yet, show a one-time dialog the next time a window is focused. The needs-admin variant has a "Download Silico…" button that opens `<feed>/Silico-universal.dmg` (`hu`). On Windows the file is `Silico-Setup.exe`; on Linux it is `Silico.AppImage`.
4. Otherwise call `O.checkForUpdates()`. If it throws, go to the error state.

**User check** ("Check for Updates…", **only in the macOS app menu**, `nd`, L5725). The cases are tried in order:

- Phase is `downloaded`: show the restart dialog.
- Unpackaged build: info dialog.
- Linux deb install: info dialog.
- Verifying the previous install: info dialog.
- Phase is `staging`: set `userInitiated`, then call `check()`.
  - Still staging: "An update is on the way".
  - Error: "Couldn’t prepare the update".
- Location is blocked: the matching dialog.
- Otherwise: set `userInitiated`, then call `check()`.
  - Result `not-available`: "You’re up to date".
  - Result `error`: "Couldn’t check for updates".

**`offerRestart()`** (`Mn`):

- If the check was user-initiated, show the dialog "A Silico update is ready" with the buttons ["Later", "Restart to update"].
- Otherwise, if this `newVersion` has not already been prompted, wait until a window is focused, then show the same dialog with the buttons ["Later", "Restart now"].
- The prompted version is remembered (`yt`), so choosing Later does not prompt again for that version. The in-app banner stays visible.
- A reentrancy flag `xe` prevents two dialogs from showing at once.

All dialogs go through a serial queue (`U`). Each one is logged as `dialog queued: …` and parented to the focused window when there is one.

### 5.4 Install and failure detection

**`installNow()`** (`ad`, L5957). This runs only when the phase is `downloaded`:

1. Write the exit marker `{fromVersion: current, toVersion: newVersion ?? "unknown", at: now}`.
2. Arm the forced exit (`sd`). After 5 s:
   - If a native error was seen: relaunch and exit.
   - Else if native staging is done: `app.exit(0)`.
   - Else wait. On native `update-downloaded`, exit after 3 s. On native `error`, relaunch and exit. After a 60 s timeout, relaunch and exit on darwin, or just exit elsewhere.
3. Kill all SSH tunnels (`Xi`).
4. Destroy all Lab views (`wl`).
5. Destroy all windows.
6. Call `O.quitAndInstall()`. Errors are logged; the forced exit remains armed.

**Quit hook.** `before-quit` writes the exit marker if an install-on-quit will happen. On darwin that means native staging is done; elsewhere it means the phase is `downloaded` (`fu`).

**At startup** (inside `ud`), `Ru(currentVersion)` reads the marker. The result is classified as follows:

- **invalid:** delete the marker.
- **applied** (`fromVersion !== current`): log and delete.
- **failed** (`fromVersion === current`): keep the marker and set `In = true` (verifying). Then:
  1. `rd` polls every 1 s for up to 30 s from `marker.at`, checking whether the bundle on disk now reports a different version. If it does, relaunch with `--relaunched-onto-disk-bundle` and exit.
  2. After that, log the ShipIt stderr tail.
  3. On the next window focus, show "The last update didn’t install". The text varies with the location check. The dialog has an optional "Download Silico…" button.
  4. Delete the marker, set `In = false`, and call `check()`.

**Disk-bundle relaunch** (`En`). This applies only on darwin, in packaged builds, when argv does not already contain `--relaunched-onto-disk-bundle`. If `CFBundleShortVersionString` in the on-disk bundle is not the running version, the app calls `app.relaunch({args: [...argv.slice(1), "--relaunched-onto-disk-bundle"]})` and then `app.exit(0)`. It is called at module load, before the single-instance lock, and again at three points in the update flow.

---

## 6. Bootstrap and lifecycle

### 6.1 Sequence

**Module load (top level, L6999-7097)**

1. Compute `Fr` = the first forbidden Chromium switch present. This applies only to packaged builds. The forbidden list is `remote-debugging-port`, `remote-debugging-pipe`, `ignore-certificate-errors`, `ignore-certificate-errors-spki-list`, `log-net-log`, and `ssl-key-log-file`. `remote-debugging-port` is allowed in test mode. If one is present, write `[launch] refusing to start with --X: it would expose your Silico sign-in` to stderr and call `process.exit(78)`.
2. Packaged builds delete `process.env.SSLKEYLOGFILE`.
3. `app.setName("Silico")` and `app.setAppUserModelId("ai.goodfire.silico")`.
4. If `SILICO_E2E_USER_DATA` is set, call `app.setPath("userData", value)`.
5. `En(...)`: relaunch onto the bundle on disk if needed (errors are swallowed).
6. Single-instance lock: `gotLock = !app.isPackaged || app.requestSingleInstanceLock()`. If the lock is not acquired, call `app.exit(0)`. **Dev builds allow multiple instances.**
7. `setAboutPanelOptions({applicationName: "Silico", applicationVersion, version: "2026-10-23 · 047c31d"})`. Load the window icon.
8. Install the `uncaughtException` handler:
   - Errors whose message starts with `net::ERR_` are logged and ignored.
   - For anything else: log, emit an `app_foreground` event with cause `error-dialog` (details sliced to 300 characters, stack to 2000), then show `dialog.showErrorBox("A JavaScript error occurred in the main process", stack)`.
   - There is **no** `unhandledRejection` handler.
9. `web-contents-created`: for every webContents, call `preventDefault` on `will-prevent-unload` (so beforeunload is always ignored) and attach the spell-check and edit context menu.
10. `child-process-gone`: if the GPU process exited abnormally, log it, then invalidate the shown Lab views 1 s later (`to`).
11. Packaged builds call `app.setAsDefaultProtocolClient("silico")`. `Info.plist` also declares `CFBundleURLSchemes: ["silico"]`.
12. A pending deep link is taken from argv (the first argument matching `/^silico:/i`).
    - `open-url`: before the app is ready, store the URL; afterwards, dispatch it.
    - `second-instance`: if argv carries a deep link, dispatch it. Otherwise focus an existing main window (marking the cause `second-instance`), or create a new one and make it the initial window.

**`app.whenReady()` (L7650), which returns early if the lock was not acquired**

1. `Vu()`: install the TLS certificate verify proc on the default session, `persist:silico`, `persist:silico-signup`, and every future session.
2. `Co()`: start importing the login-shell env, without awaiting it.
3. `wa(...)`: foreground telemetry. It listens to `did-resign-active` and `did-become-active` and delivers `app_foreground` events to the focused window's Lab view as `silico:foreground`.
4. `Vs(...)`: the shell-event sink. On each event it sends `silico:shell-event-nudge` to the first Lab view it finds.
5. `gf()`: permission handlers for `persist:silico` and `persist:silico-signup`.
6. Unless in E2E mode, `ff()`: the macOS offer to move the app to Applications. This is a synchronous dialog that calls `app.moveToApplicationsFolder`.
7. On darwin, set the dock icon.
8. `Zd()`: register IPC.
9. `nc()`: log `[auth] identity persistence: <mode> (safeStorage backend "<b>")`.
10. Register the checkout-return hook. Build the menu with `Br(false)`.
11. Developer-menu wiring: listeners on settings and on the auth developer flag (see section 4.1).
12. `Rf()`: the dock menu ("New Window").
13. `jt(Z())`: create the first main window and mark it as the initial window.
14. Dispatch the pending deep link, if any.
15. `ud()`: wire the updater. This also handles the startup exit marker.
16. `activate`: if no main window exists, create one and make it the initial window.
17. Lab watchdog (`Bc`): tick every 15 s, and on `browser-window-focus` (which also invalidates shown Lab views).
18. `powerMonitor` `suspend` and `resume`: after a resume that followed a suspend of at least 60 s, wait 2 s, then run an update check and re-authenticate all revealed Labs. On every resume, invalidate and tick the watchdog.
19. On `did-become-active`: if `yl()`, re-authenticate pending Labs (`bl()`).
20. darwin only: every 30 s while inactive, read `sysctl kern.memorystatus_level`. If it is below 15%, shed backgrounded Lab views and log `[memory] shed N …`.

**Quit**

- `window-all-closed`: on platforms other than darwin, `app.quit()`. On darwin the app stays alive.
- `before-quit`: kill all SSH tunnels (`Xi`). The updater registers its own `before-quit` that writes the exit marker (section 5.4).
- There is no `will-quit` handler.

### 6.2 Environment variables read by main.js

| Variable | Where | Effect |
|---|---|---|
| `ELECTRON_RENDERER_URL` | L6422, L7367, L7436, L3319 | Dev server URL from electron-vite. When set, windows `loadURL` it (the settings sheet uses `#settings-modal/<tab>`, the viewer uses `#viewer`) instead of loading `../renderer/index.html`. Its origin is also trusted for IPC. |
| `SILICO_E2E_USER_DATA` | L7016, L1230 | Overrides `userData`. Enables "test mode": allows `--remote-debugging-port`, persists no identity (`none-test-mode`), and skips the move-to-Applications offer. |
| `SSLKEYLOGFILE` | L7013 | Deleted in packaged builds. |
| `SHELL` | L648 | The login shell used for env import. Falls back to `os.userInfo().shell`, then `/bin/bash`. csh and tcsh get `-c`; other shells get `-ilc`. |
| `PATH`, `SSH_AUTH_SOCK` | L690-697 | **Written**: imported from the login shell. `PATH` is prepended, with duplicates removed. |
| `SystemRoot` | L737, L5597 | Windows: OpenSSH fallback path and PowerShell path (default `C:\Windows`). |
| `APPIMAGE` | via `Ho` (L5691, L5740, L6026) | On Linux, self-update is enabled only when this is set. |
| all of `process.env` | L5604 | Copied, minus `PSModulePath`, into the PowerShell child, plus `SILICO_SIGNED_FILE`. |

`SILICO_CLUSTER_ID` and `SILICO_SETUP_BEARER` appear only inside **remote** SSH command strings (`oo`, around L4830). They are never read locally.

There is no `NODE_ENV`, `DEBUG`, or `SILICO_ENV`-style switch. "Dev versus prod" means `app.isPackaged` together with `ELECTRON_RENDERER_URL`. "Staging versus prod" means the `staging` setting at sign-in, and the session's `gatewayUrl` after that.

### 6.3 Environment constants (`env/origins`, L207-256)

| | prod | staging |
|---|---|---|
| Gateway | `https://my.silico.run` | `https://my-staging.silico.run` |
| Legacy aliases (fallback, `vo`) | `https://silico.goodfire.com` | `https://silico-staging.goodfire.com` |
| Signup | `<gw>/beta-signup` (`/confirm?token=`, `/resume?token=`) | same |
| Cluster CLI | `silico` | `silico-dev` |
| Remote state dir | `state` | `state/_dev` |
| Deployment id | as is | suffixed `-dev` (`kt`, `Ks` strips it) |

Docs URL: `https://docs.silico.run`.

### 6.4 Logging and telemetry

- **Console only.** Lines are tagged: `[auth] [lab] [labview] [signup] [updater] [app] [foreground] [ipc] [launch] [managed-wake] [memory] [shell] [viewer]`. No log file exists except `updater.log`.
- **`desktop_shell` events** (`te`, L101). Shape: `{event, kind, connId?, details?, build, appVersion, platform, login?, sub?, ts}`.
  - Each event is logged as `[shell] <json>` and pushed to a buffer that keeps the last 100. The Lab page drains it through `silico:shell-events:drain` after a nudge.
  - Kinds: `connect-outcome`, `reauth-outcome`, `session-death`, `viewer-stranded`, `down-panel`, `gateway-transport-failure`. The last one is deduped per (operation, hostname) when identical within 5 min.
- **`app_foreground` events** (`ci`, L585). Shape: `{event, cause, details, stack, msSinceResign, systemIdleSeconds, focusedWindow, connId, recent, build, appVersion, platform, ts, login, sub}`.
  - `cause` is the last `D(cause)` mark within 1.5 s, or else `"external-or-user"`.
  - `recent` holds the `qe(...)` activity marks from the last 5 s.
- **No network telemetry** is sent from main itself. Whatever leaves the machine goes through the Lab web page (inferred).

---

## 7. Evidence ledger

### Observed (read directly)

- **Settings.** Defaults at L258-265, notification defaults at L207-214, read at L286-310, write at L316-330, IPC at L6585-6591. Developer-menu logic at L7691-7713. Renderer patches at renderer L22716, L22732, L22890-22927.
- **Files.** Paths at L165, L284, L482, L1262, L1265, L5062, L5175, L6807. Modes at L1347 (0o600), L1428 (0o700), L926 (0o700), L938 (0o644).
- **Updater.** Config at L6025-6105. States at L5655-5671. `check` at L5688-5723. User check at L5725-5815. Install at L5934-5977. Marker at L5174-5210. Feed at app-update.yml.
- **Bootstrap.** L6999-7097 and L7650-7803. IPC trust at L6418-6437.

### Inferred

- The default `userData` folder name is `Silico`, because `setName` runs before any `getPath`.
- The `stable` path segment is the only channel.
- Telemetry leaves the device only through the Lab page.

### Unknowns

1. How the Lab page (preload-lab and the remote web app) uses `silico:shell-events:drain` and `silico:foreground` data. The upload destination is not in this bundle.
2. The exact electron-updater runtime behavior (MacUpdater proxying through Squirrel) is inferred from the library. Why a native `update-downloaded` can fire outside the `staging` phase is guarded against in the code but not explained.
3. Whether `settings.json` v1 files were ever written with `version: 1` or with no version. Both are treated the same.
4. What the 8 SPKI hashes in `ys` (L5490) are. The code treats them as a blocklist ("private key is publicly known", and TLS rejects them as -206 / revoked).
5. There is no visible build-time switch for staging (the bundle hard-codes both origins).

### Cross-area notes

- **Security.** IPC trust relies on the sender URL (`file:` or the dev origin). The Lab-page channels instead rely on the `persist:silico` partition. `window:open-settings-sheet`, `labs:held-elsewhere`, and `labs:focus-held` are registered **without** the `y` wrapper.
- **Auth.** `staging` only takes effect at the next sign-in. The renderer signs out right after toggling it.
- **Windows.** `window-state.json` is only applied to the first window. `lastOpened:get` answers only the initial window, and only once.
- **Notifications and badge** read `settings.notifications` on every event (no caching).

---

## 8. Reimplementation notes

### Suggested module boundaries

- `main/store/jsonFile.ts`: a generic `readJson` and an `atomicWriteJson(path, obj, {mode?})` that writes tmp then renames. Pair it with `serialQueue()`.
- `main/store/settings.ts`: `sanitizeSettings(raw)`, `readSettings()`, `writeSettings(patch)`, and `onSettingsChanged(listener)`.
- `main/store/{connections,lastOpened,windowState}.ts`.
- `main/updater/decisions.ts`: pure functions (listed below). `main/updater/controller.ts`: the state machine, timers, and dialogs, with the electron-updater, native autoUpdater, dialog, and fs dependencies injected.
- `main/env.ts`: origins, `cliName(staging)`, `stateDir(staging)`, `withDevSuffix`.
- `main/bootstrap.ts`: the top-level guards. `main/index.ts`: the whenReady sequence.
- `main/telemetry.ts`: the ring buffer and the foreground attribution.

### Pure functions to unit test, with example cases

| Function | Cases |
|---|---|
| `sanitizeSettings(raw)` | `{}` gives the defaults. `{version: 1, previewBuilds: true}` gives `previewBuilds: false`. `{version: 2, previewBuilds: true}` gives `true`. `{gatewayUrl: "https://my-staging.silico.run"}` gives `staging: true`. `{staging: false, gatewayUrl: <staging>}` gives `false`. `{notifications: {sound: "yes"}}` gives `sound: true` (the default). `{notifications: null}` gives all defaults. |
| `mergeSettings(cur, patch)` | Shallow: `{notifications: {enabled: false}}` replaces the whole sub-object. The written file always carries `version: 2`. |
| `sanitizeNotifications` | Each non-boolean field falls back to its default. |
| `classifyExitMarker(m, cur)` (`au`) | `null` gives `invalid`. `{fromVersion: "", …}` gives `invalid`. A non-finite `at` gives `invalid`. `from === cur` gives `failed`. Otherwise `applied`. |
| `shouldRelaunchOntoDisk` (`cu`) | Not darwin: false. Unpackaged: false. Already retried: false. No disk version: false. disk `0.138.0` vs running `0.137.0`: true. Same version: false. |
| `locationBlock(platform, access)` (`lu`) | linux/any: `none`. darwin/writable: `none`. darwin/read-only-volume: `needs-move`. darwin/denied: `needs-admin`. |
| `stagingVerdict` (`du`) | Phase not `staging`: `not-staging`. `now - start < 10 min`: `wait`. Otherwise `stalled`. |
| `graceRemaining` (`Ir`) | `{graceMs: 30000, markerAt: 0, now: 10000}` gives 20000. `now` 40000 gives 0. A future marker is clamped to `graceMs`. |
| `willInstallOnQuit` (`fu`) | darwin uses `nativeStaged`. Elsewhere, `phase === "downloaded"`. |
| `stagedPhase` (`uu`) | `confirmed === cycle` gives `downloaded`. Otherwise `staging`. |
| `installerDownloadUrl(feed, platform)` (`hu`) | `("https://x/stable/", "darwin")` gives `https://x/stable/Silico-universal.dmg`. `("ftp://x", …)` gives null. An unknown platform gives null. |
| `parseYamlUrl` / `parseYamlVersion` (`wu`/`mu`) | `url: 'https://a/b'` gives `https://a/b`. `version: 0.138.0` gives `0.138.0`. |
| `plistScalar` (`gu`) | `<string>a&amp;b</string>` gives `a&b`. |
| `selfUpdateSupported(platform, env)` (`Ho`) | Non-linux: true. linux without `APPIMAGE`: false. |
| `forbiddenSwitch(...)` (`Xa`) | Unpackaged: null. Packaged with `remote-debugging-port`: that switch, unless in test mode. |
| `secretPersistenceMode` (`Ka`) | Unpackaged: `plaintext-dev`. Test mode: `none-test-mode`. Encryption available: `keychain`. Otherwise `none-no-keyring`. |
| `validWindowState(json, workAreas)` (`cf`/`af`) | Off-screen: undefined. Zero width: undefined. Partial overlap: accepted. |
| `resumeWasLong(suspendAt, now)` (`hf`) | 0: false. A difference of at least 60000: true. |
| `isTrustedIpcSender(url, devUrl)` (`Cs`) | `file:///…`: true. The dev origin: true. `https://my.silico.run`: false. |
| `pushBounded(buf, ev, 100)` (`Ns`) | The 101st push drops the oldest and returns 1. |
| `attributeForeground(mark, now)` (`da`) | A mark within 1500 ms returns that mark's cause. Otherwise `external-or-user`. |
