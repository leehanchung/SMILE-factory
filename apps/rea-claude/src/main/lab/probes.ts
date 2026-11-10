/**
 * HTTP probes and readiness polls. [lab §5.3]
 * Everything (fetch, clock, sleep) is injected so tests never hit the network.
 */
import {
  DATAPLANE_PROBE_TIMEOUT_MS,
  LAB_POLL_INTERVAL_MS,
  LAB_PROBE_TIMEOUT_MS,
  LAB_STATUS_TIMEOUT_MS,
  LabPath,
  MANAGED_WAKE_TIMEOUT_MS,
} from "@shared/config";
import type { LabPhase, LabReach } from "@shared/ipc";
import { networkErrorKey, probeStatusToReach, type ProbeReach } from "./pure";

export interface FetchInit {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  redirect?: "manual" | "follow" | "error";
  cache?: "no-store";
}
export type FetchLike = (url: string, init?: FetchInit) => Promise<{ status: number; ok: boolean }>;

export interface PollClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(t);
  }
}

/** lab:status: `GET <url>/healthz`, 5 s. 2xx → up; else/exception → down; falsy url → unknown. */
export async function labStatus(fetchFn: FetchLike, url: unknown): Promise<LabReach> {
  if (!url || typeof url !== "string") return "unknown";
  try {
    const target = new URL(LabPath.healthz, url).toString();
    const res = await withTimeout(LAB_STATUS_TIMEOUT_MS, (signal) => fetchFn(target, { signal }));
    return res.ok ? "up" : "down";
  } catch {
    return "down";
  }
}

/**
 * One `/api/cluster/version` probe with the Lab token (5 s). Network error →
 * `onError(err)`, then (managed front door) `/healthz/dataplane` 200 → warming.
 */
export async function probeLabVersion(
  fetchFn: FetchLike,
  base: string,
  token: string,
  opts?: { managedFrontDoor?: boolean; onError?: (err: unknown) => void },
): Promise<ProbeReach> {
  try {
    const url = new URL(LabPath.clusterVersion, base).toString();
    const res = await withTimeout(LAB_PROBE_TIMEOUT_MS, (signal) =>
      fetchFn(url, { headers: { authorization: `Bearer ${token}` }, signal }),
    );
    return probeStatusToReach(res.status);
  } catch (err) {
    opts?.onError?.(err);
    if (opts?.managedFrontDoor && (await probeDataplane(fetchFn, base, opts.onError))) return "warming";
    return "unreachable";
  }
}

async function probeDataplane(fetchFn: FetchLike, base: string, onError?: (err: unknown) => void): Promise<boolean> {
  try {
    const url = new URL(LabPath.dataplane, base).toString();
    const res = await withTimeout(DATAPLANE_PROBE_TIMEOUT_MS, (signal) =>
      fetchFn(url, { signal, redirect: "manual", cache: "no-store" }),
    );
    return res.status === 200;
  } catch (err) {
    onError?.(err);
    return false;
  }
}

export type ClusterWait = "ready" | "unreachable" | "canceled";

/**
 * Cluster readiness (`zl`): loop probe → ready returns; at the deadline return
 * ready if any probe was ever warming, else unreachable. Logs once on the first
 * non-ready probe. Abort checked before and after each probe.
 */
export async function waitClusterReady(
  fetchFn: FetchLike,
  clock: PollClock,
  base: string,
  token: string,
  opts: { budgetMs: number; signal?: AbortSignal; onLog?: (line: string) => void },
): Promise<ClusterWait> {
  const deadline = clock.now() + opts.budgetMs;
  let logged = false;
  let sawWarming = false;
  for (;;) {
    if (opts.signal?.aborted) return "canceled";
    const r = await probeLabVersion(fetchFn, base, token);
    if (opts.signal?.aborted) return "canceled";
    if (r === "ready") return "ready";
    if (r === "warming") sawWarming = true;
    if (clock.now() >= deadline) return sawWarming ? "ready" : "unreachable";
    if (!logged) {
      opts.onLog?.("Lab started. Waiting for it to be ready…\n");
      logged = true;
    }
    await clock.sleep(LAB_POLL_INTERVAL_MS);
  }
}

export type ManagedWait = "ready" | "unreachable" | "still-waking" | "canceled";

/**
 * Managed wake poll (`yi`). Before any warming: deadline min(unreachable, timeout)
 * → unreachable. After warming: deadline timeout → still-waking.
 */
export async function waitManagedWake(
  fetchFn: FetchLike,
  clock: PollClock,
  base: string,
  token: string,
  opts: {
    unreachableTimeoutMs?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    onLog?: (line: string) => void;
    onPhase?: (phase: LabPhase) => void;
    warn?: (msg: string) => void;
  },
): Promise<ManagedWait> {
  const seen = new Set<string>();
  const onError = (err: unknown): void => {
    const key = networkErrorKey(err);
    if (seen.has(key)) return;
    seen.add(key);
    opts.warn?.(`reach probe failed against ${base}: ${key}`);
    opts.onLog?.(`Couldn't reach the Lab (${key}) — retrying…\n`);
  };
  const start = clock.now();
  const wakeDeadline = start + (opts.timeoutMs ?? MANAGED_WAKE_TIMEOUT_MS);
  const unreachableDeadline = start + (opts.unreachableTimeoutMs ?? MANAGED_WAKE_TIMEOUT_MS);
  let warming = false;
  for (;;) {
    if (opts.signal?.aborted) return "canceled";
    const r = await probeLabVersion(fetchFn, base, token, { managedFrontDoor: true, onError });
    if (r === "ready") return "ready";
    if (r === "warming" && !warming) {
      warming = true;
      opts.onPhase?.("waking");
      opts.onLog?.("Starting your Lab — this usually takes under a minute…\n");
    }
    const t = clock.now();
    if (warming) {
      if (t >= wakeDeadline) return "still-waking";
    } else if (t >= Math.min(unreachableDeadline, wakeDeadline)) return "unreachable";
    if (opts.signal?.aborted) return "canceled";
    await clock.sleep(LAB_POLL_INTERVAL_MS);
  }
}
