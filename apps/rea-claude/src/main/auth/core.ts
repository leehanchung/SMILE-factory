/**
 * Auth core: in-memory session, identity.json persistence, lazy load, proof
 * refresh, browser sign-in orchestration, signup adoption, sign-out with the
 * pending-revocation queue, gateway requests. [auth §3, §4.1-4.4, §4.5 step 5, §5]
 *
 * Every await in sign-in / adoption / sign-out paths re-checks `signInEpoch`
 * (and the session object identity) so restarts and account swaps surface as
 * "Sign-in restarted." / "The signed-in account changed. Please try again.".
 */
import { promises as fsp, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DIR_PENDING_REVOCATIONS,
  FILE_IDENTITY,
  GatewayPath,
  IDENTITY_FILE_MODE,
  LOGOUT_TIMEOUT_MS,
  DESKTOP_CONTINUE_TIMEOUT_MS,
  NEVER_EXPIRES_AT,
  PROOF_REFRESH_WINDOW_MS,
  REVOCATION_DIR_MODE,
  REVOCATION_RETRY_MS,
  SIGN_IN_TIMEOUT_MS,
} from "@shared/config";
import type { AuthState, GatewayUrl, PersistenceMode, Unsubscribe } from "@shared/ipc";
import { ShellEventChannel } from "@shared/ipc";
import type {
  GatewayRequest,
  GatewayResponse,
  Identity,
  MainContext,
  SessionResult,
  UsableSession,
} from "../services";
import {
  hashToken,
  isRevocationDone,
  isTransientActivationStatus,
  mintRefreshToken,
  parseActivationCode,
} from "./activation";
import { isValidResumeToken } from "./deepLinkParse";
import { gatewayFor, isCanonicalGateway } from "./gateways";
import {
  backendName,
  encryptionAllowed,
  expiresAtOf,
  parseIdentity,
  persistenceMode,
  serializeIdentity,
  type Decryptor,
  type Encryptor,
  type Session,
} from "./identityFile";
import { buildLoginUrl, ERR_SIGN_IN_RESTARTED, startLoopback } from "./loopback";
import { decodeProofClaims, hasDeveloperClaim, isRefreshedProofValid, isSignupProofValid } from "./proof";
import { formatNetworkError, gatewayFetch, probeLoginOrigin, readJson, type FetchLike } from "./transport";

// --- user-facing error strings [auth §2, §4.1, §4.2, §4.5] --------------------
export const ERR_ACCOUNT_CHANGED = "The signed-in account changed. Please try again.";
export const ERR_SESSION_EXPIRED = "Your session has expired. Sign in again.";
export const ERR_REFRESH_UNAVAILABLE = "Session refresh is temporarily unavailable.";
export const ERR_ENV_SWITCH = "Finish the sign-in already open in your browser before changing environments.";
export const ERR_UNKNOWN_GATEWAY_ORIGIN = "Gateway returned an unknown origin.";
export const ERR_INVALID_ACTIVATION = "Gateway returned an invalid activation code.";
export const ERR_ACTIVATION_FAILED = "Could not activate the desktop sign-in.";
export const ERR_INVALID_DESKTOP_SESSION = "Gateway returned an invalid desktop session.";
export const ERR_INVALID_PROOF = "Gateway returned an invalid proof.";
export const ERR_INVALID_SIGNUP_PROOF = "Gateway returned an invalid signup identity proof.";
export const MEMORY_ONLY_WARNING = "keychain encryption unavailable; session kept in memory, not persisted";

const STALE = Symbol("stale-session");
type Usable = Session | null | typeof STALE;

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export interface AuthPlatform {
  now: () => number;
  fetch: FetchLike;
  randomBytes: (n: number) => Buffer;
  safeStorage: SafeStorageLike;
  openExternal: (url: string) => unknown;
  /** Loopback sign-in timeout (default SIGN_IN_TIMEOUT_MS). */
  signInTimeoutMs?: number;
}

export class AuthCore {
  private session: Session | null = null;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private identity: { sub: string; gatewayUrl: GatewayUrl } | null = null;
  private signInEpoch = 0;
  private refreshUnavailable = false;
  private refreshing: { session: Session; promise: Promise<Usable> } | null = null;
  private sessionDeathPending = false;
  private cancelLoopback: (() => void) | null = null;
  private inflight: { staging: boolean; promise: Promise<AuthState> } | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly identityListeners = new Set<(identity: Identity | null) => void>();
  private readonly developerListeners = new Set<(developer: boolean) => void>();
  private readonly signedInListeners = new Set<(identity: Identity) => void>();
  // revocation queue
  private readonly memoryRevocations = new Map<string, Session>();
  private retryRun: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRetryAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly ctx: MainContext,
    private readonly p: AuthPlatform,
  ) {}

  private get log() {
    return this.ctx.logger("auth");
  }

  // ------------------------------------------------------------------ paths
  identityPath(): string {
    return join(this.ctx.env.userDataPath(), FILE_IDENTITY);
  }
  revocationDir(): string {
    return join(this.ctx.env.userDataPath(), DIR_PENDING_REVOCATIONS);
  }

  // ------------------------------------------------------------ persistence
  private canEncrypt(): boolean {
    if (!encryptionAllowed({ isPackaged: this.ctx.env.isPackaged, testMode: this.ctx.env.isTestMode })) return false;
    try {
      return this.p.safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }
  private encryptor(): Encryptor | null {
    if (!this.canEncrypt()) return null;
    return (s) => this.p.safeStorage.encryptString(s).toString("base64");
  }
  private decryptor(): Decryptor | null {
    if (!this.canEncrypt()) return null;
    return (s) => this.p.safeStorage.decryptString(Buffer.from(s, "base64"));
  }
  backend(): string {
    let linuxBackend: string | undefined;
    if (this.ctx.env.platform === "linux") {
      try {
        linuxBackend = this.p.safeStorage.getSelectedStorageBackend?.();
      } catch {
        linuxBackend = undefined;
      }
    }
    return backendName({ platform: this.ctx.env.platform, ...(linuxBackend ? { linuxBackend } : {}) });
  }
  persistenceMode(): PersistenceMode {
    return persistenceMode({
      isPackaged: this.ctx.env.isPackaged,
      testMode: this.ctx.env.isTestMode,
      encryptionAvailable: this.canEncrypt(),
    });
  }
  logPersistenceMode(): void {
    this.log.info(`identity persistence: ${this.persistenceMode()} (safeStorage backend "${this.backend()}")`);
  }

  /** Serialize every identity.json / queue mutation through one promise chain. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  private removeIdentityFile(): Promise<void> {
    return this.serial(() => fsp.rm(this.identityPath(), { force: true }));
  }

  async persist(session: Session, opts: { removeExistingOnFailure?: boolean } = {}): Promise<void> {
    const record = serializeIdentity(session, this.encryptor(), {
      plaintextFallback: !this.ctx.env.isPackaged,
      backend: this.backend(),
    });
    if (!record) {
      this.log.warn(MEMORY_ONLY_WARNING);
      if (opts.removeExistingOnFailure !== false) await this.removeIdentityFile();
      return;
    }
    const target = this.identityPath();
    const tmp = `${target}.tmp`;
    await this.serial(async () => {
      await fsp.mkdir(this.ctx.env.userDataPath(), { recursive: true });
      await fsp.writeFile(tmp, JSON.stringify(record, null, 2), { encoding: "utf-8", mode: IDENTITY_FILE_MODE });
      await fsp.rename(tmp, target);
    });
  }

  /**
   * Persist a freshly installed sign-in session. A write failure (read-only
   * userData, full disk) keeps the session in memory, like the no-keyring
   * path, so the sign-in still completes and its notifications fire instead
   * of leaving an installed session behind a rejected sign-in.
   */
  private async persistOrKeepInMemory(session: Session): Promise<void> {
    try {
      await this.persist(session);
    } catch (err) {
      this.log.warn("could not write identity.json; session kept in memory, not persisted", err);
    }
  }

  private readSessionFile(text: string): Session | null {
    return parseIdentity(text, this.decryptor(), {
      currentBackend: this.backend(),
      warn: (m) => this.log.warn(m),
    });
  }

  /** Load identity.json once (lazy); later installs win over a slow load. */
  ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    this.loadPromise ??= (async () => {
      let s: Session | null = null;
      try {
        s = this.readSessionFile(await fsp.readFile(this.identityPath(), "utf-8"));
      } catch {
        s = null;
      }
      if (!this.loaded) {
        this.session = s;
        this.identity = s ? { sub: s.sub, gatewayUrl: s.gatewayUrl } : null;
        this.loaded = true;
      }
      void this.retryRevocations();
    })();
    return this.loadPromise;
  }

  // ---------------------------------------------------------------- state
  private now(): number {
    return this.p.now();
  }

  isDeveloper(): boolean {
    const s = this.session;
    return !!s && expiresAtOf(s, NEVER_EXPIRES_AT) > this.now() && s.developer === true;
  }

  cachedIdentity(): { login: string; sub: string; gatewayUrl: GatewayUrl } | null {
    const s = this.session;
    return s ? { login: s.login, sub: s.sub, gatewayUrl: s.gatewayUrl } : null;
  }

  /** Published identity (auth §3.1): survives a session drop, cleared only on sign-out. */
  lastIdentity(): { sub: string; gatewayUrl: GatewayUrl } | null {
    return this.identity ? { sub: this.identity.sub, gatewayUrl: this.identity.gatewayUrl } : null;
  }

  /** Current state without loading (callers ensure loaded). */
  private stateNow(): AuthState {
    const s = this.session;
    if (!s) return { status: "signed-out" };
    const expiresAt = expiresAtOf(s, NEVER_EXPIRES_AT);
    if (expiresAt <= this.now()) return { status: "signed-out" };
    return {
      status: "signed-in",
      login: s.login,
      sub: s.sub,
      gatewayUrl: s.gatewayUrl,
      expiresAt,
      developer: s.developer === true,
    };
  }

  async status(): Promise<AuthState> {
    await this.ensureLoaded();
    void this.retryRevocations();
    return this.stateNow();
  }

  async activeGateway(): Promise<GatewayUrl> {
    await this.ensureLoaded();
    if (this.session) return this.session.gatewayUrl;
    return gatewayFor((await this.ctx.settings.get()).staging);
  }

  private publishIdentity(identity: { sub: string; gatewayUrl: GatewayUrl } | null, login = ""): void {
    this.identity = identity;
    if (!identity) this.inflight = null; // a signed-out identity forgets the in-flight sign-in
    for (const cb of [...this.identityListeners]) {
      try {
        cb(identity ? { ...identity, login } : null);
      } catch (err) {
        this.log.error("identity listener failed", err);
      }
    }
  }

  private notifyDeveloper(developer: boolean): void {
    for (const cb of [...this.developerListeners]) {
      try {
        cb(developer);
      } catch (err) {
        this.log.error("developer listener failed", err);
      }
    }
  }

  /** Install a session (fires developer + identity listeners on change). */
  private install(next: Session): Session {
    const wasDev = this.isDeveloper();
    this.session = next;
    this.loaded = true;
    this.refreshUnavailable = false;
    const isDev = this.isDeveloper();
    if (wasDev !== isDev) this.notifyDeveloper(isDev);
    if (this.identity?.sub !== next.sub || this.identity.gatewayUrl !== next.gatewayUrl) {
      this.publishIdentity({ sub: next.sub, gatewayUrl: next.gatewayUrl }, next.login);
    }
    return next;
  }

  onIdentityChanged(cb: (identity: Identity | null) => void): Unsubscribe {
    this.identityListeners.add(cb);
    return () => this.identityListeners.delete(cb);
  }
  onDeveloperChanged(cb: (developer: boolean) => void): Unsubscribe {
    this.developerListeners.add(cb);
    return () => this.developerListeners.delete(cb);
  }
  onSignedIn(cb: (identity: Identity) => void): Unsubscribe {
    this.signedInListeners.add(cb);
    return () => this.signedInListeners.delete(cb);
  }

  private fireSignedIn(state: AuthState): void {
    if (state.status !== "signed-in") return;
    const identity: Identity = { sub: state.sub, login: state.login, gatewayUrl: state.gatewayUrl };
    for (const cb of [...this.signedInListeners]) {
      try {
        cb(identity);
      } catch (err) {
        this.log.error("could not resume a waiting window", err);
      }
    }
  }

  // --------------------------------------------------------- session death
  recordSessionDeath(reason: string): void {
    if (!this.sessionDeathPending) {
      try {
        this.ctx.telemetry.recordShellEvent("session-death", { details: { reason } });
      } catch (err) {
        this.log.warn("could not record session death", err);
      }
    }
    this.sessionDeathPending = true;
  }

  /** Read-and-clear the "a session death happened" flag (gentle sign-in focus). */
  takeSessionDeath(): boolean {
    const v = this.sessionDeathPending;
    this.sessionDeathPending = false;
    return v;
  }

  private async clearSession(): Promise<void> {
    const wasDev = this.isDeveloper();
    this.session = null;
    this.refreshUnavailable = false;
    if (wasDev) this.notifyDeveloper(false);
    await this.removeIdentityFile();
  }

  /** Drop `s` only if still current. True when it was dropped and nothing raced it. */
  async dropIfCurrent(s: Session, reason: string): Promise<boolean> {
    if (this.session !== s) return false;
    const epoch = this.signInEpoch;
    this.recordSessionDeath(reason);
    await this.clearSession();
    return this.session === null && epoch === this.signInEpoch;
  }

  // ------------------------------------------------------- usable session
  private expiredResult(): { ok: false; error: string; needsAuth?: true } {
    return this.refreshUnavailable
      ? { ok: false, error: ERR_REFRESH_UNAVAILABLE }
      : { ok: false, error: ERR_SESSION_EXPIRED, needsAuth: true };
  }

  async usableSession(): Promise<Usable> {
    await this.ensureLoaded();
    void this.retryRevocations();
    const s = this.session;
    if (!s) {
      this.refreshUnavailable = false;
      return null;
    }
    if (s.refreshToken && s.exp * 1000 <= this.now() + PROOF_REFRESH_WINDOW_MS) {
      if (this.refreshing?.session !== s) {
        const entry: { session: Session; promise: Promise<Usable> } = {
          session: s,
          promise: this.refresh(s).finally(() => {
            if (this.refreshing === entry) this.refreshing = null;
          }),
        };
        this.refreshing = entry;
      }
      return (this.refreshing as { promise: Promise<Usable> }).promise;
    }
    if (s.exp * 1000 <= this.now()) {
      this.recordSessionDeath("proof-expired");
      return null;
    }
    return s;
  }

  private async refresh(s: Session): Promise<Usable> {
    this.refreshUnavailable = false;
    const stillValid = (): boolean => s.exp * 1000 > this.now();
    try {
      const res = await gatewayFetch(
        this.p.fetch,
        `${s.gatewayUrl}${GatewayPath.refresh}`,
        { method: "POST", headers: { authorization: `Bearer ${s.refreshToken ?? ""}` } },
        { aliasFallback: true, onFailure: this.transportSink },
      );
      if (this.session !== s) return STALE;
      if (res.status === 401 || res.status === 404) {
        return (await this.dropIfCurrent(s, "device-session-rejected")) ? null : STALE;
      }
      if (!res.ok) {
        if (stillValid()) return s;
        this.refreshUnavailable = true;
        return null;
      }
      const body = (await res.json()) as unknown;
      if (this.session !== s) return STALE;
      const proof = body && typeof body === "object" ? (body as Record<string, unknown>).proof : undefined;
      if (typeof proof !== "string") {
        return (await this.dropIfCurrent(s, "device-session-invalid-response")) ? null : STALE;
      }
      const claims = decodeProofClaims(proof);
      if (!isRefreshedProofValid(claims, s.sub)) {
        return (await this.dropIfCurrent(s, "device-session-invalid-response")) ? null : STALE;
      }
      const next = this.install({
        gatewayUrl: s.gatewayUrl,
        sub: claims.sub,
        login: claims.login || s.login,
        exp: claims.exp,
        proof,
        ...(s.refreshToken ? { refreshToken: s.refreshToken } : {}),
        ...(claims.developer ? { developer: true as const } : {}),
      });
      try {
        await this.persist(next, { removeExistingOnFailure: false });
      } catch (err) {
        this.log.warn("could not persist the refreshed device session", err);
      }
      return this.session === next ? next : STALE;
    } catch {
      if (this.session !== s) return STALE;
      if (stillValid()) return s;
      this.refreshUnavailable = true;
      return null;
    }
  }

  async getSession(): Promise<SessionResult> {
    const s = await this.usableSession();
    if (s === STALE) return { ok: false, error: ERR_ACCOUNT_CHANGED };
    if (!s) return this.expiredResult();
    return { ok: true, session: toUsable(s) };
  }

  private readonly transportSink = (details: Record<string, unknown>): void => {
    try {
      this.ctx.telemetry.recordShellEvent("gateway-transport-failure", { details });
    } catch (err) {
      this.log.warn("could not record a transport failure", err);
    }
  };

  async gatewayRequest(req: GatewayRequest): Promise<GatewayResponse> {
    const s = await this.usableSession();
    if (s === STALE) return { kind: "auth", error: ERR_ACCOUNT_CHANGED };
    if (!s) return { kind: "auth", ...dropOk(this.expiredResult()) };
    const headers: Record<string, string> = { authorization: `Bearer ${s.proof}` };
    const init: RequestInit = { method: req.method ?? "GET", headers };
    if (req.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(req.body);
    }
    let res: Response;
    try {
      res = await gatewayFetch(this.p.fetch, `${s.gatewayUrl}${req.path}`, init, {
        aliasFallback: req.aliasFallback ?? true,
        ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
        operation: req.operation ?? "api",
        onFailure: this.transportSink,
      });
    } catch (err) {
      if (this.session !== s) return { kind: "auth", error: ERR_ACCOUNT_CHANGED };
      return { kind: "network", ...formatNetworkError(err, "Gateway request failed.") };
    }
    if (this.session !== s) return { kind: "auth", error: ERR_ACCOUNT_CHANGED };
    if (res.status === 401) {
      return (await this.dropIfCurrent(s, "gateway-401"))
        ? { kind: "auth", ...dropOk(this.expiredResult()) }
        : { kind: "auth", error: ERR_ACCOUNT_CHANGED };
    }
    const body = await readJson(res);
    if (this.session !== s) return { kind: "auth", error: ERR_ACCOUNT_CHANGED };
    return { kind: "http", status: res.status, body, gatewayUrl: s.gatewayUrl };
  }

  /** Developer flag from a lab token's claim. [auth §4.3] */
  async noteLabToken(labToken: string): Promise<void> {
    const s = this.session;
    if (!s) return;
    const dev = hasDeveloperClaim(labToken);
    if ((s.developer === true) === dev) return;
    if (dev) s.developer = true;
    else delete s.developer;
    try {
      await this.persist(s);
    } catch (err) {
      this.log.warn("could not persist the developer flag", err);
    }
    if (this.session !== s) return;
    this.notifyDeveloper(this.isDeveloper());
    const state = this.stateNow();
    if (state.status === "signed-in") this.ctx.windows.broadcast(ShellEventChannel.authChanged, state);
  }

  // ------------------------------------------------------------ sign-in
  /** Start or join the single in-flight browser sign-in. [auth §4.1 step 1] */
  signIn(staging: boolean, restart: boolean): Promise<AuthState> {
    const cur = this.inflight;
    if (cur) {
      if (cur.staging !== staging) return Promise.reject(new Error(ERR_ENV_SWITCH));
      if (!restart) return cur.promise;
    }
    const entry: { staging: boolean; promise: Promise<AuthState> } = {
      staging,
      promise: this.runSignIn(staging)
        .then((state) => {
          if (this.inflight === entry && state.status === "signed-in") {
            try {
              this.ctx.windows.broadcastToTrustedShells(ShellEventChannel.authChanged, state);
            } catch (err) {
              this.log.error("could not broadcast auth:changed", err);
            }
            this.fireSignedIn(state);
          }
          return state;
        })
        .finally(() => {
          if (this.inflight === entry) this.inflight = null;
        }),
    };
    this.inflight = entry;
    return entry.promise;
  }

  private async runSignIn(staging: boolean): Promise<AuthState> {
    void this.retryRevocations();
    const epoch = ++this.signInEpoch;
    const gateway = gatewayFor(staging);
    const callback = await this.loopback(gateway);
    if (epoch !== this.signInEpoch) throw new Error(ERR_SIGN_IN_RESTARTED);
    const activated = await this.activate(callback, gateway);
    if (epoch !== this.signInEpoch) throw new Error(ERR_SIGN_IN_RESTARTED);
    return this.finalize(activated, gateway);
  }

  private iconDataUri(): string {
    try {
      return `data:image/png;base64,${readFileSync(this.ctx.env.iconPath()).toString("base64")}`;
    } catch {
      return "";
    }
  }

  private loopback(gateway: GatewayUrl): Promise<{ proof: string; activationCode?: string }> {
    this.cancelLoopback?.();
    const state = this.p.randomBytes(16).toString("hex");
    const handle = startLoopback({
      state,
      timeoutMs: this.p.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS,
      iconDataUri: this.iconDataUri(),
      onListening: (port, isSettled) => {
        void probeLoginOrigin(this.p.fetch, gateway, this.transportSink)
          .catch(() => gateway)
          .then(async (origin) => {
            if (isSettled()) return;
            try {
              await this.p.openExternal(buildLoginUrl(origin, port, state));
            } catch (err) {
              this.log.error("could not open the browser for sign-in", err);
            }
          });
      },
    });
    const cancel = handle.cancel;
    this.cancelLoopback = cancel;
    const clear = (): void => {
      if (this.cancelLoopback === cancel) this.cancelLoopback = null;
    };
    handle.promise.then(clear, clear);
    return handle.promise;
  }

  private async activate(
    cb: { proof: string; activationCode?: string },
    gateway: GatewayUrl,
  ): Promise<{ proof: string; refreshToken?: string }> {
    if (!cb.activationCode) return { proof: cb.proof };
    if (!isCanonicalGateway(gateway)) throw new Error(ERR_UNKNOWN_GATEWAY_ORIGIN);
    const id = parseActivationCode(cb.activationCode);
    if (id === null) throw new Error(ERR_INVALID_ACTIVATION);
    const refreshToken = mintRefreshToken(id, this.p.randomBytes(32));
    let res: Response;
    try {
      res = await gatewayFetch(
        this.p.fetch,
        `${gateway}${GatewayPath.activate}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${cb.activationCode}`, "content-type": "application/json" },
          body: JSON.stringify({ token_hash: hashToken(refreshToken) }),
        },
        { aliasFallback: true, onFailure: this.transportSink },
      );
    } catch {
      return { proof: cb.proof };
    }
    if (isTransientActivationStatus(res.status)) return { proof: cb.proof };
    if (!res.ok) throw new Error(ERR_ACTIVATION_FAILED);
    const body = await readJson(res);
    if (!body || typeof body !== "object" || (body as Record<string, unknown>).ok !== true) {
      throw new Error(ERR_INVALID_DESKTOP_SESSION);
    }
    return { proof: cb.proof, refreshToken };
  }

  private async finalize(a: { proof: string; refreshToken?: string }, gateway: GatewayUrl): Promise<AuthState> {
    if (!isCanonicalGateway(gateway)) throw new Error(ERR_UNKNOWN_GATEWAY_ORIGIN);
    const epoch = this.signInEpoch;
    const claims = decodeProofClaims(a.proof);
    if (!claims.sub || !claims.exp) throw new Error(ERR_INVALID_PROOF);
    await this.ensureLoaded();
    if (epoch !== this.signInEpoch) throw new Error(ERR_SIGN_IN_RESTARTED);
    const next = this.install({
      gatewayUrl: gateway,
      sub: claims.sub,
      login: claims.login,
      exp: claims.exp,
      proof: a.proof,
      ...(a.refreshToken ? { refreshToken: a.refreshToken } : {}),
      ...(claims.developer ? { developer: true as const } : {}),
    });
    await this.persistOrKeepInMemory(next);
    const state = await this.status();
    if (epoch !== this.signInEpoch || this.session !== next) throw new Error(ERR_SIGN_IN_RESTARTED);
    return state;
  }

  /** Adopt a signup identity proof as the session (no refresh token). [auth §4.5 step 5] */
  async adoptSignupProof(proof: string, staging: boolean): Promise<AuthState> {
    this.cancelLoopback?.();
    const epoch = ++this.signInEpoch;
    const claims = decodeProofClaims(proof);
    if (!isSignupProofValid(claims, this.now())) throw new Error(ERR_INVALID_SIGNUP_PROOF);
    const gateway = gatewayFor(staging);
    await this.ensureLoaded();
    if (epoch !== this.signInEpoch) throw new Error(ERR_SIGN_IN_RESTARTED);
    const next = this.install({
      gatewayUrl: gateway,
      sub: claims.sub,
      login: claims.login,
      exp: claims.exp,
      proof,
      ...(claims.developer ? { developer: true as const } : {}),
    });
    this.sessionDeathPending = false;
    await this.persistOrKeepInMemory(next);
    const state = await this.status();
    if (epoch !== this.signInEpoch || this.session !== next) throw new Error(ERR_SIGN_IN_RESTARTED);
    this.fireSignedIn(state);
    return state;
  }

  /** `POST /beta-signup/desktop-continue` → resume token, or null on any failure. [auth §4.6 step 1] */
  async desktopContinue(token: string, staging: boolean): Promise<string | null> {
    const s = await this.usableSession();
    if (!s || s === STALE || s.gatewayUrl !== gatewayFor(staging)) return null;
    try {
      const res = await gatewayFetch(
        this.p.fetch,
        `${s.gatewayUrl}${GatewayPath.signupDesktopContinue}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${s.proof}`, "content-type": "application/json" },
          body: JSON.stringify({ token }),
        },
        { timeoutMs: DESKTOP_CONTINUE_TIMEOUT_MS, onFailure: this.transportSink },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as unknown;
      if (this.session !== s) return null;
      const rt = body && typeof body === "object" ? (body as Record<string, unknown>).resume_token : undefined;
      const resume = typeof rt === "string" ? rt : "";
      return isValidResumeToken(resume) ? resume : null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ sign-out
  /** Local part of "sign out everywhere" (window effects are the caller's). [auth §4.4 steps 2-5] */
  async signOutAll(): Promise<void> {
    this.signInEpoch++;
    this.cancelLoopback?.();
    this.sessionDeathPending = false;
    await this.ensureLoaded();
    const s = this.session;
    const wasDev = this.isDeveloper();
    this.session = null;
    this.refreshUnavailable = false;
    this.publishIdentity(null);
    if (wasDev) this.notifyDeveloper(false);
    if (!s?.refreshToken) {
      await this.removeIdentityFile();
      void this.retryRevocations();
      return;
    }
    const refreshToken = s.refreshToken;
    const dir = this.revocationDir();
    const dest = join(dir, `${this.now()}-${this.p.randomBytes(12).toString("hex")}.json`);
    const queued = await this.serial(async () => {
      await fsp.mkdir(dir, { recursive: true, mode: REVOCATION_DIR_MODE });
      try {
        await fsp.rename(this.identityPath(), dest);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
        this.log.warn("could not queue the saved session for revocation", err);
        try {
          await fsp.rm(this.identityPath(), { force: true });
        } catch (rmErr) {
          this.log.warn("could not remove the saved signed-out session", rmErr);
        }
        return false;
      }
    });
    if (!queued) this.memoryRevocations.set(refreshToken, s);
    void (async () => {
      if (await this.revoke(s)) {
        this.memoryRevocations.delete(refreshToken);
        if (queued) {
          try {
            await fsp.rm(dest, { force: true });
          } catch (err) {
            this.log.warn("could not remove a completed pending revocation", err);
            this.scheduleRetry();
          }
        }
        return;
      }
      this.scheduleRetry();
    })();
  }

  private async revoke(s: Session): Promise<boolean> {
    if (!s.refreshToken) return true;
    try {
      const res = await gatewayFetch(
        this.p.fetch,
        `${s.gatewayUrl}${GatewayPath.logout}`,
        { method: "POST", headers: { authorization: `Bearer ${s.refreshToken}` } },
        { timeoutMs: LOGOUT_TIMEOUT_MS, aliasFallback: true, onFailure: this.transportSink },
      );
      if (res.status === 401 || res.status === 404) return true;
      if (!res.ok) return false;
      return isRevocationDone(res.status, await readJson(res));
    } catch {
      return false;
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.retryRevocations({ force: true });
    }, REVOCATION_RETRY_MS);
    (this.retryTimer as { unref?: () => void }).unref?.();
  }

  /** Sweep the revocation queue + in-memory map; throttled to once per 30 s unless forced. */
  retryRevocations(opts: { force?: boolean } = {}): Promise<void> {
    if (this.retryRun) return this.retryRun;
    if (!opts.force && this.now() - this.lastRetryAt < REVOCATION_RETRY_MS) return Promise.resolve();
    this.lastRetryAt = this.now();
    this.retryRun = (async () => {
      let failed = false;
      let names: string[] = [];
      const dir = this.revocationDir();
      try {
        names = await fsp.readdir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          this.log.warn("could not read pending revocations", err);
          failed = true;
        }
      }
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const file = join(dir, name);
        try {
          const s = this.readSessionFile(await fsp.readFile(file, "utf-8"));
          if (s?.refreshToken) {
            if (await this.revoke(s)) await fsp.rm(file, { force: true });
            else failed = true;
          } else {
            this.log.warn("deleting an unreadable pending revocation");
            await fsp.rm(file, { force: true });
          }
        } catch (err) {
          this.log.warn("could not retry a pending revocation", err);
          failed = true;
        }
      }
      for (const [token, s] of [...this.memoryRevocations]) {
        if (await this.revoke(s)) this.memoryRevocations.delete(token);
        else failed = true;
      }
      if (failed) this.scheduleRetry();
    })().finally(() => {
      this.retryRun = null;
    });
    return this.retryRun;
  }

  /** Test/diagnostic accessor. */
  pendingMemoryRevocations(): number {
    return this.memoryRevocations.size;
  }
}

function toUsable(s: Session): UsableSession {
  return { sub: s.sub, login: s.login, gatewayUrl: s.gatewayUrl, proof: s.proof, developer: s.developer === true };
}

function dropOk(r: { ok: false; error: string; needsAuth?: true }): { error: string; needsAuth?: true } {
  return r.needsAuth ? { error: r.error, needsAuth: true } : { error: r.error };
}
