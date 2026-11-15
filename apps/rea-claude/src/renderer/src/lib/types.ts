/**
 * Renderer-local view-model types [renderer §3]. IPC payload types come from
 * @shared/ipc; these describe state that only exists inside the shell UI.
 */
import type {
  ConnectionUpsert,
  HostKeyKind,
  LabPhase,
  LabViewState,
  SettingsTab,
} from "@shared/ipc";

/** Per-connection phase: main's LabPhase plus renderer-only phases. */
export type Phase =
  | LabPhase
  | "stopping"
  | "done"
  | "error"
  | "host-key"
  | "needs-setup"
  | "forbidden"
  | "still-waking";

/** Per-connection connect/open/update progress, keyed by connection id. */
export interface ConnState {
  phase: Phase;
  startedAt: number;
  log: string;
  message?: string;
  host?: string;
  hostKeyKind?: HostKeyKind;
}

export type ConnStateMap = Record<string, ConnState>;

export type DiscoveryStatus = "loading" | "ok" | "unavailable";

/** Result of a reachability probe for a deployment. */
export type Reachability = "reachable" | "unreachable";

export type View = "labs" | "settings";

/** SettingsView section; "all" is the single-page compact-picker variant. */
export type SettingsSection = SettingsTab | "all";

/** Embedded Lab view lifecycle as tracked by App. */
export interface LabModel {
  id: string;
  title: string;
  state: LabViewState;
  reason?: string;
}

export interface LabCover {
  shown: boolean;
  title?: string;
}

/** A connection being added or edited (id present => edit). */
export type ConnectionDraft = ConnectionUpsert;

/** Identity of the last successful labs.list reply. */
export interface DiscoverySource {
  gatewayUrl: string;
  login: string;
}
