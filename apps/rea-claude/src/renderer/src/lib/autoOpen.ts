/**
 * Auto-open on launch [renderer §4.14]. One decision per evaluation; App
 * applies it and marks the attempt as tried for every kind except "wait".
 */
import type { Connection, DiscoveredLab } from "@shared/ipc";
import type { DiscoveryStatus } from "./types";
import { isManaged } from "./visibility";

export type AutoOpenDecision =
  /** Not decidable yet (or already decided): do nothing. */
  | { kind: "wait" }
  /**
   * Give up: close the launch gate. `probeLastOpened` reproduces the
   * original's discarded `lastOpened.get` on the initial window. `signup`
   * opens the signup overlay; `open` opens that row.
   */
  | { kind: "retire"; probeLastOpened: boolean; signup?: true; open?: Connection }
  /** Ask main for the last opened id and open it if still visible. */
  | { kind: "last-opened" };

export interface AutoOpenInput {
  tried: boolean;
  touched: boolean;
  isInitialWin: boolean | null;
  signedIn: boolean;
  connectionsLoaded: boolean;
  discoveryLoaded: boolean;
  discoveryStatus: DiscoveryStatus;
  discovered: readonly DiscoveredLab[];
  visible: readonly Connection[];
  launchGate: boolean;
}

export function decideAutoOpen(s: AutoOpenInput): AutoOpenDecision {
  if (s.tried) return { kind: "wait" };
  if (s.isInitialWin === null || !s.signedIn) return { kind: "wait" };
  const probe = s.isInitialWin === true;
  if (s.touched) return { kind: "retire", probeLastOpened: probe };
  if (!s.connectionsLoaded || !s.discoveryLoaded) return { kind: "wait" };
  if (!s.isInitialWin) return { kind: "retire", probeLastOpened: false };

  if (s.discoveryStatus === "ok") {
    if (s.discovered.length === 0 && s.visible.length === 0) {
      return { kind: "retire", probeLastOpened: probe, signup: true };
    }
    const only = s.discovered.length === 1 ? s.discovered[0] : undefined;
    if (only) {
      const row = s.visible.find((c) => c.deploymentId === only.deploymentId);
      if (row) return { kind: "retire", probeLastOpened: probe, open: row };
      // A hosted Lab gets its row from the auto-add effect; wait for it while the gate is up.
      if (isManaged(only) && s.launchGate) return { kind: "wait" };
      return { kind: "retire", probeLastOpened: probe };
    }
  }
  return { kind: "last-opened" };
}

/** Resolve a lastOpened id against the visible rows. */
export function lastOpenedRow(
  id: string | null,
  touched: boolean,
  visible: readonly Connection[],
): Connection | undefined {
  if (touched || !id) return undefined;
  return visible.find((c) => c.id === id);
}
