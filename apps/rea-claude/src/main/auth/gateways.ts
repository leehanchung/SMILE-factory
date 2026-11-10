/**
 * Gateway origins, alias expansion and gateway-derived URLs (pure).
 * [auth §1, §5; platform §6.3]
 */
import { GATEWAY_ALIASES, GATEWAY_PROD, GATEWAY_STAGING, GATEWAYS, GatewayPath } from "@shared/config";
import type { GatewayUrl } from "@shared/ipc";

/** `staging ? STAGING : PROD`. */
export function gatewayFor(staging: boolean): GatewayUrl {
  return staging ? GATEWAY_STAGING : GATEWAY_PROD;
}

/** True iff `origin` is exactly one of the two canonical gateways (aliases excluded). */
export function isCanonicalGateway(origin: string): origin is GatewayUrl {
  return (GATEWAYS as readonly string[]).includes(origin);
}

export function isStagingGateway(gw: string): boolean {
  return gw === GATEWAY_STAGING;
}

/** Canonical gateway for an URL whose origin is a gateway or one of its aliases; else null. */
export function gatewayOfUrl(url: string): GatewayUrl | null {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  for (const gw of GATEWAYS) {
    if (origin === gw || GATEWAY_ALIASES[gw].includes(origin)) return gw;
  }
  return null;
}

/**
 * `[url, ...same path on each alias origin]` when `url` is on a canonical
 * gateway; `[url]` otherwise (or when it does not parse).
 */
export function expandAliases(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [url];
  }
  if (!isCanonicalGateway(u.origin)) return [url];
  const suffix = url.slice(u.origin.length);
  return [url, ...GATEWAY_ALIASES[u.origin].map((alias) => `${alias}${suffix}`)];
}

export function signupUrl(staging: boolean): string {
  return `${gatewayFor(staging)}${GatewayPath.signup}`;
}

export function signupConfirmUrl(staging: boolean, token: string): string {
  return `${gatewayFor(staging)}${GatewayPath.signupConfirm}?token=${encodeURIComponent(token)}`;
}

export function signupResumeUrl(staging: boolean, resumeToken: string): string {
  return `${gatewayFor(staging)}${GatewayPath.signupResume}?token=${encodeURIComponent(resumeToken)}`;
}
