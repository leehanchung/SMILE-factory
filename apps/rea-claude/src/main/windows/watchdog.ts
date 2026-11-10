/**
 * Liveness watchdog for shown Lab views (windows spec §4.9 "Watchdog").
 * Electron-free: every probe and side effect is injected.
 *
 * Per tick, for each shown (winId, connId) whose window is "present"
 * (focused, or its settings sheet is, and system idle < 120 s):
 *  - managed Labs: probe `<labOrigin>/healthz`; 2 consecutive "down" → rewake.
 *  - page probe: "dead" strikes at least 10 s apart; 2 strikes → rewake, at
 *    most 2 page rewakes per (window, connId).
 */
import { WATCHDOG_MAX_PAGE_REWAKES, WATCHDOG_PAGE_STRIKE_GAP_MS, WATCHDOG_STRIKES } from "@shared/config";

export interface RevealedLab {
  winId: number;
  connId: string;
}

export interface WatchdogDeps {
  revealed(): RevealedLab[];
  presence(winId: number): boolean;
  isManaged(connId: string): Promise<boolean>;
  labOrigin(winId: number): string | null;
  probe(origin: string): Promise<"up" | "down" | "unknown">;
  probePage(winId: number): Promise<"alive" | "dead" | "unknown">;
  rewake(winId: number, connId: string): void;
  now?: () => number;
}

interface Strikes {
  connId: string;
  pod: number;
  page: number;
  lastPageStrikeAt: number;
}

export interface Watchdog {
  tick(): Promise<void>;
}

export function createWatchdog(deps: WatchdogDeps): Watchdog {
  const now = deps.now ?? Date.now;
  const strikes = new Map<number, Strikes>();
  const pageRewakes = new Map<number, { connId: string; count: number }>();
  let running = false;

  const strikesFor = (winId: number, connId: string): Strikes => {
    const cur = strikes.get(winId);
    const s = cur?.connId === connId ? cur : { connId, pod: 0, page: 0, lastPageStrikeAt: 0 };
    strikes.set(winId, s);
    return s;
  };
  const rewakesFor = (winId: number, connId: string): number => {
    const r = pageRewakes.get(winId);
    return r?.connId === connId ? r.count : 0;
  };
  const stillRevealed = (winId: number, connId: string): boolean =>
    deps.revealed().some((r) => r.winId === winId && r.connId === connId);

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const revealed = deps.revealed();
      const live = new Set(revealed.map((r) => r.winId));
      for (const id of [...strikes.keys()]) if (!live.has(id)) strikes.delete(id);

      for (const { winId, connId } of revealed) {
        if (!deps.presence(winId)) continue;
        if (await deps.isManaged(connId)) {
          const origin = deps.labOrigin(winId);
          if (origin) {
            const health = await deps.probe(origin);
            const s = strikesFor(winId, connId);
            if (health === "down") {
              s.pod += 1;
              if (s.pod >= WATCHDOG_STRIKES) {
                strikes.delete(winId);
                if (stillRevealed(winId, connId)) deps.rewake(winId, connId);
                continue;
              }
            } else {
              s.pod = 0;
            }
          }
        }
        const page = await deps.probePage(winId);
        const s = strikesFor(winId, connId);
        if (page === "alive") {
          s.page = 0;
          s.lastPageStrikeAt = 0;
          pageRewakes.delete(winId);
        } else if (page === "unknown") {
          s.page = 0;
          s.lastPageStrikeAt = 0;
        } else if (
          rewakesFor(winId, connId) < WATCHDOG_MAX_PAGE_REWAKES &&
          (s.lastPageStrikeAt === 0 || now() - s.lastPageStrikeAt >= WATCHDOG_PAGE_STRIKE_GAP_MS)
        ) {
          s.page += 1;
          s.lastPageStrikeAt = now();
          if (s.page >= WATCHDOG_STRIKES) {
            strikes.delete(winId);
            if (stillRevealed(winId, connId)) {
              pageRewakes.set(winId, { connId, count: rewakesFor(winId, connId) + 1 });
              deps.rewake(winId, connId);
            }
          }
        }
      }
    } finally {
      running = false;
    }
  }

  return { tick };
}
