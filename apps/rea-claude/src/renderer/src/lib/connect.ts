/**
 * Open / connect / update decision logic and result -> phase mapping
 * [renderer §4.7]. Pure: App applies the returned patches to its state.
 */
import { LAB_PHASES } from "@shared/ipc";
import type { ConnectOutcome, HostKeyKind, OpenResult } from "@shared/ipc";
import {
  MANAGED_OTHER_MESSAGE,
  STILL_WAKING_MESSAGE,
  forbiddenMessage,
  unreachableMessage,
} from "./copy";
import type { ConnState, Phase, Reachability } from "./types";

/** Phases during which a flow is in flight. */
export const RUNNING_PHASES: readonly Phase[] = [...LAB_PHASES, "stopping"];

export function isRunningPhase(p: Phase | undefined): boolean {
  return p !== undefined && RUNNING_PHASES.includes(p);
}

/** Row pill "Can’t connect". */
export function isRowFailed(p: Phase | undefined): boolean {
  return p === "error" || p === "needs-setup" || p === "forbidden" || p === "host-key";
}

/** Opening-screen failure card. */
export function isOpeningFailed(p: Phase | undefined): boolean {
  return p === "error" || p === "needs-setup" || p === "forbidden";
}

export function freshConnState(phase: Phase, now: number): ConnState {
  return { phase, startedAt: now, log: "" };
}

export type OpenAction = "update" | "open" | "connect";

/** Step 8 of openHere: update first if out of date, open if live and not known-unreachable, else connect. */
export function chooseOpenAction(opts: {
  outOfDate: boolean;
  live: boolean;
  reachable: Reachability | undefined;
}): OpenAction {
  if (opts.outOfDate) return "update";
  if (opts.live && opts.reachable !== "unreachable") return "open";
  return "connect";
}

/** What App should do with a flow result. */
export interface FlowResult {
  /** Fields merged into the conn state. */
  patch: Pick<ConnState, "phase"> & Partial<Pick<ConnState, "message" | "host" | "hostKeyKind">>;
  /** Auto-expand the log panel. */
  expandLogs: boolean;
  /** Drop the App `lab` if it is this connection and not yet ready. */
  clearPendingLab: boolean;
  /** New lab URL to write back to the saved row. */
  labUrl?: string;
}

function outcomePatch(o: ConnectOutcome): FlowResult["patch"] {
  const phase: Phase = o.status === "opened" || o.status === "canceled" ? "done" : o.status;
  let message: string | undefined;
  if (o.status === "forbidden") message = forbiddenMessage(o.login);
  else if (o.status === "still-waking") message = STILL_WAKING_MESSAGE;
  else if (o.status === "error") message = o.message;
  const host = o.status === "host-key" ? o.host : undefined;
  const hostKeyKind: HostKeyKind | undefined = o.status === "host-key" ? o.kind : undefined;
  return { phase, message, host, hostKeyKind };
}

const QUIET = new Set<ConnectOutcome["status"]>(["opened", "forbidden", "still-waking", "canceled"]);

/** lab.connect result. Every non-opened outcome drops a pending lab view. */
export function mapConnectOutcome(o: ConnectOutcome, savedLabUrl: string): FlowResult {
  return {
    patch: outcomePatch(o),
    expandLogs: !QUIET.has(o.status),
    clearPendingLab: o.status !== "opened",
    labUrl: o.status === "opened" && o.labUrl && o.labUrl !== savedLabUrl ? o.labUrl : undefined,
  };
}

/** lab.update result. Only forbidden drops a pending lab view. */
export function mapUpdateOutcome(o: ConnectOutcome, savedLabUrl: string): FlowResult {
  return {
    patch: outcomePatch(o),
    expandLogs: !QUIET.has(o.status),
    clearPendingLab: o.status === "forbidden",
    labUrl: o.status === "opened" && o.labUrl && o.labUrl !== savedLabUrl ? o.labUrl : undefined,
  };
}

/** lab.open result for a running Lab. */
export function mapOpenResult(r: OpenResult, managed: boolean): FlowResult {
  switch (r.status) {
    case "unreachable":
      return {
        patch: { phase: "error", message: unreachableMessage(managed, r.url) },
        expandLogs: true,
        clearPendingLab: false,
      };
    case "canceled":
      return { patch: { phase: "done" }, expandLogs: false, clearPendingLab: true };
    case "forbidden":
      return {
        patch: { phase: "forbidden", message: forbiddenMessage(r.login) },
        expandLogs: false,
        clearPendingLab: true,
      };
    case "still-waking":
      return {
        patch: { phase: "still-waking", message: STILL_WAKING_MESSAGE },
        expandLogs: false,
        clearPendingLab: true,
      };
    case "other":
      if (managed) {
        return {
          patch: { phase: "error", message: MANAGED_OTHER_MESSAGE },
          expandLogs: true,
          clearPendingLab: false,
        };
      }
      return { patch: { phase: "done" }, expandLogs: false, clearPendingLab: false };
    default:
      return { patch: { phase: "done" }, expandLogs: false, clearPendingLab: false };
  }
}
