/**
 * Cross-module service contracts for the main process (dependency injection).
 *
 * FROZEN SHARED FILE (architect-owned). Implementers request changes; they do
 * not edit this file.
 *
 * Rules (see docs/architecture.md "Module contract"):
 *  - A main-process module NEVER imports another module's files. It reaches
 *    other areas only through `ctx.<service>` using the interfaces below.
 *    Allowed imports everywhere: `electron`, `node:*`, `electron-updater`
 *    (I6 only), `@shared/*`, `src/main/services.ts`, `src/main/ipc/*`.
 *  - Every module exposes `create<X>Service(ctx, deps?)` and (if it owns IPC)
 *    `register<X>Ipc(ctx)` from its entry file `src/main/<area>/index.ts`.
 *  - `create*` must be side-effect free: no Electron calls that need
 *    `app.whenReady()`, no listeners, no timers, and NO synchronous access to
 *    other services (they may not exist yet). Access `ctx.other` lazily inside
 *    methods. Side effects belong in `install*()` / `start()` methods that the
 *    bootstrap calls in the documented order, or in `register*Ipc`.
 *  - `ctx` properties are lazy getters; reading a service before it was
 *    provided throws `Error("service '<name>' accessed before it was created")`.
 */

import type { ChildProcess } from "node:child_process";
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from "electron";
import type {
  AuthState,
  Connection,
  ConnectionUpsert,
  DesktopShellEvent,
  FocusedWindowKind,
  GatewayUrl,
  GithubConnectReturn,
  HostKeyKind,
  LabPhase,
  LabsListResult,
  McpOauthReturn,
  NavigateDest,
  OpenResult,
  PersistenceMode,
  RecoverSessionResult,
  Settings,
  SettingsPatch,
  ShellEventKind,
  ShellEventMap,
  SshTarget,
  Unsubscribe,
  UpdateState,
} from "@shared/ipc";

// ===========================================================================
// Platform (I6): environment + logging
// ===========================================================================

export interface AppEnv {
  /** `app.isPackaged`. */
  readonly isPackaged: boolean;
  /** True when ENV_E2E_USER_DATA is set ("test mode"). */
  readonly isTestMode: boolean;
  readonly platform: NodeJS.Platform;
  /** `app.getVersion()`. */
  readonly appVersion: string;
  /** BUILD_STRING from @shared/config. */
  readonly build: string;
  /** `ELECTRON_RENDERER_URL` (dev server), if any; always `undefined` when packaged (X17). */
  readonly rendererUrl: string | undefined;
  /** `app.getPath("userData")` (call lazily; valid after the pre-ready bootstrap set the name/path). */
  userDataPath(): string;
  /** Absolute path of a built preload script (`out/preload/<name>.js`). */
  preloadPath(name: "index" | "lab"): string;
  /** Absolute path of the built renderer `index.html` (used when rendererUrl is unset). */
  rendererHtmlPath(): string;
  /** Absolute path of the app icon PNG (may not exist; callers must tolerate an empty image). */
  iconPath(): string;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Console logger prefixed with `[tag]` (tags: auth lab labview signup updater app foreground ipc launch managed-wake memory shell viewer ...). */
export type LoggerFactory = (tag: string) => Logger;

// ===========================================================================
// Settings (I6)  [platform §4.1]
// ===========================================================================

export interface SettingsService {
  /** Sanitized settings; defaults on any read/parse error. */
  get(): Promise<Settings>;
  /**
   * Serialized shallow merge `{...await get(), ...patch}`, atomic write
   * (`{version:2,...}`), then calls every onChanged listener with the merged
   * object and returns it. Does NOT broadcast `settings:changed`; the IPC
   * handler does that (via ctx.windows.broadcast).
   */
  set(patch: SettingsPatch): Promise<Settings>;
  /** Listener receives the merged (unsanitized) object after each successful write. */
  onChanged(listener: (settings: Settings) => void): Unsubscribe;
}

// ===========================================================================
// Telemetry (I5)  [bridge §4.9, §4.10; platform §6.4]
// ===========================================================================

/** Recency markers recorded with `markRecent` (bridge §4.9). */
export type RecentMarker = "lab-reveal" | "notification-shown" | "reconnect" | "shell-renderer-gone" | "watchdog-rewake";

export interface TelemetryService {
  /** Queue a `desktop_shell` event (cap 100, transport-failure dedupe), log it, nudge one Lab view. */
  recordShellEvent(kind: ShellEventKind, opts?: { connId?: string; details?: Record<string, unknown> }): void;
  /** Remove and return every queued event. */
  drainShellEvents(): DesktopShellEvent[];
  /** Record the intentional cause of an upcoming app activation (`D(cause, details)`). */
  markCause(cause: string, details?: unknown): void;
  /** Record a recency marker (`qe(name)`). */
  markRecent(name: RecentMarker): void;
  /** whenReady step 3+4: did-resign/become-active listeners; deliver `silico:foreground`; shell-event nudge sink. */
  installForegroundTracker(): void;
  /** Called by the uncaughtException handler for non-`net::ERR_` errors (cause "error-dialog"). */
  reportMainProcessError(err: unknown): void;
}

// ===========================================================================
// Auth (I1)  [auth spec]
// ===========================================================================

export interface Identity {
  sub: string;
  login: string;
  gatewayUrl: GatewayUrl;
}

/** A session usable for proof-bearing gateway calls (refreshed if needed). */
export interface UsableSession extends Identity {
  proof: string;
  developer: boolean;
}

export type SessionResult =
  | { ok: true; session: UsableSession }
  /**
   * Already mapped to user-facing text (auth §4.2 step 5):
   * "The signed-in account changed. Please try again." |
   * "Your session has expired. Sign in again." (needsAuth) |
   * "Session refresh is temporarily unavailable."
   */
  | { ok: false; error: string; needsAuth?: true };

export interface GatewayRequest {
  /** Path on the session's gateway, e.g. "/labs/session". */
  path: string;
  method?: "GET" | "POST";
  /** JSON-serialized when present. */
  body?: unknown;
  /** Per-attempt timeout; default GATEWAY_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Try the alias origin after the canonical one on transport failure. Default true. */
  aliasFallback?: boolean;
  /** Label for `gateway-transport-failure` telemetry (e.g. "api"). */
  operation?: string;
}

export type GatewayResponse =
  /** Any HTTP status except 401 (401 drops the session and becomes kind "auth"). `body` = parsed JSON or null. */
  | { kind: "http"; status: number; body: unknown; gatewayUrl: GatewayUrl }
  | { kind: "auth"; error: string; needsAuth?: true }
  /** Transport failure; `error` is the message with ` (<code>)` appended when a safe code exists. */
  | { kind: "network"; error: string; code?: string };

export interface AuthService {
  /** auth:status semantics (lazy load, kicks revocation retry). */
  status(): Promise<AuthState>;
  persistenceMode(): PersistenceMode;
  /** whenReady step 9: logs `[auth] identity persistence: <mode> (safeStorage backend "<b>")`. */
  logPersistenceMode(): void;
  /** Signed-in session's gateway, else the gateway picked by settings.staging. */
  activeGateway(): Promise<GatewayUrl>;
  /**
   * Sync, possibly stale identity of the current session object: telemetry stamping
   * and I4 viewer recovery (account-switch detection). Null once the session is dropped.
   */
  cachedIdentity(): { login: string; sub: string; gatewayUrl: GatewayUrl } | null;
  /**
   * The module-level published identity `{sub, gatewayUrl}` (auth §3.1). Unlike
   * `cachedIdentity`, it survives a session drop (gateway/refresh 401/404) and is
   * cleared only on sign-out. I3 records it with parked "expired" re-auths so a
   * later sign-in as the same account reopens the Lab.
   */
  lastIdentity(): { sub: string; gatewayUrl: GatewayUrl } | null;
  /** Usable session (auth §4.2), refreshing the proof when within 5 min of expiry. */
  getSession(): Promise<SessionResult>;
  /** Proof-bearing gateway call with origin guard, alias fallback and 401 handling (auth §4.2 step 6, §5). */
  gatewayRequest(req: GatewayRequest): Promise<GatewayResponse>;
  /** After /labs/session or /labs/claim returned a lab token: update the developer flag from its claim (auth §4.3). */
  noteLabToken(labToken: string): void;
  /** True iff signed in and the session carries `developer: true`. */
  isDeveloper(): boolean;
  /** Fires when sub/gateway change, and with null on sign-out (not on session drop). */
  onIdentityChanged(cb: (identity: Identity | null) => void): Unsubscribe;
  /** Fires after a browser sign-in or signup adoption completes ("resume waiters", auth §4.1 step 8). */
  onSignedIn(cb: (identity: Identity) => void): Unsubscribe;
  /** Fires when `isDeveloper()` changes. */
  onDeveloperChanged(cb: (developer: boolean) => void): Unsubscribe;
  /** Record a session-death telemetry event (reasons per auth cross-area notes, e.g. "proof-expired-under-lab"). */
  recordSessionDeath(reason: string): void;
}

export interface SignupService {
  /** Open or re-show the embedded signup view in `win` (auth §4.5). `url` defaults to `<settingsGateway>/beta-signup`. */
  open(win: BrowserWindow, url?: string): Promise<void>;
  /** Remove and close the signup view of `win` (if any); emits `signup:closed`. */
  close(win: BrowserWindow): void;
  isOpen(win: BrowserWindow): boolean;
  /** Re-layout after window resize / zoom change. */
  relayout(win: BrowserWindow): void;
  /** Used for focused-window classification ("signup"). */
  isSignupWebContents(wc: WebContents): boolean;
}

export interface DeepLinkService {
  /**
   * Accept a `silico:` URL from argv / open-url / second-instance. Before
   * `markReady()` only the latest URL is stashed; afterwards it is dispatched.
   */
  handle(url: string): void;
  /** whenReady step 14: dispatch the stashed URL (if any); later calls to `handle` dispatch immediately. */
  markReady(): void;
  /** First argv entry matching DEEP_LINK_ARG_RE, or null. */
  findInArgv(argv: readonly string[]): string | null;
}

export type ReturnKind = "checkout" | "mcp-oauth" | "github-connect";

export interface ReturnsService {
  /** Mint a single-use UUID nonce bound to `sender` + `connId` (TTL per kind). */
  begin(kind: ReturnKind, sender: WebContents, connId: string | null): string;
  /** Pop the newest queued MCP OAuth payload for `connId` (null if none / connId null). */
  takeMcpOauthReturn(connId: string | null): McpOauthReturn | null;
  /** Take and clear the stored GitHub-connect result for `connId`. */
  takeGithubConnectReturn(connId: string | null): GithubConnectReturn | null;
  /** whenReady step 10: register the lab-ready hook that flushes pending checkout outcomes. */
  install(): void;
}

// ===========================================================================
// Connections + SSH (I2)  [conn-ssh spec]
// ===========================================================================

export interface ConnectionsService {
  /** ENOENT / non-array => []. Corrupt JSON => D5: back up and return [] (never throws for corrupt data). */
  list(): Promise<Connection[]>;
  get(id: string): Promise<Connection | undefined>;
  /** Serialized; replaces wholesale by id; assigns randomUUID when id missing. */
  upsert(conn: ConnectionUpsert): Promise<Connection>;
  /** Serialized; removes every record with that id (rewrites even if absent). */
  remove(id: string): Promise<void>;
}

export interface RemoteResult {
  /** Exit code; null when killed/aborted. 255 + toolMissing when ssh is not installed. */
  code: number | null;
  stdout: string;
  stderr: string;
  toolMissing?: true;
}

export interface RunRemoteOptions {
  /** Streaming UTF-8 chunks (no line buffering). */
  onChunk?: (text: string, stream: "stdout" | "stderr") => void;
  /** Receives the ssh child right after spawn (for cancellation registries). */
  onSpawn?: (child: ChildProcess) => void;
  /** Checked before and right after spawn (does not kill a running child). */
  signal?: AbortSignal;
}

export type SpawnToolResult =
  | { ok: true; child: ChildProcess }
  | { ok: false; toolMissing: true; message: string };

export interface SshService {
  /** Memoized login-shell PATH / SSH_AUTH_SOCK import (no-op on win32). whenReady step 2 starts it. */
  ensureShellEnv(): Promise<void>;
  /** `ssh <sshArgs> <dest> <cmd>` (conn-ssh §4.3). Awaits ensureShellEnv first. */
  runRemote(target: SshTarget, cmd: string, opts?: RunRemoteOptions): Promise<RemoteResult>;
  /** Spawn an OpenSSH tool through the cached resolver (used for tunnels). Rejects only on non-ENOENT errors. */
  spawnTool(tool: "ssh" | "ssh-keyscan" | "ssh-keygen", args: string[]): Promise<SpawnToolResult>;
  /** `-o BatchMode=yes -o ConnectTimeout=10 [-i f -o IdentitiesOnly=yes] [-p port] [-J jump]`. */
  sshArgs(target: SshTarget): string[];
  /** `user@host` or `host`. */
  sshDest(target: SshTarget): string;
  classifyHostKey(stderr: string): HostKeyKind | null;
  /** classifySshError (conn-ssh §8). */
  classifySshError(result: RemoteResult): string;
}

// ===========================================================================
// Lab lifecycle (I3)  [lab spec; windows §4.4 re-auth]
// ===========================================================================

export interface OpenLabOptions {
  /** Readiness budget; default CONNECT_REACH_BUDGET_MS. */
  reachBudgetMs?: number;
  onLog?: (line: string) => void;
  onPhase?: (phase: LabPhase) => void;
  forceTunnel?: boolean;
  /** Re-auth path: use this epoch instead of bumping the window's epoch. */
  recoveryEpoch?: number;
  returnTo?: string;
  /** false => never fall back to opening the gateway in the system browser. Default true. */
  browserFallback?: boolean;
}

export type LabSessionResult =
  | { ok: true; token: string; labUrl: string }
  | { ok: false; error: string; status?: number; needsAuth?: true };

export type LabWaitOutcome = "ready" | "unreachable" | "still-waking" | "canceled";

export interface LabLifecycleService {
  /** Shared open flow `Ge` (lab §4.7). Ends in ctx.windows.openLabInWindow on success. */
  openLab(conn: Connection, win: BrowserWindow | null, opts?: OpenLabOptions): Promise<OpenResult>;
  /** Auth-wall re-auth in place (`rs`): 15 s budget, 45 s cooldown. */
  reauthOnAuthWall(win: BrowserWindow, connId: string, returnTo?: string | null): Promise<void>;
  /** Wake/crash/watchdog/memory reopen (`xt`): 30 s budget. */
  rewake(win: BrowserWindow, connId: string, returnTo?: string | null): Promise<void>;
  /** On app did-become-active (called by windows): retry I3's parked re-auths (session-expired waits) (`yl`/`bl`). */
  resumePendingReauths(): void;
  /**
   * User hid the Lab (`ts`): drop parked resume, bump the window epoch, clear reauth flags
   * and I3's per-window re-auth state (reauthing / 45 s cooldown).
   */
  cancelWindow(winId: number): void;
  /** Window closed: forget every per-window record (epoch, parked re-auth, re-auth state). */
  forgetWindow(winId: number): void;
  /** Tear down the SSH tunnel owned by this window (window closed). */
  closeTunnel(winId: number): void;
  /** before-quit / update install. */
  killAllTunnels(): void;
  /** labs:list semantics. */
  listLabs(): Promise<LabsListResult>;
  /** POST /labs/session (managed: raw id; cluster on staging: `-dev` suffix applied by this service). */
  createLabSession(req: { deploymentId: string; managed: boolean; labUrl?: string }): Promise<LabSessionResult>;
  /** Managed wake poll / cluster readiness poll (lab §5.3). */
  waitForLab(
    baseUrl: string,
    labToken: string,
    opts: { managed: boolean; budgetMs: number; signal?: AbortSignal; onPhase?: (p: LabPhase) => void; onLog?: (line: string) => void },
  ): Promise<LabWaitOutcome>;
}

// ===========================================================================
// Windows, Lab views, viewer, menu, lifecycle hooks (I4)  [windows spec]
// ===========================================================================

export interface LabRef {
  win: BrowserWindow;
  connId: string;
  shown: boolean;
  /** Origin of the URL passed to `openLabInWindow` (e.g. `https://x.silico.run`), null if unparseable. */
  labOrigin: string | null;
}

export interface CreateShellWindowOptions {
  /** Mark as the initial window (allowed to auto-reopen the last Lab once). */
  initial?: boolean;
  /** Enter compact (picker) mode immediately with default height (lab switcher). */
  compact?: boolean;
}

export interface WindowService {
  // --- shell windows ------------------------------------------------------
  createShellWindow(opts?: CreateShellWindowOptions): BrowserWindow;
  /** second-instance / welcome: restore+focus the first live shell window (marking `cause`), or create an initial one. */
  focusOrCreateShellWindow(cause: string): BrowserWindow;
  /** macOS `activate`: create an initial shell window if none exists. */
  ensureShellWindow(): void;
  isShellWindow(win: BrowserWindow): boolean;
  shellWindows(): BrowserWindow[];
  /** Focused window if it is a shell window, else first live shell window, else null. */
  primaryShellWindow(): BrowserWindow | null;
  /** Restore/show/focus + `app.focus({steal:true})` (+ macOS critical dock bounce) (`Zo`). */
  activateWindow(win: BrowserWindow, cause: string): void;
  /** Send to every non-destroyed BrowserWindow (`settings:changed`, `update:state`, ...). */
  broadcast<C extends keyof ShellEventMap>(channel: C, payload: ShellEventMap[C]): void;
  /** Send to every window whose webContents passes the shell-trust check (`auth:changed` after sign-in). */
  broadcastToTrustedShells<C extends keyof ShellEventMap>(channel: C, payload: ShellEventMap[C]): void;
  /** Sign-out-all window effects (auth §4.4 steps 6-7): close aux windows, `auth:expired`+hide for anchor family, close others. */
  applySignOut(anchor: BrowserWindow | null): void;
  /** Install the context menu on a webContents (from `web-contents-created`). */
  attachContextMenu(wc: WebContents): void;

  // --- Lab views -----------------------------------------------------------
  /** `openLabInWindow` (windows §4.1). */
  openLabInWindow(win: BrowserWindow, connId: string, url: string, title: string): void;
  /** Plain hide (`dt`): keeps the view alive. */
  hideLabView(win: BrowserWindow): void;
  /** Reveal the Lab owning `wc` if its entry is hidden (`Sn`/`Vi`). */
  revealIfHidden(wc: WebContents): void;
  /** Lab-in-window entry owning `wc` (viewer views return null). */
  findLab(wc: WebContents): LabRef | null;
  /** Window holding `connId` (live entries first, then parked). */
  windowForConn(connId: string): BrowserWindow | null;
  /** Live Lab webContents for `connId` (parked excluded). */
  labWebContentsForConn(connId: string): WebContents | null;
  /** The shown Lab webContents of `win`, if any. */
  shownLabWebContents(win: BrowserWindow): WebContents | null;
  /** Viewer content webContents of `win`, if it is a viewer window. */
  viewerWebContents(win: BrowserWindow): WebContents | null;
  /** Register a callback run every time a Lab view becomes ready/shown. */
  onLabReady(cb: (connId: string, wc: WebContents) => void): Unsubscribe;
  /** Re-auth bookkeeping used by ctx.lab: true sets `reauthing`; false clears `reauthing` and `userLeft`. */
  setReauthing(win: BrowserWindow, reauthing: boolean): void;
  /** Wait until the shell renderer is usable (reload a crashed one, ≤8 s). `reloaded` tells the caller to resend lab:opened. */
  waitForShellRenderer(win: BrowserWindow): Promise<{ reloaded: boolean }>;
  /** Resend `lab:opened {id,title}` for the window's current entry. */
  resendLabOpened(win: BrowserWindow): void;
  /** Current Lab route (path+search+hash) excluding "/" and "/auth/callback…", or null (`Hi`). */
  currentLabReturnTo(win: BrowserWindow): string | null;
  /** Update install: destroy every Lab view (`wl`). */
  destroyAllLabViews(): void;
  /** Repaint shown windows and Lab views (GPU gone, resume). */
  invalidateShownViews(): void;

  // --- bridge-facing -------------------------------------------------------
  /** silico:recover-session (bridge §4.13). */
  handleRecoverSession(event: IpcMainInvokeEvent): Promise<RecoverSessionResult>;
  /** silico:open-desktop-settings: open the settings sheet over the window hosting the Lab view `wc` (no-op otherwise). */
  openDesktopSettingsFor(wc: WebContents): void;
  /** silico:open-lab-switcher: new compact shell window if `wc` is a Lab view (no-op otherwise). */
  openLabSwitcherFor(wc: WebContents): void;
  /** Focused-window classification for foreground telemetry (`Ef`). */
  classifyFocusedWindow(): { kind: FocusedWindowKind; connId: string | null };

  // --- navigation / viewer ---------------------------------------------------
  openSettingsSheet(win: BrowserWindow, dest: NavigateDest): void;
  /** Menu navigation (`xn`). */
  navigateMenu(dest: NavigateDest): void;
  /** `silico://open?url=` share viewer (`ul`). */
  openShareViewer(url: string): void;

  // --- startup hooks (called by src/main/index.ts) -----------------------------
  /** whenReady steps 10-12: app menu (dev=false) + developer-menu wiring (settings + auth) + dock menu. */
  installMenus(): void;
  /** whenReady steps 17-20: watchdog, browser-window-focus, powerMonitor, did-become-active, memory shedding. */
  startBackgroundMonitors(): void;
}

// ===========================================================================
// Lab bridge (I5)  [bridge spec]
// ===========================================================================

export interface BridgeService {
  /** whenReady step 1: certificate verify proc on default, LAB, SIGNUP and every future session. */
  installCertificateVerifier(): void;
  /** whenReady step 5: permission request/check handlers on LAB and SIGNUP partitions. */
  installPermissionHandlers(): void;
  /** Sign-out-all / re-auth "expired": clear per-Lab counts and the dock badge. */
  clearBadgeCounts(): void;
}

// ===========================================================================
// Updater (I6)  [platform §5; decision D4]
// ===========================================================================

export interface UpdaterService {
  /** False unless ENV_UPDATE_URL is set (and packaged). */
  isEnabled(): boolean;
  /** Snapshot; `{phase:"idle", currentVersion}` while disabled. */
  getState(): UpdateState;
  /** update:install semantics; no-op while disabled. */
  install(): void;
  /** whenReady step 15 (`ud`): wire electron-updater, exit-marker check, timers. No-op while disabled. */
  start(): void;
  /** Background check (power resume). No-op while disabled. */
  checkInBackground(): void;
  /** Menu "Check for Updates…" (macOS). Shows an informational dialog while disabled. */
  userCheck(): void;
}

// ===========================================================================
// Context
// ===========================================================================

export interface MainContext {
  readonly env: AppEnv;
  readonly logger: LoggerFactory;
  readonly settings: SettingsService;
  readonly telemetry: TelemetryService;
  readonly auth: AuthService;
  readonly signup: SignupService;
  readonly deepLinks: DeepLinkService;
  readonly returns: ReturnsService;
  readonly connections: ConnectionsService;
  readonly ssh: SshService;
  readonly lab: LabLifecycleService;
  readonly windows: WindowService;
  readonly bridge: BridgeService;
  readonly updater: UpdaterService;
}

export type ServiceName = keyof MainContext;

export interface MainContextBuilder {
  /** The lazy context handed to every module. */
  readonly ctx: MainContext;
  /** Provide a service exactly once. */
  provide<K extends ServiceName>(name: K, value: MainContext[K]): void;
  /** Names not yet provided (bootstrap asserts this is empty before whenReady). */
  missing(): ServiceName[];
}

const SERVICE_NAMES: readonly ServiceName[] = [
  "env",
  "logger",
  "settings",
  "telemetry",
  "auth",
  "signup",
  "deepLinks",
  "returns",
  "connections",
  "ssh",
  "lab",
  "windows",
  "bridge",
  "updater",
];

/** Create the lazy service context (see file header). */
export function createMainContext(): MainContextBuilder {
  const store = new Map<ServiceName, unknown>();
  const ctx = {} as MainContext;
  for (const name of SERVICE_NAMES) {
    Object.defineProperty(ctx, name, {
      enumerable: true,
      get() {
        if (!store.has(name)) throw new Error(`service '${name}' accessed before it was created`);
        return store.get(name);
      },
    });
  }
  return {
    ctx,
    provide(name, value) {
      if (store.has(name)) throw new Error(`service '${name}' provided twice`);
      store.set(name, value);
    },
    missing() {
      return SERVICE_NAMES.filter((n) => !store.has(n));
    },
  };
}
