/**
 * Single source of truth for Rea Claude constants: app identity, gateway
 * endpoints, file names, timeouts and limits gathered from the behavioral
 * specs in docs/spec/*.md.
 *
 * FROZEN SHARED FILE (architect-owned). Implementers request changes; they do
 * not edit this file. Safe to import from main, preload and renderer (no Node
 * or Electron imports allowed here).
 *
 * Citation format: `[spec §section]`, where spec is one of auth, conn-ssh,
 * lab, windows, bridge, platform (= settings-updater-lifecycle), renderer,
 * design.
 */

import type { GatewayUrl, NotificationSettings, Settings } from "./ipc";

// ---------------------------------------------------------------------------
// App identity (decision D1 in docs/architecture.md)
// ---------------------------------------------------------------------------

/** Display name used for app chrome (about panel, dialogs, default window title). [D1] */
export const PRODUCT_NAME = "Rea Claude";
/** macOS bundle id / Windows AppUserModelId. [D1; platform §6.1 step 3] */
export const APP_ID = "dev.smilefactory.rea-claude";
/** `app.setName()` value and therefore the userData folder name. Never "Silico". [D1] */
export const USER_DATA_DIR_NAME = "rea-claude";
/** Default window title for shell/viewer windows (original: "Silico"). [D1; windows §3.3] */
export const WINDOW_TITLE = PRODUCT_NAME;
/** Settings sheet window title. [windows §3.3] */
export const SETTINGS_SHEET_TITLE = "Settings";
/** Build string shown in the about panel (original baked a date · sha). [platform §6.1 step 7] */
export const BUILD_STRING = "rea-claude dev build";

// ---------------------------------------------------------------------------
// Environment variables (decisions D3, D4)
// ---------------------------------------------------------------------------

/** When "1", register as the OS default handler for `silico://`. Off by default. [D3] */
export const ENV_REGISTER_PROTOCOL = "REA_CLAUDE_REGISTER_PROTOCOL";
/** Generic-provider update feed URL. Updater disabled when unset. [D4] */
export const ENV_UPDATE_URL = "REA_CLAUDE_UPDATE_URL";
/** Overrides userData and enables "test mode" (original: SILICO_E2E_USER_DATA). [platform §6.2] */
export const ENV_E2E_USER_DATA = "REA_CLAUDE_E2E_USER_DATA";
/** electron-vite dev server URL; its origin is a trusted shell IPC origin. [platform §6.2] */
export const ENV_RENDERER_URL = "ELECTRON_RENDERER_URL";

// ---------------------------------------------------------------------------
// Deep links (decision D2/D3)
// ---------------------------------------------------------------------------

/** URL scheme handled internally (always) and registered with the OS only under D3. [auth §4.6] */
export const PROTOCOL_SCHEME = "silico";
/** argv / open-url detection. [auth §4.6] */
export const DEEP_LINK_ARG_RE = /^silico:/i;

// ---------------------------------------------------------------------------
// Gateways and external URLs (decision D2) [auth §5, platform §6.3]
// ---------------------------------------------------------------------------

export const GATEWAY_PROD = "https://my.silico.run" as const;
export const GATEWAY_STAGING = "https://my-staging.silico.run" as const;
export const GATEWAYS: readonly GatewayUrl[] = [GATEWAY_PROD, GATEWAY_STAGING];
/** Legacy alias origins used as fallback transport for the same API. [auth §1, §5] */
export const GATEWAY_ALIASES: Readonly<Record<GatewayUrl, readonly string[]>> = {
  [GATEWAY_PROD]: ["https://silico.goodfire.com"],
  [GATEWAY_STAGING]: ["https://silico-staging.goodfire.com"],
};
/** Every origin that counts as "a gateway" for auth-wall / trust checks. [windows §6.3] */
export const ALL_GATEWAY_ORIGINS: readonly string[] = [
  GATEWAY_PROD,
  GATEWAY_STAGING,
  ...GATEWAY_ALIASES[GATEWAY_PROD],
  ...GATEWAY_ALIASES[GATEWAY_STAGING],
];
export const GITHUB_ORIGIN = "https://github.com";
export const DOCS_URL = "https://docs.silico.run"; // [windows §3.1, §5]
export const LEGAL_TOS_URL = "https://www.goodfire.com/legal/tos"; // [renderer §4.2]
export const LEGAL_PRIVACY_URL = "https://www.goodfire.com/legal/privacy"; // [renderer §4.2]
/** Google-account guidance links in EmptyLabDiscoveryMessage. [renderer §4.11] */
export const GOOGLE_LINK_HOST_PROD = "silico.goodfire.com";
export const GOOGLE_LINK_HOST_STAGING = "silico-staging.goodfire.com";

/** Gateway paths. [auth §5, lab §1] */
export const GatewayPath = {
  login: "/login",
  jwks: "/.well-known/jwks.json",
  activate: "/labs/activate",
  refresh: "/labs/refresh",
  logout: "/labs/logout",
  labs: "/labs",
  labSession: "/labs/session",
  labClaim: "/labs/claim",
  setupBearer: "/labs/setup-bearer",
  install: "/install",
  claimPage: "/claim",
  signup: "/beta-signup",
  signupConfirm: "/beta-signup/confirm",
  signupResume: "/beta-signup/resume",
  signupGithub: "/beta-signup/github",
  signupDesktopContinue: "/beta-signup/desktop-continue",
} as const;

/** Lab-side paths. [lab §1, auth §5] */
export const LabPath = {
  healthz: "/healthz",
  clusterVersion: "/api/cluster/version",
  dataplane: "/healthz/dataplane",
  authCallback: "/auth/callback",
  authConfig: "/api/auth/config",
} as const;

/** Proof claims expected on refreshed / signup proofs. [auth §4.2, §4.5] */
export const PROOF_PURPOSE = "labs";
export const PROOF_ISSUER = "silico-lab-auth";

// ---------------------------------------------------------------------------
// Cluster CLI / remote layout [lab §4, platform §6.3]
// ---------------------------------------------------------------------------

export const CLI_PROD = "silico";
export const CLI_STAGING = "silico-dev";
export const REMOTE_STATE_DIR_PROD = "state";
export const REMOTE_STATE_DIR_STAGING = "state/_dev";
export const DEPLOYMENT_DEV_SUFFIX = "-dev";
/** Local docker dev stack constants. [lab §4.9, renderer §6] */
export const LOCAL_DEPLOYMENT_ID = "goodfire-local";
export const DOCKER_PS_NAME_FILTER = "name=silico-local-";
export const DOCKER_PS_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Electron session partitions [windows §3.1, auth §3.5]
// ---------------------------------------------------------------------------

export const LAB_PARTITION = "persist:silico";
export const SIGNUP_PARTITION = "persist:silico-signup";

// ---------------------------------------------------------------------------
// Files under userData [platform §4.2]
// ---------------------------------------------------------------------------

export const FILE_SETTINGS = "settings.json";
export const FILE_CONNECTIONS = "connections.json";
export const FILE_LAST_OPENED = "last-opened.json";
export const FILE_IDENTITY = "identity.json";
export const DIR_PENDING_REVOCATIONS = "pending-revocations";
export const FILE_WINDOW_STATE = "window-state.json";
export const FILE_UPDATE_EXIT_MARKER = "update-exit-marker.json";
export const FILE_UPDATER_LOG = "updater.log";
export const UPDATER_LOG_ROTATE_BYTES = 1024 * 1024; // [platform §4.2]
export const SETTINGS_FILE_VERSION = 2; // [platform §4.1]
export const IDENTITY_FILE_MODE = 0o600; // [auth §3.2]
export const REVOCATION_DIR_MODE = 0o700; // [auth §3.3]
export const SSH_DIR_MODE = 0o700; // [conn-ssh §3]
export const SSH_CONFIG_MODE = 0o600; // [conn-ssh §4.5]
export const KNOWN_HOSTS_MODE = 0o644; // [conn-ssh §4.9]

// ---------------------------------------------------------------------------
// Settings defaults [platform §4.1, bridge §4.2]
// ---------------------------------------------------------------------------

export const DEFAULT_NOTIFICATIONS: Readonly<NotificationSettings> = Object.freeze({
  enabled: true,
  needsInput: true,
  experimentFinished: true,
  sound: true,
  notifyWhenActive: false,
  badge: true,
});

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  staging: false,
  verbose: false,
  previewBuilds: false,
  notifications: DEFAULT_NOTIFICATIONS,
  developerMode: false,
  skipVersionCheck: false,
});

// ---------------------------------------------------------------------------
// Auth timings and limits [auth §4]
// ---------------------------------------------------------------------------

export const SIGN_IN_TIMEOUT_MS = 180_000; // [auth §4.1 step 3]
export const LOGIN_ORIGIN_PROBE_TIMEOUT_MS = 2_500; // [auth §4.1 step 4]
export const GATEWAY_FETCH_TIMEOUT_MS = 10_000; // [auth §5 Transport]
export const LOGOUT_TIMEOUT_MS = 3_000; // [auth §4.4 step 5]
export const DESKTOP_CONTINUE_TIMEOUT_MS = 6_000; // [auth §4.6 step 1]
export const PROOF_REFRESH_WINDOW_MS = 5 * 60_000; // [auth §4.2 step 3]
export const REVOCATION_RETRY_MS = 30_000; // [auth §4.4]
/** expiresAt reported when a refresh token exists ("effectively never"). [auth §2] */
export const NEVER_EXPIRES_AT = 8.64e15;
export const SIGN_IN_RETRY_COOLDOWN_MS = 2_500; // [auth §4.1 step 10, renderer §4.2]
export const SIGNUP_GITHUB_OPEN_THROTTLE_MS = 2_500; // [auth §4.5 step 4]
export const SIGNUP_BAR_DEFAULT_PX = 78; // [auth §4.5 step 3, windows §3.1]
export const SIGNUP_ADOPT_REACH_BUDGET_MS = 3_000; // [auth §4.5 step 5]

/** Nonce-bound return flows. [auth §3.6, bridge §4.5-4.7] */
export const CHECKOUT_NONCE_TTL_MS = 30 * 60_000;
export const MCP_OAUTH_NONCE_TTL_MS = 15 * 60_000;
export const GITHUB_CONNECT_NONCE_TTL_MS = 15 * 60_000;
export const MCP_RETURN_QUEUE_MAX = 3;
export const MCP_RETURN_TTL_MS = 10 * 60_000;

/** Viewer session recovery. [auth §4.7, windows §4.11] */
export const RECOVERY_THROTTLE_MS = 45_000;
export const RECOVERY_LOAD_DEADLINE_MS = 30_000;
export const AUTH_CONFIG_TIMEOUT_MS = 8_000;
export const AUTH_CONFIG_MAX_BYTES = 16 * 1024;

// ---------------------------------------------------------------------------
// Lab lifecycle [lab §4, §5]
// ---------------------------------------------------------------------------

export const REACH_BUDGET_DEFAULT_MS = 3_000; // lab:open default [lab §2]
export const REACH_BUDGET_MIN_MS = 1_000;
export const REACH_BUDGET_MAX_MS = 120_000;
export const CONNECT_REACH_BUDGET_MS = 90_000; // [lab §4.1]
export const MANAGED_WAKE_TIMEOUT_MS = 90_000; // [lab §5.3]
export const LAB_POLL_INTERVAL_MS = 1_500; // [lab §5.3]
export const LAB_PROBE_TIMEOUT_MS = 5_000; // /api/cluster/version, /healthz [lab §5.3]
export const DATAPLANE_PROBE_TIMEOUT_MS = 3_000; // [lab §5.3]
export const LAB_STATUS_TIMEOUT_MS = 5_000; // lab:status [lab §2]
export const VERSION_POLL_ATTEMPTS = 4; // [lab §4.1 step 5]
export const VERSION_POLL_INTERVAL_MS = 1_500;
export const STDERR_TAIL_CHARS = 600; // [lab §4.1]
export const REAUTH_COOLDOWN_MS = 45_000; // [lab cross-area, windows §4.4]
export const REAUTH_AUTH_WALL_BUDGET_MS = 15_000;
export const REWAKE_BUDGET_MS = 30_000;
/** Renderer open budgets. [renderer §4.7, lab §4.10] */
export const OPEN_BUDGET_REACHABLE_MS = 3_000;
export const OPEN_BUDGET_UNKNOWN_MS = 90_000;
/** Remote PATH prefix applied to CLI commands. [lab §4] */
export const REMOTE_PATH_PREFIX = 'PATH="$PATH:$HOME/.local/bin"';

/** SSH tunnel. [lab §5.2, conn-ssh §5] */
export const TUNNEL_READY_TIMEOUT_MS = 8_000;
export const TUNNEL_READY_POLL_MS = 250;
export const TUNNEL_MAX_RETRIES = 6;
export const TUNNEL_RETRY_RESET_AFTER_MS = 60_000;
export const TUNNEL_BACKOFF_BASE_MS = 1_000;
export const TUNNEL_BACKOFF_MAX_MS = 8_000;
export const TUNNEL_SERVER_ALIVE_INTERVAL = 15;
export const TUNNEL_SERVER_ALIVE_COUNT_MAX = 3;

// ---------------------------------------------------------------------------
// SSH [conn-ssh §4, §5]
// ---------------------------------------------------------------------------

export const SSH_CONNECT_TIMEOUT_S = 10;
export const SHELL_ENV_TIMEOUT_MS = 5_000; // [conn-ssh §4.1]
export const SHELL_ENV_MARKER = "__SILICO_SHELL_ENV__";
export const SSH_KEY_TYPE_PREFERENCE: readonly string[] = ["ED25519", "ECDSA", "RSA"]; // [conn-ssh §4.8]

// ---------------------------------------------------------------------------
// Windows / Lab view [windows §3.1]
// ---------------------------------------------------------------------------

export const WIN_DEFAULT_W = 1280;
export const WIN_DEFAULT_H = 840;
export const WIN_MIN_H = 540;
export const WIN_MIN_W = Math.round((540 * 1280) / 840); // 823
export const COMPACT_W = 620;
export const COMPACT_DEFAULT_H = 680;
export const COMPACT_MAX_H = 880;
export const COMPACT_MIN_W = 520;
export const COMPACT_MIN_H = 500;
export const COMPACT_SCREEN_MARGIN = 40;
export const CASCADE_OFFSET = 28;
export const STRIP_HEIGHT = 32;
export const WIN_OVERLAY_COLOR = "#ffffff";
export const WIN_OVERLAY_SYMBOL = "#1d272a";
export const SETTINGS_OVERLAY_COLOR = "#1d272a";
export const SETTINGS_OVERLAY_OPACITY = 0.3;
export const SETTINGS_SHEET_MAX_W = 800;
export const SETTINGS_SHEET_MAX_H = 600;
export const LAB_MIN_LOADING_MS = 1_500;
export const LAB_MOUNT_WAIT_MS = 20_000;
export const VIEWER_REVEAL_FALLBACK_MS = 5_000;
export const CRASH_WINDOW_MS = 60_000;
export const CRASH_MAX = 3;
export const SHELL_SHOW_FALLBACK_MS = 500;
export const WINDOW_STATE_SAVE_DEBOUNCE_MS = 250;
export const RENDERER_WAIT_MS = 8_000;
export const ZOOM_STEP = 0.5; // [windows §5]
export const AUTH_WALL_SELECTOR = '[data-testid="auth-github-login"]'; // [windows §4.1]

/** Watchdog / power / memory. [windows §4.9, platform §6.1] */
export const WATCHDOG_TICK_MS = 15_000;
export const WATCHDOG_MAX_IDLE_S = 120;
export const WATCHDOG_PAGE_MIN_AGE_MS = 15_000;
export const WATCHDOG_STRIKES = 2;
export const WATCHDOG_PAGE_STRIKE_GAP_MS = 10_000;
export const WATCHDOG_MAX_PAGE_REWAKES = 2;
export const LONG_SUSPEND_MS = 60_000;
export const RESUME_ACTION_DELAY_MS = 2_000;
/** GPU process gone (non clean-exit) → invalidate shown views after 1 s. [windows §GPU process gone L7071-7076; platform §6.1 step 10] */
export const GPU_GONE_INVALIDATE_DELAY_MS = 1_000;
export const MEMORY_POLL_MS = 30_000;
export const MEMORY_SHED_THRESHOLD_PCT = 15;
export const DOCK_BOUNCE_DELAY_MS = 350;

// ---------------------------------------------------------------------------
// Lab bridge: notifications, badge, telemetry [bridge §4]
// ---------------------------------------------------------------------------

export const NOTIFY_TEXT_MAX = 200;
export const NOTIFY_DEDUPE_MS = 5 * 60_000;
export const NOTIFY_BATCH_DEBOUNCE_MS = 700;
export const NOTIFY_QUICK_FINISH_S = 30;
export const NOTIFY_HOLD_MS = 60_000;
export const BADGE_COUNT_MAX = 9_999;
export const SHELL_EVENT_CAP = 100;
export const TRANSPORT_FAILURE_DEDUPE_MS = 5 * 60_000;
export const FOREGROUND_CAUSE_WINDOW_MS = 1_500;
export const FOREGROUND_RECENT_WINDOW_MS = 5_000;
export const ERROR_DETAILS_MAX = 300;
export const ERROR_STACK_MAX = 2_000;

/** TLS: SPKI SHA-256 hashes rejected (-206) in every session. [auth §6, bridge §5] */
export const BLOCKED_SPKI_SHA256: readonly string[] = [
  "ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105",
  "43bffa19d6ef651451f6841e019931e96f6f2eaeff28ab4b6f1ce4576de2717b",
  "e0254c7fcdc265e2f0f8a428dabb75ab4ae039b4872d62f5ee57f0877d5a8a41",
  "ec4ffa1ad0ac88081314b7aaffef6a91f97cd57291bb5ba686c5415f5eb4f6b6",
  "49dd353dc2b919a3770645117d0e60c16115e7d1bc259eefe734b00ea434fe5f",
  "63ecefee431d49523bc1136c4e72d0206a477086caf606cd5cf025686c109cf8",
  "5c0660a2b164910d8ff589c18e14552e9e0ec237dcefe2cb736d41a4811f81a0",
  "92c063d67e8f14db71d288e11266ffdaf69cbf115f7bab14f3bc2f68d25e0e30",
];
export const CERT_VERIFY_REJECT = -206;
export const CERT_VERIFY_USE_CHROMIUM = -3;

/** Permission allowlist (non-media). [bridge §5] */
export const ALLOWED_PERMISSIONS: readonly string[] = ["clipboard-sanitized-write", "fullscreen"];

// ---------------------------------------------------------------------------
// Launch guard [platform §6.1 step 1, auth §6]
// ---------------------------------------------------------------------------

export const FORBIDDEN_SWITCHES: readonly string[] = [
  "remote-debugging-port",
  "remote-debugging-pipe",
  "ignore-certificate-errors",
  "ignore-certificate-errors-spki-list",
  "log-net-log",
  "ssl-key-log-file",
];
export const FORBIDDEN_SWITCH_EXIT_CODE = 78;
export const RELAUNCHED_ONTO_DISK_FLAG = "--relaunched-onto-disk-bundle";

// ---------------------------------------------------------------------------
// Updater [platform §5] (only active under D4)
// ---------------------------------------------------------------------------

export const UPDATE_FIRST_CHECK_DELAY_MS = 3_000;
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000;
export const UPDATE_STAGING_PATIENCE_MS = 10 * 60_000;
export const UPDATE_INSTALL_GRACE_MS = 30_000;
export const UPDATE_GRACE_POLL_MS = 1_000;
export const UPDATE_FORCED_EXIT_DELAY_MS = 5_000;
export const UPDATE_NATIVE_EXIT_DELAY_MS = 3_000;
export const UPDATE_NATIVE_WAIT_TIMEOUT_MS = 60_000;
export const UPDATE_LATEST_YML_TIMEOUT_MS = 10_000;
export const PLUTIL_TIMEOUT_MS = 5_000;
export const SHIPIT_LOG_TAIL_LINES = 25;
export const UPDATER_CACHE_DIR_NAME = "rea-claude-updater";

// ---------------------------------------------------------------------------
// Renderer timers [renderer §7]
// ---------------------------------------------------------------------------

export const DISCOVERY_POLL_MS = 20_000;
export const REACH_POLL_MS = 20_000;
export const LOCAL_STACK_POLL_MS = 3_000;
export const ELAPSED_TICK_MS = 1_000;
export const LAUNCH_GATE_MAX_MS = 6_000;
export const JUST_ADDED_CLEAR_MS = 1_500;
