/** URL and environment helpers [renderer §4.7, §4.11, §4.15]. */
import {
  CONNECT_REACH_BUDGET_MS,
  GATEWAY_STAGING,
  GOOGLE_LINK_HOST_PROD,
  GOOGLE_LINK_HOST_STAGING,
  REACH_BUDGET_DEFAULT_MS,
} from "@shared/config";
import type { Reachability } from "./types";

/** Base URL for a heartbeating Lab's host:port (reachability probe). */
export function labBaseUrl(host: string, port: number): string {
  if (port === 443) return `https://${host}`;
  if (host.endsWith(".silico.run")) return `https://${host}:${port}`;
  return `http://${host}:${port}`;
}

/** lab.open reach budget: short when a probe already saw it up. */
export function openReachBudgetMs(reach: Reachability | undefined): number {
  return reach === "reachable" ? REACH_BUDGET_DEFAULT_MS : CONNECT_REACH_BUDGET_MS;
}

export function isStaging(gatewayUrl: string | undefined): boolean {
  return gatewayUrl === GATEWAY_STAGING;
}

/** Account-linking host shown to Google sign-ins with no Silico account. */
export function googleLinkHost(gatewayUrl: string | undefined): string {
  return isStaging(gatewayUrl) ? GOOGLE_LINK_HOST_STAGING : GOOGLE_LINK_HOST_PROD;
}

export function avatarUrl(login: string, size: number): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=${size * 2}`;
}
