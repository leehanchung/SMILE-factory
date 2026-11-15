/**
 * Which saved connections a signed-in account may see, discovery status and
 * developer-tab visibility [renderer §4.5, §4.6, §4.17].
 */
import type { AuthState, Connection, DiscoveredLab, Settings, SettingsTab } from "@shared/ipc";
import type { DiscoveryStatus, DiscoverySource } from "./types";

interface Routed {
  routeMode?: string;
}

export function isManaged(x: Routed): boolean {
  return x.routeMode === "managed";
}

export function isLocal(x: Routed): boolean {
  return x.routeMode === "local";
}

/** A row without a gateway stamp belongs to every environment. */
export function inEnvironment(c: Pick<Connection, "gatewayUrl">, activeGateway: string): boolean {
  return !c.gatewayUrl || c.gatewayUrl === activeGateway;
}

/** Stable id of an auto-added hosted Lab row. */
export function managedRowId(login: string, deploymentId: string, gatewayUrl: string): string {
  return `managed:${login}:${deploymentId}:${gatewayUrl}`;
}

type VisibilityFields = Pick<Connection, "dismissed" | "gatewayUrl" | "deploymentId" | "owner">;

/**
 * Visibility rule, in order: dismissed rows are hidden; rows stamped for
 * another gateway are hidden; an unstamped row needs to be vouched for by
 * discovery (or be the user's own while discovery is unavailable); finally
 * an owned row is visible only to its owner, an unowned one only if vouched.
 */
export function isVisibleTo(
  c: VisibilityFields,
  login: string,
  activeGateway: string,
  discovery: DiscoveryStatus,
  byDeployment: ReadonlyMap<string, unknown> | ReadonlySet<string>,
): boolean {
  if (c.dismissed) return false;
  if (!inEnvironment(c, activeGateway)) return false;
  const vouched = !c.deploymentId || (discovery === "ok" && byDeployment.has(c.deploymentId));
  const ownFallback = discovery === "unavailable" && !!c.owner && c.owner === login;
  if (!c.gatewayUrl && !vouched && !ownFallback) return false;
  if (c.owner) return c.owner === login;
  return vouched;
}

/** Index discovered labs by deployment id (empty unless discovery is ok). */
export function discoveryIndex(
  discovered: readonly DiscoveredLab[],
  status: DiscoveryStatus,
): Map<string, DiscoveredLab> {
  return new Map(status === "ok" ? discovered.map((l) => [l.deploymentId, l] as const) : []);
}

export function visibleConnections(
  connections: readonly Connection[],
  auth: AuthState | undefined,
  discovered: readonly DiscoveredLab[],
  status: DiscoveryStatus,
): Connection[] {
  if (auth?.status !== "signed-in") return [];
  const index = discoveryIndex(discovered, status);
  return connections.filter((c) => isVisibleTo(c, auth.login, auth.gatewayUrl, status, index));
}

/**
 * "loading" until signed in and the first labs.list reply arrived; then "ok"
 * when the last successful reply matches the current identity, else
 * "unavailable".
 */
export function discoveryStatus(
  auth: AuthState | undefined,
  loaded: boolean,
  source: DiscoverySource | null,
): DiscoveryStatus {
  if (auth?.status !== "signed-in" || !loaded) return "loading";
  return source && source.gatewayUrl === auth.gatewayUrl && source.login === auth.login
    ? "ok"
    : "unavailable";
}

/** App rule: developer tab shows for developers or when any dev setting is on. */
export function developerSettingsVisible(
  auth: AuthState | undefined,
  settings: Settings | null | undefined,
): boolean {
  if (auth?.status === "signed-in" && auth.developer) return true;
  if (!settings) return false;
  return (
    settings.developerMode ||
    settings.staging ||
    settings.previewBuilds ||
    settings.verbose ||
    settings.skipVersionCheck
  );
}

/** Settings-sheet variant: also visible while the developer tab is selected. */
export function modalDeveloperVisible(
  auth: AuthState | undefined,
  settings: Settings | null | undefined,
  tab: SettingsTab,
): boolean {
  return tab === "developer" || developerSettingsVisible(auth, settings);
}
