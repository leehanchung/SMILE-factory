/**
 * Auth module entry (owner: I1).
 *
 * Owns: session store + identity.json, loopback browser sign-in, refresh,
 * revocation queue, gateway fetch guard (+ alias fallback), signup view,
 * deep-link parsing & dispatch (+ pre-ready stash), nonce/return stores for
 * checkout / MCP OAuth / GitHub connect. IPC: auth:* and signup:*.
 *
 * All four services created for one MainContext share a single module
 * instance (see ./module.ts); creation is side-effect free.
 */
import type { AuthService, DeepLinkService, MainContext, ReturnsService, SignupService } from "../services";
import { registerAuthIpcWith } from "./ipc";
import { getAuthModule } from "./module";
import type { AuthDeps } from "./platform";

export type { AuthDeps } from "./platform";

export function createAuthService(ctx: MainContext, deps?: AuthDeps): AuthService {
  return getAuthModule(ctx, deps).auth;
}

export function createSignupService(ctx: MainContext, deps?: AuthDeps): SignupService {
  return getAuthModule(ctx, deps).signup;
}

export function createDeepLinkService(ctx: MainContext, deps?: AuthDeps): DeepLinkService {
  const { handle, markReady, findInArgv } = getAuthModule(ctx, deps).deepLinks;
  return { handle, markReady, findInArgv };
}

export function createReturnsService(ctx: MainContext, deps?: AuthDeps): ReturnsService {
  const { begin, takeMcpOauthReturn, takeGithubConnectReturn, install } = getAuthModule(ctx, deps).returns;
  return { begin, takeMcpOauthReturn, takeGithubConnectReturn, install };
}

/** auth:status, auth:persistence, auth:signIn, auth:signOutAll, signup:open/close/status. */
export function registerAuthIpc(ctx: MainContext): void {
  registerAuthIpcWith(ctx, getAuthModule(ctx));
}
