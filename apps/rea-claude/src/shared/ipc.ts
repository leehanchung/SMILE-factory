/**
 * IPC contract for Rea Claude: every channel name and every payload type that
 * crosses a process boundary, plus the exact shapes of `window.silico`
 * (shell preload) and `window.silicoDesktop` (Lab preload).
 *
 * FROZEN SHARED FILE (architect-owned). Implementers request changes; they do
 * not edit this file. Pure types + string constants only (safe for main,
 * sandboxed preload, and renderer). Channel names are identical to Silico
 * v0.137.0 (decision D2).
 *
 * Note on trust: argument types describe the contract. Values still arrive
 * over IPC unvalidated, so main handlers validate wherever the specs say the
 * original validates (and where docs/architecture.md lists a deviation).
 */

// ===========================================================================
// Channel names
// ===========================================================================

/** Renderer (window.silico) -> main, `ipcRenderer.invoke`. Shell-trusted senders only. */
export const ShellInvokeChannel = {
  ping: "ping",
  appIsDevBuild: "app:isDevBuild",
  windowIsInitial: "window:is-initial",
  windowSetCompact: "window:set-compact",
  /** D5: shell-trusted (original registered it raw). */
  windowOpenSettingsSheet: "window:open-settings-sheet",
  localDetectStacks: "local:detectStacks",
  dialogPickFile: "dialog:pickFile",
  dialogConfirm: "dialog:confirm",
  authStatus: "auth:status",
  authPersistence: "auth:persistence",
  authSignIn: "auth:signIn",
  authSignOutAll: "auth:signOutAll",
  signupOpen: "signup:open",
  signupClose: "signup:close",
  signupStatus: "signup:status",
  labsList: "labs:list",
  /** D5: shell-trusted (original registered it raw). */
  labsHeldElsewhere: "labs:held-elsewhere",
  /** D5: shell-trusted (original registered it raw). */
  labsFocusHeld: "labs:focus-held",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  lastOpenedGet: "lastOpened:get",
  lastOpenedSet: "lastOpened:set",
  sshListHosts: "ssh:listHosts",
  sshAddHost: "ssh:addHost",
  connectionsList: "connections:list",
  connectionsUpsert: "connections:upsert",
  connectionsRemove: "connections:remove",
  labStatus: "lab:status",
  labTest: "lab:test",
  labHostKeyScan: "lab:hostKey:scan",
  labHostKeyAccept: "lab:hostKey:accept",
  labOpen: "lab:open",
  labConnect: "lab:connect",
  labUpdate: "lab:update",
  labCancel: "lab:cancel",
  labDown: "lab:down",
  updateGetState: "update:get-state",
  updateInstall: "update:install",
  labHide: "lab:hide",
  labGoBack: "lab:goBack",
  labGoForward: "lab:goForward",
  viewerRetry: "viewer:retry",
} as const;
export type ShellInvokeChannel = (typeof ShellInvokeChannel)[keyof typeof ShellInvokeChannel];

/** Main -> shell renderer (`webContents.send`). */
export const ShellEventChannel = {
  appNavigate: "app:navigate",
  authExpired: "auth:expired",
  authChanged: "auth:changed",
  signupOpened: "signup:opened",
  signupClosed: "signup:closed",
  settingsChanged: "settings:changed",
  connectionsChanged: "connections:changed",
  labOutput: "lab:output",
  labPhase: "lab:phase",
  updateState: "update:state",
  labNavState: "lab:navstate",
  labOpened: "lab:opened",
  labState: "lab:state",
  labViewVis: "lab:viewvis",
  viewerRecovery: "viewer:recovery",
  viewerTitle: "viewer:title",
  viewerContentReady: "viewer:content-ready",
} as const;
export type ShellEventChannel = (typeof ShellEventChannel)[keyof typeof ShellEventChannel];

/** Lab page (window.silicoDesktop) -> main, `ipcRenderer.invoke`. Lab-trusted senders only. */
export const LabInvokeChannel = {
  /** Gate is the recovery registry; D5 also applies the lab-partition check. */
  recoverSession: "silico:recover-session",
  beginCheckout: "silico:begin-checkout",
  beginMcpOauth: "silico:begin-mcp-oauth",
  takeMcpOauthReturn: "silico:take-mcp-oauth-return",
  beginGithubConnect: "silico:begin-github-connect",
  takeGithubConnectReturn: "silico:take-github-connect-return",
  shellEventsDrain: "silico:shell-events:drain",
} as const;
export type LabInvokeChannel = (typeof LabInvokeChannel)[keyof typeof LabInvokeChannel];

/** Lab page -> main, fire-and-forget `ipcRenderer.send`. Untrusted senders are silently dropped. */
export const LabSendChannel = {
  notify: "silico:notify",
  badgeCounts: "silico:badge-counts",
  openDesktopSettings: "silico:open-desktop-settings",
  openLabSwitcher: "silico:open-lab-switcher",
} as const;
export type LabSendChannel = (typeof LabSendChannel)[keyof typeof LabSendChannel];

/** Main -> Lab page (`webContents.send` to a Lab view). */
export const LabEventChannel = {
  navigate: "silico:navigate",
  checkoutReturn: "silico:checkout-return",
  mcpOauthReturn: "silico:mcp-oauth-return",
  githubConnectReturn: "silico:github-connect-return",
  reportIssue: "silico:report-issue",
  foreground: "silico:foreground",
  shellEventNudge: "silico:shell-event-nudge",
} as const;
export type LabEventChannel = (typeof LabEventChannel)[keyof typeof LabEventChannel];

// ===========================================================================
// Common
// ===========================================================================

/** Disposer returned by every `on*` subscription. Removes exactly the listener it added. */
export type Unsubscribe = () => void;

// ===========================================================================
// Auth [auth §2, §3]
// ===========================================================================

export type GatewayUrl = "https://my.silico.run" | "https://my-staging.silico.run";

export type AuthState =
  | { status: "signed-out" }
  | {
      status: "signed-in";
      /** GitHub-style login from proof claim `login`. */
      login: string;
      /** Subject; may be prefixed, e.g. "google:...". */
      sub: string;
      gatewayUrl: GatewayUrl;
      /** ms epoch; NEVER_EXPIRES_AT when a refresh token exists, else proof exp*1000. */
      expiresAt: number;
      developer: boolean;
    };

export type SignedInAuthState = Extract<AuthState, { status: "signed-in" }>;

export type PersistenceMode = "keychain" | "none-no-keyring" | "none-test-mode" | "plaintext-dev";

// ===========================================================================
// Settings [platform §4.1]
// ===========================================================================

export interface NotificationSettings {
  enabled: boolean;
  needsInput: boolean;
  experimentFinished: boolean;
  sound: boolean;
  notifyWhenActive: boolean;
  badge: boolean;
}

export interface Settings {
  staging: boolean;
  verbose: boolean;
  previewBuilds: boolean;
  notifications: NotificationSettings;
  developerMode: boolean;
  skipVersionCheck: boolean;
}

/** Shallow patch; not validated on write (a partial `notifications` replaces the whole object). */
export type SettingsPatch = Partial<Settings> & Record<string, unknown>;

// ===========================================================================
// Connections + SSH [conn-ssh §2, §3]
// ===========================================================================

/** Anything other than "managed"/"local" (including missing) is treated as "cluster". */
export type RouteMode = "managed" | "cluster" | "local";

export interface SshTarget {
  /** ssh alias or hostname; empty => "No SSH host". */
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  /** ProxyJump spec; read by main, never set by the renderer. */
  jump?: string;
}

/**
 * Stored connection record. Main stores it WITHOUT validation, so main code
 * must treat every field (even the non-optional ones) defensively when it
 * comes from disk or IPC.
 */
export interface Connection {
  /** randomUUID() if absent on upsert; managed rows `managed:<login>:<deploymentId>:<gatewayUrl>`; local rows `local:<project>` (never persisted). */
  id: string;
  name: string;
  /** Key of the renderer's connection icon map; default "flask". */
  icon: string;
  /** "" if unknown; local => "goodfire-local". */
  deploymentId: string;
  /** "https://<labPublicHost>" or ""; local => "http://localhost:<port>". */
  labUrl: string;
  routeMode?: RouteMode;
  ssh?: SshTarget;
  owner?: string;
  gatewayUrl?: string;
  dismissed?: boolean;
}

/** Upsert input: a connection with an optional id (main assigns one). Replaces wholesale. */
export type ConnectionUpsert = Omit<Connection, "id"> & { id?: string };

export interface SshHostEntry {
  alias: string;
  hostName?: string;
  user?: string;
  identityFile?: string;
  port?: number;
}

export interface AddHostInput {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number | string;
  identityFile?: string;
}

export type HostKeyKind = "changed" | "unknown";

export type TestResult =
  | { ok: true; detail: string }
  | { ok: false; detail: string; hostKey?: HostKeyKind };

export type HostKeyScanResult =
  | { ok: true; host: string; keyType: string; fingerprint: string }
  | { ok: false; error: string };

export type HostKeyAcceptResult = { ok: true } | { ok: false; error: string };

// ===========================================================================
// Lab lifecycle [lab §2]
// ===========================================================================

/** Phases emitted by main on `lab:phase`. */
export type LabPhase =
  | "checking"
  | "ssh"
  | "setup"
  | "starting"
  | "updating"
  | "opening"
  | "claiming"
  | "tunneling"
  | "waiting"
  | "waking";

export const LAB_PHASES: readonly LabPhase[] = [
  "checking",
  "ssh",
  "setup",
  "starting",
  "updating",
  "opening",
  "claiming",
  "tunneling",
  "waiting",
  "waking",
];

/** Result of lab:connect / lab:update. */
export type ConnectOutcome =
  | { status: "opened"; labUrl?: string }
  | { status: "canceled" }
  | { status: "forbidden"; login?: string }
  | { status: "still-waking" }
  | { status: "error"; message: string }
  | { status: "host-key"; host: string; kind: HostKeyKind }
  | { status: "needs-setup" };

/** Raw result of the shared open flow (lab:open returns this). */
export type OpenResult =
  | { status: "opened" }
  | { status: "canceled" }
  | { status: "forbidden"; login?: string }
  | { status: "unreachable"; url: string }
  | { status: "still-waking" }
  | { status: "other" };

export interface LabOpenOptions {
  /** Clamped to [1000, 120000]; default 3000. */
  reachTimeoutMs?: number;
}
export interface LabConnectOptions {
  tunnel?: boolean;
}
export interface LabUpdateOptions {
  preview?: boolean;
}

export type LabReach = "up" | "down" | "unknown";

export interface LocalStack {
  project: string;
  port: number;
  worktree?: string;
  branch?: string;
}

export interface DiscoveredLab {
  deploymentId: string;
  labPublicHost: string;
  routeMode: RouteMode;
  host?: string;
  port?: number;
  stale: boolean;
  currentSha?: string;
  targetSha?: string;
  minSha?: string;
  updateAvailable: boolean;
  updateRequired: boolean;
  reportsVersion?: boolean;
}

export type LabsListResult =
  | { ok: true; labs: DiscoveredLab[]; gatewayUrl: string; login: string }
  | { ok: false; error: string; needsAuth?: true };

export interface LabOutputEvent {
  id: string;
  /** Raw chunk; app-generated progress lines end in "\n". */
  chunk: string;
}
export interface LabPhaseEvent {
  id: string;
  phase: LabPhase;
}

// ===========================================================================
// Updater [platform §5.2]
// ===========================================================================

export type UpdatePhase =
  | "idle"
  | "checking"
  | "not-available"
  | "available"
  | "downloading"
  | "staging"
  | "downloaded"
  | "error";

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  newVersion?: string;
  percent?: number;
  message?: string;
  blocked?: "needs-move" | "needs-admin";
}

// ===========================================================================
// Windows / Lab view / viewer [windows §2, §3]
// ===========================================================================

export type SettingsTab = "notifications" | "developer" | "profile";

/** `app:navigate` payload. Unknown strings are treated as "labs". */
export type NavigateDest =
  | "connections"
  | "settings:notifications"
  | "settings:developer"
  | "settings:profile"
  | (string & {});

export interface LabOpenedEvent {
  id: string;
  title: string;
}

export type LabViewState = "loading" | "ready" | "down";
export type LabDownReason = "error" | "still-waking";

export interface LabStateEvent {
  id: string;
  state: LabViewState;
  reason?: LabDownReason;
}

export interface ViewVis {
  shown: boolean;
  /** Present only when shown. */
  title?: string;
}

export interface NavState {
  canGoBack: boolean;
  canGoForward: boolean;
}

export type RecoveryState =
  | { kind: "idle" }
  | { kind: "loading"; message: string }
  | { kind: "signin"; staging: boolean; message: string }
  | { kind: "choose"; message: string; deployments: string[] }
  | { kind: "error"; message: string };

export interface ConfirmOptions {
  message: string;
  detail?: string;
  /** Default "OK". Buttons are ["Cancel", confirmLabel]. */
  confirmLabel?: string;
}

// ===========================================================================
// Lab bridge [bridge §2]
// ===========================================================================

export type RecoverSessionResult =
  | { status: "accepted" }
  | { status: "unsupported" }
  | { status: "error"; message: string };

export type NotifyKind = "needsInput" | "finished";
export type RunStatus = "completed" | "failed" | "stopped";

export interface NotifyPayload {
  kind: NotifyKind;
  title: string;
  body?: string;
  route: string;
  dedupeKey: string;
  status?: RunStatus;
  elapsedSeconds?: number;
  routeMatchesActiveView?: boolean;
}

export interface BadgeCounts {
  attention: number;
  unread: number;
}

export type CheckoutOutcome = "success" | "cancel" | "manage";

export type McpOauthReturn =
  | { outcome: "code"; code: string; state: string }
  | { outcome: "error"; error: string };

export type GithubConnectReturn = { outcome: "success" } | { outcome: "error"; error: string };

export type FocusedWindowKind = "none" | "settings-sheet" | "signup" | "lab" | "app-shell" | "aux";

export interface ForegroundEvent {
  event: "app_foreground";
  cause: string;
  details?: unknown;
  stack?: string;
  msSinceResign: number | null;
  systemIdleSeconds: number;
  focusedWindow: FocusedWindowKind;
  connId: string | null;
  recent?: Record<string, number>;
  build: string;
  appVersion: string;
  /** NodeJS.Platform value; typed as string so the renderer needs no Node types. */
  platform: string;
  ts: string;
  login?: string;
  sub?: string;
}

export type ShellEventKind =
  | "connect-outcome"
  | "down-panel"
  | "gateway-transport-failure"
  | "reauth-outcome"
  | "session-death"
  | "viewer-stranded";

/** A `desktop_shell` telemetry record (queued for the Lab to drain). */
export interface DesktopShellEvent {
  event: "desktop_shell";
  kind: ShellEventKind;
  connId?: string;
  details?: Record<string, unknown>;
  build: string;
  appVersion: string;
  platform: string;
  login?: string;
  sub?: string;
  ts: string;
}

// ===========================================================================
// Typed channel maps (used by src/main/ipc/trust.ts and the preloads)
// ===========================================================================

/** Shell invoke channels: argument tuple and resolved return type. */
export interface ShellInvokeMap {
  [ShellInvokeChannel.ping]: { args: []; ret: "pong" };
  [ShellInvokeChannel.appIsDevBuild]: { args: []; ret: boolean };
  [ShellInvokeChannel.windowIsInitial]: { args: []; ret: boolean };
  [ShellInvokeChannel.windowSetCompact]: { args: [compact: boolean, contentHeight?: number]; ret: void };
  [ShellInvokeChannel.windowOpenSettingsSheet]: { args: []; ret: void };
  [ShellInvokeChannel.localDetectStacks]: { args: []; ret: LocalStack[] };
  [ShellInvokeChannel.dialogPickFile]: { args: []; ret: string | null };
  [ShellInvokeChannel.dialogConfirm]: { args: [opts: ConfirmOptions]; ret: boolean };
  [ShellInvokeChannel.authStatus]: { args: []; ret: AuthState };
  [ShellInvokeChannel.authPersistence]: { args: []; ret: PersistenceMode };
  /** Main treats only `restart === true` as restart. */
  [ShellInvokeChannel.authSignIn]: { args: [staging: boolean, restart?: boolean]; ret: AuthState };
  [ShellInvokeChannel.authSignOutAll]: { args: []; ret: void };
  [ShellInvokeChannel.signupOpen]: { args: []; ret: void };
  [ShellInvokeChannel.signupClose]: { args: []; ret: void };
  [ShellInvokeChannel.signupStatus]: { args: []; ret: boolean };
  [ShellInvokeChannel.labsList]: { args: []; ret: LabsListResult };
  [ShellInvokeChannel.labsHeldElsewhere]: { args: []; ret: string[] };
  [ShellInvokeChannel.labsFocusHeld]: { args: [connId: string]; ret: boolean };
  [ShellInvokeChannel.settingsGet]: { args: []; ret: Settings };
  [ShellInvokeChannel.settingsSet]: { args: [patch: SettingsPatch]; ret: Settings };
  [ShellInvokeChannel.lastOpenedGet]: { args: [account: string]; ret: string | null };
  [ShellInvokeChannel.lastOpenedSet]: { args: [account: string, connId: string]; ret: void };
  [ShellInvokeChannel.sshListHosts]: { args: []; ret: SshHostEntry[] };
  [ShellInvokeChannel.sshAddHost]: { args: [input: AddHostInput]; ret: void };
  [ShellInvokeChannel.connectionsList]: { args: []; ret: Connection[] };
  [ShellInvokeChannel.connectionsUpsert]: { args: [conn: ConnectionUpsert]; ret: Connection };
  [ShellInvokeChannel.connectionsRemove]: { args: [id: string]; ret: void };
  [ShellInvokeChannel.labStatus]: { args: [url: string]; ret: LabReach };
  [ShellInvokeChannel.labTest]: { args: [target: SshTarget]; ret: TestResult };
  [ShellInvokeChannel.labHostKeyScan]: { args: [target: SshTarget]; ret: HostKeyScanResult };
  /**
   * D5 deviation: the renderer passes the fingerprint the user approved (from
   * a prior scan). Main appends only keys whose fingerprint matches it.
   */
  [ShellInvokeChannel.labHostKeyAccept]: {
    args: [target: SshTarget, expectedFingerprint: string];
    ret: HostKeyAcceptResult;
  };
  [ShellInvokeChannel.labOpen]: { args: [conn: Connection, opts?: LabOpenOptions]; ret: OpenResult };
  [ShellInvokeChannel.labConnect]: {
    args: [conn: Connection, verbose?: boolean, opts?: LabConnectOptions];
    ret: ConnectOutcome;
  };
  [ShellInvokeChannel.labUpdate]: { args: [conn: Connection, opts?: LabUpdateOptions]; ret: ConnectOutcome };
  [ShellInvokeChannel.labCancel]: { args: [connId: string]; ret: void };
  [ShellInvokeChannel.labDown]: { args: [conn: Connection]; ret: void };
  [ShellInvokeChannel.updateGetState]: { args: []; ret: UpdateState };
  [ShellInvokeChannel.updateInstall]: { args: []; ret: void };
  [ShellInvokeChannel.labHide]: { args: []; ret: void };
  [ShellInvokeChannel.labGoBack]: { args: []; ret: void };
  [ShellInvokeChannel.labGoForward]: { args: []; ret: void };
  [ShellInvokeChannel.viewerRetry]: { args: [deployment?: string]; ret: void };
}

/** Main -> shell renderer event payloads (`undefined` = no payload). */
export interface ShellEventMap {
  [ShellEventChannel.appNavigate]: NavigateDest;
  [ShellEventChannel.authExpired]: undefined;
  [ShellEventChannel.authChanged]: AuthState;
  [ShellEventChannel.signupOpened]: undefined;
  [ShellEventChannel.signupClosed]: undefined;
  [ShellEventChannel.settingsChanged]: Settings;
  [ShellEventChannel.connectionsChanged]: undefined;
  [ShellEventChannel.labOutput]: LabOutputEvent;
  [ShellEventChannel.labPhase]: LabPhaseEvent;
  [ShellEventChannel.updateState]: UpdateState;
  [ShellEventChannel.labNavState]: NavState;
  [ShellEventChannel.labOpened]: LabOpenedEvent;
  [ShellEventChannel.labState]: LabStateEvent;
  [ShellEventChannel.labViewVis]: ViewVis;
  [ShellEventChannel.viewerRecovery]: RecoveryState;
  [ShellEventChannel.viewerTitle]: string;
  /** Main sends `undefined` (= ready) or `false`; the preload maps `payload !== false` to boolean. */
  [ShellEventChannel.viewerContentReady]: false | undefined;
}

/** Lab invoke channels. */
export interface LabInvokeMap {
  [LabInvokeChannel.recoverSession]: { args: []; ret: RecoverSessionResult };
  [LabInvokeChannel.beginCheckout]: { args: []; ret: string };
  [LabInvokeChannel.beginMcpOauth]: { args: []; ret: string };
  [LabInvokeChannel.takeMcpOauthReturn]: { args: []; ret: McpOauthReturn | null };
  [LabInvokeChannel.beginGithubConnect]: { args: []; ret: string };
  [LabInvokeChannel.takeGithubConnectReturn]: { args: []; ret: GithubConnectReturn | null };
  [LabInvokeChannel.shellEventsDrain]: { args: []; ret: DesktopShellEvent[] };
}

/** Lab send channels (payloads are untrusted `unknown` in main; validate). */
export interface LabSendMap {
  [LabSendChannel.notify]: NotifyPayload;
  [LabSendChannel.badgeCounts]: BadgeCounts;
  [LabSendChannel.openDesktopSettings]: undefined;
  [LabSendChannel.openLabSwitcher]: undefined;
}

/** Main -> Lab page event payloads. */
export interface LabEventMap {
  [LabEventChannel.navigate]: string;
  [LabEventChannel.checkoutReturn]: CheckoutOutcome;
  [LabEventChannel.mcpOauthReturn]: undefined;
  [LabEventChannel.githubConnectReturn]: undefined;
  [LabEventChannel.reportIssue]: undefined;
  [LabEventChannel.foreground]: ForegroundEvent;
  [LabEventChannel.shellEventNudge]: undefined;
}

export type InvokeArgs<M, C extends keyof M> = M[C] extends { args: infer A extends unknown[] } ? A : never;
export type InvokeRet<M, C extends keyof M> = M[C] extends { ret: infer R } ? R : never;

// ===========================================================================
// window.silico  (src/preload/index.ts)  [renderer §5, platform §3]
// ===========================================================================

export interface SilicoApi {
  ping(): Promise<"pong">;
  /** `process.platform` of the main process ("darwin" | "win32" | "linux" | ...). */
  platform: string;
  isDevBuild(): Promise<boolean>;
  isInitialWindow(): Promise<boolean>;
  setCompact(compact: boolean, contentHeight?: number): Promise<void>;
  openSettingsSheet(): Promise<void>;
  detectLocalStacks(): Promise<LocalStack[]>;
  pickSshKey(): Promise<string | null>;
  confirm(opts: ConfirmOptions): Promise<boolean>;
  onNavigate(cb: (dest: NavigateDest) => void): Unsubscribe;
  auth: {
    status(): Promise<AuthState>;
    persistence(): Promise<PersistenceMode>;
    /** `restart` defaults to false. */
    signIn(staging: boolean, restart?: boolean): Promise<AuthState>;
    signOutEverywhere(): Promise<void>;
    onExpired(cb: () => void): Unsubscribe;
    onChanged(cb: (state: AuthState) => void): Unsubscribe;
  };
  signup: {
    open(): Promise<void>;
    close(): Promise<void>;
    status(): Promise<boolean>;
    onOpened(cb: () => void): Unsubscribe;
    onClosed(cb: () => void): Unsubscribe;
  };
  labs: {
    list(): Promise<LabsListResult>;
    heldElsewhere(): Promise<string[]>;
    focusHeld(connId: string): Promise<boolean>;
  };
  settings: {
    get(): Promise<Settings>;
    set(patch: SettingsPatch): Promise<Settings>;
    onChanged(cb: (settings: Settings) => void): Unsubscribe;
  };
  lastOpened: {
    get(account: string): Promise<string | null>;
    set(account: string, connId: string): Promise<void>;
  };
  ssh: {
    listHosts(): Promise<SshHostEntry[]>;
    addHost(input: AddHostInput): Promise<void>;
  };
  connections: {
    list(): Promise<Connection[]>;
    upsert(conn: ConnectionUpsert): Promise<Connection>;
    remove(id: string): Promise<void>;
    onChanged(cb: () => void): Unsubscribe;
  };
  lab: {
    status(url: string): Promise<LabReach>;
    test(target: SshTarget): Promise<TestResult>;
    hostKey: {
      scan(target: SshTarget): Promise<HostKeyScanResult>;
      /** D5: pass the fingerprint from the scan the user approved. */
      accept(target: SshTarget, expectedFingerprint: string): Promise<HostKeyAcceptResult>;
    };
    open(conn: Connection, opts?: LabOpenOptions): Promise<OpenResult>;
    /** `verbose` defaults to false. */
    connect(conn: Connection, verbose?: boolean, opts?: LabConnectOptions): Promise<ConnectOutcome>;
    update(conn: Connection, opts?: LabUpdateOptions): Promise<ConnectOutcome>;
    cancel(connId: string): Promise<void>;
    down(conn: Connection): Promise<void>;
    onOutput(cb: (e: LabOutputEvent) => void): Unsubscribe;
    onPhase(cb: (e: LabPhaseEvent) => void): Unsubscribe;
  };
  update: {
    getState(): Promise<UpdateState>;
    install(): Promise<void>;
    onState(cb: (state: UpdateState) => void): Unsubscribe;
  };
  labView: {
    hide(): Promise<void>;
    goBack(): Promise<void>;
    goForward(): Promise<void>;
    onNavState(cb: (nav: NavState) => void): Unsubscribe;
    onOpened(cb: (e: LabOpenedEvent) => void): Unsubscribe;
    onState(cb: (e: LabStateEvent) => void): Unsubscribe;
    onViewVis(cb: (vis: ViewVis) => void): Unsubscribe;
  };
  viewer: {
    retry(deployment?: string): Promise<void>;
    onRecovery(cb: (state: RecoveryState) => void): Unsubscribe;
    onTitle(cb: (title: string) => void): Unsubscribe;
    onContentReady(cb: (ready: boolean) => void): Unsubscribe;
  };
}

// ===========================================================================
// window.silicoDesktop  (src/preload/lab.ts)  [bridge §2]
// ===========================================================================

export interface SilicoDesktopApi {
  recoverSession(): Promise<RecoverSessionResult>;
  notify(payload: NotifyPayload): void;
  setBadgeCounts(counts: BadgeCounts): void;
  onNavigate(cb: (route: string) => void): Unsubscribe;
  beginCheckout(): Promise<string>;
  onCheckoutReturn(cb: (outcome: CheckoutOutcome) => void): Unsubscribe;
  beginMcpOauth(): Promise<string>;
  /** Pull-on-signal: the preload calls take and invokes cb only for a non-null result. */
  onMcpOauthReturn(cb: (r: McpOauthReturn) => void): Unsubscribe;
  takeMcpOauthReturn(): Promise<McpOauthReturn | null>;
  beginGithubConnect(): Promise<string>;
  onGithubConnectReturn(cb: (r: GithubConnectReturn) => void): Unsubscribe;
  takeGithubConnectReturn(): Promise<GithubConnectReturn | null>;
  readonly manageReturn: true;
  onReportIssue(cb: () => void): Unsubscribe;
  onForeground(cb: (e: ForegroundEvent) => void): Unsubscribe;
  onShellEventNudge(cb: () => void): Unsubscribe;
  drainShellEvents(): Promise<DesktopShellEvent[]>;
  openDesktopSettings(): void;
  openLabSwitcher(): void;
}
