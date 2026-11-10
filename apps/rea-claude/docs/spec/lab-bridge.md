# Lab bridge (`window.silicoDesktop`), notifications, badges, shell events, permissions

Scope: the preload that remote Lab web pages see, every main-process handler behind it, OS notifications, dock/taskbar badges, the "shell events" telemetry queue, the foreground (app activation) events, and the per-session permission handlers (microphone for dictation, clipboard, fullscreen).

Source of truth: `pretty/preload-lab.js` (94 lines, all read) and `pretty/main.js` (line numbers below refer to this file). Silico v0.137.0.

---

## 1. Overview

- A **Lab** is a remote web app (for example `https://<x>.silico.run`, the managed gateways `https://my.silico.run` / `https://my-staging.silico.run`, or `http://localhost` / `127.0.0.1` for local stacks). The desktop shell embeds it in a `WebContentsView` and injects a small preload (`preload/lab.js`) that exposes `window.silicoDesktop` through `contextBridge` (only when `contextIsolation` is on. Otherwise it logs the warning `contextIsolation is disabled; the silicoDesktop bridge was not exposed` and exposes nothing).
- Two kinds of host surface carry the lab preload:
  1. **Lab-in-window views** (main app windows, `Bo`, main.js:3700-3860). Each `BrowserWindow` has at most one lab view. The main process tracks it in a map `windowId -> LabEntry { view, connId, title, vis: "hidden"|"loading"|"shown", labOrigin, reauthing, userLeft, lastStatus, loadStartedAt, ... }` (main.js:3836-3846). Windows whose lab was parked (evicted) sit in a second map `windowId -> { connId, returnTo }` (main.js:3437).
  2. **Viewer windows** (share / doc links, `Ni`, main.js:3133-3160). These get the lab preload only when `labBridge` is true, which `ul` computes as "URL is a trusted Lab URL AND (path matches the Lab route allowlist OR it is a managed-gateway URL)" (main.js:3346). Viewer views are NOT in the lab-in-window map, so they have no `connId`.
- Both kinds of view use the persistent partition **`persist:silico`** (main.js:3032), and that partition is what the lab-bridge trust check keys on (section 6).
- The bridge provides: session recovery, OS notifications, badge counts, route navigation from the shell, three external-browser return flows (Stripe-like checkout, MCP OAuth, GitHub connect), a "report issue" trigger, foreground (activation) diagnostics, a shell-event telemetry queue, and two shell UI openers (desktop settings, lab switcher).

---

## 2. Bridge API

```ts
/** Disposer returned by every on* subscription. Removes exactly the listener it added. */
type Unsubscribe = () => void;

type RecoverSessionResult =
  | { status: "accepted" }
  | { status: "unsupported" }
  | { status: "error"; message: "Could not restore this window. Please try again." };

type NotifyKind = "needsInput" | "finished";
type RunStatus = "completed" | "failed" | "stopped";

interface NotifyPayload {
  kind: NotifyKind;                 // anything else: payload dropped
  title: string;                    // truncated to 200 chars; empty after truncation: dropped
  body?: string;                    // truncated to 200 chars; non-string becomes ""
  route: string;                    // Lab-relative route sent back via onNavigate on click; "" or non-string: dropped
  dedupeKey: string;                // non-empty; same key within 5 min is suppressed
  status?: RunStatus;               // other values are ignored (treated as undefined)
  elapsedSeconds?: number;          // used for the "finished quickly" suppression
  routeMatchesActiveView?: boolean; // only literal true counts
}

interface BadgeCounts {
  attention: number; // finite, >= 0; floored; capped at 9999
  unread: number;    // same rules; if either is invalid the whole payload is ignored
}

type CheckoutOutcome = "success" | "cancel" | "manage";

type McpOauthReturn =
  | { outcome: "code"; code: string; state: string }
  | { outcome: "error"; error: string };

type GithubConnectReturn =
  | { outcome: "success" }
  | { outcome: "error"; error: string };

/** Diagnostic record describing why the app came to the foreground (section 4.9). */
interface ForegroundEvent {
  event: "app_foreground";
  cause: string;             // e.g. "notification-click", "deep-link:checkout", "external-or-user", "error-dialog"
  details?: unknown;
  stack?: string;            // JS stack captured where the cause was recorded
  msSinceResign: number | null;
  systemIdleSeconds: number; // -1 if unavailable
  focusedWindow: "none" | "settings-sheet" | "signup" | "lab" | "app-shell" | "aux";
  connId: string | null;
  recent?: Record<string, number>; // marker name -> ms ago (only markers within 5000 ms)
  build: string;                   // baked build string, e.g. "2026-10-23 · 047c31d"
  appVersion: string;
  platform: NodeJS.Platform;
  ts: string;                      // ISO
  login?: string;
  sub?: string;
}

/** A telemetry record produced by the shell (section 4.10). */
interface ShellEvent {
  event: "desktop_shell";
  kind:
    | "connect-outcome" | "down-panel" | "gateway-transport-failure"
    | "reauth-outcome" | "session-death" | "viewer-stranded";
  connId?: string;
  details?: Record<string, unknown>;
  build: string;
  appVersion: string;
  platform: NodeJS.Platform;
  login?: string;
  sub?: string;
  ts: string;
}

interface SilicoDesktop {
  /** Ask the shell to re-establish the Lab session (re-auth) for this view.
   *  Only honoured for the top frame of a registered Lab view sitting on an allow-listed route. */
  recoverSession(): Promise<RecoverSessionResult>;

  /** Fire-and-forget request for an OS notification. The shell applies user settings,
   *  focus suppression, dedupe, and batching. */
  notify(payload: NotifyPayload): void;

  /** Fire-and-forget report of this Lab's counts. The shell aggregates all Labs into one dock/taskbar badge. */
  setBadgeCounts(counts: BadgeCounts): void;

  /** Called with a route string when the user clicks one of this Lab's notifications. */
  onNavigate(cb: (route: string) => void): Unsubscribe;

  /** Mint a single-use nonce (UUID v4) tying a future checkout deep link to this view. Valid 30 min. */
  beginCheckout(): Promise<string>;
  /** Called with the outcome when silico://checkout-return?outcome=..&s=<nonce> arrives. */
  onCheckoutReturn(cb: (outcome: CheckoutOutcome) => void): Unsubscribe;

  /** Mint a single-use nonce for an MCP OAuth round-trip. Valid 15 min. */
  beginMcpOauth(): Promise<string>;
  /** Fires when an MCP OAuth return was queued for this Lab. The preload pulls it via take and
   *  only calls cb when the take returned non-null. */
  onMcpOauthReturn(cb: (r: McpOauthReturn) => void): Unsubscribe;
  /** Pop the most recent queued MCP OAuth return for this Lab (or null). Destructive. */
  takeMcpOauthReturn(): Promise<McpOauthReturn | null>;

  /** Mint a single-use nonce for a GitHub-connect round-trip. Valid 15 min. */
  beginGithubConnect(): Promise<string>;
  /** Same pull-on-signal pattern as onMcpOauthReturn. */
  onGithubConnectReturn(cb: (r: GithubConnectReturn) => void): Unsubscribe;
  /** Take (and clear) the stored GitHub-connect result for this Lab (or null). */
  takeGithubConnectReturn(): Promise<GithubConnectReturn | null>;

  /** Static capability flag, always true: this shell understands the "manage" checkout outcome. */
  readonly manageReturn: true;

  /** Called (no args) when the user picks Help > "Send feedback" (Cmd/Ctrl+Shift+/) while this Lab is shown. */
  onReportIssue(cb: () => void): Unsubscribe;

  /** Called with a ForegroundEvent each time the app becomes active, delivered only to the
   *  shown Lab in the focused window. */
  onForeground(cb: (e: ForegroundEvent) => void): Unsubscribe;

  /** Signal (no args) that new shell events were queued. Call drainShellEvents() in response. */
  onShellEventNudge(cb: () => void): Unsubscribe;
  /** Remove and return every queued shell event (global queue, max 100). */
  drainShellEvents(): Promise<ShellEvent[]>;

  /** Open the desktop Settings sheet on the Notifications tab, over this Lab's window. */
  openDesktopSettings(): void;
  /** Open a new compact shell window showing the connection/lab picker. */
  openLabSwitcher(): void;
}

declare global { interface Window { silicoDesktop?: SilicoDesktop } }
```

Preload implementation notes (Observed, preload-lab.js):
- Every `on*` wraps the callback so the page never sees the `IpcRendererEvent`. `onNavigate`, `onCheckoutReturn`, `onForeground` forward the first payload arg. `onReportIssue` and `onShellEventNudge` call `cb()` with no args.
- `onMcpOauthReturn` / `onGithubConnectReturn` ignore the event's payload (none is sent). On each signal they `invoke` the matching `take-*` channel and call `cb(result)` only if `result` is truthy. A rejected invoke is not caught in the preload.

---

## 3. IPC contract

"Lab-trusted" means `isLabSender(sender)` (section 6) passes. "Shell-trusted" is the separate guard for the app's own renderer (`file:` or the dev server origin), shown here only where it matters.

| Channel | Dir / kind | Args | Return | Behaviour | Errors |
|---|---|---|---|---|---|
| `silico:recover-session` | R→M `invoke` | none | `RecoverSessionResult` | Looks up the sender in the recovery registry. Accepted only if a registry entry exists, the sending frame is the sender's main frame and not destroyed, and the entry reports `eligible()`. It then calls the entry's `recover()`. If that returns `false` → unsupported. (main.js:2648-2665, 6500) | No sender-partition check; the registry is the gate. A thrown exception returns `{status:"error", message:"Could not restore this window. Please try again."}` |
| `silico:notify` | R→M `send` | `NotifyPayload` (unknown) | — | If Lab-trusted, runs the notify pipeline (4.2). Otherwise silently dropped. (6675) | none (silent) |
| `silico:badge-counts` | R→M `send` | `BadgeCounts` (unknown) | — | If Lab-trusted, stores counts for the sender's connId and recomputes the badge (4.3). (6678) | silent |
| `silico:begin-checkout` | R→M `invoke` | none | `string` UUID | Registers `nonce -> {wc: sender, connId \| null, expiresAt: now+30min}`. The entry is also deleted by a 30 min timer. (6250) | Untrusted: rejects with `Blocked 'silico:begin-checkout': untrusted sender.` |
| `silico:begin-mcp-oauth` | R→M `invoke` | none | `string` UUID | Same pattern, TTL 15 min. (6299) | `Blocked 'silico:begin-mcp-oauth': untrusted sender.` |
| `silico:begin-github-connect` | R→M `invoke` | none | `string` UUID | Same pattern, TTL 15 min. (6371) | `Blocked 'silico:begin-github-connect': untrusted sender.` |
| `silico:take-mcp-oauth-return` | R→M `invoke` | none | `McpOauthReturn \| null` | connId = the sender's lab connId. If null → `null`. Otherwise **pops the newest** queued payload for that connId (LIFO) and cancels its expiry timer. (6705, 6359) | `Blocked 'silico:take-mcp-oauth-return': untrusted sender.` |
| `silico:take-github-connect-return` | R→M `invoke` | none | `GithubConnectReturn \| null` | Returns and deletes the single stored result for the connId. (6713, 6411) | `Blocked 'silico:take-github-connect-return': untrusted sender.` |
| `silico:shell-events:drain` | R→M `invoke` | none | `ShellEvent[]` | Empties the global queue and returns everything in it. Not per-Lab. (6698, 127) | `Blocked 'silico:shell-events:drain': untrusted sender.` |
| `silico:open-desktop-settings` | R→M `send` | none | — | If the sender is a lab-in-window view, opens or focuses the Settings sheet for that window on `settings:notifications`. Otherwise no-op. (7443) | silent |
| `silico:open-lab-switcher` | R→M `send` | none | — | If the sender is a lab-in-window view, creates a **new** shell window and puts it in compact mode. (7447) | silent |
| `silico:navigate` | M→R | `route: string` | — | Sent to a Lab view after a notification click, or later when that Lab next becomes ready (4.2). (6120, 6205) | — |
| `silico:checkout-return` | M→R | `CheckoutOutcome` | — | Sent on a valid checkout deep link, or on next Lab-ready for that connId (4.5). (7265, 7688) | — |
| `silico:mcp-oauth-return` | M→R | none | — | Pull signal (4.6). (7222) | — |
| `silico:github-connect-return` | M→R | none | — | Pull signal (4.7). (7202) | — |
| `silico:report-issue` | M→R | none | — | Sent to the shown Lab of the focused window from Help > "Send feedback". (3664-3669, 7591-7593) | — |
| `silico:foreground` | M→R | `ForegroundEvent` | — | Sent on app activation to the focused window's shown Lab only. (7653-7661) | — |
| `silico:shell-event-nudge` | M→R | none | — | Sent to one view after each shell event is queued (4.10). (7666-7676) | — |

Notes:
- `silico:recover-session`, `silico:begin-*`, `silico:take-*`, and `silico:shell-events:drain` are registered with raw `ipcMain.handle`, not the shell's guarded helper. That helper (`y`, main.js:6428) would reject Lab pages, because it only trusts `file:` / dev-server origins.
- `silico:open-desktop-settings` and `silico:open-lab-switcher` do not call the partition check. They gate only on "sender is a known lab-in-window view" (`de(sender)` non-null).

---

## 4. Flows

### 4.1 Shared lookups (pure over main-process state)

- `labOf(wc)`: find the lab-in-window entry whose `view.webContents === wc` and return `{winId, entry}` (main.js:3446).
- `windowOfLab(wc)`: that entry's `BrowserWindow`, or null (3451).
- `connIdOf(wc)`: that entry's `connId`, or null (3465). Viewer windows always yield null.
- `windowForConn(connId)`: search active lab entries first, then parked entries (3468).
- `labWcForConn(connId)`: active entries only (3473).
- `isLabShown(wc)`: entry `vis === "shown"` (3477).
- `revealIfHidden(wc)`: if the entry is `"hidden"`, re-show the lab view in its window. This sends `lab:opened`, `lab:state: ready` and `lab:navstate` to the shell renderer, and records the `lab-reveal` marker (3480-3500).
- **Lab-ready hooks:** a list of callbacks `(connId, labWc)` that run every time a lab view transitions to `"ready"/shown` (registered via `Wi`, 3074; invoked at 3763). Two are registered: pending-navigate flush (6118) and pending-checkout flush (7686).

### 4.2 `notify` → OS notification

Settings (`settings.json` → `notifications`, defaults main.js:207-214): `{ enabled: true, needsInput: true, experimentFinished: true, sound: true, notifyWhenActive: false, badge: true }`. Non-boolean stored values fall back to the defaults (268-283).

1. Drop unless the sender is Lab-trusted.
2. Validate and normalise the payload (`bd`, 6126): require `kind ∈ {needsInput, finished}`, a non-empty truncated `title`, a non-empty string `route`, and a non-empty string `dedupeKey`. Truncate `title` and `body` to 200 chars. Keep `status` only if it is in `{completed, failed, stopped}`. Keep `elapsedSeconds` only if it is a number. `routeMatchesActiveView = (v === true)`.
3. Load settings and drop if any of these hold:
   - `!enabled`
   - `kind == needsInput && !needsInput`
   - `kind == finished && !experimentFinished`
   - `kind == finished && status == completed && elapsedSeconds != null && elapsedSeconds < 30`. Quick successful runs are not announced. Failed or stopped runs are.
4. Focus suppression: drop if the sender's window is focused AND the sender's lab is shown AND `routeMatchesActiveView` AND `!notifyWhenActive`.
5. Dedupe (`vd`, 6146): first prune dedupe entries older than 5 min, then drop if `dedupeKey` is present, else record it with `now`.
6. Build the request `{title, body, route, senderWc, connId: connIdOf(sender), sound: settings.sound}`.
7. `needsInput` → show immediately. `finished` → batching:
   - Push to a buffer and (re)start a 700 ms debounce timer. Every new item resets it.
   - On fire with 1 item → show it unchanged.
   - On fire with N > 1 items → show one notification:
     - title: `` `${N} experiments finished` ``
     - body: the first 3 item titles joined with `", "`, followed by `` ` +${N-3} more` `` when N > 3
     - route, senderWc, connId, sound: taken from the **last** item.
8. Show (`lo`, 6175): bail if `Notification.isSupported()` is false. Create `new Notification({ title, body, silent: !sound })` (no icon or actions set). Hold a strong reference until close, click, or 60 s. Record the `notification-shown` marker. Call `show()`.
9. On click:
   1. Resolve the target Lab webContents: the original sender if it is still alive, otherwise `labWcForConn(connId)` (active entries only).
   2. Resolve the window: `windowOfLab(target)`, else `windowForConn(connId)` (which also includes parked).
   3. If a window is found: record foreground cause `notification-click` (details = connId), restore if minimised, `show()`, `focus()`, and `app.focus({steal:true})`.
   4. If the target webContents is alive: `revealIfHidden(target)`, then send `silico:navigate` with `route`.
   5. Otherwise, if `connId` is set: store `pendingNavigate[connId] = route` (the latest value wins, there is no TTL). On the next Lab-ready for that connId, delete the entry and send `silico:navigate` to the ready Lab.
   6. Otherwise the route is lost.

Web `Notification` permission is **denied** to Lab pages (section 5), so this bridge is the only way a Lab can raise notifications.

### 4.3 `setBadgeCounts` → dock/taskbar badge

1. Drop unless the sender is Lab-trusted.
2. Sanitise each field: a non-number, non-finite, or negative value is invalid. Otherwise `min(floor(v), 9999)`. If either field is invalid, ignore the whole payload (`Ml`, 3880).
3. `connId = connIdOf(sender)`. If null (for example a viewer window) → ignore.
4. Store `counts[connId] = sanitized`. The first time this sender is seen, attach a one-shot `destroyed` listener. On the next tick it prunes connIds with no window (`windowForConn` null, so parked counts are kept) and recomputes.
5. Recompute (serialised through a promise chain, `ht`/`kr`, 3905-3917):
   - If `!notifications.enabled || !notifications.badge` → text `""`, count 0.
   - Otherwise sum `attention` and `unread` over all connIds. `attention > 0` → text = `String(sumAttention)` (the sum is not re-capped), count = sum. Else `unread > 0` → text `"•"`, count 0. Else `""`, 0.
   - macOS: `app.dock.setBadge(text)`. Linux: `app.setBadgeCount(count)`, so unread-only shows nothing. Windows: no badge.
6. Other recompute triggers:
   - any `BrowserWindow` `closed` (prune, then recompute) (3936-3943)
   - settings change (3942)
7. Clearing all counts happens on "sign out all" (6548) and on a re-auth outcome of `expired` (4527).

### 4.4 `onNavigate`

Only produced by notification clicks (4.2 step 9). The route string is opaque to the shell. Note: the shell's own menu navigation uses a different channel (`app:navigate`) that goes to the shell renderer, not to Labs.

### 4.5 Checkout (`beginCheckout` / `onCheckoutReturn` / `manageReturn`)

1. The Lab calls `beginCheckout()` and receives `nonce`. The shell stores `nonce -> {wc, connId, expiresAt: now + 30 min}`.
2. *(Inferred)* The Lab embeds the nonce in the billing URL it opens externally. Cross-origin `window.open` / navigations from a Lab are routed to the OS browser by the shell's window-open handler (`Fo`/`Ee`, main.js:3105, 16). The billing provider eventually redirects to `silico://checkout-return?outcome=<success|cancel|manage>&s=<nonce>`.
3. Deep-link parsing (`Id`, 6259):
   - Require scheme `silico:` and host-or-path (case-insensitive) `checkout-return`.
   - `outcome` must be one of `success`, `cancel`, `manage`.
   - `s` must be non-empty. No format regex is applied, unlike the other two flows.
   - Anything else → ignored.
4. Consume the nonce (`Rd`): delete it. If it is unknown or expired → do nothing.
5. Resolve the target webContents and window as in 4.2. If a window is found: foreground cause `deep-link:checkout`, restore, show, focus, `app.focus({steal:true})`.
6. If the original webContents is alive: `revealIfHidden`, then send `silico:checkout-return` with `outcome`. Otherwise, if connId is set: store `pendingCheckout[connId] = outcome` (latest wins, no TTL). On the next Lab-ready for that connId, take it and send `silico:checkout-return` (7686-7689).
7. `manageReturn: true` is a constant capability flag. *(Inferred)* It tells the Lab that the shell accepts `outcome=manage` (billing-portal return).

### 4.6 MCP OAuth (`beginMcpOauth` / `onMcpOauthReturn` / `takeMcpOauthReturn`)

1. `beginMcpOauth()` returns `nonce` (TTL 15 min).
2. Deep link `silico://mcp-oauth-return?...` (`xd`, 6308):
   - `s` must match `/^[A-Za-z0-9-]{1,64}$/`.
   - `outcome=code` requires `code` matching `/^[\x20-\x7E]{1,2048}$/` and `state` matching `/^[\x20-\x7E]{1,4096}$/`. The payload is `{outcome:"code", code, state}`.
   - `outcome=error` requires `error` matching `/^[a-z_]{1,64}$/`. The payload is `{outcome:"error", error}`.
   - Anything else → not an MCP link, so dispatch tries the next handler.
3. Consume the nonce. If it is unknown or expired, the link is still treated as handled (swallowed, no further dispatch, no UI) (`kf`, 7206-7210).
4. Resolve the target and window. If a window is found: foreground cause `deep-link:mcp-oauth`, restore, `show()`, then `activate(win)` (`Zo`, 7098):
   - start an activation tracker
   - `win.focus()`
   - on macOS, `showInactive()` if visible
   - `app.focus({steal:true})`
   - on macOS, `dock.bounce("critical")` after 350 ms
5. If connId is set: enqueue the payload into `mcpQueue[connId]` (`Wd`, 6339). The queue holds at most **3** entries. Pushing a 4th drops the oldest. Each entry expires after **10 min**. If the original webContents is alive: `revealIfHidden`, then send the payload-less `silico:mcp-oauth-return`.
6. The preload's listener immediately calls `take`, which **pops the newest** entry (LIFO). Older entries remain until they expire or are taken by later calls. A Lab that was closed or reloaded should call `takeMcpOauthReturn()` on startup to collect a pending result.
7. If connId is null (viewer), the payload is dropped (only the window focus happens).

### 4.7 GitHub connect (`beginGithubConnect` / `onGithubConnectReturn` / `takeGithubConnectReturn`)

1. `beginGithubConnect()` returns `nonce` (TTL 15 min).
2. Deep link `silico://github-connect-return?...` (`Hd`, 6380):
   - `s` must match `/^[A-Za-z0-9-]{1,64}$/`.
   - `outcome=success` gives `{outcome:"success"}`.
   - `outcome=error` with `error` matching `/^[a-z_]{1,64}$/` gives `{outcome:"error", error}`.
   - Anything else → not handled.
3. Consume the nonce. If it is unknown or expired, the link is swallowed (7186-7190).
4. Focus as in 4.6 with foreground cause `deep-link:github-connect`.
5. If connId is set: store into a single slot per connId (`jd`, 6408). An `error` does **not** overwrite an existing stored `success`. Otherwise the new value replaces the old one. There is no expiry. If the original webContents is alive: reveal, then send the payload-less `silico:github-connect-return`.
6. `take` returns and clears the slot.

Deep-link dispatch order (7184): after share/other routes, try MCP OAuth, then GitHub connect, then checkout. The first two return "handled" for any syntactically valid link even when the nonce is stale.

### 4.8 `onReportIssue`

Trigger: the application menu Help > **"Send feedback"** (accelerator `CmdOrCtrl+Shift+/`) calls `Ll(focusedWindow)` (7591-7593). That sends `silico:report-issue` to the focused window's lab view only if its `vis === "shown"` (3664-3669). Otherwise it is a no-op. The Help menu also has "Help center", which opens an external URL `bf` (not in scope).

### 4.9 `onForeground`

1. At startup the shell installs a foreground tracker (`wa`, 558) with:
   - `focusedWindow()` → classifies the focused window (`Ef`, 7270) as `none | settings-sheet | signup | lab (with connId) | app-shell | aux`
   - `identity()` → `{login, sub}` when signed in
   - `deliver(evt)` → send `silico:foreground` to the focused window's **shown** lab webContents only (7653-7661).
2. "Intentional activation" bookkeeping. `markCause(cause, details)` (`D`, 549) records `{cause, details, stack, ts}` just before the shell itself activates or focuses something. Causes observed:
   - `deep-link:checkout|delivered|github-connect|mcp-oauth|share|signup|welcome`
   - `doc-window`, `menu:navigate`, `menu:settings`, `notification-click`, `popup`, `second-instance`, `sign-in`, `window-create`

   `mark(name)` (`qe`, 552) stores a timestamp for recency markers: `lab-reveal`, `notification-shown`, `reconnect`, `shell-renderer-gone`, `watchdog-rewake`.
3. `app` `did-resign-active` clears the active flag, records the resign time, clears the pending cause, and clears the suppress flag.
4. `app` `did-become-active`:
   1. Set the active flag.
   2. If the suppress flag is set: clear it, clear the cause, and emit nothing.
   3. Otherwise refresh identity. Cause = the recorded cause if it is ≤ 1500 ms old, else `"external-or-user"`. Clear the recorded cause.
   4. Build the `ForegroundEvent`: `msSinceResign`, `systemIdleSeconds` from powerMonitor, the focused-window classification, and `recent` = markers ≤ 5000 ms old.
   5. Log `[foreground] {json}` and deliver it.
5. A main-process `uncaughtException` that is not a `net::ERR_*` error (`ga`, 555, called at 7039):
   - emits an immediate foreground event with cause `error-dialog`, details = message (≤ 300 chars), stack ≤ 2000 chars
   - if the app was not active, sets the suppress flag so the activation caused by the error box is not double-reported.

### 4.10 Shell events (`onShellEventNudge` / `drainShellEvents`)

"Shell events" are the desktop's own diagnostic telemetry records, which the Lab page is expected to forward to its analytics backend *(Inferred: the shell has no network sink for them; it only logs them and queues them for the Lab)*.

1. `recordShellEvent(kind, {connId?, details?})` (`te`, 101):
   - Rate limit for `gateway-transport-failure` only: the key is `[details.operation, details.hostname]`. Drop the event if the same key had an identical `details` JSON within 5 min.
   - Build `{event:"desktop_shell", kind, connId?, details?, build, appVersion, platform, login, sub, ts}`. `login` and `sub` come from a cached identity that is refreshed asynchronously on each call, so it may lag by one event.
   - Log `[shell] {json}`.
   - Push to a global array capped at **100**. When over the cap, drop the oldest.
   - Call the sink's `nudge()`.
2. `nudge()` (7666-7676): among all non-destroyed windows, pick the first window whose lab view is shown and send it `silico:shell-event-nudge`. If there is none, pick the first window with a viewer view. Exactly one recipient (or none).
3. `drainShellEvents()` atomically removes and returns the whole queue (`splice(0)`). Any Lab-trusted sender may drain. The queue is global, not per-connection, so the first Lab to drain gets everything.
4. Kinds emitted (all `te(...)` call sites):

   | Kind | Line | Source |
   |---|---|---|
   | `connect-outcome` | 6613, 6640 | `lab:open` / `lab:connect` results with `{path, budgetMs?, managed, status, ms}` |
   | `down-panel` | 3764 | Lab view went down, with `{lastStatus, msSinceLoad}` |
   | `gateway-transport-failure` | 1872 | Gateway transport failure |
   | `reauth-outcome` | 4541, 4566 | `{trigger: "auth-wall" \| "wake", outcome}` |
   | `session-death` | 1255 | Session death |
   | `viewer-stranded` | 3205 | `{surface, page: origin+path, labBridge}` |

### 4.11 `openDesktopSettings`

If the sender is a lab-in-window view, open the settings sheet (`Qo`, 7374) for its window with tab key `settings:notifications`:
- If a sheet already exists for that window, focus it and send `app:navigate` with the key.
- Otherwise create a dimming overlay child window (opacity 0.3, click-through, `#1d272a`) and a frameless child `BrowserWindow` titled `"Settings"`, at most 800×600, horizontally centred, top at max(28 px, 1/3 of the free height). It loads the shell renderer at `#settings-modal/notifications`.
- The sheet closes on blur unless a shell dialog is open for it or devtools are open.
- When opened fresh, it records foreground cause `menu:settings`.

### 4.12 `openLabSwitcher`

If the sender is a lab-in-window view: create a brand-new shell window (`Z()`) and immediately put it into compact mode (`oi(win, true)`, the connection-picker size). It does not reuse or focus an existing window. *(Inferred: the compact window is the lab picker.)*

### 4.13 `recoverSession`

Each recoverable view registers, on creation, a registry entry (`Ui`, 2599) keyed by its webContents. Lab-in-window views register at 3731. Viewer windows register at 2960. The registration takes an `isTrustedOrigin(origin)` predicate and a `recover()` function. The registry tracks navigation:
- On `did-navigate` it records the origin and sets `eligibleAtCommit = isTrustedOrigin(origin) && isAllowedLabRoute(url) && !isGatewayUrl(url)`.
- While a main-frame, non-same-document navigation is in flight, `eligible()` is false.

`eligible()` is true when:
- no navigation is pending
- the committed state was eligible
- the current URL still has the same origin
- that origin is trusted
- the current route is allow-listed.

`isAllowedLabRoute` (`rt`, 2575) matches a lower-cased pathname against a fixed list: `/`, `/auth/callback`, `/home`, `/settings`, `/workspaces[/new]`, `/workspace[/…]`, `/folders/<x>`, `/org/<x>/(settings|new)`, `/join-org/<x>`, `/onboarding/compute`, `/cluster`, `/reports[/<x>]`, `/papers[/<x>]`, `/publications[/<x>]`, `/artifacts/<x>[/read]`, and `/s/(th_|sh_)<x>[/(thread|experiment)/<y>]`, each with an optional trailing slash.

`recover()`:
- Lab-in-window: returns false if the view is no longer the window's current view, if it is hidden, or if no re-auth handler is installed. Otherwise it starts the re-auth flow (`rs`, 4535; covered by the auth analyst) and returns true.
- Viewer: runs the viewer recovery state machine.

---

## 5. Permissions & session hooks

Installed once at startup (`gf`, 6883, called at 7678) on **both** `persist:silico` (Labs/viewers) and `persist:silico-signup` (signup window, main.js:5291).

**Permission request handler:**
- For a permission other than `media`: grant only if it is in `{ "clipboard-sanitized-write", "fullscreen" }`. Everything else is denied: `notifications`, `geolocation`, `clipboard-read`, `openExternal`, `display-capture`, etc.
- For `media`, grant only if **all** of these hold:
  - the partition is `persist:silico` (signup always denied)
  - the request is from the main frame
  - `mediaTypes` is exactly `["audio"]` (camera, or audio plus video, is denied)
  - `focusedLabWindowFor(wc, requestingUrl)` returns a window (`Dn`, 3683). That requires all of:
    - the focused window has a **shown** lab view whose webContents is this `wc`
    - that entry has a `labOrigin`
    - `requestingUrl` is same-origin with `labOrigin`
    - the wc's current URL is same-origin with `labOrigin`

  So viewer windows and background Labs cannot get the mic.
- Additionally, no prompt may already be pending for this `wc`. A concurrent request is denied.
- If this `wc` was already granted for the same current origin (WeakMap `wc -> origin`), grant without prompting.
- Otherwise show a modal message box on the focused lab window:
  - type `question`, title `"Microphone access"`
  - message `"Allow microphone access for dictation?"`
  - detail: `` `${origin}\nAudio is sent to your Lab's transcription service when you finish dictating.` ``
  - buttons `["Allow microphone", "Cancel"]`, `defaultId: 1`, `cancelId: 1`, `noLink: true`
- Grant only if all of these hold, then remember `wc -> origin`:
  - "Allow microphone" was chosen
  - the wc is not destroyed
  - its URL is **unchanged** since the prompt (full URL equality)
  - `focusedLabWindowFor` still returns the same window
- Any dialog error → deny.

**Permission check handler:**
- Non-media: the same allowlist set.
- Media: true only if all of these hold:
  - partition is `persist:silico`
  - main frame
  - `mediaType === "audio"`
  - `wc` is present
  - `focusedLabWindowFor(wc, requestingUrl ?? requestingOrigin)` is non-null
  - the remembered origin for that wc equals `requestingOrigin`

The grant memory is per webContents and in-memory only: it is not persisted, and it is lost when the view is recreated or the app restarts.

**Not present (Observed by grep over main.js):** no `setDisplayMediaRequestHandler`, no `webRequest` hooks, no `setUserAgent` / user-agent changes, and no `cookies` API usage on lab partitions. The only other session-wide hook is `setCertificateVerifyProc`, installed on `defaultSession`, `persist:silico`, `persist:silico-signup`, and any later-created session (`Vu`, 5527). It rejects with `-206` when any cert in the chain has an SPKI SHA-256 in a hard-coded 8-entry set (main.js:5490-5499), otherwise it returns `-3` (use Chromium's verdict). *(Cross-area: TLS. The set looks like a denylist since a match → reject. Unknown which CAs these are.)*

---

## 6. Security notes

- **Lab-bridge sender trust** (`oe`, main.js:6438): `!wc.isDestroyed() && wc.session === session.fromPartition("persist:silico")`. It is partition identity, not an origin check. Consequences:
  - Any webContents in that partition passes: lab-in-window views, viewer views (including viewers created with `labBridge:false`, which have no preload and so cannot call it), and *(Inferred)* popups opened by a Lab via `window.open` that the shell allowed (same-origin only, `Fo`, 3105). Electron child windows normally inherit the opener's session. Whether they also inherit the lab preload is **Unknown**.
  - Per-Lab scoping comes from `connIdOf(sender)`. Viewers have connId null, so `take-*` returns null, badges and pending routes are ignored, and settings/switcher are no-ops. `drainShellEvents` and `begin-*` still work for viewers.
- **Shell IPC trust** (`Cs`, 6418) is the opposite: it trusts only the `file:` protocol or the `ELECTRON_RENDERER_URL` origin, checked against `senderFrame.url` (falling back to `sender.getURL()`). All `y(...)` handlers use it, so Lab pages cannot call shell channels like `settings:set`. Blocked calls log `` [ipc] blocked '<channel>' from untrusted sender ``.
- **Preload attachment:**
  - Lab-in-window views always get `preload/lab.js` (3721). The Lab URL itself comes from the connection layer, so trust is "whatever Lab the user connected to".
  - Viewer windows get it only when `isTrustedLabUrl(url) && (isAllowedLabRoute(url) || isGatewayUrl(url))` (`Uo` 2562, `rt` 2575, `J` 2554). `isTrustedLabUrl` requires no userinfo, and one of: a managed gateway origin (`https://my.silico.run`, `https://my-staging.silico.run`, plus per-gateway alias origins `bo[...]`), `https://*.silico.run`, or `http://localhost` / `http://127.0.0.1`.
  - Lab views also set `backgroundThrottling: false`.
- **Recover-session** additionally requires the sending frame to be the main frame (subframes are rejected), the origin to match the Lab's recorded origin, and an allow-listed route. This prevents a navigated-away or iframe page from triggering re-auth.
- **Deep-link return hardening:**
  - Nonces are UUID v4, single-use, bound to the minting webContents and connId, and have a TTL (checkout 30 min, MCP and GitHub 15 min).
  - Strict regexes are applied to `s`, `code`, `state`, and `error` (MCP and GitHub).
  - Results are delivered by pull (`take`) through a trusted-sender-gated channel, never pushed in the event payload, for MCP and GitHub. Checkout pushes the outcome enum directly.
  - Stale or unknown nonces for MCP and GitHub are swallowed silently.
- **Microphone:** audio only, main frame only, focused and shown Lab only, origin-pinned, URL unchanged across the prompt, one prompt in flight per wc. Notifications permission is denied, so pages must go through `notify`, which applies the user's settings.
- **Notification payload limits:** 200-char title/body, strict kind enum, dedupe, batching. This bounds spam from a compromised Lab.

---

## 7. Evidence ledger

| Claim | Lines | O/I |
|---|---|---|
| Bridge members and channel names | preload-lab.js 1-94 | Observed |
| Bridge exposed only with contextIsolation | preload-lab.js 85-94 | Observed |
| Lab-bridge handler registration | 6500-6502, 6675-6720, 7443-7449 | Observed |
| Trust check by partition `persist:silico` | 6438-6440, 3032 | Observed |
| Shell trust check (`file:`/dev origin) | 6418-6436 | Observed |
| recover-session logic & error string | 2599-2665 | Observed |
| Route allowlist | 2575-2588 | Observed |
| Lab-in-window recover → re-auth | 3731-3740, 6499, 4535 | Observed (re-auth internals: other analyst) |
| Notify validation / settings / suppression / dedupe / batching / click | 6106-6248 | Observed |
| Notification defaults | 207-214, 268-283 | Observed |
| Pending navigate on lab ready | 6118-6123, 3074-3076, 3763 | Observed |
| Badge sanitise/aggregate/platform | 3874-3943 | Observed |
| Badge cleared on sign-out-all / expired | 6548, 4527 | Observed |
| Checkout nonce/parse/consume/pending | 6249-6290, 7253-7267, 7686-7689 | Observed |
| MCP OAuth nonce/parse/queue(3, 10 min, LIFO pop) | 6291-6364, 7206-7225 | Observed |
| GitHub nonce/parse/slot(no-downgrade) | 6365-6414, 7186-7205 | Observed |
| Deep-link dispatch order | 7184 | Observed |
| Activation helper `Zo`/`Ts`/critical bounce | 7098-7130, 7002 | Observed |
| report-issue trigger via Help > Send feedback | 3664-3669, 7588-7594 | Observed |
| Foreground tracker, causes, markers, delivery | 549-610, 7270-7289, 7653-7661, 7039 | Observed |
| Shell event record/cap 100/rate limit/drain/nudge | 64-69, 80-128, 7663-7677 | Observed |
| Settings sheet & lab switcher | 7374-7442, 7443-7449, 430-470, 7290+ | Observed |
| Permission handlers & strings | 6882-6952, 3683-3696 | Observed |
| Cert verify proc | 5490-5534 | Observed |
| Lab views created with lab preload & partition | 3146-3155, 3716-3724 | Observed |
| Viewer labBridge condition | 3339-3347, 2554-2574 | Observed |
| Shell events are forwarded by the Lab to analytics | n/a | Inferred |
| Nonce is embedded by the Lab in external URLs | n/a | Inferred |
| `manageReturn` means "manage" outcome supported | 6271 | Inferred |
| `openLabSwitcher` window shows the picker | 7447-7449 | Inferred |

**Unknowns:**
1. Exact external URLs and return-URL construction for checkout, MCP OAuth, and GitHub. They are built by the Lab web app, not the shell.
2. Whether Lab-opened popup windows inherit `preload/lab.js` (Electron default inheritance under `overrideBrowserWindowOptions` without `webPreferences`).
3. Meaning of the 8 SPKI hashes in the cert proc (denylist vs pinning intent).
4. Exact contents of `bo[...]` gateway alias origins (defined in the settings/auth area).
5. How the Lab uses `ForegroundEvent` beyond diagnostics.
6. Why MCP returns are popped LIFO rather than FIFO (intent unknown. The behaviour is observed).

---

## 8. Reimplementation notes

**Module boundaries (suggested):**
- `src/preload/lab.ts`: thin bridge exactly per section 2 (channel names unchanged so existing Lab web apps work).
- `src/main/lab-bridge/trust.ts`: `isLabSender(wc)`, `isShellSender(evt)`.
- `src/main/lab-bridge/registry.ts`: the lab-in-window map plus parked map, with lookups `labOf`, `connIdOf`, `windowOfLab`, `windowForConn`, `labWcForConn`, `revealIfHidden`, and the `onLabReady` hook list.
- `src/main/lab-bridge/notify.ts`: pure `parseNotify`, `shouldSuppress`, `Deduper`, `Batcher` (injectable clock and timers), plus the Electron `showNotification` adapter.
- `src/main/lab-bridge/badge.ts`: pure `sanitizeCount`, `parseBadge`, `aggregateBadge`, plus a platform adapter.
- `src/main/lab-bridge/returns.ts`: `NonceStore<T>` (TTL, single-use), parsers `parseCheckoutReturn`, `parseMcpReturn`, `parseGithubReturn`, `McpQueue` (cap 3, TTL 10 min, pop newest), `GithubSlot` (no success→error downgrade), `PendingByConn<T>` (latest wins).
- `src/main/telemetry/shell-events.ts`: `ShellEventQueue` (cap 100, drain), rate limiter, nudge target selection.
- `src/main/telemetry/foreground.ts`: cause recorder (1500 ms window), recency markers (5000 ms), event builder.
- `src/main/permissions.ts`: request and check handlers with an injected `focusedLabWindowFor` and dialog.

**Pure functions and test cases:**
- `parseNotify(x)`:
  - `{kind:"finished", title:"A", route:"/w/1", dedupeKey:"k"}` → ok, `body ""`, `routeMatchesActiveView false`
  - `kind:"other"` → null
  - `title:""` → null
  - `route:""` → null
  - missing dedupeKey → null
  - title of 250 chars → 200
  - `status:"weird"` → `status undefined`
  - `routeMatchesActiveView:"true"` → false
- `shouldSuppressBySettings(n, s)`:
  - `finished` + `completed` + `elapsedSeconds:29` → suppressed
  - same with `30` → shown
  - `failed` + `5` → shown
  - `completed` with no elapsed → shown
  - `enabled:false` → suppressed
- Focus suppression: focused, shown, matches, `notifyWhenActive:false` → suppressed. Same with `notifyWhenActive:true` → shown.
- `Deduper` (5 min):
  - key at t=0 → new
  - t=299 999 → dup
  - t=300 001 → new (pruned when strictly older than 300 000 ms)
- `Batcher` (700 ms debounce):
  - 1 item → itself
  - 2 items "a","b" → title `2 experiments finished`, body `a, b`, route of "b"
  - 5 items → body `a, b, c +2 more`
- `sanitizeCount`:
  - `3.7` → 3
  - `-1` → null
  - `NaN` → null
  - `"3"` → null
  - `1e9` → 9999
- `parseBadge({attention:1})` → null (unread missing).
- `aggregateBadge`:
  - `[{a:0,u:2},{a:0,u:1}]` → `{text:"•", count:0}`
  - `[{a:2,u:0},{a:3,u:9}]` → `{text:"5", count:5}`
  - `[]` → `""`
  - `badge:false` → `""`
- `parseCheckoutReturn`:
  - `silico://checkout-return?outcome=manage&s=x` → `{manage, x}`
  - `silico:checkout-return?...` (path form) → accepted
  - `CHECKOUT-RETURN` host → accepted
  - `outcome=refund` → null
  - missing `s` → null
  - `https://...` → null
- `parseMcpReturn`:
  - `outcome=code&code=abc&state=xyz&s=ab-1` → ok
  - `s=a_b` → null
  - `code` with a non-ASCII char → null
  - `outcome=error&error=access_denied` → ok
  - `error=Access` → null
- `parseGithubReturn`: `outcome=success&s=n` → ok. `outcome=error&error=bad-thing` → null (hyphen not allowed).
- `McpQueue`:
  - push p1, p2, p3, p4 → contains p2, p3, p4
  - take → p4, then p3
  - entries vanish after 10 min
- `GithubSlot`:
  - set success, then set error → take returns success
  - set error, then set success → success
  - take twice → second is null
- `NonceStore`:
  - consume twice → second null
  - consume after TTL → null (and the entry is removed)
- `ShellEventQueue`:
  - push 105 → drain returns the last 100 in order
  - drain again → `[]`
- `gateway-transport-failure` limiter: same op, host, and details within 5 min → dropped. Different details → kept.
- Foreground cause: cause recorded at t, became active at t+1500 → that cause. At t+1501 → `"external-or-user"`.
- `isAllowedLabRoute`:
  - `/` → true
  - `/workspace/abc/x/y` → true
  - `/s/th_1/thread/2` → true
  - `/s/xx_1` → false
  - `/admin` → false
  - `/Home/` → true (lower-cased)

**Behavioural gotchas to preserve:**
- `notify` and `setBadgeCounts` use `send`, not `invoke`, and fail silently.
- `begin-*`, `take-*`, and `drain` reject with the exact `Blocked '<channel>': untrusted sender.` strings.
- MCP and GitHub signals carry no payload. The Lab must pull.
- The notification-click and checkout pending maps are keyed by connId and flushed on the next Lab-ready, latest wins.
- The Linux badge ignores unread-only. Windows has no badge.

---

## Cross-area notes

- Re-auth flow behind `recoverSession` (`rs`/`ns`, 4535+) and the auth-wall detection (`[data-testid="auth-github-login"]` probe, 3085) belong to the auth analyst.
- Deep-link entry (`open-url`/`second-instance` → dispatcher at ~7140-7184, plus `share`/`welcome`/`open` handlers) belongs to the deep-link analyst.
- Help menu, settings sheet, and compact-window sizing (`oi`) belong to the windowing/menu analyst. The `Notifications` menu item (`CmdOrCtrl+,`) opens the same `settings:notifications` sheet.
- TLS `setCertificateVerifyProc` SPKI set (5490-5534).
- `labs:held-elsewhere` / `labs:focus-held` (7451-7466) are shell IPC (not lab bridge) but use the same registry lookups.
