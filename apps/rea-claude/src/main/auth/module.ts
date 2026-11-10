/**
 * One shared auth-area instance per MainContext. The four public services
 * (auth, signup, deepLinks, returns) and the IPC registration all reach the
 * same AuthCore / signup / returns objects through this cache. Construction
 * is side-effect free (closures only).
 */
import type { AuthService, MainContext } from "../services";
import { AuthCore } from "./core";
import { createDeepLinks } from "./deepLinks";
import { resolveDeps, type AuthDeps, type ResolvedAuthDeps } from "./platform";
import { createReturns, type ReturnsInternals } from "./returns";
import { createSignup, type SignupInternals } from "./signupView";

export interface AuthModule {
  deps: ResolvedAuthDeps;
  core: AuthCore;
  auth: AuthService;
  signup: SignupInternals;
  returns: ReturnsInternals;
  deepLinks: ReturnType<typeof createDeepLinks>;
}

const modules = new WeakMap<MainContext, AuthModule>();

function authServiceOf(core: AuthCore): AuthService {
  return {
    status: () => core.status(),
    persistenceMode: () => core.persistenceMode(),
    logPersistenceMode: () => core.logPersistenceMode(),
    activeGateway: () => core.activeGateway(),
    cachedIdentity: () => core.cachedIdentity(),
    lastIdentity: () => core.lastIdentity(),
    getSession: () => core.getSession(),
    gatewayRequest: (req) => core.gatewayRequest(req),
    noteLabToken: (token) => void core.noteLabToken(token),
    isDeveloper: () => core.isDeveloper(),
    onIdentityChanged: (cb) => core.onIdentityChanged(cb),
    onSignedIn: (cb) => core.onSignedIn(cb),
    onDeveloperChanged: (cb) => core.onDeveloperChanged(cb),
    recordSessionDeath: (reason) => core.recordSessionDeath(reason),
  };
}

/** Build a fresh module (tests) without caching. */
export function buildAuthModule(ctx: MainContext, deps?: AuthDeps): AuthModule {
  const resolved = resolveDeps(deps);
  const core = new AuthCore(ctx, {
    now: resolved.now,
    fetch: resolved.fetch,
    randomBytes: resolved.randomBytes,
    safeStorage: resolved.safeStorage,
    openExternal: resolved.openExternal,
    signInTimeoutMs: resolved.signInTimeoutMs,
  });
  const signup = createSignup(ctx, core, resolved);
  const returns = createReturns(ctx, resolved);
  const deepLinks = createDeepLinks(ctx, core, signup, returns, resolved);
  return { deps: resolved, core, auth: authServiceOf(core), signup, returns, deepLinks };
}

/** The module for `ctx` (created on first use; the first caller's deps win). */
export function getAuthModule(ctx: MainContext, deps?: AuthDeps): AuthModule {
  let m = modules.get(ctx);
  if (!m) {
    m = buildAuthModule(ctx, deps);
    modules.set(ctx, m);
  }
  return m;
}
