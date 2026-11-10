/**
 * In-memory stores for the Lab-initiated return flows (Electron-free).
 * [auth §3.6, §4.8; bridge §4.5-4.7]
 */

export type Clock = () => number;

/** Single-use nonces with a TTL; entries are also swept by a timer after TTL. */
export class NonceStore<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: Clock = Date.now,
  ) {}

  add(nonce: string, value: T): void {
    this.entries.set(nonce, { value, expiresAt: this.now() + this.ttlMs });
    const t = setTimeout(() => this.entries.delete(nonce), this.ttlMs);
    (t as { unref?: () => void }).unref?.();
  }

  /** Delete the nonce; return its value unless unknown or expired. */
  consume(nonce: string): T | null {
    const e = this.entries.get(nonce);
    if (!e) return null;
    this.entries.delete(nonce);
    return this.now() > e.expiresAt ? null : e.value;
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Per-key queue: at most `max` entries (oldest dropped), each expiring after `ttlMs`; take pops the newest. */
export class BoundedLifoQueue<T> {
  private readonly queues = new Map<string, { value: T; timer: ReturnType<typeof setTimeout> }[]>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
  ) {}

  push(key: string, value: T): void {
    const q = this.queues.get(key) ?? [];
    if (q.length >= this.max) {
      const dropped = q.shift();
      if (dropped) clearTimeout(dropped.timer);
    }
    const entry = {
      value,
      timer: setTimeout(() => {
        const cur = this.queues.get(key);
        if (!cur) return;
        const i = cur.indexOf(entry);
        if (i !== -1) cur.splice(i, 1);
        if (cur.length === 0) this.queues.delete(key);
      }, this.ttlMs),
    };
    (entry.timer as { unref?: () => void }).unref?.();
    q.push(entry);
    this.queues.set(key, q);
  }

  take(key: string): T | null {
    const q = this.queues.get(key);
    const e = q?.pop();
    if (!q || !e) return null;
    clearTimeout(e.timer);
    if (q.length === 0) this.queues.delete(key);
    return e.value;
  }

  size(key: string): number {
    return this.queues.get(key)?.length ?? 0;
  }
}

/** Latest-wins value per key, taken once. */
export class PendingByKey<T> {
  private readonly map = new Map<string, T>();
  set(key: string, value: T): void {
    this.map.set(key, value);
  }
  take(key: string): T | null {
    if (!this.map.has(key)) return null;
    const v = this.map.get(key) as T;
    this.map.delete(key);
    return v;
  }
}

/** GitHub-connect slot: an "error" never overwrites a stored "success". */
export class StickySuccessSlot<T extends { outcome: string }> extends PendingByKey<T> {
  private readonly last = new Map<string, T>();
  override set(key: string, value: T): void {
    if (value.outcome === "error" && this.last.get(key)?.outcome === "success") return;
    this.last.set(key, value);
    super.set(key, value);
  }
  override take(key: string): T | null {
    this.last.delete(key);
    return super.take(key);
  }
}
