/**
 * Pure URL / navigation policy for Lab views, viewer views and popups
 * (windows spec §4.11, §6.2, §6.3; bridge spec §4.13; auth spec §4.7).
 */
import { ALL_GATEWAY_ORIGINS, GATEWAY_ALIASES, GATEWAYS, LabPath } from "@shared/config";
import type { GatewayUrl } from "@shared/ipc";

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isHttpProtocol(u: URL): boolean {
  return u.protocol === "http:" || u.protocol === "https:";
}

export function isHttpUrl(url: string): boolean {
  const u = parse(url);
  return !!u && isHttpProtocol(u);
}

/** Same origin (both parseable). (`Ne`) */
export function sameOrigin(a: string, b: string): boolean {
  const ua = parse(a);
  const ub = parse(b);
  return !!ua && !!ub && ua.origin === ub.origin;
}

/** Canonical gateway owning the URL's origin (canonical or alias), else null. (`J`) */
export function gatewayOf(url: string): GatewayUrl | null {
  const u = parse(url);
  if (!u) return null;
  return GATEWAYS.find((g) => u.origin === g || (GATEWAY_ALIASES[g] ?? []).includes(u.origin)) ?? null;
}

/** Gateway `/login` or `/login/…` page on any gateway origin. (`$o`) */
export function isAuthWall(url: string): boolean {
  const u = parse(url);
  if (!u) return false;
  return ALL_GATEWAY_ORIGINS.includes(u.origin) && (u.pathname === "/login" || u.pathname.startsWith("/login/"));
}

/** Same-origin `/api/…` main-frame navigation → open as a document viewer. (`Sc`) */
export function isOpenDocument(target: string, current: string): boolean {
  const t = parse(target);
  const c = parse(current);
  return !!t && !!c && t.origin === c.origin && t.pathname.startsWith("/api/");
}

/** http(s) target on a different origin than the current page. (`kc`) */
export function isCrossOriginHttp(target: string, current: string): boolean {
  const t = parse(target);
  if (!t || !isHttpProtocol(t)) return false;
  const c = parse(current);
  if (!c) return false;
  return t.origin !== c.origin;
}

/** Redirect leaving the Lab to a non-Lab, non-gateway, cross-origin http(s) URL. (`Cc`) */
export function isRedirectEscape(target: string, current: string, labOrigin: string | null): boolean {
  const t = parse(target);
  if (!t || !isHttpProtocol(t) || t.origin === labOrigin || ALL_GATEWAY_ORIGINS.includes(t.origin)) return false;
  const c = parse(current);
  if (c && c.origin === t.origin) return false;
  return true;
}

export type LabNavDecision =
  | "freeze"
  | "open-document"
  | "auth-wall-reauth"
  | "auth-wall-neutralize"
  | "browser"
  | "in-app";

export interface LabNavContext {
  reauthing: boolean;
  /** true for `will-navigate`, false for main-frame `will-redirect`. */
  fromNavigation: boolean;
  shown: boolean;
  labOrigin: string | null;
}

/** Lab view navigation decision table (§6.3, `Ec`). */
export function decideLabNavigation(target: string, current: string, ctx: LabNavContext): LabNavDecision {
  if (ctx.reauthing) return "freeze";
  if (ctx.fromNavigation && isOpenDocument(target, current)) return "open-document";
  if (isAuthWall(target)) return ctx.shown ? "auth-wall-reauth" : "auth-wall-neutralize";
  if (ctx.fromNavigation && isCrossOriginHttp(target, current)) return "browser";
  if (!ctx.fromNavigation && isRedirectEscape(target, current, ctx.labOrigin)) return "browser";
  return "in-app";
}

export type FrameNavDecision = "allow" | "block-external";

/**
 * Sub-frame navigation guard (§6.2, `cl`). `frameUrl` = the frame's current
 * URL, `topUrl` = the top page URL. Non-http(s) targets and unparseable
 * frame URLs are allowed (not handled).
 */
export function decideFrameNavigation(frameUrl: string, target: string, topUrl: string): FrameNavDecision {
  const t = parse(target);
  if (!t || !isHttpProtocol(t)) return "allow";
  if (frameUrl === "about:srcdoc") return "block-external";
  if (sameOrigin(target, topUrl)) return "allow";
  const f = parse(frameUrl);
  if (!f) return "allow";
  return t.origin !== f.origin ? "block-external" : "allow";
}

/**
 * Viewer content may be revealed on this URL (§4.11 step 3, `wr`): not the
 * auth callback, not `/` with `return_to`, not an artifact/report landing.
 */
export function isRevealablePath(url: string): boolean {
  const u = parse(url);
  if (!u) return true;
  const path = u.pathname.replace(/\/+$/, "") || "/";
  if (path.toLowerCase() === LabPath.authCallback || (path === "/" && u.searchParams.has("return_to"))) return false;
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 2 && parts[0] === "artifacts") return false;
  if (parts.length === 2 && (parts[0] === "reports" || parts[0] === "papers" || parts[0] === "publications")) return false;
  return true;
}

/** Current Lab route to return to after a reopen (`vc`/`Hi`): path+search+hash, excluding "/" and the auth callback. */
export function labReturnTo(url: string): string | null {
  const u = parse(url);
  if (!u || !isHttpProtocol(u) || u.pathname.startsWith("//")) return null;
  const lower = u.pathname.toLowerCase();
  if (lower === LabPath.authCallback || lower.startsWith(`${LabPath.authCallback}/`)) return null;
  const route = `${u.pathname}${u.search}${u.hash}`;
  return route === "/" ? null : route;
}

const LAB_ROUTE_RE =
  /^\/(?:auth\/callback|home|settings|workspaces(?:\/new)?|workspace(?:\/[^/]+(?:\/.*)?)?|folders\/[^/]+|org\/[^/]+\/(?:settings|new)|join-org\/[^/]+|onboarding\/compute|cluster|reports(?:\/[^/]+)?|papers(?:\/[^/]+)?|publications(?:\/[^/]+)?|artifacts\/[^/]+(?:\/read)?|s\/(?:th_|sh_)[^/]+(?:\/(?:thread|experiment)\/[^/]+)?)\/?$/;

const ROUTE_BASE = "https://route.invalid";

/** Lab route allow-list (bridge §4.13, `rt`). Accepts absolute URLs or paths. */
export function isAllowedLabRoute(url: string): boolean {
  let path: string;
  try {
    path = new URL(url, ROUTE_BASE).pathname.toLowerCase();
  } catch {
    return false;
  }
  return path === "/" || LAB_ROUTE_RE.test(path);
}

/** Allow-listed recovery route (path+search) excluding `/auth/…` (`Ut`). */
export function recoveryRoute(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url, ROUTE_BASE);
  } catch {
    return null;
  }
  if (!isAllowedLabRoute(u.href) || u.pathname.toLowerCase().startsWith("/auth/")) return null;
  return u.pathname + u.search;
}

/** Gateway, `https://*.silico.run`, or `http://localhost|127.0.0.1` without credentials (`Uo`). */
export function isLabishUrl(url: string): boolean {
  const u = parse(url);
  if (!u || u.username || u.password) return false;
  if (gatewayOf(url)) return true;
  if (u.protocol === "https:" && u.hostname.endsWith(".silico.run")) return true;
  return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
}

/** Viewer content gets the Lab bridge preload (`ul`). */
export function viewerNeedsLabBridge(url: string): boolean {
  return isLabishUrl(url) && (isAllowedLabRoute(url) || !!gatewayOf(url));
}

export interface RecoveryContext {
  gatewayUrl: GatewayUrl;
  deployment?: string;
  sub?: string;
}

export interface RecoveryTarget {
  originalUrl: string;
  route: string;
  context?: RecoveryContext;
}

/** Recovery target for a viewer URL (`Jc`); null => this URL cannot be recovered. */
export function parseRecoveryTarget(url: string): RecoveryTarget | null {
  if (!isLabishUrl(url)) return null;
  const u = new URL(url);
  const gw = gatewayOf(url);
  const route = gw ? (u.searchParams.get("return_to") ?? "/") : u.pathname + u.search;
  if (!route.startsWith("/") || route.startsWith("//") || route.includes("\\")) return null;
  const r = recoveryRoute(route);
  if (!r) return null;
  const deployment = gw ? u.searchParams.get("deployment") || undefined : undefined;
  return {
    originalUrl: url,
    route: r,
    ...(gw ? { context: { gatewayUrl: gw, ...(deployment ? { deployment } : {}) } } : {}),
  };
}

/** origin+pathname of an http(s) URL, else "" (telemetry, `Bs`). */
export function pageLabel(url: string): string {
  const u = parse(url);
  return u && isHttpProtocol(u) ? `${u.origin}${u.pathname}` : "";
}

/** URL host or undefined (`si`). */
export function urlHost(url: string): string | undefined {
  return parse(url)?.host;
}

/** Is `url` the gateway root `/` (viewer recovery trigger)? */
export function isGatewayRoot(url: string): boolean {
  const u = parse(url);
  return !!u && !!gatewayOf(url) && u.pathname === "/";
}
