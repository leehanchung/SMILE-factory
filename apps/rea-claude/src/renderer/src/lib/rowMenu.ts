/** Row liveness and overflow-menu entries [renderer §4.5]. */
import type { DiscoveredLab } from "@shared/ipc";

/** Heartbeating per discovery and not stopped locally. */
export function isLive(
  disc: Pick<DiscoveredLab, "stale"> | undefined,
  deploymentId: string,
  stopped: ReadonlySet<string>,
): boolean {
  return !!(disc?.stale === false && deploymentId && !stopped.has(deploymentId));
}

export type RowAction = "tunnel" | "update" | "stop" | "edit" | "remove";

export interface RowMenuEntry {
  action: RowAction;
  label: string;
  danger?: boolean;
}

/** Entries in order; the first three are developer-mode only. */
export function rowMenuEntries(s: {
  developerMode: boolean;
  sshHost: string | undefined;
  deploymentId: string;
  busy: boolean;
  outOfDate: boolean;
  live: boolean;
  managed: boolean;
  previewPinned: boolean;
}): RowMenuEntry[] {
  const out: RowMenuEntry[] = [];
  if (s.developerMode) {
    if (s.sshHost && !s.busy) out.push({ action: "tunnel", label: "Open via SSH tunnel" });
    if (s.sshHost && s.deploymentId && !s.busy && !s.outOfDate) {
      out.push({ action: "update", label: s.previewPinned ? "Update Lab (preview)" : "Update Lab" });
    }
    if (s.live && !s.busy && !s.managed) out.push({ action: "stop", label: "Stop Lab" });
  }
  out.push({ action: "edit", label: "Edit" });
  out.push({ action: "remove", label: "Remove", danger: true });
  return out;
}
