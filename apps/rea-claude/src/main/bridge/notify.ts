/**
 * Pure notification policy for `silico:notify` [bridge §4.2]: payload
 * validation, settings-based suppression, focus suppression, per-key dedupe
 * and coalescing of "finished" alerts. Electron-free so it unit-tests
 * without mocks; timers and clocks are injected.
 */
import {
  NOTIFY_BATCH_DEBOUNCE_MS,
  NOTIFY_DEDUPE_MS,
  NOTIFY_QUICK_FINISH_S,
  NOTIFY_TEXT_MAX,
} from "@shared/config";
import type { NotificationSettings, NotifyKind, RunStatus } from "@shared/ipc";

/** A validated, normalised notify payload. */
export interface ParsedNotify {
  kind: NotifyKind;
  title: string;
  body: string;
  route: string;
  dedupeKey: string;
  status: RunStatus | undefined;
  elapsedSeconds: number | undefined;
  routeMatchesActiveView: boolean;
}

const KINDS: readonly string[] = ["needsInput", "finished"];
const STATUSES: readonly string[] = ["completed", "failed", "stopped"];

/** Strings are cut to NOTIFY_TEXT_MAX chars; anything else becomes "". */
function clip(v: unknown): string {
  return typeof v === "string" ? v.slice(0, NOTIFY_TEXT_MAX) : "";
}

/** Validate an untrusted payload (`bd`). Returns null when it must be dropped. */
export function parseNotify(raw: unknown): ParsedNotify | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.kind !== "string" || !KINDS.includes(p.kind)) return null;
  const title = clip(p.title);
  const body = clip(p.body);
  const route = typeof p.route === "string" ? p.route : "";
  const dedupeKey = typeof p.dedupeKey === "string" ? p.dedupeKey : "";
  if (!title || !route || !dedupeKey) return null;
  return {
    kind: p.kind as NotifyKind,
    title,
    body,
    route,
    dedupeKey,
    status: typeof p.status === "string" && STATUSES.includes(p.status) ? (p.status as RunStatus) : undefined,
    elapsedSeconds: typeof p.elapsedSeconds === "number" ? p.elapsedSeconds : undefined,
    routeMatchesActiveView: p.routeMatchesActiveView === true,
  };
}

/** Settings gate (step 3): true when the notification must not be shown. */
export function suppressedBySettings(n: ParsedNotify, s: NotificationSettings): boolean {
  if (!s.enabled) return true;
  if (n.kind === "needsInput" && !s.needsInput) return true;
  if (n.kind === "finished" && !s.experimentFinished) return true;
  // Quick successful runs are not announced; failed / stopped ones are.
  if (
    n.kind === "finished" &&
    n.status === "completed" &&
    n.elapsedSeconds != null &&
    n.elapsedSeconds < NOTIFY_QUICK_FINISH_S
  ) {
    return true;
  }
  return false;
}

export interface FocusState {
  /** The sender's window exists and is focused. */
  windowFocused: boolean;
  /** The sender's Lab view is shown. */
  labShown: boolean;
}

/** Focus gate (step 4): the user is already looking at that page. */
export function suppressedByFocus(n: ParsedNotify, f: FocusState, s: NotificationSettings): boolean {
  return f.windowFocused && f.labShown && n.routeMatchesActiveView && !s.notifyWhenActive;
}

/** 5-minute per-key dedupe (`vd`). */
export class Deduper {
  private readonly seen = new Map<string, number>();

  constructor(private readonly windowMs: number = NOTIFY_DEDUPE_MS) {}

  /** Prune entries strictly older than the window, then true if `key` is a duplicate (else record it). */
  isDuplicate(key: string, now: number): boolean {
    for (const [k, t] of this.seen) if (now - t > this.windowMs) this.seen.delete(k);
    if (this.seen.has(key)) return true;
    this.seen.set(key, now);
    return false;
  }

  get size(): number {
    return this.seen.size;
  }
}

/** A notification ready to show, plus click-routing context. */
export interface NotificationRequest<W = unknown> {
  title: string;
  body: string;
  route: string;
  senderWc: W;
  connId: string | null;
  sound: boolean;
}

/** Number of item titles listed in a coalesced body. */
export const COALESCE_LIST_MAX = 3;

/** Merge N>1 buffered "finished" items into one notification (route/sender/sound from the last). */
export function coalesce<W>(items: readonly NotificationRequest<W>[]): NotificationRequest<W> | null {
  const last = items[items.length - 1];
  if (!last) return null;
  if (items.length === 1) return last;
  const titles = items.map((i) => i.title);
  const listed = titles.slice(0, COALESCE_LIST_MAX).join(", ");
  const body = titles.length > COALESCE_LIST_MAX ? `${listed} +${titles.length - COALESCE_LIST_MAX} more` : listed;
  return {
    title: `${items.length} experiments finished`,
    body,
    route: last.route,
    senderWc: last.senderWc,
    connId: last.connId,
    sound: last.sound,
  };
}

export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** 700 ms debounce buffer for "finished" alerts (`Sd`/`kd`). Each push restarts the timer. */
export class Batcher<W> {
  private buffer: NotificationRequest<W>[] = [];
  private timer: unknown = null;

  constructor(
    private readonly emit: (req: NotificationRequest<W>) => void,
    private readonly timers: TimerApi,
    private readonly delayMs: number = NOTIFY_BATCH_DEBOUNCE_MS,
  ) {}

  push(req: NotificationRequest<W>): void {
    this.buffer.push(req);
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => this.flush(), this.delayMs);
  }

  /** Fire now (normally called by the timer). */
  flush(): void {
    const items = this.buffer;
    this.buffer = [];
    this.timer = null;
    const merged = coalesce(items);
    if (merged) this.emit(merged);
  }

  get pending(): number {
    return this.buffer.length;
  }
}
