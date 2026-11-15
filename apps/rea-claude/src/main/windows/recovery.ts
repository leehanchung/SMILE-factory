/**
 * Session recovery for Lab views and viewer windows.
 *
 *  - `RecoveryRegistry`: the `silico:recover-session` registry (bridge
 *    §4.13): per-webContents eligibility tracking + recover hook.
 *  - `runRecovery`: one recovery attempt for a viewer (auth §4.7, windows
 *    §4.11): route context → sign-in check → deployment choice → lab
 *    session → wait for reach → callback URL.
 *  - `createRecoveryController`: the viewer recovery state machine.
 */
import {
  AUTH_CONFIG_MAX_BYTES,
  AUTH_CONFIG_TIMEOUT_MS,
  GATEWAY_STAGING,
  LabPath,
  MANAGED_WAKE_TIMEOUT_MS,
  RECOVERY_LOAD_DEADLINE_MS,
  RECOVERY_THROTTLE_MS,
} from "@shared/config";
import type { AuthState, GatewayUrl, LabsListResult, RecoverSessionResult, RecoveryState } from "@shared/ipc";
import type { Identity, LabSessionResult, LabWaitOutcome } from "../services";
import {
  gatewayOf,
  isAllowedLabRoute,
  isAuthWall,
  isLabishUrl,
  parseRecoveryTarget,
  recoveryRoute,
} from "./navPolicy";
import type { RecoveryContext, RecoveryTarget } from "./navPolicy";

// ---------------------------------------------------------------------------
// Messages (windows §4.11 / auth §4.7)
// ---------------------------------------------------------------------------

export const RecoveryText = {
  restoring: "Restoring this page…",
  signIn: "Sign in to restore this page in Silico.",
  choose: "Choose the Lab that contains this shared page.",
  throttled: "The renewed session was rejected. Try again, or reopen the link after checking your account.",
  canceled: "Recovery was canceled. Please try again.",
  loadDeadline: "This page did not finish opening. Please try again.",
  generic: "Could not restore this page. Please try again.",
  accountChanged: "The signed-in account changed. Reopen this link with the intended account.",
  wrongAccount: "This page belongs to a different account or environment. Reopen the link with the intended account.",
  labGone: "That Lab is no longer available to this account.",
  noLabs: "This account has no hosted Labs that can open this link.",
  forbidden: "This account does not have access to the requested Lab.",
  badLabUrl: "The gateway returned an unsupported Lab address.",
  stillWaking: "Your Lab is still starting. Try again in a moment.",
  unreachable: "Your Lab could not be reached. Check your connection and try again.",
  loadFailed: "Could not load this page. Please try again.",
  notOpenable: "This link cannot be opened in Silico. Open a current share link.",
  windowRestoreFailed: "Could not restore this window. Please try again.",
  configUnreachable:
    "The original Lab could not identify this link. Retry when it is reachable, or open the current share link.",
  configEmpty: "The original Lab returned no routing information.",
  configInvalid: "The original Lab returned invalid routing information.",
  configUnsupported: "This link does not identify a supported hosted Lab. Open a current share link from Silico.",
} as const;

// ---------------------------------------------------------------------------
// Registry (`silico:recover-session`)
// ---------------------------------------------------------------------------

// Event listener arguments differ per event, so the structural type accepts any.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (...args: any[]) => void;

/** The part of a WebContents the registry needs. */
export interface RecoverableContents {
  isDestroyed(): boolean;
  getURL(): string;
  readonly mainFrame: unknown;
  on(event: string, listener: Listener): unknown;
  once(event: string, listener: Listener): unknown;
}

interface RegistryEntry {
  eligible(): boolean;
  navigationEligible(): boolean;
  canceled(): void;
  recover(): boolean | void;
}

interface NavDetails {
  url: string;
  isSameDocument: boolean;
  isMainFrame: boolean;
}

export class RecoveryRegistry {
  private readonly entries = new Map<RecoverableContents, RegistryEntry>();

  /**
   * Track `wc` (`Ui`). `isTrustedOrigin` decides which committed origins may
   * request recovery; `recover` returns false when unsupported.
   */
  register(wc: RecoverableContents, isTrustedOrigin: (origin: string) => boolean, recover: () => boolean | void): () => void {
    let committedOrigin: string | null = null;
    let committedEligible = false;
    let navigating = false;
    let navEligible = false;

    const eligible = (): boolean => {
      if (wc.isDestroyed() || navigating || !committedEligible || !committedOrigin) return false;
      try {
        const u = new URL(wc.getURL());
        return u.origin === committedOrigin && isTrustedOrigin(u.origin) && isAllowedLabRoute(u.href);
      } catch {
        return false;
      }
    };

    wc.on("did-start-navigation", (details: NavDetails) => {
      if (!details?.isMainFrame || details.isSameDocument) return;
      const wasEligible = eligible();
      navigating = true;
      try {
        const u = new URL(details.url);
        navEligible =
          (isTrustedOrigin(u.origin) && isAllowedLabRoute(details.url)) ||
          (wasEligible && (isAuthWall(details.url) || (!!gatewayOf(details.url) && u.pathname === "/")));
      } catch {
        navEligible = false;
      }
    });

    wc.on("did-navigate", (_e: unknown, url: string) => {
      navigating = false;
      navEligible = false;
      try {
        committedOrigin = new URL(url).origin;
        committedEligible = isTrustedOrigin(committedOrigin) && isAllowedLabRoute(url) && !gatewayOf(url);
      } catch {
        committedEligible = false;
      }
    });

    this.entries.set(wc, {
      eligible,
      recover,
      navigationEligible: () => (navigating ? navEligible : eligible()),
      canceled: () => {
        navigating = false;
        navEligible = false;
      },
    });
    const dispose = (): void => {
      this.entries.delete(wc);
    };
    wc.once("destroyed", dispose);
    return dispose;
  }

  /** `silico:recover-session` (`Kc`). */
  handle(wc: RecoverableContents, senderFrame: unknown): RecoverSessionResult {
    const entry = this.entries.get(wc);
    try {
      if (!entry || !senderFrame || senderFrame !== wc.mainFrame) return { status: "unsupported" };
      const frame = senderFrame as { isDestroyed?: () => boolean };
      if (typeof frame.isDestroyed === "function" && frame.isDestroyed()) return { status: "unsupported" };
      if (!entry.eligible()) return { status: "unsupported" };
      return entry.recover() === false ? { status: "unsupported" } : { status: "accepted" };
    } catch {
      return { status: "error", message: RecoveryText.windowRestoreFailed };
    }
  }

  eligible(wc: RecoverableContents): boolean {
    return this.entries.get(wc)?.eligible() ?? false;
  }

  navigationEligible(wc: RecoverableContents): boolean {
    return this.entries.get(wc)?.navigationEligible() ?? false;
  }

  /** A guard prevented the in-flight navigation (`mr`). */
  navigationCanceled(wc: RecoverableContents): void {
    this.entries.get(wc)?.canceled();
  }
}

// ---------------------------------------------------------------------------
// One recovery attempt
// ---------------------------------------------------------------------------

export type RecoveryOutcome =
  | { kind: "canceled" }
  | { kind: "blocked"; context?: RecoveryContext; state: RecoveryState }
  | { kind: "ready"; context: RecoveryContext; url: string };

export interface RecoveryDeps {
  authStatus(): Promise<AuthState>;
  listLabs(): Promise<LabsListResult>;
  createLabSession(req: { deploymentId: string; managed: boolean }): Promise<LabSessionResult>;
  waitForLab(baseUrl: string, token: string, opts: { managed: boolean; budgetMs: number; signal?: AbortSignal }): Promise<LabWaitOutcome>;
  /** `GET <origin>/api/auth/config` → gateway + deployment (throws user-facing errors). */
  fetchAuthConfig(originalUrl: string, signal: AbortSignal): Promise<{ gatewayUrl: RecoveryContext["gatewayUrl"]; deployment: string }>;
}

function blockedError(message: string): RecoveryOutcome {
  return { kind: "blocked", state: { kind: "error", message } };
}

function signInState(ctx: RecoveryContext): RecoveryState {
  return { kind: "signin", staging: ctx.gatewayUrl === GATEWAY_STAGING, message: RecoveryText.signIn };
}

export async function runRecovery(
  target: RecoveryTarget,
  signal: AbortSignal,
  chosenDeployment: string | undefined,
  deps: RecoveryDeps,
): Promise<RecoveryOutcome> {
  try {
    const base: RecoveryContext = target.context ?? (await deps.fetchAuthConfig(target.originalUrl, signal));
    if (signal.aborted) return { kind: "canceled" };
    const auth = await deps.authStatus();
    if (signal.aborted) return { kind: "canceled" };
    if (auth.status !== "signed-in") return { kind: "blocked", context: base, state: signInState(base) };
    if (auth.gatewayUrl !== base.gatewayUrl || (base.sub && auth.sub !== base.sub)) {
      return blockedError(RecoveryText.wrongAccount);
    }
    const withSub: RecoveryContext = { ...base, sub: auth.sub };

    let deployment = base.deployment;
    if (!deployment) {
      const labs = await deps.listLabs();
      if (signal.aborted) return { kind: "canceled" };
      if (!labs.ok) {
        return labs.needsAuth ? { kind: "blocked", context: withSub, state: signInState(base) } : blockedError(labs.error);
      }
      const managed = labs.labs.filter((l) => l.routeMode === "managed");
      if (chosenDeployment && !managed.some((l) => l.deploymentId === chosenDeployment)) {
        return blockedError(RecoveryText.labGone);
      }
      deployment = chosenDeployment ?? (managed.length === 1 ? managed[0]?.deploymentId : undefined);
      if (!deployment) {
        if (managed.length === 0) return blockedError(RecoveryText.noLabs);
        return {
          kind: "blocked",
          context: withSub,
          state: { kind: "choose", message: RecoveryText.choose, deployments: managed.map((l) => l.deploymentId) },
        };
      }
    }

    const ctx: RecoveryContext = { ...withSub, deployment };
    const session = await deps.createLabSession({ deploymentId: deployment, managed: true });
    if (signal.aborted) return { kind: "canceled" };
    if (!session.ok) {
      return {
        kind: "blocked",
        context: ctx,
        state: session.needsAuth
          ? signInState(base)
          : { kind: "error", message: session.status === 403 ? RecoveryText.forbidden : session.error },
      };
    }
    if (!isLabishUrl(session.labUrl) || gatewayOf(session.labUrl)) return blockedError(RecoveryText.badLabUrl);

    const reach = await deps.waitForLab(session.labUrl, session.token, {
      managed: true,
      budgetMs: MANAGED_WAKE_TIMEOUT_MS,
      signal,
    });
    if (signal.aborted || reach === "canceled") return { kind: "canceled" };
    if (reach !== "ready") {
      return {
        kind: "blocked",
        context: ctx,
        state: {
          kind: "error",
          message: reach === "still-waking" ? RecoveryText.stillWaking : RecoveryText.unreachable,
        },
      };
    }

    const again = await deps.authStatus();
    if (signal.aborted || again.status !== "signed-in" || again.sub !== auth.sub || again.gatewayUrl !== auth.gatewayUrl) {
      return { kind: "canceled" };
    }
    const cb = new URL(LabPath.authCallback, session.labUrl);
    cb.searchParams.set("return_to", target.route);
    cb.hash = `token=${session.token}`;
    return { kind: "ready", context: ctx, url: cb.href };
  } catch (err) {
    if (signal.aborted) return { kind: "canceled" };
    return blockedError(err instanceof Error ? err.message : RecoveryText.generic);
  }
}

/** Minimal fetch signature (Electron `net.fetch` / global fetch). */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** `GET <origin>/api/auth/config`: no credentials, no redirects, 8 s, ≤ 16 KiB. */
export async function fetchAuthConfig(
  originalUrl: string,
  signal: AbortSignal,
  fetchFn: FetchLike,
): Promise<{ gatewayUrl: RecoveryContext["gatewayUrl"]; deployment: string }> {
  const url = new URL(LabPath.authConfig, originalUrl).href;
  const res = await fetchFn(url, {
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(AUTH_CONFIG_TIMEOUT_MS)]),
  });
  if (!res.ok || (res.url && res.url !== url)) throw new Error(RecoveryText.configUnreachable);
  const reader = res.body?.getReader();
  if (!reader) throw new Error(RecoveryText.configEmpty);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > AUTH_CONFIG_MAX_BYTES) throw new Error(RecoveryText.configInvalid);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new Error(RecoveryText.configInvalid);
  }
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as { auth_url?: unknown; tenant_id?: unknown };
  const gw = typeof obj.auth_url === "string" ? gatewayOf(obj.auth_url) : null;
  if (!gw || typeof obj.tenant_id !== "string" || !obj.tenant_id) throw new Error(RecoveryText.configUnsupported);
  return { gatewayUrl: gw, deployment: obj.tenant_id };
}

// ---------------------------------------------------------------------------
// Viewer recovery controller
// ---------------------------------------------------------------------------

export interface RecoveryController {
  /** Start recovery. `force` bypasses the 45 s throttle and blocked states; `deployment` = user's choice. */
  recover(force?: boolean, deployment?: string): void;
  state(): RecoveryState;
  ownsOrigin(origin: string): boolean;
  recovering(): boolean;
  cancel(): void;
  fail(message: string): void;
  /** Window closed: stop everything and unsubscribe. */
  dispose(): void;
}

export interface ControllerHost {
  /** The viewer content webContents. */
  wc: RecoverableContents;
  isWindowDestroyed(): boolean;
  onState(state: RecoveryState): void;
  /** Hand the recovered URL to the view. */
  load(url: string): void;
}

export interface ControllerDeps extends RecoveryDeps {
  registry: RecoveryRegistry;
  /** Sync cached identity of the signed-in session (`ctx.auth.cachedIdentity`). */
  cachedIdentity(): { sub: string; gatewayUrl: GatewayUrl } | null;
  onIdentityChanged(cb: (identity: Identity | null) => void): () => void;
  onSignedIn(cb: (identity: Identity) => void): () => void;
  now?: () => number;
  /** Override for tests. */
  run?: typeof runRecovery;
}

/** Create the controller for a labBridge viewer (`el`); null when the URL is not recoverable. */
export function createRecoveryController(initialUrl: string, host: ControllerHost, deps: ControllerDeps): RecoveryController | null {
  const parsed = parseRecoveryTarget(initialUrl);
  if (!parsed) return null;
  const initialRoute = parsed.route;
  const now = deps.now ?? Date.now;
  const run = deps.run ?? runRecovery;
  const wc = host.wc;

  let target: RecoveryTarget = parsed;
  let current: RecoveryState = { kind: "idle" };
  const owned = new Set<string>();
  if (!gatewayOf(initialUrl)) owned.add(new URL(initialUrl).origin);
  let inflight: AbortController | null = null;
  let generation = 0;
  let lastAttemptAt = -Infinity;
  let handedOff = false;
  let handedUrl: string | null = null;
  let disposed = false;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let fallbackIdentity: { sub: string; gatewayUrl: string } | null = null;

  const clearDeadline = (): void => {
    if (deadline) clearTimeout(deadline);
    deadline = null;
  };
  const setState = (s: RecoveryState): void => {
    current = s;
    if (s.kind !== "loading") clearDeadline();
    if (!host.isWindowDestroyed()) host.onState(s);
  };
  const cancel = (): void => {
    generation++;
    inflight?.abort();
    inflight = null;
    handedOff = false;
    clearDeadline();
  };
  const trackRoute = (url: string): void => {
    if (!deps.registry.eligible(wc)) return;
    const r = recoveryRoute(url);
    if (!r || r === "/" || /^\/(?:reports|papers|publications)\//.test(initialRoute)) return;
    target = { ...target, route: r };
  };

  const recover = (force = false, deployment?: string): void => {
    if (disposed || host.isWindowDestroyed() || wc.isDestroyed() || inflight) return;
    if (!force && (current.kind === "signin" || current.kind === "choose" || current.kind === "error")) return;
    if (!force && now() - lastAttemptAt < RECOVERY_THROTTLE_MS) {
      setState({ kind: "error", message: RecoveryText.throttled });
      return;
    }
    handedOff = false;
    lastAttemptAt = now();
    trackRoute(wc.getURL());
    const ac = new AbortController();
    inflight = ac;
    const gen = ++generation;
    setState({ kind: "loading", message: RecoveryText.restoring });
    run(target, ac.signal, deployment, deps)
      .then((out) => {
        if (ac.signal.aborted || gen !== generation || host.isWindowDestroyed() || wc.isDestroyed()) return;
        inflight = null;
        if (out.kind === "canceled") {
          setState({ kind: "error", message: RecoveryText.canceled });
        } else if (out.kind === "blocked") {
          if (out.context) target = { ...target, context: out.context };
          setState(out.state);
        } else {
          target = { ...target, context: out.context };
          owned.clear();
          owned.add(new URL(out.url).origin);
          handedOff = true;
          handedUrl = out.url;
          deadline = setTimeout(() => {
            handedOff = false;
            setState({ kind: "error", message: RecoveryText.loadDeadline });
          }, RECOVERY_LOAD_DEADLINE_MS);
          deadline.unref?.();
          host.load(out.url);
        }
      })
      .catch(() => {
        if (gen !== generation || ac.signal.aborted || host.isWindowDestroyed()) return;
        inflight = null;
        setState({ kind: "error", message: RecoveryText.generic });
      });
  };

  const unregister = deps.registry.register(
    wc,
    (origin) => owned.has(origin),
    () => recover(),
  );

  // Remember the signed-in identity (auth §3.1 cached identity, sync like the
  // original) so an account switch can be detected before the first recovery
  // stamped `sub` into the context.
  const cached = deps.cachedIdentity();
  if (cached && !target.context?.sub && (!target.context || target.context.gatewayUrl === cached.gatewayUrl)) {
    if (target.context) target = { ...target, context: { ...target.context, sub: cached.sub } };
    fallbackIdentity = { sub: cached.sub, gatewayUrl: cached.gatewayUrl };
  }

  const offIdentity = deps.onIdentityChanged((id) => {
    const ref = target.context?.sub ? target.context : fallbackIdentity;
    if (!id || (ref && (id.sub !== ref.sub || id.gatewayUrl !== ref.gatewayUrl))) {
      disposed = true;
      cancel();
      setState({ kind: "error", message: RecoveryText.accountChanged });
    }
  });
  const offSignedIn = deps.onSignedIn((id) => {
    if (current.kind !== "signin" || disposed) return;
    const c = target.context;
    if (c?.gatewayUrl !== id.gatewayUrl || (c.sub && c.sub !== id.sub)) return;
    recover(true);
  });

  const onStartNavigation = (details: NavDetails): void => {
    if (!details?.isMainFrame) return;
    const url = details.url;
    let expected = false;
    if (handedOff && handedUrl) {
      try {
        const h = new URL(handedUrl);
        const t = new URL(url);
        expected =
          (t.origin === h.origin &&
            t.pathname === h.pathname &&
            (t.search === h.search || t.search === "") &&
            (t.hash === h.hash || t.hash === "")) ||
          url === new URL(target.route, handedUrl).href;
      } catch {
        expected = false;
      }
    }
    if (!expected && (inflight || current.kind !== "idle")) {
      cancel();
      setState({ kind: "idle" });
    }
    if (details.isSameDocument) trackRoute(url);
  };
  wc.on("did-start-navigation", onStartNavigation);
  wc.on("did-navigate", (_e: unknown, url: string) => trackRoute(url));
  wc.on("did-navigate-in-page", (_e: unknown, url: string, isMainFrame: boolean) => {
    if (!isMainFrame) return;
    trackRoute(url);
    if (handedOff && deps.registry.eligible(wc) && recoveryRoute(url)) {
      handedOff = false;
      setState({ kind: "idle" });
    }
  });
  wc.on("did-finish-load", () => {
    if (handedOff && deps.registry.eligible(wc) && recoveryRoute(wc.getURL())) {
      handedOff = false;
      setState({ kind: "idle" });
    }
  });

  return {
    recover,
    state: () => current,
    ownsOrigin: (o) => owned.has(o),
    recovering: () => !!inflight || current.kind !== "idle",
    cancel,
    fail: (message) => {
      cancel();
      setState({ kind: "error", message });
    },
    dispose: () => {
      disposed = true;
      cancel();
      unregister();
      offIdentity();
      offSignedIn();
    },
  };
}
