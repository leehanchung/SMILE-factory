import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("./fakes")).electronMock);

import { createTelemetryService } from "../../../src/main/bridge";
import type { Logger } from "../../../src/main/services";
import { emitApp, FakeWc, FakeWin, resetElectron, state } from "./fakes";
import { makeWorld } from "./world";

function setup(identity: { login: string; sub: string } | null = { login: "octo", sub: "u1" }) {
  const logs: Array<[string, unknown[]]> = [];
  const logger = (tag: string): Logger => ({
    debug() {},
    info: (...a: unknown[]) => logs.push([tag, a]),
    warn() {},
    error() {},
  });
  let t = Date.UTC(2026, 10, 8, 12, 0, 0);
  const world = makeWorld({
    ctxOverrides: { auth: { cachedIdentity: () => identity }, logger },
  });
  const tel = createTelemetryService(world.ctx, { now: () => t });
  return { world, tel, logs, advance: (ms: number) => (t += ms), now: () => t };
}

beforeEach(() => resetElectron());
afterEach(() => vi.useRealTimers());

describe("shell events", () => {
  it("builds desktop_shell records, logs them, queues and drains everything", () => {
    const { tel, logs } = setup();
    tel.recordShellEvent("connect-outcome", { connId: "c1", details: { status: "opened" } });
    tel.recordShellEvent("session-death");
    const events = tel.drainShellEvents();
    expect(events).toEqual([
      {
        event: "desktop_shell",
        kind: "connect-outcome",
        connId: "c1",
        details: { status: "opened" },
        build: "test",
        appVersion: "0.0.0-test",
        platform: "darwin",
        login: "octo",
        sub: "u1",
        ts: "2026-11-08T12:00:00.000Z",
      },
      expect.objectContaining({ kind: "session-death" }),
    ]);
    expect(events[1]).not.toHaveProperty("connId");
    expect(events[1]).not.toHaveProperty("details");
    expect(tel.drainShellEvents()).toEqual([]);
    expect(logs.filter(([tag]) => tag === "shell")).toHaveLength(2);
    expect(JSON.parse(String(logs[0]?.[1][0]))).toMatchObject({ kind: "connect-outcome" });
  });

  it("omits identity when signed out", () => {
    const { tel } = setup(null);
    tel.recordShellEvent("down-panel");
    const [e] = tel.drainShellEvents();
    expect(e).not.toHaveProperty("login");
    expect(e).not.toHaveProperty("sub");
  });

  it("keeps the last 100 events", () => {
    const { tel } = setup();
    for (let i = 0; i < 105; i++) tel.recordShellEvent("down-panel", { details: { i } });
    const all = tel.drainShellEvents();
    expect(all).toHaveLength(100);
    expect(all[0]?.details).toEqual({ i: 5 });
  });

  it("rate-limits identical gateway-transport-failure within 5 min", () => {
    const { tel, advance } = setup();
    const details = { operation: "api", hostname: "my.silico.run", code: "ECONNRESET" };
    tel.recordShellEvent("gateway-transport-failure", { details });
    advance(60_000);
    tel.recordShellEvent("gateway-transport-failure", { details: { ...details } });
    tel.recordShellEvent("gateway-transport-failure", { details: { ...details, code: "ETIMEDOUT" } });
    advance(300_000);
    tel.recordShellEvent("gateway-transport-failure", { details: { ...details, code: "ETIMEDOUT" } });
    // other kinds are never limited
    tel.recordShellEvent("down-panel", { details });
    tel.recordShellEvent("down-panel", { details });
    expect(tel.drainShellEvents().map((e) => e.kind)).toEqual([
      "gateway-transport-failure",
      "gateway-transport-failure",
      "gateway-transport-failure",
      "down-panel",
      "down-panel",
    ]);
  });

  it("nudges nobody before the tracker is installed, then exactly one Lab (shown Lab first, else viewer)", () => {
    const { world, tel } = setup();
    const hiddenLab = world.addLab("c0", { shown: false });
    const viewerWin = new FakeWin();
    const viewerWc = new FakeWc();
    world.viewers.set(viewerWin, viewerWc);
    const shown1 = world.addLab("c1");
    const shown2 = world.addLab("c2");
    state.allWindows = [hiddenLab.win, viewerWin, shown1.win, shown2.win];
    tel.recordShellEvent("down-panel");
    expect(shown1.wc.sent).toEqual([]);
    tel.installForegroundTracker();
    tel.recordShellEvent("down-panel");
    expect(shown1.wc.sent).toEqual([["silico:shell-event-nudge"]]);
    expect(shown2.wc.sent).toEqual([]);
    expect(hiddenLab.wc.sent).toEqual([]);
    expect(viewerWc.sent).toEqual([]);
    // no shown Lab → the first viewer
    shown1.shown = false;
    shown2.shown = false;
    tel.recordShellEvent("down-panel");
    expect(viewerWc.sent).toEqual([["silico:shell-event-nudge"]]);
    // destroyed windows are skipped; nothing at all → no throw
    viewerWin.destroyed = true;
    expect(() => tel.recordShellEvent("down-panel")).not.toThrow();
  });
});

describe("foreground tracker", () => {
  it("delivers app_foreground with a recent cause to the focused window's shown Lab", () => {
    const { world, tel, advance, logs } = setup();
    const lab = world.addLab("c1");
    const other = world.addLab("c2");
    state.focusedWindow = lab.win;
    tel.installForegroundTracker();
    tel.installForegroundTracker(); // idempotent
    emitApp("did-resign-active");
    advance(10_000);
    tel.markRecent("notification-shown");
    advance(200);
    tel.markCause("notification-click", "c1");
    advance(1_500);
    emitApp("did-become-active");
    expect(lab.wc.sent).toHaveLength(1);
    expect(other.wc.sent).toHaveLength(0);
    const [ch, evt] = lab.wc.sent[0] as [string, Record<string, unknown>];
    expect(ch).toBe("silico:foreground");
    expect(evt).toMatchObject({
      event: "app_foreground",
      cause: "notification-click",
      details: "c1",
      msSinceResign: 11_700,
      systemIdleSeconds: 7,
      focusedWindow: "lab",
      connId: "c1",
      recent: { "notification-shown": 1_700 },
      build: "test",
      appVersion: "0.0.0-test",
      platform: "darwin",
      login: "octo",
      sub: "u1",
    });
    expect(typeof evt.stack).toBe("string");
    expect(logs.some(([tag]) => tag === "foreground")).toBe(true);
  });

  it("cause older than 1.5 s → external-or-user; cause consumed after one activation", () => {
    const { world, tel, advance } = setup();
    const lab = world.addLab("c1");
    state.focusedWindow = lab.win;
    tel.installForegroundTracker();
    tel.markCause("menu:settings");
    advance(1_501);
    emitApp("did-become-active");
    tel.markCause("popup");
    advance(10);
    emitApp("did-become-active");
    emitApp("did-become-active");
    const causes = lab.wc.sent.map((s) => (s[1] as { cause: string }).cause);
    expect(causes).toEqual(["external-or-user", "popup", "external-or-user"]);
  });

  it("not delivered when the focused window's Lab is hidden or nothing is focused; idle -1 on error", () => {
    const { world, tel } = setup();
    const lab = world.addLab("c1", { shown: false });
    tel.installForegroundTracker();
    state.focusedWindow = lab.win;
    emitApp("did-become-active");
    state.focusedWindow = null;
    emitApp("did-become-active");
    expect(lab.wc.sent).toEqual([]);
    lab.shown = true;
    state.focusedWindow = lab.win;
    state.idle = () => {
      throw new Error("x");
    };
    emitApp("did-become-active");
    expect((lab.wc.sent[0]?.[1] as { systemIdleSeconds: number }).systemIdleSeconds).toBe(-1);
  });

  it("main-process error: immediate error-dialog event (300/2000 slices) and suppresses the next activation if inactive", () => {
    const { world, tel } = setup();
    const lab = world.addLab("c1");
    state.focusedWindow = lab.win;
    tel.installForegroundTracker();
    const err = new Error("x".repeat(400));
    err.stack = "s".repeat(3000);
    tel.reportMainProcessError(err);
    expect(lab.wc.sent).toHaveLength(1);
    const evt = lab.wc.sent[0]?.[1] as { cause: string; details: string; stack: string };
    expect(evt.cause).toBe("error-dialog");
    expect(evt.details).toHaveLength(300);
    expect(evt.stack).toHaveLength(2000);
    emitApp("did-become-active"); // caused by the error box → suppressed
    expect(lab.wc.sent).toHaveLength(1);
    emitApp("did-become-active");
    expect(lab.wc.sent).toHaveLength(2);
    // while active: no suppression
    tel.reportMainProcessError("plain string");
    expect((lab.wc.sent[2]?.[1] as { details: string; stack?: string }).details).toBe("plain string");
    emitApp("did-become-active");
    expect(lab.wc.sent).toHaveLength(4);
    // net::ERR_ errors are ignored
    tel.reportMainProcessError(new Error("net::ERR_CONNECTION_RESET"));
    expect(lab.wc.sent).toHaveLength(4);
  });
});
