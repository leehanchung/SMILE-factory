/**
 * Signup view URL policy (pure). [auth §4.5 step 4]
 */
import { GATEWAYS, GITHUB_ORIGIN, GatewayPath } from "@shared/config";

export type SignupUrlClass = "blocked" | "system-auth" | "embedded" | "external";

const GATEWAY_ORIGINS = new Set<string>(GATEWAYS);
const EMBEDDED_ORIGINS = new Set<string>([...GATEWAYS, GITHUB_ORIGIN]);

export function classifySignupUrl(url: string): SignupUrlClass {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "blocked";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "blocked";
  if (GATEWAY_ORIGINS.has(u.origin) && u.pathname === GatewayPath.signupGithub) return "system-auth";
  if (EMBEDDED_ORIGINS.has(u.origin)) return "embedded";
  return "external";
}

/** True iff the URL's origin is one of the two canonical gateways. */
export function isGatewayPage(url: string): boolean {
  try {
    return GATEWAY_ORIGINS.has(new URL(url).origin);
  } catch {
    return false;
  }
}

/** URL to open in the system browser for `system-auth` (adds `desktop=1`) or `external`; else null. */
export function systemBrowserUrl(url: string): string | null {
  const cls = classifySignupUrl(url);
  if (cls !== "system-auth" && cls !== "external") return null;
  const u = new URL(url);
  if (cls === "system-auth") u.searchParams.set("desktop", "1");
  return u.href;
}

/** Signup bar height scaled by the host zoom factor (invalid zoom => unscaled). */
export function scaleByZoom(px: number, zoom: number): number {
  return Number.isFinite(zoom) && zoom > 0 ? px * zoom : px;
}

export function signupBounds(
  contentSize: readonly [number, number] | number[],
  barPx: number,
  zoom: number,
): { x: number; y: number; width: number; height: number } {
  const width = contentSize[0] ?? 0;
  const height = contentSize[1] ?? 0;
  const top = Math.ceil(scaleByZoom(barPx, zoom));
  return { x: 0, y: top, width, height: Math.max(0, height - top) };
}
