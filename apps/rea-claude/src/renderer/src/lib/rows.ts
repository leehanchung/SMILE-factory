/**
 * Row bookkeeping: auto-claim legacy rows, auto-add hosted Labs, sorting,
 * the "fresh" discovered list and wizard drafts [renderer §4.5, §4.11, §4.15, §6].
 */
import type { Connection, ConnectionUpsert, DiscoveredLab } from "@shared/ipc";
import { nextUnusedIcon } from "./icons";
import { inEnvironment, isManaged, managedRowId } from "./visibility";

const byText = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: "base" });

/** Rows to stamp with owner (and gateway for hosted rows), with their patched values. */
export function rowsToClaim(
  connections: readonly Connection[],
  discovered: readonly DiscoveredLab[],
  login: string,
  gatewayUrl: string,
): Connection[] {
  const reachable = new Set(discovered.map((l) => l.deploymentId));
  return connections
    .filter(
      (c) =>
        !c.dismissed &&
        !!c.deploymentId &&
        reachable.has(c.deploymentId) &&
        (!c.owner || (c.owner === login && isManaged(c) && !c.gatewayUrl)),
    )
    .map((c) => ({
      ...c,
      owner: c.owner ?? login,
      gatewayUrl: c.gatewayUrl ?? (isManaged(c) ? gatewayUrl : undefined),
    }));
}

/** New rows for discovered hosted Labs that have no matching row yet. */
export function managedRowsToAdd(
  connections: readonly Connection[],
  discovered: readonly DiscoveredLab[],
  login: string,
  gatewayUrl: string,
): Connection[] {
  const fresh = discovered.filter(
    (l) =>
      isManaged(l) &&
      !connections.some(
        (c) =>
          c.deploymentId === l.deploymentId &&
          inEnvironment(c, gatewayUrl) &&
          (!c.owner || c.owner === login),
      ),
  );
  const added: Connection[] = [];
  for (const l of fresh) {
    added.push({
      id: managedRowId(login, l.deploymentId, gatewayUrl),
      name: l.deploymentId,
      icon: nextUnusedIcon([...connections, ...added]),
      deploymentId: l.deploymentId,
      labUrl: l.labPublicHost ? `https://${l.labPublicHost}` : "",
      routeMode: l.routeMode,
      owner: login,
      gatewayUrl,
    });
  }
  return added;
}

export function rowLabel(c: Pick<Connection, "name" | "deploymentId">): string {
  return c.name || c.deploymentId || "Untitled";
}

/** Just-added row first, then by name (or deployment id), case-insensitive. */
export function sortConnections(rows: readonly Connection[], justAdded: string | null): Connection[] {
  return [...rows].sort((a, b) => {
    if (justAdded) {
      if (a.id === justAdded && b.id !== justAdded) return -1;
      if (b.id === justAdded && a.id !== justAdded) return 1;
    }
    return byText(a.name || a.deploymentId, b.name || b.deploymentId);
  });
}

export function sortDiscovered(labs: readonly DiscoveredLab[]): DiscoveredLab[] {
  return [...labs].sort((a, b) => byText(a.deploymentId, b.deploymentId));
}

/** Discovered Labs not yet among the visible rows. */
export function freshDiscovered(
  discovered: readonly DiscoveredLab[],
  visible: readonly Connection[],
): DiscoveredLab[] {
  const have = new Set(visible.map((c) => c.deploymentId));
  return sortDiscovered(discovered.filter((l) => !have.has(l.deploymentId)));
}

/** ConfigureForm draft for a picked discovered Lab. */
export function draftFromDiscovered(
  lab: DiscoveredLab,
  visible: readonly Connection[],
): ConnectionUpsert {
  return {
    name: lab.deploymentId,
    icon: nextUnusedIcon(visible),
    deploymentId: lab.deploymentId,
    labUrl: lab.labPublicHost ? `https://${lab.labPublicHost}` : "",
    routeMode: lab.routeMode,
    ssh: isManaged(lab) ? undefined : { host: "", user: "" },
  };
}

/** Stamp owner / gateway on save. */
export function stampForSave(
  draft: ConnectionUpsert,
  login: string | undefined,
  gatewayUrl: string | undefined,
): ConnectionUpsert {
  return {
    ...draft,
    owner: draft.owner ?? login,
    gatewayUrl: draft.gatewayUrl ?? (isManaged(draft) ? gatewayUrl : undefined),
  };
}
