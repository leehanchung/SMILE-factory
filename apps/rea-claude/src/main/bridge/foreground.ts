/**
 * Pure foreground-attribution state machine [bridge §4.9, platform §6.4]:
 * cause marks (valid 1500 ms), recency markers (5000 ms), resign/become-active
 * bookkeeping and the error-dialog suppression flag. Event assembly (focused
 * window, idle time, identity, delivery) is done by the telemetry service.
 */
import { FOREGROUND_CAUSE_WINDOW_MS, FOREGROUND_RECENT_WINDOW_MS } from "@shared/config";

export interface CauseMark {
  cause: string;
  details?: unknown;
  stack?: string;
  ts: number;
}

export interface Attribution {
  cause: string;
  details?: unknown;
  stack?: string;
}

export const EXTERNAL_CAUSE = "external-or-user";

/** A mark at most 1500 ms old wins; otherwise "external-or-user". */
export function attributeForeground(mark: CauseMark | null, now: number): Attribution {
  if (mark && now - mark.ts <= FOREGROUND_CAUSE_WINDOW_MS) {
    return { cause: mark.cause, details: mark.details, stack: mark.stack };
  }
  return { cause: EXTERNAL_CAUSE };
}

/** Markers 0..5000 ms old as `name -> ms ago`; undefined when none qualify. */
export function recentMarkers(markers: ReadonlyMap<string, number>, now: number): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const [name, at] of markers) {
    const ago = now - at;
    if (ago >= 0 && ago <= FOREGROUND_RECENT_WINDOW_MS) out[name] = ago;
  }
  return Object.keys(out).length ? out : undefined;
}

/** What a foreground event should report (before window/identity enrichment). */
export interface ForegroundDraft extends Attribution {
  at: number;
  msSinceResign: number | null;
  recent: Record<string, number> | undefined;
}

export class ForegroundState {
  private active = false;
  private resignedAt: number | null = null;
  private mark: CauseMark | null = null;
  private suppressNext = false;
  private readonly markers = new Map<string, number>();

  markCause(cause: string, details: unknown, stack: string | undefined, now: number): void {
    this.mark = { cause, details, stack, ts: now };
  }

  markRecent(name: string, now: number): void {
    this.markers.set(name, now);
  }

  onResignActive(now: number): void {
    this.active = false;
    this.resignedAt = now;
    this.mark = null;
    this.suppressNext = false;
  }

  /** Returns the event draft, or null when this activation is the error dialog's (already reported). */
  onBecomeActive(now: number): ForegroundDraft | null {
    this.active = true;
    if (this.suppressNext) {
      this.suppressNext = false;
      this.mark = null;
      return null;
    }
    const attr = attributeForeground(this.mark, now);
    this.mark = null;
    return this.draft(now, attr);
  }

  /** Main-process error: report immediately; suppress the activation the error box may cause. */
  onError(details: unknown, stack: string | undefined, now: number): ForegroundDraft {
    if (!this.active) this.suppressNext = true;
    return this.draft(now, { cause: "error-dialog", details, stack });
  }

  get isActive(): boolean {
    return this.active;
  }

  private draft(now: number, attr: Attribution): ForegroundDraft {
    return {
      ...attr,
      at: now,
      msSinceResign: this.resignedAt == null ? null : now - this.resignedAt,
      recent: recentMarkers(this.markers, now),
    };
  }
}
