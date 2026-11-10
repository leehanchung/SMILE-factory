/**
 * Pure shell-event queue and transport-failure rate limiter [bridge §4.10,
 * platform §6.4].
 */
import { SHELL_EVENT_CAP, TRANSPORT_FAILURE_DEDUPE_MS } from "@shared/config";

/** Global FIFO capped at `cap`; overflow drops the oldest; drain takes everything. */
export class ShellEventQueue<T> {
  private items: T[] = [];

  constructor(private readonly cap: number = SHELL_EVENT_CAP) {}

  /** Returns the number of dropped (oldest) items. */
  push(item: T): number {
    this.items.push(item);
    const over = Math.max(0, this.items.length - this.cap);
    if (over > 0) this.items.splice(0, over);
    return over;
  }

  drain(): T[] {
    return this.items.splice(0, this.items.length);
  }

  get size(): number {
    return this.items.length;
  }
}

/**
 * `gateway-transport-failure` limiter: key = [operation, hostname]; an event
 * whose `details` JSON equals the key's last recorded one within 5 min is dropped.
 */
export class TransportFailureLimiter {
  private readonly last = new Map<string, { signature: string; recordedAt: number }>();

  constructor(private readonly windowMs: number = TRANSPORT_FAILURE_DEDUPE_MS) {}

  /** True if the event should be kept (and records it). */
  admit(details: Record<string, unknown> | undefined, now: number): boolean {
    const key = JSON.stringify([details?.operation, details?.hostname]);
    const signature = JSON.stringify(details) ?? "undefined";
    const prev = this.last.get(key);
    if (prev && prev.signature === signature && now - prev.recordedAt < this.windowMs) return false;
    this.last.set(key, { signature, recordedAt: now });
    return true;
  }
}
