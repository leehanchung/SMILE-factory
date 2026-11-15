/** A tiny fake of the windows/labs world behind ctx.windows, plus a test context builder. */
import { vi } from "vitest";
import { DEFAULT_SETTINGS } from "@shared/config";
import type { NotificationSettings, Settings } from "@shared/ipc";
import type { LabRef, MainContext, WindowService } from "../../../src/main/services";
import { makeTestContext } from "../helpers/context";
import { FakeWc, FakeWin } from "./fakes";

export interface LabEntry {
  win: FakeWin;
  wc: FakeWc;
  connId: string;
  shown: boolean;
  parked?: boolean;
  labOrigin?: string;
}

export interface World {
  labs: LabEntry[];
  viewers: Map<FakeWin, FakeWc>;
  readyHooks: Array<(connId: string, wc: FakeWc) => void>;
  settingsListeners: Array<(s: Settings) => void>;
  settings: Settings;
  ctx: MainContext;
  windows: Partial<WindowService> & Record<string, unknown>;
  telemetry: { markCause: ReturnType<typeof vi.fn>; markRecent: ReturnType<typeof vi.fn>; drainShellEvents: ReturnType<typeof vi.fn> };
  addLab(connId: string, opts?: Partial<Omit<LabEntry, "connId">>): LabEntry;
  setNotifications(p: Partial<NotificationSettings>): void;
  fireReady(connId: string, wc: FakeWc): void;
}

export function makeWorld(opts: { platform?: NodeJS.Platform; ctxOverrides?: Record<string, unknown> } = {}): World {
  const w = {
    labs: [] as LabEntry[],
    viewers: new Map<FakeWin, FakeWc>(),
    readyHooks: [] as Array<(connId: string, wc: FakeWc) => void>,
    settingsListeners: [] as Array<(s: Settings) => void>,
    settings: structuredClone(DEFAULT_SETTINGS) as Settings,
  } as World;
  const live = () => w.labs.filter((l) => !l.parked && !l.wc.destroyed);
  const find = (wc: unknown) => live().find((l) => (l.wc as unknown) === wc) ?? null;
  w.windows = {
    findLab: vi.fn((wc: unknown) => {
      const l = find(wc);
      if (!l) return null;
      const ref: LabRef = { win: l.win as never, connId: l.connId, shown: l.shown, labOrigin: l.labOrigin ?? null };
      return ref;
    }),
    windowForConn: vi.fn((connId: string) => {
      const l = live().find((x) => x.connId === connId) ?? w.labs.find((x) => x.parked && x.connId === connId);
      return (l && !l.win.destroyed ? l.win : null) as never;
    }),
    labWebContentsForConn: vi.fn((connId: string) => (live().find((x) => x.connId === connId)?.wc ?? null) as never),
    shownLabWebContents: vi.fn((win: unknown) => (live().find((x) => (x.win as unknown) === win && x.shown)?.wc ?? null) as never),
    viewerWebContents: vi.fn((win: unknown) => (w.viewers.get(win as FakeWin) ?? null) as never),
    revealIfHidden: vi.fn((wc: unknown) => {
      const l = find(wc);
      if (l) l.shown = true;
    }),
    onLabReady: vi.fn((cb: (connId: string, wc: FakeWc) => void) => {
      w.readyHooks.push(cb);
      return () => {};
    }) as never,
    classifyFocusedWindow: vi.fn(() => ({ kind: "lab" as const, connId: "c1" })),
    handleRecoverSession: vi.fn(async () => ({ status: "accepted" as const })),
    openDesktopSettingsFor: vi.fn(),
    openLabSwitcherFor: vi.fn(),
  };
  w.telemetry = { markCause: vi.fn(), markRecent: vi.fn(), drainShellEvents: vi.fn(() => []) };
  w.ctx = makeTestContext({
    env: { platform: opts.platform ?? "darwin" },
    windows: w.windows as never,
    telemetry: w.telemetry as never,
    settings: {
      get: async () => structuredClone(w.settings),
      onChanged: (cb: (s: Settings) => void) => {
        w.settingsListeners.push(cb);
        return () => {};
      },
    },
    ...(opts.ctxOverrides ?? {}),
  } as never);
  w.addLab = (connId, o = {}) => {
    const e: LabEntry = { win: o.win ?? new FakeWin(), wc: o.wc ?? new FakeWc(), connId, shown: o.shown ?? true, ...o };
    w.labs.push(e);
    return e;
  };
  w.setNotifications = (p) => {
    w.settings = { ...w.settings, notifications: { ...w.settings.notifications, ...p } };
  };
  w.fireReady = (connId, wc) => {
    for (const h of w.readyHooks) h(connId, wc);
  };
  return w;
}
