/**
 * Pure lifecycle rules (windows spec §3.4, §4.8, §4.9).
 */
import {
  CRASH_MAX,
  CRASH_WINDOW_MS,
  LONG_SUSPEND_MS,
  MEMORY_SHED_THRESHOLD_PCT,
  WATCHDOG_MAX_IDLE_S,
} from "@shared/config";
import type { LabViewState } from "@shared/ipc";

export type LabVis = "hidden" | "loading" | "shown";

/** Crash-loop guard (`Mi`): revive unless clean exit or ≥3 crashes in the last 60 s. */
export function shouldRevive(reason: string, history: readonly number[], now: number): boolean {
  if (reason === "clean-exit") return false;
  return history.filter((t) => now - t < CRASH_WINDOW_MS).length < CRASH_MAX;
}

/** `lab:state` to resend after a shell reload (`Tc`). */
export function labStateFor(vis: LabVis, downAlreadyReported: boolean): LabViewState {
  if (vis === "shown") return "ready";
  return downAlreadyReported ? "down" : "loading";
}

/** Reload targets the Lab view only in these visibilities (`Rc`). */
export function isReloadableVis(vis: LabVis): boolean {
  return vis === "loading" || vis === "shown";
}

export interface HoldState {
  vis: LabVis;
  reauthing: boolean;
  userLeft: boolean;
}

/** Window holds a Lab (compact requests are ignored) (`Dl`). */
export function windowHoldsLab(entry: HoldState | undefined, parked: boolean): boolean {
  if (entry && (entry.vis !== "hidden" || (entry.reauthing && !entry.userLeft))) return true;
  return parked;
}

/** Existing entry must be replaced before opening `connId` (`Ic`). */
export function entryNeedsReplace(entry: { connId: string; destroyed: boolean } | undefined, connId: string): boolean {
  return !!entry && (entry.destroyed || entry.connId !== connId);
}

/** Resume after a suspend ≥ 60 s counts as "long" (`hf`). */
export function isLongSuspend(suspendedAt: number, now: number): boolean {
  return suspendedAt > 0 && now - suspendedAt >= LONG_SUSPEND_MS;
}

/** Shed backgrounded Lab views when available memory is below 15 % (`sf`). */
export function shouldShedMemory(level: number | null | undefined): boolean {
  return level !== null && level !== undefined && level < MEMORY_SHED_THRESHOLD_PCT;
}

/** Watchdog only probes Labs the user is looking at (`Pc`). */
export function watchdogPresence(focused: boolean, idleSeconds: number): boolean {
  return focused && idleSeconds < WATCHDOG_MAX_IDLE_S;
}

/** `/healthz` status classification for managed Labs. */
export function classifyHealthStatus(status: number): "up" | "down" {
  return status >= 500 || status === 425 ? "down" : "up";
}

/** Normalize a page-liveness probe result (`Fc`). */
export function normalizePageProbe(v: unknown): "alive" | "dead" | "unknown" {
  return v === "alive" || v === "dead" ? v : "unknown";
}

/** Settings-sheet tab from a navigate dest (`dest.split(":")[1] ?? "notifications"`). */
export function sheetTabFor(dest: string): string {
  return dest.split(":")[1] ?? "notifications";
}
