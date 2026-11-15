# Silico desktop: Authentication, Session, Sign-up and Deep Links (behavioral spec)

Source: Silico.app v0.137.0 (`silico-desktop`). Line refs are to the prettified bundles
(`pretty/main.js`, `pretty/preload-index.js`, `pretty/preload-lab.js`, `pretty/renderer.js`).
This spec describes behavior in our own words; it is not a copy of the original code.

---

## 1. Overview

- The app signs a user in against one of two **gateways**: production `https://my.silico.run`
  or staging `https://my-staging.silico.run`. Each gateway has one **alias origin**
  (`https://silico.goodfire.com` / `https://silico-staging.goodfire.com`) used as a fallback
  transport for the same API.
- **Sign-in is a loopback flow in the system browser.** Main starts a one-shot HTTP server on
  `127.0.0.1:<random port>`, opens `<gateway>/login?mode=desktop&redirect_uri=http://127.0.0.1:<port>/callback?s=<state>`
  in the user's browser, and waits up to 180 s for the browser to hit `/callback` with a
  `proof` (a JWT-shaped identity token) and optionally an `activation_code`.
- If an activation code comes back, the app **generates its own refresh token**
  (`sdr_<id>.<random>`), registers only its SHA-256 hash with the gateway (`POST /labs/activate`),
  and keeps the plaintext refresh token locally. That gives a long-lived "device session"; the
  short-lived `proof` is refreshed via `POST /labs/refresh` when it is within 5 minutes of expiry.
- The session (`proof`, optional `refreshToken`, identity fields) lives in memory and is
  persisted to `<userData>/identity.json`, with the secrets encrypted by Electron `safeStorage`
  (macOS Keychain / Windows DPAPI / Linux keyring). If no keyring is available in a packaged
  build, the session is kept **in memory only**.
- **Sign-out** wipes local state, moves the stored file into a `pending-revocations/` queue,
  and best-effort revokes the refresh token server-side (`POST /labs/logout`), retrying every 30 s.
- **Sign-up (beta)** runs inside the app in a sandboxed `WebContentsView` (partition
  `persist:silico-signup`) on `<gateway>/beta-signup`. When the signup site navigates to
  `silico://signup-ready?...`, the app adopts the signup identity proof as the session (no
  refresh token), discovers the new managed Lab, saves a connection, and opens it.
- The app registers the `silico://` URL scheme. Deep links cover sign-up confirmation/resume,
  "welcome", share links (`open`), and three **nonce-bound return flows** that a Lab web page starts
  through the `window.silicoDesktop` bridge: Stripe-style checkout return, MCP OAuth return, and
  GitHub-connect return.
- Lab web pages never see the gateway proof. The desktop exchanges the proof for a per-Lab
  token (`POST /labs/session`) and hands it to the Lab via
  `<labUrl>/auth/callback?return_to=<path>#token=<labToken>` (token in the URL fragment). The
  desktop itself does **not** write cookies into the lab partition (no cookie API usage in main).

---

## 2. IPC contract

Two classes of senders:
- **Shell renderer** (connection manager, settings windows; `window.silico` from `preload/index.js`).
  Handlers registered via the wrapper `y(channel, fn)` reject unless the sender frame URL is
  `file:` or has the origin of `ELECTRON_RENDERER_URL` (dev). Error: `Blocked '<channel>': untrusted sender.` (main.js:6418-6436).
- **Lab pages** (`window.silicoDesktop` from `preload/lab.js`), running in `WebContentsView`s on
  partition `persist:silico`. Their handlers check `sender.session === session.fromPartition("persist:silico")`
  (main.js:6438-6440) and throw `Blocked '<channel>': untrusted sender.`.

```ts
type GatewayUrl = "https://my.silico.run" | "https://my-staging.silico.run";

type AuthState =
  | { status: "signed-out" }
  | {
      status: "signed-in";
      login: string;          // GitHub-style login from proof claim `login`
      sub: string;            // subject; may be prefixed e.g. "google:..." (renderer.js:17854)
      gatewayUrl: GatewayUrl;
      expiresAt: number;      // ms epoch; 8.64e15 (effectively never) when a refresh token exists, else proof exp*1000
      developer: boolean;
    };

type PersistenceMode = "keychain" | "none-no-keyring" | "none-test-mode" | "plaintext-dev";

type RecoverResult =
  | { status: "accepted" }
  | { status: "unsupported" }
  | { status: "error"; message: string };

type CheckoutOutcome = "success" | "cancel" | "manage";
type McpOauthReturn =
  | { outcome: "code"; code: string; state: string }
  | { outcome: "error"; error: string };
type GithubConnectReturn = { outcome: "success" } | { outcome: "error"; error: string };
```

### Shell renderer (`window.silico.auth.*`, `window.silico.signup.*`)

| Channel | Dir | Args | Returns | Behavior | Errors |
|---|---|---|---|---|---|
| `auth:status` | invoke | – | `AuthState` | Loads persisted session once (lazy), kicks the pending-revocation retry (throttled), returns state. Signed-out if no session or `expiresAt <= now`. | sender check |
| `auth:persistence` | invoke | – | `PersistenceMode` | `plaintext-dev` if not packaged; else `none-test-mode` if `SILICO_E2E_USER_DATA` set; else `keychain` if `safeStorage.isEncryptionAvailable()` else `none-no-keyring`. | sender check |
| `auth:signIn` | invoke | `staging: boolean`, `restart?: boolean` (preload defaults `false`; main treats only `=== true` as restart) | `Promise<AuthState>` | Starts or joins the single in-flight browser sign-in (Flow 4.1). The first caller of a given attempt focuses the sender's window on success. | `"Finish the sign-in already open in your browser before changing environments."`, `"Sign-in restarted."`, `"Sign-in timed out. Please try again."`, `"Sign-in failed (state mismatch or missing proof)."`, `"Gateway returned an unknown origin."`, `"Gateway returned an invalid activation code."`, `"Could not activate the desktop sign-in."`, `"Gateway returned an invalid desktop session."`, `"Gateway returned an invalid proof."`, `"Malformed proof"`, server listen errors |
| `auth:signOutAll` | invoke | – | `void` | Flow 4.4. Preload name: `signOutEverywhere()`. | sender check |
| `auth:expired` | event main→renderer | – | – | Sent (a) to a lab window whose silent re-open found the session expired (main.js:4521-4532), (b) by sign-out to the caller's window family (main.js:6543-6554). Main renderer resets to signed-out; settings window closes itself (renderer.js:19527-19536, 23080-23082). | – |
| `auth:changed` | event main→renderer | `AuthState` | – | Sent (a) to all trusted shell windows after a browser sign-in completes (main.js:6518-6524), (b) to every window when the `developer` flag changes after a lab token exchange (main.js:2001-2015), (c) to the signup host window after signup adoption (main.js:5342). | – |
| `signup:open` | invoke | – | `void` | Hides any visible lab view in the window, then opens/re-shows the embedded signup view at `<settingsGateway>/beta-signup` (Flow 4.5). | `"The Silico window is no longer available."`, `"Refusing to open an untrusted signup destination."`, loadURL errors |
| `signup:close` | invoke | – | `void` | Removes and closes the signup view; emits `signup:closed`. | sender check |
| `signup:status` | invoke | – | `boolean` | True if this window has a live signup view. | sender check |
| `signup:opened` / `signup:closed` | event | – | – | Renderer shows/hides `SignupShell` header bar. | – |
| `app:navigate` | event | `"connections"` | – | Sent before opening signup from a deep link. | – |

### Lab pages (`window.silicoDesktop.*`)

| Channel | Dir | Args | Returns | Behavior | Errors |
|---|---|---|---|---|---|
| `silico:recover-session` | invoke | – | `RecoverResult` | **Not** wrapped by either sender check; instead only works for webContents registered as a recoverable viewer (lab-bridge viewer windows) when the sender frame is the main frame and the current URL is eligible. Kicks Flow 4.7. | none thrown; returns `error` with `"Could not restore this window. Please try again."` on exception |
| `silico:begin-checkout` | invoke | – | `string` (nonce, UUID v4) | Registers `{wc, connId, expiresAt: now+30min}`. | `Blocked 'silico:begin-checkout': untrusted sender.` |
| `silico:checkout-return` | event main→lab | `CheckoutOutcome` | – | Delivered on deep link, or later when the lab view for that connection becomes ready. | – |
| `silico:begin-mcp-oauth` | invoke | – | `string` nonce | Registers nonce, TTL 15 min. | `Blocked 'silico:begin-mcp-oauth': untrusted sender.` |
| `silico:mcp-oauth-return` | event main→lab | (no payload) | – | Nudge; page must call take. Preload's `onMcpOauthReturn` auto-calls take. | – |
| `silico:take-mcp-oauth-return` | invoke | – | `McpOauthReturn \| null` | Pops the **most recent** queued payload for the sender's connection (null if sender is not a known lab view). | `Blocked ...` |
| `silico:begin-github-connect` | invoke | – | `string` nonce | TTL 15 min. | `Blocked ...` |
| `silico:github-connect-return` | event main→lab | (no payload) | – | Nudge. | – |
| `silico:take-github-connect-return` | invoke | – | `GithubConnectReturn \| null` | Returns and clears the single stored result for the sender's connection. | `Blocked ...` |

`preload-lab.js` also exposes the constant `manageReturn: true` (capability flag; meaning on the
lab side Unknown).

---

## 3. State & persistence

### 3.1 In-memory session (main)

```ts
interface Session {
  gatewayUrl: GatewayUrl;
  sub: string;
  login: string;
  exp: number;            // seconds epoch, from proof claim
  proof: string;          // JWT-shaped bearer used against the gateway
  refreshToken?: string;  // "sdr_<id>.<base64url 32 bytes>", client-generated
  developer?: true;
}
```
Plus module state: `loaded` flag + single load promise; `identity: {sub, gatewayUrl} | null`
(published to identity listeners only when sub/gateway change or on sign-out); `signInEpoch`
counter (incremented on every sign-in attempt and sign-out); `refreshUnavailable` boolean;
single in-flight refresh `{session, promise}`; `sessionDeathPending` boolean (telemetry +
"gentle" focus); in-flight sign-in `{staging, promise}`; cancel hook for the loopback server.

### 3.2 `<userData>/identity.json` (mode 0600, atomic write via `.tmp` + rename)

```ts
interface IdentityFileV1 {
  version: 1;
  gatewayUrl: GatewayUrl;   // load rejects anything else
  sub: string;
  login: string;
  exp: number;              // seconds
  developer?: true;
  encrypted: boolean;
  proof: string;            // encrypted: base64(safeStorage.encryptString(proof)); plaintext only in unpackaged dev builds
  refreshToken?: string;    // same encoding as proof
  backend?: string;         // only when encrypted: "keychain" | "dpapi" | <linux backend> | "unknown"
}
```
Rules:
- Encryption is used only when packaged, not in E2E test mode (`SILICO_E2E_USER_DATA` unset), and `safeStorage.isEncryptionAvailable()`.
- Plaintext fallback only when `!app.isPackaged`.
- If neither is possible: log `[auth] keychain encryption unavailable; session kept in memory, not persisted` and delete any existing file (unless the caller passed `removeExistingOnFailure: false`, used by refresh).
- On load, if `encrypted` and decryption is unavailable or throws: treated as signed out; if the stored `backend` differs from the current one, log a warning about the keyring backend switch. The file is not deleted on load failure.
- Load validation: non-empty proof, finite `exp`, `gatewayUrl` exactly one of the two gateways.
- Writes are serialized through a promise chain.

### 3.3 `<userData>/pending-revocations/<Date.now()>-<24 hex>.json` (dir mode 0700)
Same format as `identity.json` (the file is renamed into the queue on sign-out). Entries
whose refresh token can't be read are deleted. If the rename fails, the session is kept in an
in-memory map keyed by refresh token for retry instead.

### 3.4 `<userData>/settings.json` (owned by settings area)
Only `staging: boolean` matters here (legacy: `gatewayUrl === staging` implies staging). It
picks the gateway for **new** sign-ins (renderer passes `settings.staging` to `auth:signIn`)
and for the signup URL. Changing it does not sign the user out; API calls use the session's own `gatewayUrl`.

### 3.5 Electron session partitions
- `persist:silico`: lab views (main lab window views and viewer windows). Lab handles its own cookies after `/auth/callback#token=`.
- `persist:silico-signup`: signup view (sandbox: true, contextIsolation, no nodeIntegration).
- Neither partition is cleared on sign-out (no `clearStorageData`/cookie calls exist in main.js).

### 3.6 Nonce / return stores (memory only)
```ts
// checkout: nonce -> {wc, connId|null, expiresAt}; TTL 30 min; single-use
// checkout pending outcome: connId -> CheckoutOutcome (delivered when that lab view becomes ready)
// mcp: nonce -> {wc, connId, expiresAt}; TTL 15 min; single-use
// mcp payload queue: connId -> up to 3 payloads, each auto-expires after 10 min; take() pops newest
// github: nonce -> {wc, connId, expiresAt}; TTL 15 min; single-use
// github result: connId -> GithubConnectReturn (no TTL); an "error" never overwrites a stored "success"
```

---

## 4. Flows

### 4.1 Browser sign-in (`auth:signIn(staging, restart)`)
1. If a sign-in is in flight: if its `staging` differs, reject with "Finish the sign-in already open in your browser before changing environments."; if `restart` is not true, return the in-flight promise.
2. Otherwise start a new attempt: kick revocation retry; `epoch = ++signInEpoch`; `gateway = staging ? STAGING : PROD`.
3. Loopback: cancel any previous loopback (it rejects "Sign-in restarted."). `state = 16 random bytes hex`. Listen on `127.0.0.1:0`.
   - Requests with `Host` header not exactly `127.0.0.1:<port>` get 403.
   - Paths other than `/callback` get 404.
   - `/callback`: read `proof`, `activation_code`, `s`. Success iff `proof` non-empty and `s === state`. Respond 200 HTML page "Signed in" / "You can close this tab and return to the app." or 400 "Sign-in didn’t complete" / "Return to the app and try again." (Goodfire icon inlined as data URI). Close server, resolve or reject "Sign-in failed (state mismatch or missing proof).".
   - Timeout 180 s: "Sign-in timed out. Please try again.".
4. After listening, choose a reachable origin: for gateway G with alias A, try `GET A/.well-known/jwks.json` then `GET G/.well-known/jwks.json` (2.5 s each); first that doesn't throw wins (any status); default G. Then `shell.openExternal(<origin>/login?mode=desktop&redirect_uri=<urlencoded http://127.0.0.1:<port>/callback?s=<state>>)` unless already settled.
5. If `epoch` changed, throw "Sign-in restarted.".
6. Activation (only if `activation_code` present):
   - Require it to match `^sda_([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$` else "Gateway returned an invalid activation code.".
   - `refreshToken = "sdr_" + <captured id> + "." + base64url(32 random bytes)`; `token_hash = sha256_hex(refreshToken)`.
   - `POST <gateway>/labs/activate`, `Authorization: Bearer <activation_code>`, JSON `{token_hash}`, 10 s, alias fallback.
   - Network error, or status 408/425/429/>=500: continue **without** refresh token.
   - Other non-2xx: "Could not activate the desktop sign-in."; body `ok !== true`: "Gateway returned an invalid desktop session.".
7. Finalize: decode proof payload (base64url middle segment; claims `sub, login, exp, purpose, iss, developer`). Require `sub` and `exp` ("Gateway returned an invalid proof."). Note: this path does not check `purpose`/`iss`. Ensure loaded; check epoch. Install session (fires developer-flag listeners if it changed; publishes identity if sub/gateway changed), persist, compute `AuthState`; if epoch or session changed, "Sign-in restarted.".
8. On success, resume waiters: broadcast `auth:changed` to trusted shell windows; re-open labs that were parked on "expired" for the same sub+gateway; viewer windows in "signin" state retry recovery.
9. The first IPC caller for this attempt focuses its window: if a session-death had been recorded since last check, "gentle" (show inactive, dock bounce informational, flash frame on non-mac); else steal focus, restore, show, focus.
10. Renderer: button "Sign in" → "Waiting for your browser…"; hint "Complete sign-in in your browser, then return here. Hit a snag?" with "Try again" (calls with `restart=true`, 2.5 s cooldown showing "Opening browser…"). Shows "Staging environment" if staging, and the keyring notice when persistence is `none-no-keyring`: "Your system keyring isn’t available, so Silico can’t remember this sign-in — you’ll need to sign in again next launch."

### 4.2 Getting a usable session (used by every gateway call)
1. Ensure loaded; kick revocation retry.
2. No session → null (clears `refreshUnavailable`).
3. Has refresh token and `exp*1000 <= now + 5 min` → refresh (deduplicated per session object):
   - `POST <gateway>/labs/refresh`, `Authorization: Bearer <refreshToken>`, 10 s, alias fallback.
   - If the session changed meanwhile → STALE.
   - 401/404 → drop session (reason `device-session-rejected`) → null.
   - Other non-2xx or network error → if proof still valid keep it; else set `refreshUnavailable = true` → null.
   - Body must have string `proof` whose claims have same `sub`, nonzero `exp`, `purpose === "labs"`, `iss === "silico-lab-auth"`; else drop (`device-session-invalid-response`).
   - Install new session (same refresh token; login falls back to old), persist with `removeExistingOnFailure:false`.
4. No refresh token and proof expired → record session death `proof-expired` → null (session object left in memory; status reports signed-out).
5. Callers map results: STALE → `{ok:false, error:"The signed-in account changed. Please try again."}`; null → `refreshUnavailable ? "Session refresh is temporarily unavailable." : {error:"Your session has expired. Sign in again.", needsAuth:true}`.
6. Any gateway 401 on a proof-bearing call → drop session (`gateway-401`) and return the expired error (or account-changed if a race).
"Drop session" = only if still current: record session death, clear memory, clear `refreshUnavailable`, notify developer-flag listeners, delete `identity.json`. It does **not** publish a null identity and does not revoke.

### 4.3 Developer flag update
After `/labs/session` or `/labs/claim` returns a lab `token`, its payload's `developer === true` claim is compared with the session's flag; on change, update, persist, notify developer listeners (gates DevTools/menu), and broadcast `auth:changed` to all windows.

### 4.4 Sign out everywhere (`auth:signOutAll`)
1. Resolve the anchor window: sender window's parent, else itself.
2. `++signInEpoch`; cancel loopback; clear session-death flag; ensure loaded; clear session; publish identity null; notify developer listeners if dev was on.
3. No refresh token → delete `identity.json` (and kick retry) and finish.
4. Else rename `identity.json` into `pending-revocations/`; if rename fails (non-ENOENT), try to delete it and keep the session in an in-memory retry map.
5. Fire-and-forget revoke: `POST <gateway>/labs/logout`, `Authorization: Bearer <refreshToken>`, 3 s, alias fallback. Success if 401/404, or 2xx with body `ok === true`. On success delete the queue file; else schedule a forced retry in 30 s.
6. Close all viewer/aux windows; clear dock badge counts.
7. For every window: if it is the anchor or a child of it (or no anchor), send `auth:expired` and hide its lab view; otherwise close it.
Retry sweep: runs at most every 30 s (unless forced), re-reads queue files (deleting unreadable ones) and the in-memory map; reschedules if anything failed.

### 4.5 Embedded sign-up (`signup:open`)
1. URL = `<settingsGateway>/beta-signup` (or a deep-link-supplied URL). Must classify as `embedded`.
2. If the window already has a signup view: reposition, show, emit `signup:opened`, re-measure header, navigate if URL differs.
3. Else create `WebContentsView` (`persist:silico-signup`, sandboxed), placed below the renderer's `.signup-shell__bar` (measured via JS; default 78 px; zoom-scaled), emit `signup:opened`, load URL (on failure close + rethrow).
4. URL classification:
   - non-http(s) → `blocked`
   - origin is either gateway and path exactly `/beta-signup/github` → `system-auth` (open in system browser with `desktop=1` added; throttled to once per 2.5 s)
   - origin is either gateway or `https://github.com` → `embedded` (stays in view)
   - else → `external` (system browser)
   - `window.open` always denied; embedded targets are loaded into the same view.
5. Navigation/redirect to `silico://signup-ready?deployment_id=..&proof=..[&return_to=/onboarding/compute]`:
   - Valid iff `deployment_id` matches `^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$`, `proof` length 100..4096 and three dot-separated base64url segments; `return_to` kept only if exactly `/onboarding/compute`.
   - Prevent navigation. Handle only once per view and only if the view's current origin is one of the gateways; staging = current origin is staging.
   - Adopt: proof must have `sub`, `login`, `exp` in the future, `purpose === "labs"`, `iss === "silico-lab-auth"` ("Gateway returned an invalid signup identity proof."). Cancels any browser sign-in, bumps epoch, installs session **without refresh token**, clears session-death flag, persists.
   - Discover labs (`GET /labs`); require the deployment present ("The new Lab was not returned by Silico discovery.") and managed ("The new Lab is not app-managed.").
   - Upsert connection (owner=login, gatewayUrl, labUrl `https://<lab_public_host>`, icon "flask"), emit `connections:changed`, close signup, emit `auth:changed`, open the Lab (3 s reach budget, optional returnTo). Failure → "The Lab could not be opened automatically.".
   - On any failure, set the signup page's `#setup-sub` text to "Your Lab is ready, but Silico couldn't open it automatically. Use Back to login and sign in."
6. Signup renderer process crash → close view.

### 4.6 Deep links (`silico://`)
Registration: `setAsDefaultProtocolClient("silico")` only when packaged; Info.plist `CFBundleURLSchemes: [silico]`. Single-instance lock only when packaged.
Intake: initial `process.argv` (first arg matching `/^silico:/i`), `open-url` (macOS), `second-instance` argv. Before `ready`, the latest link is stored and dispatched once after the first main window is created. A `second-instance` without a link focuses an existing main window or creates one.
Target name = `(url.hostname || url.pathname without leading slashes).toLowerCase()`. Dispatch order:
1. `signup?token=<^[A-Za-z0-9_-]{43}$>` → if signed in on the settings gateway, `POST <gateway>/beta-signup/desktop-continue` (Bearer proof, JSON `{token}`, 6 s, no alias fallback); a `resume_token` matching `^[A-Za-z0-9_-]{80,4096}={0,2}$` yields `<gateway>/beta-signup/resume?token=<rt>`; else `<gateway>/beta-signup/confirm?token=<token>`. Open in signup view (step 4.6.a).
2. `signup-resume?token=<same 80-4096 regex>` → `<gateway>/beta-signup/resume?token=..`.
3. `welcome` → focus/restore an existing main window, or create one.
4. `open?url=<https *.silico.run | http localhost/127.0.0.1>` → share viewer (other area).
5. `mcp-oauth-return`, then `github-connect-return`, then `checkout-return` (4.8). Unmatched links are ignored.
4.6.a Signup window choice: window currently showing signup, else focused main window, else any main window, else new; focus, send `app:navigate("connections")`, hide lab, open signup. Errors are logged only.

### 4.7 Viewer session recovery (`silico:recover-session` and automatic)
Applies to lab-bridge viewer windows (pop-out/share). Recovery: if the original URL is on a gateway origin, use its `return_to`/`deployment` params; otherwise `GET <labOrigin>/api/auth/config` (credentials omitted, no redirects, 8 s, max 16 KiB) to read `auth_url` (must map to a gateway) and `tenant_id`. Then require signed-in on the same gateway/sub, pick the managed deployment (auto if exactly one, else "choose" state), `POST /labs/session {deployment_id}` (managed: no `-dev` suffix), wait for reach, and load `<labUrl>/auth/callback?return_to=<route>#token=<token>`. Routes are allow-listed (see `rt` regex, main.js:2572-2583). Automatic triggers: navigation to a gateway `/login` path or a gateway root, or a SPA "auth wall" (`[data-testid="auth-github-login"]` present). Throttle: a non-forced recovery within 45 s of the previous one fails with "The renewed session was rejected. Try again, or reopen the link after checking your account."; 30 s load deadline "This page did not finish opening. Please try again.". If sub/gateway changes: "The signed-in account changed. Reopen this link with the intended account." Blocked sign-in state message: "Sign in to restore this page in Silico."; a later sign-in with matching identity auto-retries.

### 4.8 Lab-initiated return flows
Common: lab page calls `begin*` → gets a UUID nonce (the lab passes it to its server/provider; how it is embedded in the outbound URL is Unknown) → external site eventually opens `silico://<name>-return?...&s=<nonce>` → main consumes the nonce (single-use; expired → ignored). Target webContents = original sender if alive, else the current lab view for that connection; window = its host window or the window holding that connection.
- **Checkout**: params `outcome ∈ {success,cancel,manage}`, `s` non-empty. Restore/show/focus window and steal app focus. If target alive: reveal lab view and send `silico:checkout-return(outcome)`; else store outcome by connId and deliver when that connection's lab view next becomes ready.
- **MCP OAuth**: `s` `^[A-Za-z0-9-]{1,64}$`; `outcome=code` needs `code` `^[\x20-\x7E]{1,2048}$` and `state` `^[\x20-\x7E]{1,4096}$`; `outcome=error` needs `error` `^[a-z_]{1,64}$`. Focus window; if connId known: enqueue payload (max 3, 10 min each); if target alive, reveal and send `silico:mcp-oauth-return`. Lab calls `take-mcp-oauth-return`.
- **GitHub connect**: `s` same regex; `outcome=success` or `outcome=error&error=^[a-z_]{1,64}$`. Store per connId (success not overwritten by error); nudge `silico:github-connect-return`; lab calls take.

### 4.9 Lab token handoff and silent re-auth (overlaps Lab area)
- `POST <gateway>/labs/session` (Bearer proof, JSON `{deployment_id, lab_url?}`) → `{token, lab_url}`; 409 for cluster labs triggers claim via `POST /labs/claim {deployment_id, claim_token_hash}`; `POST /labs/setup-bearer {deployment_id}` → `{setup_bearer}`. Non-managed, non-local deployment ids get `-dev` appended on staging.
- Lab URL loaded: `<labUrl>/auth/callback?return_to=<enc path>#token=<labToken>`.
- If a lab navigates to a gateway `/login` page while shown, the app re-auths in place (15 s budget; 45 s cooldown after non-terminal outcomes). If the session is gone: send `auth:expired`, clear badges, hide the lab, and park `{win, connId, returnTo, identity}`; when sign-in completes for the same sub+gateway, the lab reopens automatically.

---

## 5. External interfaces

| Item | Value |
|---|---|
| Gateways | `https://my.silico.run` (prod), `https://my-staging.silico.run` (staging) |
| Aliases | prod → `https://silico.goodfire.com`; staging → `https://silico-staging.goodfire.com` (same path appended) |
| Browser login | `GET <origin>/login?mode=desktop&redirect_uri=<enc http://127.0.0.1:<port>/callback?s=<32 hex>>` |
| Loopback callback | `GET /callback?s=<state>&proof=<jwt>[&activation_code=sda_<id>.<x>]` |
| Probe | `GET <origin>/.well-known/jwks.json` (2.5 s) |
| Activate | `POST /labs/activate` Bearer activation code, `{token_hash}` → `{ok:true}` |
| Refresh | `POST /labs/refresh` Bearer refresh token → `{proof}` |
| Logout | `POST /labs/logout` Bearer refresh token → `{ok:true}` (401/404 treated as done) |
| Discovery | `GET /labs` Bearer proof → `{labs:[{deployment_id, kind, lab_public_host, host, port, stale, current_sha, target_sha, min_sha, update_available, update_required, reports_version}]}` |
| Lab session | `POST /labs/session`, `POST /labs/claim`, `POST /labs/setup-bearer` |
| Signup | `<gw>/beta-signup`, `/beta-signup/confirm?token=`, `/beta-signup/resume?token=`, `/beta-signup/github` (system browser, `desktop=1`), `POST /beta-signup/desktop-continue {token}` → `{resume_token}` |
| Lab auth | `<labUrl>/auth/callback?return_to=..#token=..`; lab probe `GET /api/cluster/version` with `Authorization: Bearer <labToken>`; `GET /api/auth/config` → `{auth_url, tenant_id}` |
| Proof claims | `sub, login, exp, purpose ("labs"), iss ("silico-lab-auth"), developer` |
| Scheme | `silico://signup`, `signup-resume`, `signup-ready`, `welcome`, `open`, `checkout-return`, `mcp-oauth-return`, `github-connect-return` |
| Legal links (renderer) | `https://www.goodfire.com/legal/tos`, `https://www.goodfire.com/legal/privacy` |
| Transport | All gateway calls use `net.fetch` through a guard that refuses any origin other than the two gateways ("Refusing to send gateway credentials to an unknown origin."; invalid URL: "Refusing an invalid gateway URL."). Default timeout 10 s per attempt; with alias fallback tries primary then alias and returns the first HTTP response of any status. |

---

## 6. Security notes

- **IPC sender validation**: shell channels require `file:` (or dev-server origin) frames; lab channels require the `persist:silico` session; `take-*` return null unless the sender is a registered lab view (returns are scoped per connection).
- `silico:recover-session` has no generic sender check; it is safe only because it is a no-op unless the sender is a registered viewer main frame.
- **Loopback hardening**: bound to 127.0.0.1, random port, strict `Host` header check (DNS-rebinding defence), path check, random state compared exactly, single use, 180 s timeout.
- **Refresh token never leaves the device in plaintext to the server at activation**: only its SHA-256 hash is registered. Later refresh/logout calls send it as a Bearer.
- **Credential origin pinning**: gateway credentials are only sent to the two gateways (aliases included via fallback).
- **Proof validation**: refresh and signup paths check `purpose`/`iss`/`sub`; the browser sign-in path only checks presence of `sub`/`exp` (signature verification is not done client-side).
- **Launch guard**: packaged builds exit with code 78 if started with `--remote-debugging-port` (allowed in test mode), `--remote-debugging-pipe`, `--ignore-certificate-errors`, `--ignore-certificate-errors-spki-list`, `--log-net-log`, `--ssl-key-log-file`, logging that the flag "would expose your Silico sign-in"; `SSLKEYLOGFILE` is deleted from env.
- **TLS interception blocklist**: every session (default, `persist:silico`, `persist:silico-signup`, and any created later) gets a certificate verify proc that rejects (net error -206) chains containing any of 8 hard-coded SPKI SHA-256 hashes (keys "whose private key is publicly known", per the same set's use in installer verification), otherwise defers to Chromium (-3).
- **Signup view**: sandboxed, separate partition, `window.open` denied, navigation restricted to gateway/github origins, `silico://signup-ready` accepted only from gateway-origin pages, once per view.
- **Deep-link inputs** are regex-validated; return flows require an unexpired, single-use nonce bound to the originating webContents/connection.
- **External opens** only allow http/https.
- Sign-out does not clear `persist:silico` / `persist:silico-signup` storage (lab cookies may persist).
- identity.json written 0600; revocation dir 0700.

---

## 7. Evidence ledger

O = Observed in code, I = Inferred.

| Claim | Evidence | O/I |
|---|---|---|
| Gateway constants, alias map, alias URL expansion | main.js:215-229 | O |
| staging→gateway, signup URL builders, `-dev` suffix | main.js:230-256 | O |
| settings.staging parsing (legacy gatewayUrl) | main.js:285-310 | O |
| signup/signup-resume deep-link parsers + token regexes | main.js:1086-1124 | O |
| identity record serialize/encrypt | main.js:1122-1155 | O |
| backend-mismatch warning | main.js:1158-1164 | O |
| identity load/validate | main.js:1165-1198 | O |
| persistence mode + backend names | main.js:1199-1214, 1268-1298 | O |
| launch flag guard, exit 78 | main.js:1215-1230, 7003-7015 | O |
| identity.json / pending-revocations paths | main.js:1258-1263 | O |
| proof claim decode | main.js:1299-1314 | O |
| persist (0600, tmp+rename, memory-only warning) | main.js:1328-1350 | O |
| lazy load | main.js:1351-1369 | O |
| expiresAt rule (refresh token → 8.64e15) | main.js:1380-1382, 1397-1411 | O |
| drop session (`nt`/`rc`) | main.js:1383-1394 | O |
| sign out + revocation queue | main.js:1416-1465 | O |
| revocation call + retry 30 s | main.js:1466-1540 | O |
| error strings, refresh logic, 5-min window | main.js:1541-1633 | O |
| sign-in orchestration, epoch | main.js:1634-1643 | O |
| activation + client-generated refresh token | main.js:1644-1680 | O |
| sign-in finalize (no purpose/iss check) | main.js:1681-1700 | O |
| signup proof adoption (purpose/iss check) | main.js:1719-1746 | O |
| loopback server, 180 s, Host/path checks | main.js:1747-1811 | O |
| login URL, Host check, callback parse | main.js:1045-1072 | O |
| HTML result pages | main.js:2160-2179 | O |
| gateway fetch guard + alias fallback | main.js:1882-1914 | O |
| jwks probe | main.js:1915-1945 | O |
| discovery `/labs` | main.js:1947-1973 | O |
| desktop-continue | main.js:1974-1998 | O |
| developer flag from lab token | main.js:1073-1085, 1999-2014 | O |
| `/labs/session`, `/labs/claim`, `/labs/setup-bearer` | main.js:2015-2140 | O |
| auth-wall classification (gateway `/login`) | main.js:2212-2222 | O |
| in-flight sign-in single-flight + env mismatch | main.js:2514-2553 | O |
| viewer recovery registry & `recover-session` result | main.js:2599-2671 | O |
| recovery via `/api/auth/config`, handoff URL | main.js:2672-2848 | O |
| recovery throttle 45 s / 30 s deadline / messages | main.js:2854-3030 | O |
| partition `persist:silico` | main.js:3032, 3145-3155 | O |
| lab ready callbacks (checkout delivery) | main.js:3073-3076, 3755, 7686-7689 | O |
| lab handoff `#token=` | main.js:4299-4305, 4334-4341, 4403-4411 | O |
| re-auth, park-and-resume on sign-in, `auth:expired` | main.js:4440-4560 | O |
| signup-ready parser | main.js:5267-5289 | O |
| signup view, classification, adoption | main.js:5237-5475 | O |
| TLS SPKI blocklist + verify proc | main.js:5490-5534 | O |
| -206 = ERR_CERT_REVOKED | Chromium net error list | I |
| checkout nonce/parse/stash | main.js:6246-6290 | O |
| mcp nonce/parse/queue | main.js:6291-6370 | O |
| github nonce/parse/store | main.js:6371-6414 | O |
| IPC sender wrapper & partition check | main.js:6418-6440 | O |
| sign-in focus behavior | main.js:6441-6456, 6525-6536 | O |
| auth/signup IPC registration, signOutAll | main.js:6500-6556 | O |
| lab-bridge IPC handlers | main.js:6681-6720 | O |
| welcome / open parsers | main.js:6730-6765 | O |
| argv deep-link finder | main.js:6954-6956 | O |
| scheme registration, open-url, second-instance | main.js:7075-7097 | O |
| deep-link dispatcher & return handlers | main.js:7130-7268 | O |
| startup ordering, pending link dispatch | main.js:7647-7722 | O |
| preload shell bridge | preload-index.js:20-56 | O |
| preload lab bridge | preload-lab.js:1-90 | O |
| SignIn UI strings, cooldown 2.5 s | renderer.js:22425-22553 | O |
| keyring notice | renderer.js:22612-22624 | O |
| renderer reactions to auth events | renderer.js:19489-19560, 20300-20357, 23066-23082 | O |
| `google:` sub prefix messaging | renderer.js:17849-17880 | O |
| Info.plist URL scheme | `/Applications/Silico.app/Contents/Info.plist` CFBundleURLTypes | O |
| Lab sets its own session cookie from `#token` | no cookie code in main.js | I |

**Unknowns**
- Server-side semantics: proof lifetime, what `activation_code` represents beyond its format, whether `/labs/refresh` rotates anything server-side, and JWT signature algorithm (client never verifies).
- How the Lab page transports the checkout/MCP/GitHub nonce to the external provider and how the provider builds the `silico://...-return` URL (lab-side code not in this bundle).
- Meaning of `manageReturn: true` in the lab bridge.
- How the Lab converts `#token=` into its own session (cookie name, lifetime).
- Why `/labs/refresh` 404 is treated like 401 (presumably "device session unknown") — I.
- Behaviour on Windows/Linux deep links beyond `second-instance` argv (no extra handling observed).

---

## 8. Reimplementation notes

Suggested modules (main process, `src/main/auth/`):
- `gateways.ts` (pure): `PROD`, `STAGING`, `ALIASES`, `gatewayFor(staging)`, `isGateway(origin)`, `expandAliases(url)`, `gatewayOf(url)`, `isAuthWall(url)`, `signupUrl(staging)`, `confirmUrl`, `resumeUrl`, `withDevSuffix(id, staging)`.
- `proof.ts` (pure): `decodeProofClaims(jwt)`, `isLabsProof(claims, expectSub?)`, `hasDeveloperClaim(jwt)`.
- `identityFile.ts` (pure core + fs adapter): `serializeIdentity(session, encrypt|null, {plaintextFallback, backend})`, `parseIdentity(json, decrypt|null, {currentBackend, warn})`, `persistenceMode({isPackaged, testMode, encryptionAvailable})`, `backendName({platform, linuxBackend})`.
- `loopback.ts`: `buildLoginUrl(origin, port, state)`, `isValidHost(host, port)`, `parseCallback(url, state)` (pure) + server wrapper with injectable timeout.
- `activation.ts`: `parseActivationCode(code)`, `mintRefreshToken(id, randomBytes)`, `hashToken(t)` (pure).
- `gatewayClient.ts`: `gatewayFetch(url, init, timeoutMs, {aliasFallback})` with origin guard; `probeLoginOrigin(gw)`.
- `sessionStore.ts`: in-memory session, epoch, refresh single-flight, `getUsableSession()`, `dropIfCurrent(reason)`, listeners (identity, developer, signed-in waiters).
- `revocation.ts`: queue dir, `revoke(session)`, throttled `retryPending({force})`.
- `signup.ts`: `classifySignupUrl(url)`, `parseSignupReady(url)`, view manager, adoption.
- `deepLinks.ts` (pure parsers): `parseSignup`, `parseSignupResume`, `parseSignupReady`, `isWelcome`, `parseOpen`, `parseCheckoutReturn`, `parseMcpOauthReturn`, `parseGithubConnectReturn`, `findDeepLinkInArgv`, `deepLinkTarget(url)`; plus a dispatcher with ordered handlers.
- `returnStores.ts`: `NonceStore<T>(ttlMs)` (single-use, expiring), `BoundedQueue(max=3, ttl=10min, popNewest)`, `ResultSlot(successSticky)`; injectable clock.
- `ipc/auth.ts`, `ipc/labBridge.ts`: thin handlers + sender guards (`isTrustedShellSender`, `isLabPartitionSender`).
- `tlsGuard.ts`: `spkiSha256(certDer)`, `chainHasBlockedKey(chain, set)`.

Unit-test targets: every parser/regex boundary (43-char token, 80-4096 resume token, deployment id, proof length), alias expansion, Host header check, callback state mismatch, identity round-trip (encrypted / plaintext / null encryptor / backend mismatch / bad gateway), `expiresAt` rule, refresh decision table (401/404, 5xx with valid/expired proof, bad claims, session swapped mid-flight → STALE), activation status mapping (408/425/429/5xx → no refresh token), revocation success predicate, signup URL classification, nonce TTL and single-use, MCP queue overflow/LIFO, GitHub success stickiness, signOutAll window partitioning (anchor/children vs close).

Keep a single `signInEpoch` integer and re-check it after every await in sign-in, adoption, and sign-out paths; that is what makes "Sign-in restarted." and account-swap races behave.

---

## Cross-area notes
- Telemetry events emitted from this area: `session-death` (reasons: `gateway-401`, `proof-expired`, `proof-expired-under-lab`, `device-session-rejected`, `device-session-invalid-response`), `gateway-transport-failure` (operation `api`/`sign-in-probe`, `failureKind` dns/reset/timeout/tls/connection/other), `reauth-outcome`, `viewer-stranded`; breadcrumbs `deep-link:*`, `sign-in`, `second-instance` (main.js:549-551, 1254-1257, 1812-1881).
- Signed-in developer claim OR any dev setting toggles the developer menu/DevTools availability (main.js:7690-7718).
- Crash/feedback identity uses `auth:status` login/sub (main.js:7651-7670).
- Windows installer signature verification reuses the same SPKI blocklist plus a pinned SSL.com CA set (main.js:5546-5576) — updater area.
