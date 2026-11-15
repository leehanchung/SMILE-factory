# Spec: Windows, the embedded Lab view, the Viewer window, and the app menu

Source: Silico.app v0.137.0 (`ai.goodfire.silico`, build stamp `"2026-10-23 · 047c31d"`).
Evidence is from the prettified main bundle (`main.js`, line numbers below), `preload-index.js`,
`preload-lab.js`, and `renderer.js`. Minified identifiers appear only as `[id]` evidence tags.

---

## 1. Overview

The main process manages four kinds of `BrowserWindow`:

| Kind | Purpose | Created by | Renderer route |
|---|---|---|---|
| **Shell window** ("app shell") | The main Silico window. Shows the Labs picker / settings UI (React) in its own `webContents`, and hosts at most **one embedded Lab view** (`WebContentsView`) laid out beneath a 32 px title strip. | `createShellWindow()` `[Z]` L7288 | `index.html` (no hash) |
| **Settings sheet** (+ its dim overlay) | A modal-looking frameless child window over a shell window, showing settings tabs. | `openSettingsSheet(win, dest)` `[Qo]` L7368 | `index.html#settings-modal/<tab>` |
| **Viewer window** | A standalone window that shows one web page (a shared link, or an API document opened from a Lab) in a `WebContentsView` under a title strip with back/forward, title, and a recovery overlay. | `createViewerWindow()` `[Ni]` L3133 | `index.html#viewer` |
| **Popup window** | A window created by `window.open` from a Lab/viewer page to a same-origin URL. | Electron, via `setWindowOpenHandler` allow `[Fo]` L3107 | (remote page) |

(The signup flow also embeds a `WebContentsView` inside a shell window; it belongs to another area — see Cross-area notes.)

Key ideas:

* **Multi-window, one Lab per window.** Any number of shell windows can exist ("New Window", Cmd+N). Each holds at most one Lab view, keyed by window id. A Lab (connection id) is considered "held" by the window whose Lab entry carries that `connId`. The renderer uses `labs:held-elsewhere` to know which Labs are open in *other* windows and `labs:focus-held` to jump to that window instead of opening a duplicate. Exclusivity is **advisory** (renderer-enforced), not enforced in main.
* **Initial window.** Exactly one shell window at a time is flagged "initial" (the first window at launch, or a window recreated on `activate` / `second-instance` / welcome deep link when no shell window exists). Only the initial window is allowed to auto-reopen the last-opened Lab, and only once.
* **Compact mode.** When the renderer shows the Labs picker (no Lab open), it asks main to shrink the window to a 620 px-wide "picker" size with a content-driven height; leaving the picker restores the previous normal size.
* **Lab view lifecycle** `hidden → loading → shown`, with "down" states reported to the renderer, automatic re-auth/reopen ("rewake") on auth walls, crashes, sleep/wake, memory pressure, and a liveness watchdog.
* **App menu** is rebuilt when "developer" status changes. Menu actions route to the focused shell window (`app:navigate`) or open the settings sheet over a window that is currently showing a Lab.
* `D(cause, details?)` `[D]` L549 is **not** a dispatcher: it records the most recent "cause" (e.g. `"menu:settings"`, `"menu:navigate"`, `"second-instance"`) with a timestamp and stack, used by foreground-telemetry (`app_foreground` event, cause considered valid for 1500 ms `[da]` L507). A reimplementation can stub it as `noteForegroundCause()`.

---

## 2. IPC contract

Trust gates used below:

* **shell-trusted** `[y]/[Cs]` L6418-6437: `ipcMain.handle` wrapper. Sender frame URL (or sender URL) must have protocol `file:` or the same origin as `process.env.ELECTRON_RENDERER_URL`. Otherwise logs `[ipc] blocked '<ch>' from untrusted sender` and throws `Error("Blocked '<ch>': untrusted sender.")`.
* **lab-session** `[oe]` L6438: sender's session is `session.fromPartition("persist:silico")` (Lab or viewer page).
* **lab-view sender** `[de]` L3462: sender `webContents` is the Lab view of some shell window.
* **none**: registered with raw `ipcMain.handle` / `on` with no trust check (observed).

### 2.1 Renderer (shell/viewer/settings, `window.silico`) → main

| Channel | Kind | Args | Returns | Gate | Behavior |
|---|---|---|---|---|---|
| `window:is-initial` | invoke | – | `boolean` | shell-trusted | `true` iff the sender's window id equals the stored initial-window id `[di]` L624. |
| `window:set-compact` | invoke | `compact: unknown, contentHeight?: number` | `void` | shell-trusted | No-op if sender destroyed. If `compact` truthy **and** the window currently holds a Lab (`windowHoldsLab`, §3.4) → ignored. Otherwise `applyCompact(win, !!compact, contentHeight>0 ? contentHeight*sender.getZoomFactor() : undefined)` (§4.6). L6487-6497 |
| `window:open-settings-sheet` | invoke | – | `void` | **none**, but checks: sender's window exists, not destroyed, `win.webContents === sender`, and window is a shell window | Opens the settings sheet at `settings:notifications` (§4.7). L7448-7456 |
| `lastOpened:get` | invoke | `accountKey: string` | `string \| null` | shell-trusted | Returns stored last-opened connection id for that account **only if** the sender's window is the initial window **and** this is the first `lastOpened:get` since it became initial (`[ma]` L628: flips a one-shot flag). Otherwise `null`. Reads `userData/last-opened.json`. |
| `lastOpened:set` | invoke | `accountKey: string, connId: string` | `Promise<void>` | shell-trusted | Serialized (queue `[on]`) write of `{version:1, byAccount:{...prev,[accountKey]:connId}}` to `userData/last-opened.json` via `.tmp` + rename. L481-505 |
| `labs:held-elsewhere` | invoke | – | `string[]` | **none** | Connection ids of all Lab entries (any visibility) **plus** parked (memory-shed) entries, excluding the sender's own window. May contain duplicates in theory (not deduped). L7425-7430, `[kl]` L3527 |
| `labs:focus-held` | invoke | `connId: unknown` | `boolean` | **none** | Non-string → `false`. Find the window holding `connId` (live entries first, then parked) `[Ye]` L3468. None/destroyed → `false`. Else: restore if minimized, `D("menu:navigate","labs:focus-held")`, `show()`, `focus()`, **reveal** that window's Lab view if it is hidden (§4.5) → `true`. L7431-7442 |
| `lab:hide` | invoke | – | `void` | shell-trusted | `hideLab(win)` (§4.2). |
| `lab:goBack` | invoke | – | `void` | shell-trusted | `goBack(win)` (§4.3). |
| `lab:goForward` | invoke | – | `void` | shell-trusted | `goForward(win)`. |
| `lab:open` | invoke | `conn: Connection, opts?: {reachTimeoutMs?: number}` | `Promise<{status: "opened"\|"canceled"\|"unreachable"\|"still-waking"\|"other"\|...; url?: string}>` | shell-trusted | Cross-area (connection/auth). Ends by calling `openLabInWindow(win, conn.id, "<labUrl>/auth/callback?return_to=<enc>#token=<token>", conn.name \|\| conn.deploymentId \|\| "Lab")` (§4.1). `reachTimeoutMs` clamped to [1000, 120000], default 3000 `[xs]` L38. Emits `lab:phase` `{id, phase}` during. L6604-6627 |
| `viewer:retry` | invoke | `deployment?: unknown` | `void` | shell-trusted | On the sender window's viewer recovery controller: `recover(force=true, deployment)` where `deployment` is passed only if it is a string, current state is `choose`, and it is in `state.deployments`. No controller → no-op. L6501-6511 |
| `signup:open` | invoke | – | – | shell-trusted | Cross-area; note it first **hides the Lab** (`hideLab` without the cancel hook — calls `dt`) L6538-6540. |
| `auth:signOutAll` | invoke | – | – | shell-trusted | Cross-area; window effects: closes all popup/viewer ("aux") windows `[rl]`, clears badge counts; for every window: if it is the sender's root window (sender's parent or itself) or its child → send `auth:expired` and hide its Lab; else `close()` it. L6543-6555 |

### 2.2 Lab page (`window.silicoDesktop`, preload `lab.js`) → main (window-relevant subset)

| Channel | Kind | Args | Returns | Gate | Behavior |
|---|---|---|---|---|---|
| `silico:recover-session` | invoke | – | `{status:"accepted"} \| {status:"unsupported"} \| {status:"error", message:"Could not restore this window. Please try again."}` | **none** (checks inside) | Accepted only when the sender has a registered recovery hook, sender frame is the main frame, and the page is "eligible" (current URL origin is the tracked lab origin, path matches the Lab route allow-list `[rt]`, not a gateway origin). Then calls the hook; hook returning `false` → unsupported. `[Kc]` L2643 |
| `silico:open-desktop-settings` | send | – | – | lab-view sender | Opens the settings sheet on that window at `settings:notifications`. L7418-7421 |
| `silico:open-lab-switcher` | send | – | – | lab-view sender | Creates a **new** shell window and immediately puts it in compact mode with default height (no content height). Note: it is *not* marked initial. L7422-7424 |
| `silico:badge-counts` | send | `{attention:number, unread:number}` | – | lab-session | Dock badge (§4.10). |

### 2.3 Main → renderer events

| Channel | Target | Payload | When |
|---|---|---|---|
| `app:navigate` | shell or settings-sheet `webContents` | `dest: string` — `"connections"`, `"settings:notifications"`, `"settings:developer"`, `"settings:profile"` | Menu navigation `[xn]`, re-focusing an existing settings sheet, deep-link signup flow. Renderer: `settings…` → settings view with tab (`profile`/`developer` else `notifications`); anything else → labs view; also clears open-lab UI state (renderer.js L19566-19584). |
| `lab:opened` | shell | `{id: string, title: string}` | Start of `openLabInWindow`; on reveal of a hidden Lab; on shell reload resync; after a crash-reload when lab state needed. |
| `lab:state` | shell | `{id: string, state: "loading"\|"ready"\|"down", reason?: "error"\|"still-waking"}` | See §4. |
| `lab:viewvis` | shell | `{shown: boolean, title?: string}` | Whenever the Lab view is shown (`true`, with title) or hidden (`false`, no title). Renderer stores as "labCover". |
| `lab:navstate` | shell **or viewer** | `{canGoBack: boolean, canGoForward: boolean}` | Shell: after Lab nav events / visibility changes (`false,false` unless shown). Viewer: after viewer page navigation and on viewer strip load. |
| `lab:phase` | shell | `{id, phase}` | Cross-area (open progress). |
| `viewer:content-ready` | viewer | `undefined` (⇒ true) or `false` | Preload maps payload `!== false` to boolean. Sent `true` once the page is revealed; `false` when recovery hides it. |
| `viewer:recovery` | viewer | `RecoveryState` (§3.5) | Recovery state transitions; also re-sent on viewer strip reload. |
| `viewer:title` | viewer | `string` | Page title updates (window title set to title or `"Silico"`). |
| `auth:expired` | shell | – | Cross-area. |
| `silico:report-issue` | Lab view | – | Menu "Send feedback" when a Lab is shown. |

---

## 3. Window / view model

### 3.1 Constants (all observed values)

```ts
const DEFAULT_W = 1280;                 // [cn] L332
const DEFAULT_H = 840;                  // [ln] L333
const MIN_H = 540;                      // [Pe]
const MIN_W = Math.round(540*1280/840); // [ct] = 823
const COMPACT_W = 620;                  // [Zs]
const COMPACT_DEFAULT_H = 680;          // [Xs]
const COMPACT_MAX_H = 880;              // [Qs]
const COMPACT_MIN_W = 520;              // [ea]
const COMPACT_MIN_H = 500;              // [Nn]
const COMPACT_SCREEN_MARGIN = 40;       // [ta]
const CASCADE_OFFSET = 28;              // [sr] L360
const STRIP_HEIGHT = 32;                // [$i] L2399  (title strip above Lab/viewer view)
const SIGNUP_BAR_DEFAULT = 78;          // [fs] L5290 (cross-area)
const WIN_OVERLAY_COLOR = "#ffffff";    // [Vc]
const WIN_OVERLAY_SYMBOL = "#1d272a";   // [Hc]
const LAB_PARTITION = "persist:silico"; // [Se] L3032
const SIGNUP_PARTITION = "persist:silico-signup"; // [zo] L5291
const LAB_MIN_LOADING_MS = 1500;        // [tl]
const LAB_MOUNT_WAIT_MS = 20000;        // [nl]
const VIEWER_REVEAL_FALLBACK_MS = 5000; // [ol]
const CRASH_WINDOW_MS = 60000, CRASH_MAX = 3;   // [Dc],[Lc] L2287
const SHELL_SHOW_FALLBACK_MS = 500;     // L7319
const WINDOW_STATE_SAVE_DEBOUNCE_MS = 250; // [uf] L6817
const RENDERER_WAIT_MS = 8000;          // [_l] L3574
const DOCS_URL = "https://docs.silico.run"; // [bf]
```

### 3.2 Platform chrome `[Oi]` L2402

```ts
function chromeFor(platform): Partial<BrowserWindowConstructorOptions> {
  if (platform === "darwin") return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 10 } };
  if (platform === "win32")  return { titleBarStyle: "hidden", titleBarOverlay: { color: "#ffffff", symbolColor: "#1d272a", height: 32 } };
  return {};
}
```
No `vibrancy`, no `backgroundColor` on shell/viewer windows (observed absence). Only the settings dim overlay sets `backgroundColor: "#1d272a"`.

### 3.3 BrowserWindow / WebContentsView options

**Shell window** `[Z]` L7288-7306:
```ts
{
  width: saved?.width ?? 1280, height: saved?.height ?? 840,
  minWidth: 823, minHeight: 540,
  ...(saved ? { x: saved.x, y: saved.y } : cascadePosition()),   // cascadePosition may return undefined → OS default
  show: false, autoHideMenuBar: true, title: "Silico",
  icon: nativeImage(appPath/resources/icon.png),
  ...chromeFor(process.platform),
  webPreferences: { preload: "<out>/preload/index.js", sandbox: false, contextIsolation: true },
}
```
`saved` is read from `userData/window-state.json` **only when no BrowserWindow exists at all** (`getAllWindows().length === 0`). Loads `ELECTRON_RENDERER_URL` (dev) or `renderer/index.html`.

**Viewer window** `[Ni]` L3134-3143:
```ts
{
  ...(parent ? sizeLikeParent(parent) : { autoHideMenuBar: true, title: "Silico" }),
  show: false, ...chromeFor(platform),
  webPreferences: { preload: "<out>/preload/index.js", sandbox: false, contextIsolation: true },
}
// then win.setMenuBarVisibility(false); registered as an "aux" window
```
`sizeLikeParent(p)` `[ni]` L378: `{width: max(p.width,823), height: max(p.height,540), minWidth: 823, minHeight: 540, ...cascadePosition(w,h,p), autoHideMenuBar: true, title: "Silico"}`. With no parent, size is Electron's default (Inferred: 800×600). Loads `index.html#viewer` (dev: `${ELECTRON_RENDERER_URL}#viewer`).

**Viewer content view** L3145-3156: `new WebContentsView({webPreferences: {partition: "persist:silico", ...(labBridge ? {preload: "<out>/preload/lab.js", backgroundThrottling: false} : {})}})`, added to `win.contentView`, initially `setVisible(false)`.

**Lab view** (in shell window) L3718-3724: `new WebContentsView({webPreferences: {partition: "persist:silico", preload: "<out>/preload/lab.js", backgroundThrottling: false}})`; `setVisible(false)`; added as child of shell `contentView`. (Electron defaults otherwise: `contextIsolation` true, `sandbox` default.)

**Popup window** (from `window.open` same-origin) `[Fo]` L3108-3111: `overrideBrowserWindowOptions = sizeLikeParent(hostWindow)`; on creation: menu bar hidden, registered aux, gets the same open-handler/frame guards recursively, and a navigation guard allowing only same-origin to its initial URL (others → external browser).

**Settings dim overlay** L7376-7392: `{parent: win, x,y,width,height: win.getBounds(), show:false, frame:false, focusable:false, hasShadow:false, backgroundColor:"#1d272a", resizable:false, minimizable:false, maximizable:false, skipTaskbar:true}`; `setIgnoreMouseEvents(true)`; `setOpacity(0.3)`.

**Settings sheet** L7393-7409: `w = min(800, parentW-24)`, `h = min(600, parentH-24)`, `x = round(px + (pw-w)/2)`, `y = round(py + max(28, (ph-h)/3))`; `{parent: win, show:false, frame:false, hasShadow:false, resizable:false, minimizable:false, maximizable:false, title:"Settings", webPreferences:{preload index.js, sandbox:false, contextIsolation:true}}`. Loads `index.html#settings-modal/<tab>`.

### 3.4 In-memory state

```ts
type LabVis = "hidden" | "loading" | "shown";

interface LabEntry {              // map labs: Map<winId, LabEntry>  [b] L3027
  view: WebContentsView;
  connId: string;
  title: string;
  vis: LabVis;
  reauthing: boolean;             // a re-auth/reopen is in flight for this window
  userLeft: boolean;              // user hid the lab while reauthing → abort the pending reopen
  lastStatus: number;             // HTTP status of last main-frame did-navigate
  labOrigin: string | null;       // origin of the URL passed to openLabInWindow
  loadStartedAt: number;          // ms epoch of last loadURL
  downLoadStartedAt?: number;     // loadStartedAt value when "down" was last reported (dedupe)
}

interface ParkedLab { connId: string; returnTo: string | null }   // parked: Map<winId, ParkedLab> [ae]

// Shell-window registry
shellWindowIds: Set<number>;          // [wo] L7268; isShellWindow(w) [Y]
initialWindowId: number | null;       // [ui] L623
initialLastOpenedConsumed: boolean;   // [jn]
auxWindows: Set<BrowserWindow>;       // [Qn] viewer + popup windows, closed on sign-out-all
viewerViews: Map<winId, WebContentsView>;          // [Ve] L3127
viewerRecovery: Map<winId, RecoveryController>;    // [Xn] L2850
settingsSheets: Map<parentWinId, BrowserWindow>;   // [$e] L7367
dialogOpenFor: Set<winId>;            // [fo] windows with a dialog:confirm open (sheet must not auto-close)

// Compact-mode bookkeeping  L390-429
compactNormalBounds: Map<winId, Rectangle>;  // [we] presence ⇒ window is compact
compactRecordedHeight: Map<winId, number>;   // [me]
compactUserResized: Set<winId>;              // [be]
compactResizeHooked: Set<winId>;             // [Bn]
pendingFirstCompact: Map<winId, () => void>; // [Gt] one-shot callback run after next applyCompact

// Re-auth state per window [z] L4486: WeakMap<BrowserWindow, {kind:"reauthing"} | {kind:"cooldown", until:number}>
// Open epoch per window [_e] L4205: Map<winId, number>, bumped to supersede in-flight opens.
```

Derived predicates:
```ts
windowHoldsLab(w) = entry && (entry.vis !== "hidden" || (entry.reauthing && !entry.userLeft)) || parked.has(w.id)  // [Dl] L3627
isLabShown(w)     = labs.get(w.id)?.vis === "shown"                          // [ji]
labStateFor(vis, downAlreadyReported) = vis==="shown" ? "ready" : downAlreadyReported ? "down" : "loading" // [Tc] L2285
isReloadableVis(vis) = vis === "loading" || vis === "shown"                  // [Rc]
```

### 3.5 Viewer recovery state (sent on `viewer:recovery`)

```ts
type RecoveryState =
  | { kind: "idle" }
  | { kind: "loading"; message: string }          // "Restoring this page…"
  | { kind: "signin"; staging: boolean; message: string }
  | { kind: "choose"; message: string; deployments: string[] }
  | { kind: "error"; message: string };
```

### 3.6 Persistence files (userData)

| File | Shape | Written |
|---|---|---|
| `window-state.json` | `{x,y,width,height}` (shell `getBounds()`) | Debounced 250 ms on shell `resize`/`moved`, skipped while the window is compact. Errors swallowed. L6807-6824 |
| `last-opened.json` | `{version:1, byAccount: Record<string,string>}` | `lastOpened:set`. Non-string values dropped on read. |

Restore validation `[cf]/[af]` L6788-6806: parse JSON; reject unless x,y,width,height all finite, width>0, height>0, and the rect intersects (strict overlap) at least one display's `workArea`. Otherwise ignore.

---

## 4. Flows

### 4.1 Open a Lab in a shell window (`openLabInWindow(win, connId, url, title)`) `[Bo]` L3695-3910

1. If window missing/destroyed → return. If the entry has `userLeft` set → clear `userLeft` and `reauthing`, **return without opening** (the user hid the Lab while a reopen was pending).
2. Send `lab:opened {id: connId, title}`.
3. If an entry exists and (its view is destroyed **or** its `connId` differs) → remove view from window, send `lab:viewvis {shown:false}`, close its webContents, delete entry.
4. If no entry: create the Lab view (§3.3), hidden; install popup/frame guards (§6.2), Lab navigation guard (§6.3), recovery hook (the page can request re-auth via `silico:recover-session`, which triggers the window's re-auth routine `rs(win, connId)` if this view is still current and not hidden). Wire:
   * `did-navigate` → record `lastStatus = httpResponseCode`; send navstate.
   * `did-navigate-in-page` (main frame) → send navstate.
   * `did-finish-load` → **readiness check** (step 7).
   * `did-fail-load` (main frame, `errorCode !== -3`) → mark down.
   * `render-process-gone` → mark down.
   * New entry `{vis:"hidden", reauthing:false, userLeft:false, lastStatus:0, labOrigin:null, loadStartedAt:0}`; add as child view.
5. Update entry: `connId`, `title`, `vis="loading"`, `reauthing=false`, `lastStatus=0`, `labOrigin = origin(url)` (null if unparsable), `loadStartedAt = now`.
6. Pre-layout trick `[pl]`: setVisible(true) → setBounds → setVisible(false). Send `lab:state {id, state:"loading"}`. `view.webContents.loadURL(url)`.
   * Any exception → log `[labview] openLabInWindow failed` and send `lab:state {id, state:"down", reason:"error"}`.
7. Readiness (on each `did-finish-load` while entry is this view and not hidden):
   1. `lastStatus >= 400` → **down**.
   2. Evaluate in page: does `[data-testid="auth-github-login"]` exist? If yes → trigger re-auth (`rs(win, connId)`, §4.4) and stop.
   3. Await (max 20 s) a page script that resolves when the SPA is mounted: `html[data-silico-mounted]` set, or `#root` has children other than a lone `#silico-boot` (observed MutationObserver on attributes+childList).
   4. Abort if superseded (entry gone/hidden, `loadStartedAt` changed, or down already reported for this load).
   5. Ensure at least 1500 ms since `loadStartedAt`, then **ready**.
8. **ready**: if hidden, ignore. Else `lab:viewvis {shown:true, title}`, `view.setVisible(true)`, `vis="shown"`, navstate, run "lab revealed" hooks (`[Pi]`: e.g. deliver pending `silico:checkout-return` / `silico:navigate` from notifications), send `lab:state {id, state:"ready"}`.
9. **down**: `vis="loading"`; if this load hasn't been reported down yet, record `downLoadStartedAt = loadStartedAt` and emit telemetry `down-panel`. Then `[Tl]`: wait for the shell renderer to be usable (if shell webContents crashed → reload it and wait ≤ 8 s for finish/fail/destroy); if the entry/load is unchanged and still `loading` → (if the shell was reloaded, resend `lab:opened`) send `lab:state {state:"down", reason:"error"}`, hide view, `lab:viewvis {shown:false}`, navstate.

### 4.2 Hide the Lab (`lab:hide`) `[No]`+`[dt]` L3631-3640, L3616-3624

1. Bump the window's open epoch and cancel any pending "resume after sign-in" reopen (`[ts]` via `[xo]` hook L4483-4486), clear reauth flags (`Wo`).
2. If the entry is `reauthing` → set `userLeft = true` (so a later `openLabInWindow` aborts, step 4.1.1).
3. `view.setVisible(false)`, `vis = "hidden"`, send `lab:viewvis {shown:false}`, navstate (`false,false`). The view and its page are **kept alive** (not destroyed) — the Lab stays "held" by this window.

Other callers of plain hide (`dt`, without step 1/2): `signup:open`, sign-out-all, failed reopen (`os`), start of a reopen (`ns`), deep-link signup (`No`).

### 4.3 Back / Forward

* Target webContents `[zi]`: the window's Lab view if `vis==="shown"` and alive; else the viewer view of that window; else nothing.
* Back: if `navigationHistory.canGoBack()` → `goBack()`. Forward analogously. Triggered by `lab:goBack`/`lab:goForward`, menu History items, and window `app-command` `browser-backward`/`browser-forward` (mouse buttons on Windows/Linux) for both shell and viewer windows.
* `lab:navstate` emission (shell) `[Oe]`: `{canGoBack, canGoForward}` from the Lab view if shown, else both `false`.

### 4.4 Re-auth / reopen in place ("rewake")

Two entry points (cross-area detail lives with auth/connection spec):
* `rs(win, connId, returnTo?)` (auth wall seen) `[rs]` L4537: skip if already reauthing; if in cooldown (45 s after a previous attempt) → report down; else run reopen with 15 s reach timeout; afterwards set cooldown 45 s unless outcome is `expired`/`superseded`.
* `xt(win, connId, returnTo?)` (wake/crash/watchdog/memory) `[xt]` L4558: skip if reauthing; reopen with 30 s reach timeout; restore any previous cooldown.

Reopen `[ns]` L4499: compute `returnTo` = current Lab route (path+search+hash, excluding `/` and `/auth/callback…`) `[Hi]/[vc]`; bump epoch; set `reauthing`; wait for shell renderer; resend `lab:opened` if shell was reloaded; send `lab:state loading`; **hide** the view; re-run the connection open (`Ge` with `browserFallback:false`). Outcome `opened` → done (open flow 4.1). `expired` → clear badges, send `auth:expired`, remember to resume after sign-in. Others → `lab:state {state:"down", reason: "still-waking" | "error"}` and hide.

### 4.5 Focus a Lab held by another window (`labs:focus-held`) and reveal

1. Renderer: when the user picks a Lab whose id is in `heldElsewhere`, call `labs.focusHeld(id)`; if it returns `false`, drop it from the list and open locally (renderer.js L20054-20066).
2. Main: locate holder window (live entry or parked). Restore, `show()`, `focus()`.
3. Reveal `[Vi]` L3486: only if entry `vis === "hidden"`: send `lab:opened {id,title}`, layout, `lab:viewvis {shown:true,title}`, `setVisible(true)`, `vis="shown"`, `lab:state ready`, navstate. (A parked window has no entry → nothing revealed; it will reopen on next app activation, §4.9.)

`labs:held-elsewhere` is re-queried by the renderer on mount of the picker and on every window `focus` event while no Lab is open.

### 4.6 Compact mode (`window:set-compact`) `[oi]` L430-480

Pure helpers:
```ts
compactContentHeight(h?: number, workH: number): number   // [rr]
  if (h === undefined || !isFinite(h)) return 680;
  const cap = min(880, max(500, workH - 40));
  return ceil(max(500, min(h, cap)));
frameHeight(win, contentH) = contentH + (win.getBounds().height - win.getContentBounds().height) // [cr]
centerClamp(oldBounds, w, h, workArea): Rectangle   // [ir]
  cx = old.x + old.width/2; cy = old.y + old.height/2
  x = round(clamp(cx - w/2, wa.x, wa.x + wa.width - w)); y = round(clamp(cy - h/2, wa.y, wa.y + wa.height - h))
  // clamp(v, lo, hi) = max(lo, min(v, hi))  (lo wins if hi < lo)
```
Algorithm `applyCompact(win, compact, contentH?)`:
1. Ensure a one-time `resize` listener: while compact and not fullscreen/maximized, if `|bounds.height − recordedHeight| > 1` mark **user-resized**, else unmark.
2. **Entering** (compact && not currently compact): store `getNormalBounds()`; clear user-resized; `setMinimumSize(520, 500)`; if fullscreen → forget recorded height (no resize); else `h = frameHeight(compactContentHeight(contentH, workArea.height))`, bounds = `centerClamp(current, 620, h, workArea)`, `setBounds`, record height.
3. **Leaving** (!compact && currently compact): read stored normal bounds; clear all compact bookkeeping; `setMinimumSize(823, 540)`; width = stored.width if ≥823 else 1280; height = stored.height if ≥540 else 840; `setBounds(centerClamp(current, width, height, workArea))`.
4. **Staying compact with a new height** (compact && already compact && contentH defined && not user-resized && not fullscreen/maximized): `s = frameHeight(compactContentHeight(contentH, workH))`; if `|s − bounds.height| > 1`: `setBounds({x, y: min(y, max(wa.y, wa.y + wa.height − s)), width, height: s})`, record.
5. Finally run and clear the window's pending-first-compact callback (used by the show gate, §4.8).

Renderer contract: the shell renderer calls `setCompact(labsPicker, contentHeight)` whenever the landing state is known and picker visibility/size changes; `contentHeight` = inner content height + body padding + (innerHeight − body height), only when the picker labs list is showing (renderer.js L19781-19806). Main multiplies by `sender.getZoomFactor()`.

### 4.7 Settings sheet `[Qo]` L7368-7417

`openSettingsSheet(win, dest)`; `tab = dest.split(":")[1] ?? "notifications"`.
1. Existing sheet for `win` → `D("menu:settings", dest)`, `focus()` it, send it `app:navigate dest`. Done.
2. Else create overlay + sheet (§3.3). Register `sheets[win.id] = sheet`.
3. Sheet `closed` → unregister (if still current), destroy overlay.
4. Sheet `blur` → `close()` unless a `dialog:confirm` is open for it or its DevTools are open (light-dismiss).
5. Sheet `ready-to-show` → `overlay.showInactive()`, `D("menu:settings")`, `sheet.show()`, `sheet.focus()`.
6. Load `#settings-modal/<tab>` (renderer accepts `^#settings-modal\/(\w+)$`).
Note: overlay/sheet are positioned once at creation; they do not follow parent moves/resizes (no listeners observed).

### 4.8 Shell window creation and show gate `[Z]` L7288-7366

1. Construct (§3.3). Register pending-first-compact callback; on `ready-to-show`: if compact was already applied → show now, else show after 500 ms. Show = packaged ? (`D("window-create")`, `show()`) : `showInactive()`. (Purpose: avoid a visible resize flash when the renderer will request compact.)
2. Shell `setWindowOpenHandler`: always deny; open http/https URLs in the system browser `[Ee]` L16.
3. `resize` → relayout Lab view and signup view, save window state (unless compact). `moved` → save window state.
4. Add to shell registry. `closed` → remove from registry; tear down Lab entry (`cancel hook`, close view webContents, delete entry and parked record) `[gl]`; tear down signup view; clear compact state; kill this window's SSH tunnel `[B]`.
5. `webContents did-start-loading` → close signup view.
6. Shell renderer crash `render-process-gone`: crash-loop guard `shouldRevive(reason, history, now)` `[Mi]` = `reason !== "clean-exit" && history.filter(t => now − t < 60000).length < 3`. Logs `[shell] window <id> renderer gone (<reason>); reviving|crash-looping — giving up` (not for clean-exit). If revive: push now, reload; log failed revive loads; on `did-finish-load` resync `[Sl]`: if entry hidden → resend `lab:opened` only when `reauthing && !userLeft`; else resend `lab:opened`, (if shown) `lab:viewvis true`; if Lab view is destroyed or crashed → reopen via `xt(win, connId)`; else send `lab:state` = `labStateFor(vis, downLoadStartedAt===loadStartedAt)` (with `reason:"error"` when down).
7. `focus` → if the Lab view is shown and not focused, focus it `[Yn]`.
8. Lab view layout `[ke]` L3384: `[w,h] = win.getContentSize(); top = ceil(32 × win.webContents.getZoomFactor()); view.setBounds({x:0, y:top, width:w, height:max(0, h−top)})`. Same layout for viewer views. Relayout on window resize, on strip `did-finish-load` (viewer), and after any zoom change (all windows).

### 4.9 App lifecycle

**Startup** (whenReady, only if single-instance lock held) L7647-7798: set dock icon (macOS, if icon non-empty); install IPC; build menu (`dev=false`); dock menu; **create shell window and mark it initial**; process any deep link captured before ready; start updater; register `activate`; start watchdog; power/memory hooks.

**Single instance** L7023-7024: `lock = !app.isPackaged || app.requestSingleInstanceLock()`; if not acquired → `app.exit(0)`. (Unpackaged/dev builds never take the lock.)

**second-instance** L7080-7095: if argv contains a `silico:` URL (case-insensitive prefix) → handle deep link (or stash until ready). Else (when ready): first live shell window → `D("second-instance")`, restore if minimized, `app.focus({steal:true})`, `show()`, `focus()`; none → create shell window and mark initial.

**open-url** (macOS) L7077: preventDefault; handle now or stash until ready.

**activate** (macOS dock click) L7722-7725: if no live shell window exists → create one and mark initial. (Viewer windows don't count.)

**window-all-closed** L7799: quit unless macOS.

**before-quit** L7802: kill all SSH tunnels (+ updater hook L6056, cross-area).

**App focus helpers**: `activateApp()` `[Ts]` L7101: `app.focus({steal:true})`; on macOS also schedule `dock.bounce("critical")` after 350 ms `[go]`. `[Zo]`: activate then `win.focus()`, and on macOS `showInactive()` if visible.

**Memory shedding** (macOS only) L7774-7790: every 30 s while the app is *inactive*, read `sysctl -n kern.memorystatus_level`; if `< 15` → for each shown, non-reauthing Lab: send `lab:state loading`, remove view, `lab:viewvis false`, close its webContents, park `{connId, returnTo: current route}`. Logs `[memory] shed <n> backgrounded Lab view(s) at <level>% available`. On `did-become-active`, every parked Lab is reopened with `xt(win, connId, returnTo)` (parked list cleared).

**Sleep/wake** L7756-7772: on `resume`, if suspended ≥ 60 s → after 2 s: trigger update check and `xt` every shown Lab; always repaint (`invalidate`) shown windows+views and run a watchdog tick.

**GPU process gone** (non clean-exit) L7071-7076: log, then after 1 s invalidate all shown windows and Lab views.

**Watchdog** `[Bc]` L2328, every 15 s and on any `browser-window-focus`: for each shown Lab whose window (or its settings sheet) is focused and system idle < 120 s: managed Labs probe `<labOrigin>/healthz` (5 s timeout; ≥500 or 425 = down); 2 consecutive downs → `xt`. Page probe (skipped if loading or < 15 s since load start; 5 s timeout) classifies `alive|dead|unknown` via DOM (`#root` empty or only `#silico-boot` ⇒ dead). 2 dead strikes ≥ 10 s apart → `xt`, at most 2 such page rewakes per (window, connId).

### 4.10 Dock badge `[$l]/[kr]` L3870-3914

Per Lab connId, keep last `{attention, unread}` (each must be finite ≥0 number, floored, capped 9999; else the message is ignored). Total across Labs (entries dropped when no window holds that connId). If notifications disabled or badge disabled → empty. `attention>0` → text `String(attention)`, count=attention; else `unread>0` → text `"•"`, count 0; else empty. macOS `dock.setBadge(text)`; Linux `app.setBadgeCount(count)`; Windows nothing. Recomputed (serialized) on message, Lab view destroy, window close, settings change, and cleared on sign-out/expiry.

### 4.11 Viewer window flow (share link / API document) `[Ni]` L3133-3333

Entry points:
* Share deep link `silico://open?url=<https://*.silico.run/... | http://localhost|127.0.0.1/...>` `[tf]` → `ul(url, reveal)`: parent = focused or first window; `labBridge = isLabishUrl(url) && (isLabRoute(url) || isGatewayUrl(url))`. Revealed (macOS `showInactive()+focus()`, else `show()`) only after both app activation and viewer `ready-to-show` have occurred `[mf]`.
* Lab navigates main frame to a same-origin `/api/...` URL → `ll(parentShell, url)`: `D("doc-window", host)`, viewer with `labBridge:false`, shown on `ready-to-show`.

Steps:
1. Create window + hidden view; layout on resize and strip load; guards (§6.2); store view.
2. `contentRevealed` (once): if recovery state non-idle → skip; cancel fallback timer; `view.setVisible(true)`; send `viewer:content-ready`. Fallback timer: reveal after 5 s regardless.
3. On view `did-finish-load` (and main-frame in-page nav): if `labBridge` and URL is not a revealable path (`/auth/callback`, `/` with `return_to`, `/artifacts/<x>`, `/reports|papers|publications/<x>` are **not** revealable `[wr]`) → wait. Non-labBridge → reveal. labBridge → run an "artifact settled" page script (resolves after artifact read frame loads / denied/error marker / two rAFs with no artifact page) then reveal if URL still revealable.
4. Recovery controller (labBridge only) emits `RecoveryState`; non-idle → hide view, `viewer:content-ready false`; idle → re-check reveal.
5. If the initial URL is a gateway URL (`https://my.silico.run`, `https://my-staging.silico.run` or aliases `https://silico.goodfire.com`, `https://silico-staging.goodfire.com`) → start recovery, or if no controller, state error `"This link cannot be opened in Silico. Open a current share link."`. Otherwise `loadURL(url)`.
6. Main-frame load failure (not -3): if recovering → `fail("Could not load this page. Please try again.")`; else reveal anyway.
7. On did-finish-load of an eligible Lab page, if `[data-testid="auth-github-login"]` exists → telemetry `viewer-stranded` (once) and `recover()`.
8. Title: `page-title-updated` → `win.setTitle(title || "Silico")`, send `viewer:title`.
9. Strip renderer crash → same crash-loop guard (log prefix `[viewer] window <id> strip renderer gone`), reload. Strip `did-finish-load` → resend title, navstate, `content-ready` if revealed, current recovery state.
10. `closed` → clear timer, drop view, close its webContents (and controller cleanup).

Recovery controller user-facing strings (observed, `[el]`/`[Zc]` L2738-2990): `"Restoring this page…"`, `"Sign in to restore this page in Silico."`, `"Choose the Lab that contains this shared page."`, `"The renewed session was rejected. Try again, or reopen the link after checking your account."` (non-forced retry within 45 s), `"Recovery was canceled. Please try again."`, `"This page did not finish opening. Please try again."` (30 s after handing the URL to the view), `"Could not restore this page. Please try again."`, `"The signed-in account changed. Reopen this link with the intended account."`, `"This page belongs to a different account or environment. Reopen the link with the intended account."`, `"That Lab is no longer available to this account."`, `"This account has no hosted Labs that can open this link."`, `"This account does not have access to the requested Lab."`, `"The gateway returned an unsupported Lab address."`, `"Your Lab is still starting. Try again in a moment."`, `"Your Lab could not be reached. Check your connection and try again."`, and the routing errors in `[Yc]` L2696-2735.

---

## 5. Application menu `[Br]` L7525-7639

Rebuilt by `buildMenu(dev)`. `dev = settingsDev || signedInDeveloper`, where `settingsDev = developerMode || staging || previewBuilds || verbose || skipVersionCheck` (settings) and `signedInDeveloper = auth.status==="signed-in" && auth.developer`. Rebuilt whenever `dev` changes; when it flips to false in a packaged build, all open DevTools are closed. Initial build uses `dev=false`.

Shared "settings items" `S`:
| Label | Accelerator | Action |
|---|---|---|
| Notifications | `CmdOrCtrl+,` | `navigateMenu("settings:notifications")` |
| Developer settings *(only if dev)* | – | `navigateMenu("settings:developer")` |
| Profile | – | `navigateMenu("settings:profile")` |

| Menu | Item | Accelerator / role | Action |
|---|---|---|---|
| **Silico** (macOS only, label `app.name`) | About | role `about` | About panel: name "Silico", version `app.getVersion()`, `version: "2026-10-23 · 047c31d"` |
| | Check for Updates… | – | manual update check (cross-area `[nd]`) |
| | — | separator | |
| | *S items* | | |
| | — | | |
| | Services | role `services` | |
| | — | | |
| | Hide / Hide Others / Show All | roles `hide`, `hideOthers`, `unhide` | |
| | — | | |
| | Quit | role `quit` | |
| **File** | New Window | `CmdOrCtrl+N` | create shell window (not initial) |
| | *(non-macOS)* — + *S items* | | |
| | — | | |
| | Close (macOS) / Quit (others) | role `close` / `quit` | |
| **Edit** | | role `editMenu` | |
| **View** | Reload | `CmdOrCtrl+R` | reload focused window target `[yr]`: Lab view if vis loading/shown, else viewer view, else window webContents |
| | Force Reload | `Shift+CmdOrCtrl+R` | same target, `reloadIgnoringCache()` |
| | — | | |
| | Toggle Developer Tools *(dev or unpackaged)* | `Alt+Command+I` (mac) / `Ctrl+Shift+I` | toggle DevTools (`mode:"detach"`) on shown Lab view ?? viewer view ?? focused window |
| | — *(same condition)* | | |
| | Actual Size | `CmdOrCtrl+0` | focused webContents `zoomLevel = 0`; relayout all views |
| | Zoom In | `CmdOrCtrl+Plus` | `zoomLevel += 0.5`; relayout |
| | Zoom Out | `CmdOrCtrl+-` | `zoomLevel -= 0.5`; relayout |
| | — | | |
| | Toggle Full Screen | role `togglefullscreen` | |
| **History** | Back | `CmdOrCtrl+[` | goBack(focused window) |
| | Forward | `CmdOrCtrl+]` | goForward(focused window) |
| **Window** | | role `windowMenu` | |
| **Help** (role `help`) | Help center | – | `shell.openExternal("https://docs.silico.run")` |
| | Send feedback | `CmdOrCtrl+Shift+/` | if focused window's Lab is shown → send `silico:report-issue` to the Lab view |

Zoom note: "focused webContents" is `webContents.getFocusedWebContents()` — may be the Lab view or the shell strip; after any zoom, all Lab/viewer/signup views are re-laid out because the strip height scales with the host window's zoom factor.

**Dock menu** (macOS) `[Rf]`: single item "New Window" → create shell window.

**`navigateMenu(dest)`** `[xn]` L7476-7500:
1. Target = focused window if it is a shell window, else first live shell window.
2. If target exists: restore if minimized, `D("menu:navigate", dest)`, `show()` (no explicit focus). If `dest !== "connections"` and the target is **showing a Lab** → open the settings sheet with `dest`. Else send `app:navigate dest`; if `dest === "connections"` also hide its Lab (`lab:hide` semantics).
3. No shell window: create one (not initial); if `dest !== "connections"` send `app:navigate dest` after its first `did-finish-load`.

**Context menu** (every webContents, L7055-7067): only for editable targets: spelling suggestions (or disabled "No spelling suggestions") + "Add to Dictionary" + separator when a word is misspelled; then Undo, Redo, —, Cut, Copy, Paste, Select All (roles, enabled per `editFlags`). Popped up on the window owning the Lab view, else the webContents' window, else focused window.

---

## 6. Security notes

### 6.1 Partitions & sessions
* Shell, viewer strip, settings sheet: default session; `sandbox:false`, `contextIsolation:true`, preload `index.js` (`window.silico`).
* Lab views and viewer views: `persist:silico` (shared cookie jar for all Labs). Lab view always gets `preload lab.js` (`window.silicoDesktop`); viewer view only when `labBridge`.
* Signup view: `persist:silico-signup`, `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`.
* All webContents: `will-prevent-unload` is always overridden (beforeunload prompts never block close) L7054.

### 6.2 Popup/frame guards (Lab + viewer views, popups) `[Fo]` L3107-3125, `[cl]` L3084
* `window.open`: same origin as the opener's current URL → allowed as a popup window (§3.3); else open externally (http/https only) and deny.
* Sub-frame navigation (`will-frame-navigate`, non-main frames): only for http/https targets: if the frame is currently `about:srcdoc` → block + open externally; same origin as the top page → allow; else if target origin differs from the frame's current origin → block + open externally.
* Shell windows: every `window.open` denied; http/https opened externally.

### 6.3 Lab view navigation policy `[Ec]` L2260, applied on `will-navigate` (`fromNavigation=true`) and main-frame `will-redirect` (`false`)
```ts
decide(target, currentUrl, {reauthing, fromNavigation, shown, labOrigin}):
  if reauthing → "freeze"                                     // block
  if fromNavigation && sameOrigin(target,current) && path startsWith "/api/" → "open-document" // block, open viewer window
  if isAuthWall(target) → shown ? "auth-wall-reauth" : "auth-wall-neutralize"
  if fromNavigation && http(s) && crossOrigin(target,current) → "browser"
  if !fromNavigation && http(s) && origin ∉ {labOrigin, gateway origins+aliases} && crossOrigin(target,current) → "browser"
  else "in-app"
```
`isAuthWall(url)` `[$o]`: origin in gateway set (`https://my.silico.run`, `https://my-staging.silico.run`, `https://silico.goodfire.com`, `https://silico-staging.goodfire.com`) and path `/login` or `/login/…`. Actions: freeze → preventDefault; open-document → preventDefault + viewer window; browser → preventDefault + openExternal; auth-wall-reauth → preventDefault + `rs(win, connId)`; auth-wall-neutralize → preventDefault, `vis="hidden"`, load `about:blank`. Every preventDefault from these guards also cancels the recovery "navigation in flight" flag (`[mr]`).

Viewer view navigation: if recovery exists and the in-flight navigation is eligible and target is an auth wall or a gateway root `/` → block and `recover()`. Otherwise allowed only to origins owned by the recovery controller (or, without a controller, same origin as the initial URL); others → block + openExternal.

### 6.4 Permissions `[gf]` L6887-6960 (both `persist:silico` and `persist:silico-signup`)
* Request handler: non-`media` permissions granted only for `clipboard-sanitized-write` and `fullscreen`.
* `media`: only in `persist:silico`, main frame, exactly `["audio"]`, and the requester must be the **focused window's shown Lab view**, with requesting URL and current URL both same-origin as the entry's `labOrigin`. One prompt at a time per webContents. Remembered per webContents for the origin. Dialog: title `"Microphone access"`, message `"Allow microphone access for dictation?"`, detail `"<origin>\nAudio is sent to your Lab's transcription service when you finish dictating."`, buttons `["Allow microphone","Cancel"]`, default/cancel = 1, `noLink:true`. Grant only if response 0 and URL unchanged and still eligible.
* Check handler mirrors this (media allowed only if remembered origin === securityOrigin).

### 6.5 IPC trust
See §2. Notable: `labs:held-elsewhere`, `labs:focus-held`, `window:open-settings-sheet` use raw `ipcMain.handle` (no `file:`-origin check) — a Lab page in theory could call them if it had `ipcRenderer`, but the Lab preload doesn't expose them. A reimplementation should gate them with shell-trusted.

### 6.6 External URL opener `[Ee]` L16
Only `http:`/`https:` URLs are passed to `shell.openExternal`; anything else silently ignored.

---

## 7. Evidence ledger

| Claim | Lines | Status |
|---|---|---|
| Size constants, compact math, cascade | 332-389, 430-480 | Observed |
| Platform chrome options | 2399-2411 | Observed |
| Shell window creation, show gate, close teardown, crash revive | 7288-7366 | Observed |
| Settings sheet + overlay | 7367-7417 | Observed |
| open-desktop-settings, open-lab-switcher, held-elsewhere, focus-held, open-settings-sheet | 7418-7456 | Observed |
| navigateMenu, devtools toggle, zoom | 7476-7524 | Observed |
| Application menu, dock menu | 7525-7646 | Observed |
| whenReady wiring, activate, watchdog, power, memory shed | 7647-7798 | Observed |
| window-all-closed, before-quit | 7799-7802 | Observed |
| Single-instance, second-instance, open-url, context menu, will-prevent-unload, GPU gone | 7023-7095 | Observed |
| Deep link router (welcome/share/oauth returns) | 7128-7267 | Observed (cross-area) |
| IPC registrations (`window:*`, `lastOpened:*`, `lab:hide/goBack/goForward`, `viewer:retry`, `lab:open`) | 6476-6675 | Observed |
| IPC trust gate | 6418-6440 | Observed |
| Lab entry maps, view layout, hide/reveal/resync/park | 3027-3700 | Observed |
| openLabInWindow | 3695-3866 | Observed |
| Navigation decision function | 2260-2273 | Observed |
| Crash-loop guard | 2287-2293 | Observed |
| Viewer window | 3133-3333 | Observed |
| Viewer recovery controller | 2738-3026 | Observed (summarized) |
| Recovery-hook registry (`silico:recover-session`) | 2599-2672 | Observed |
| Badge | 3867-3933 | Observed |
| Permission handlers | 6884-6960 | Observed |
| Window-state persistence | 6788-6824 | Observed |
| last-opened persistence | 481-505, 624-632 | Observed |
| `D()` is telemetry cause recorder | 549-551, 501-507 | Observed |
| Renderer use of initial/compact/heldElsewhere/lastOpened | renderer.js 19505-19806, 20054-20066 | Observed |
| Viewer w/o parent is 800×600 | – | Inferred (Electron default) |
| Settings sheet doesn't track parent move/resize | 7368-7417 | Inferred from absence of listeners |

**Unknowns**
1. `titleBarOverlay` on win32 for viewer windows: no hit-test region code seen; the React `TitlebarStrip` presumably provides drag regions (CSS) — not verified in renderer.css.
2. Exact semantics of electron `contentView`/`WebContentsView` focus when the settings sheet is open (sheet `focusable` default true, overlay non-focusable).
3. Whether the renderer ever calls `window:open-settings-sheet` (preload exposes `openSettingsSheet`; call sites not traced).
4. The `[Pi]` "lab revealed" hook list: two registrations observed (notification route delivery L6118, checkout return L7701); others not searched exhaustively.
5. `Ge`/`Kl`/`ql` open-flow statuses beyond those listed (e.g. `Rt` 403 result shape) — owned by connection/auth spec.
6. Windows/Linux-specific behaviour of `app.dock` calls (guarded by `?.`) — no-ops.

---

## 8. Reimplementation notes

### Module boundaries (suggested)
* `main/windows/geometry.ts` — pure: constants, `compactContentHeight`, `centerClamp`, `cascadePosition(focusedBounds, workArea, w, h)`, `sizeLikeParent`, `labViewBounds(contentSize, zoom)`, `isValidSavedBounds(rect, workAreas)`.
* `main/windows/shell.ts` — create shell window, show gate, initial-window registry, window-state persistence.
* `main/windows/compact.ts` — compact state machine over `BrowserWindow` (inject geometry).
* `main/windows/settingsSheet.ts`, `main/windows/viewer.ts` (+ `viewerRecovery.ts`).
* `main/labview/registry.ts` — `LabEntry` maps, `heldElsewhere`, `findHolder`, park/unpark.
* `main/labview/lifecycle.ts` — `openLabInWindow`, readiness, down, hide, reveal, resync after shell crash.
* `main/labview/navPolicy.ts` — pure `decideLabNavigation`, `isAuthWall`, `isRevealablePath`, `labRoute`(returnTo), frame-navigation decision.
* `main/menu.ts` — `buildMenuTemplate(platform, dev, isPackaged, actions)` returning a plain template (test without Electron).
* `main/lifecycle.ts` — single-instance, activate, second-instance, quit, power/memory hooks, watchdog wiring.
* `main/badge.ts` — pure `computeBadge`.
* `main/ipc/windows.ts` — channel registrations with a shared trust wrapper.

### Pure functions & example cases
```ts
compactContentHeight(undefined, 1000) === 680
compactContentHeight(300, 1000) === 500          // floor at 500
compactContentHeight(700.2, 1000) === 701        // ceil
compactContentHeight(2000, 1000) === 880         // cap 880
compactContentHeight(2000, 600) === 560          // cap = max(500, 600-40)
compactContentHeight(2000, 400) === 500          // cap = max(500, 360)

centerClamp({x:0,y:0,width:1280,height:840}, 620, 600, {x:0,y:0,width:1440,height:900})
  // → {x:330, y:120, width:620, height:600}
centerClamp({x:1300,y:0,width:400,height:400}, 620, 600, {x:0,y:25,width:1440,height:875})
  // cx=1500 → x=clamp(1190, 0, 820)=820; cy=200 → y=clamp(-100, 25, 300)=25

cascadePosition(focused at (100,10), wa {0,0,1440,900}, 1280, 840) → {x:128, y:38}
cascadePosition(no focused window) → undefined (OS default placement)
cascadePosition(focused at (200,100), same wa, 1280, 840) → overflow → {x:40, y:40}

shouldRevive("clean-exit", [], now) === false
shouldRevive("crashed", [now-1000, now-2000], now) === true
shouldRevive("crashed", [now-1, now-2, now-3], now) === false
shouldRevive("crashed", [now-61000, now-62000, now-63000], now) === true

labStateFor("shown", any) === "ready"; labStateFor("loading", true) === "down"; labStateFor("hidden", false) === "loading"

decideLabNavigation("https://lab.x/api/doc.pdf", "https://lab.x/home", {reauthing:false, fromNavigation:true, shown:true, labOrigin:"https://lab.x"}) === "open-document"
decideLabNavigation("https://my.silico.run/login", cur, {...shown:true})  === "auth-wall-reauth"
decideLabNavigation("https://my.silico.run/login", cur, {...shown:false}) === "auth-wall-neutralize"
decideLabNavigation("https://github.com/x", "https://lab.x/", {fromNavigation:true,...}) === "browser"
decideLabNavigation("https://my.silico.run/oauth", "https://lab.x/", {fromNavigation:false, labOrigin:"https://lab.x"}) === "in-app"  // redirect to gateway allowed
decideLabNavigation(anything, cur, {reauthing:true}) === "freeze"

isRevealablePath("https://lab.x/auth/callback") === false
isRevealablePath("https://lab.x/?return_to=/a") === false
isRevealablePath("https://lab.x/artifacts/abc") === false
isRevealablePath("https://lab.x/artifacts/abc/read") === true
isRevealablePath("not a url") === true

labReturnTo("https://lab.x/") === null
labReturnTo("https://lab.x/auth/callback?x") === null
labReturnTo("https://lab.x/workspace/1?tab=a#h") === "/workspace/1?tab=a#h"

computeBadge([{attention:2,unread:5},{attention:1,unread:0}], {enabled:true,badge:true}) → {text:"3",count:3}
computeBadge([{attention:0,unread:4}], on) → {text:"•",count:0}
computeBadge(any, {enabled:false,badge:true}) → {text:"",count:0}
sanitizeBadge({attention:1.7, unread:1e6}) → {attention:1, unread:9999}; sanitizeBadge({attention:-1,unread:0}) → null

isValidSavedBounds({x:0,y:0,width:100,height:100}, [{x:0,y:0,width:1440,height:900}]) === true
isValidSavedBounds({x:5000,y:0,width:100,height:100}, same) === false
isValidSavedBounds({x:0,y:0,width:0,height:100}, same) === false

labViewBounds([1280, 800], 1.25) → {x:0, y:40, width:1280, height:760}

buildMenuTemplate("darwin", false, true): no "Developer settings", no "Toggle Developer Tools"
buildMenuTemplate("win32", true, true): File contains Notifications/Developer settings/Profile and role "quit"; DevTools accel "Ctrl+Shift+I"
```

### Implementation cautions
* Track Lab entries by window id; always re-check "is this still the same entry & same `loadStartedAt`" after every `await` (supersession).
* Keep hidden Lab views alive (don't destroy on hide); only destroy on window close, connId switch, memory shed, or update install (`wl` destroys all views, L3412).
* Use a monotonically increasing per-window epoch for open/reopen cancellation.
* The show gate (wait for compact decision ≤500 ms after ready-to-show) avoids a full-size flash for picker windows.

---

## Cross-area notes
* **Deep links** (`silico://welcome`, `silico://open?url=`, signup/OAuth/checkout/GitHub returns) router at L7128-7267 — focuses/creates windows and reveals Labs via `Sn` (reveal the Lab containing a webContents). Owned by deep-link/auth spec.
* **Signup view** (`hs`/`Ue`, L5368-5490) embeds in shell windows below a bar whose height is measured from `.signup-shell__bar` (default 78). Closed when the shell starts loading.
* **Connection open** (`Ge`, `Kl`, `ql`, L4249-4420) and re-auth (`rs`, `xt`, `ns`) — open flow ends in `openLabInWindow`.
* **Updater**: `update:install` destroys all windows and views before `quitAndInstall` (L5958-5966); restart dialog text lives there.
* **Notifications**: clicking a notification restores/focuses the holding window and either sends `silico:navigate route` to the Lab view (revealing it) or stashes the route until the Lab is next revealed.
* **Move-to-Applications** prompt at startup (macOS packaged, L6832-6876).
* `app.setName("Silico")`, `setAppUserModelId("ai.goodfire.silico")`, `setAsDefaultProtocolClient("silico")` (packaged), refusal to start with sign-in-exposing switches (L6994-7002).
