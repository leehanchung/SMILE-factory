import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("./fakes")).electronMock);

import type { WebContents } from "electron";
import { createBridgeService } from "../../../src/main/bridge";
import { bridgeInternals } from "../../../src/main/bridge/service";
import { emitApp, FakeNotification, FakeSession, FakeWc, FakeWin, resetElectron, state } from "./fakes";
import { makeWorld, type World } from "./world";

const asWc = (wc: FakeWc) => wc as unknown as WebContents;

function setup(opts: Parameters<typeof makeWorld>[0] = {}) {
  const world = makeWorld(opts);
  const svc = createBridgeService(world.ctx);
  const internals = bridgeInternals(world.ctx);
  internals.installHooks();
  return { world, svc, internals };
}

const notifyPayload = (o: Record<string, unknown> = {}) => ({
  kind: "needsInput",
  title: "Needs input",
  body: "b",
  route: "/w/1",
  dedupeKey: `k-${Math.random()}`,
  ...o,
});

beforeEach(() => {
  resetElectron();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("notify pipeline", () => {
  it("shows needsInput immediately with silent = !sound and marks notification-shown", async () => {
    const { world, internals } = setup();
    const lab = world.addLab("c1");
    world.setNotifications({ sound: false });
    await internals.handleNotify(asWc(lab.wc), notifyPayload());
    expect(FakeNotification.instances).toHaveLength(1);
    const n = FakeNotification.instances[0];
    expect(n?.opts).toEqual({ title: "Needs input", body: "b", silent: true });
    expect(n?.shown).toBe(true);
    expect(world.telemetry.markRecent).toHaveBeenCalledWith("notification-shown");
  });

  it("drops invalid payloads and settings-suppressed ones", async () => {
    const { world, internals } = setup();
    const lab = world.addLab("c1");
    await internals.handleNotify(asWc(lab.wc), { kind: "bogus" });
    world.setNotifications({ needsInput: false });
    await internals.handleNotify(asWc(lab.wc), notifyPayload());
    world.setNotifications({ needsInput: true, enabled: false });
    await internals.handleNotify(asWc(lab.wc), notifyPayload());
    world.setNotifications({ enabled: true });
    await internals.handleNotify(asWc(lab.wc), notifyPayload({ kind: "finished", status: "completed", elapsedSeconds: 10 }));
    vi.advanceTimersByTime(1000);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("does nothing when Notification is unsupported", async () => {
    const { world, internals } = setup();
    FakeNotification.supported = false;
    await internals.handleNotify(asWc(world.addLab("c1").wc), notifyPayload());
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("is quiet while the user is viewing that page, unless notifyWhenActive", async () => {
    const { world, internals } = setup();
    const lab = world.addLab("c1");
    lab.win.focused = true;
    await internals.handleNotify(asWc(lab.wc), notifyPayload({ routeMatchesActiveView: true }));
    expect(FakeNotification.instances).toHaveLength(0);
    // not focused → shown
    lab.win.focused = false;
    await internals.handleNotify(asWc(lab.wc), notifyPayload({ routeMatchesActiveView: true }));
    expect(FakeNotification.instances).toHaveLength(1);
    // hidden lab → shown
    lab.win.focused = true;
    lab.shown = false;
    await internals.handleNotify(asWc(lab.wc), notifyPayload({ routeMatchesActiveView: true }));
    expect(FakeNotification.instances).toHaveLength(2);
    lab.shown = true;
    world.setNotifications({ notifyWhenActive: true });
    await internals.handleNotify(asWc(lab.wc), notifyPayload({ routeMatchesActiveView: true }));
    expect(FakeNotification.instances).toHaveLength(3);
  });

  it("dedupes the same key for 5 minutes", async () => {
    const { world, internals } = setup();
    const lab = world.addLab("c1");
    await internals.handleNotify(asWc(lab.wc), notifyPayload({ dedupeKey: "same" }));
    vi.advanceTimersByTime(299_000);
    await internals.handleNotify(asWc(lab.wc), notifyPayload({ dedupeKey: "same" }));
    expect(FakeNotification.instances).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    await internals.handleNotify(asWc(lab.wc), notifyPayload({ dedupeKey: "same" }));
    expect(FakeNotification.instances).toHaveLength(2);
  });

  it("dedupe runs after suppression: a suppressed alert does not consume its key", async () => {
    const { world, internals } = setup();
    const lab = world.addLab("c1");
    lab.win.focused = true;
    await internals.handleNotify(asWc(lab.wc), notifyPayload({ dedupeKey: "k", routeMatchesActiveView: true }));
    lab.win.focused = false;
    await internals.handleNotify(asWc(lab.wc), notifyPayload({ dedupeKey: "k", routeMatchesActiveView: true }));
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it("coalesces finished alerts within 700 ms into 'N experiments finished'", async () => {
    const { world, internals } = setup();
    const a = world.addLab("c1");
    const b = world.addLab("c2");
    for (const [i, t] of ["a", "b", "c", "d"].entries()) {
      await internals.handleNotify(asWc(i < 3 ? a.wc : b.wc), notifyPayload({ kind: "finished", title: t, route: `/r/${t}` }));
      vi.advanceTimersByTime(600);
    }
    expect(FakeNotification.instances).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]?.opts).toEqual({ title: "4 experiments finished", body: "a, b, c +1 more", silent: false });
    // click routes with the last item (route /r/d, lab c2)
    FakeNotification.instances[0]?.emit("click");
    expect(b.wc.sent).toEqual([["silico:navigate", "/r/d"]]);
    expect(a.wc.sent).toEqual([]);
  });

  it("a single finished alert is shown unchanged after 700 ms", async () => {
    const { world, internals } = setup();
    const lab = world.addLab("c1");
    await internals.handleNotify(asWc(lab.wc), notifyPayload({ kind: "finished", title: "Run 1", body: "done" }));
    vi.advanceTimersByTime(699);
    expect(FakeNotification.instances).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(FakeNotification.instances[0]?.opts).toEqual({ title: "Run 1", body: "done", silent: false });
  });
});

describe("notification click", () => {
  it("focuses the window (restoring if minimised), reveals the Lab and sends silico:navigate", async () => {
    const { world, internals } = setup();
    const lab = world.addLab("c1", { shown: false });
    lab.win.minimized = true;
    await internals.handleNotify(asWc(lab.wc), notifyPayload({ route: "/x" }));
    FakeNotification.instances[0]?.emit("click");
    expect(world.telemetry.markCause).toHaveBeenCalledWith("notification-click", "c1");
    expect(lab.win.calls).toEqual(["restore", "show", "focus"]);
    expect(state.appFocus).toHaveBeenCalledWith({ steal: true });
    expect(world.windows.revealIfHidden).toHaveBeenCalledWith(lab.wc);
    expect(lab.wc.sent).toEqual([["silico:navigate", "/x"]]);
  });

  it("sender gone → uses the live Lab webContents for the connId", async () => {
    const { world, internals } = setup();
    const old = world.addLab("c1");
    await internals.handleNotify(asWc(old.wc), notifyPayload({ route: "/y" }));
    old.wc.destroyed = true;
    const fresh = world.addLab("c1");
    FakeNotification.instances[0]?.emit("click");
    expect(fresh.wc.sent).toEqual([["silico:navigate", "/y"]]);
    expect(fresh.win.calls).toContain("focus");
  });

  it("Lab gone but window parked → focus window, defer route until next lab-ready (latest wins)", async () => {
    const { world, internals } = setup();
    const lab = world.addLab("c1");
    await internals.handleNotify(asWc(lab.wc), notifyPayload({ route: "/first" }));
    await internals.handleNotify(asWc(lab.wc), notifyPayload({ route: "/second" }));
    lab.wc.destroyed = true;
    lab.parked = true;
    FakeNotification.instances[0]?.emit("click");
    FakeNotification.instances[1]?.emit("click");
    expect(lab.win.calls).toContain("focus");
    expect(internals.pendingRoutes().get("c1")).toBe("/second");
    const ready = new FakeWc();
    world.fireReady("c2", ready);
    expect(ready.sent).toEqual([]);
    world.fireReady("c1", ready);
    expect(ready.sent).toEqual([["silico:navigate", "/second"]]);
    world.fireReady("c1", ready);
    expect(ready.sent).toHaveLength(1);
  });

  it("viewer sender (no connId) alive → navigate sent to it without window focus; gone → route lost", async () => {
    const { world, internals } = setup();
    const viewer = new FakeWc();
    await internals.handleNotify(asWc(viewer), notifyPayload({ route: "/v" }));
    FakeNotification.instances[0]?.emit("click");
    expect(viewer.sent).toEqual([["silico:navigate", "/v"]]);
    expect(world.telemetry.markCause).not.toHaveBeenCalled();
    await internals.handleNotify(asWc(viewer), notifyPayload({ route: "/v2" }));
    viewer.destroyed = true;
    FakeNotification.instances[1]?.emit("click");
    expect(internals.pendingRoutes().size).toBe(0);
  });
});

describe("badge", () => {
  async function settle(world: World) {
    await vi.runAllTimersAsync();
    await bridgeInternals(world.ctx).badgeSettled();
  }

  it("macOS: sums attention across Labs; unread-only shows a dot", async () => {
    const { world, internals } = setup({ platform: "darwin" });
    const a = world.addLab("c1");
    const b = world.addLab("c2");
    internals.handleBadgeCounts(asWc(a.wc), { attention: 2, unread: 0 });
    internals.handleBadgeCounts(asWc(b.wc), { attention: 3, unread: 9 });
    await settle(world);
    expect(state.dock.setBadge).toHaveBeenLastCalledWith("5");
    internals.handleBadgeCounts(asWc(a.wc), { attention: 0, unread: 1 });
    internals.handleBadgeCounts(asWc(b.wc), { attention: 0, unread: 0 });
    await settle(world);
    expect(state.dock.setBadge).toHaveBeenLastCalledWith("•");
    expect(state.setBadgeCount).not.toHaveBeenCalled();
  });

  it("caps each Lab at 9999 and ignores invalid payloads entirely", async () => {
    const { world, internals } = setup();
    const a = world.addLab("c1");
    internals.handleBadgeCounts(asWc(a.wc), { attention: 1e9, unread: 0 });
    await settle(world);
    expect(state.dock.setBadge).toHaveBeenLastCalledWith("9999");
    internals.handleBadgeCounts(asWc(a.wc), { attention: 5, unread: -1 });
    internals.handleBadgeCounts(asWc(a.wc), { attention: 5 });
    expect(internals.badgeCounts().get("c1")).toEqual({ attention: 9999, unread: 0 });
  });

  it("Linux: attention count only; unread-only → 0", async () => {
    const { world, internals } = setup({ platform: "linux" });
    const a = world.addLab("c1");
    internals.handleBadgeCounts(asWc(a.wc), { attention: 4, unread: 2 });
    await settle(world);
    expect(state.setBadgeCount).toHaveBeenLastCalledWith(4);
    internals.handleBadgeCounts(asWc(a.wc), { attention: 0, unread: 2 });
    await settle(world);
    expect(state.setBadgeCount).toHaveBeenLastCalledWith(0);
    expect(state.dock.setBadge).not.toHaveBeenCalled();
  });

  it("Windows: no badge API is called", async () => {
    const { world, internals } = setup({ platform: "win32" });
    internals.handleBadgeCounts(asWc(world.addLab("c1").wc), { attention: 4, unread: 2 });
    await settle(world);
    expect(state.setBadgeCount).not.toHaveBeenCalled();
    expect(state.dock.setBadge).not.toHaveBeenCalled();
  });

  it("senders without a connId (viewers) are ignored", async () => {
    const { world, internals } = setup();
    internals.handleBadgeCounts(asWc(new FakeWc()), { attention: 4, unread: 2 });
    await settle(world);
    expect(internals.badgeCounts().size).toBe(0);
    expect(state.dock.setBadge).not.toHaveBeenCalled();
  });

  it("badge or master switch off → empty; settings change recomputes", async () => {
    const { world, internals } = setup();
    internals.handleBadgeCounts(asWc(world.addLab("c1").wc), { attention: 4, unread: 0 });
    await settle(world);
    expect(state.dock.setBadge).toHaveBeenLastCalledWith("4");
    world.setNotifications({ badge: false });
    for (const l of world.settingsListeners) l(world.settings);
    await settle(world);
    expect(state.dock.setBadge).toHaveBeenLastCalledWith("");
    world.setNotifications({ badge: true, enabled: false });
    for (const l of world.settingsListeners) l(world.settings);
    await settle(world);
    expect(state.dock.setBadge).toHaveBeenLastCalledWith("");
  });

  it("Lab view destroyed → next tick prune connIds without a window (parked kept) and recompute", async () => {
    const { world, internals } = setup();
    const a = world.addLab("c1");
    const b = world.addLab("c2");
    internals.handleBadgeCounts(asWc(a.wc), { attention: 1, unread: 0 });
    internals.handleBadgeCounts(asWc(a.wc), { attention: 2, unread: 0 }); // second message: listener attached once
    internals.handleBadgeCounts(asWc(b.wc), { attention: 3, unread: 0 });
    await settle(world);
    expect(state.dock.setBadge).toHaveBeenLastCalledWith("5");
    // c2 parked (window still holds it) → kept
    b.parked = true;
    b.wc.destroy();
    await settle(world);
    expect(internals.badgeCounts().has("c2")).toBe(true);
    // c1 gone entirely → pruned
    world.labs = world.labs.filter((l) => l !== a);
    a.wc.destroy();
    await settle(world);
    expect(internals.badgeCounts().has("c1")).toBe(false);
    expect(state.dock.setBadge).toHaveBeenLastCalledWith("3");
  });

  it("window closed → prune and recompute", async () => {
    const { world, internals } = setup();
    const a = world.addLab("c1");
    const win = new FakeWin();
    emitApp("browser-window-created", {}, win);
    internals.handleBadgeCounts(asWc(a.wc), { attention: 1, unread: 0 });
    await settle(world);
    world.labs = [];
    win.emit("closed");
    await settle(world);
    expect(internals.badgeCounts().size).toBe(0);
    expect(state.dock.setBadge).toHaveBeenLastCalledWith("");
  });

  it("clearBadgeCounts clears every Lab and the badge", async () => {
    const { world, svc, internals } = setup();
    internals.handleBadgeCounts(asWc(world.addLab("c1").wc), { attention: 1, unread: 0 });
    await settle(world);
    svc.clearBadgeCounts();
    await settle(world);
    expect(internals.badgeCounts().size).toBe(0);
    expect(state.dock.setBadge).toHaveBeenLastCalledWith("");
  });

  it("recomputes are serialised; a failing settings read does not break the chain", async () => {
    const { world, internals } = setup();
    const a = world.addLab("c1");
    let fail = true;
    const original = world.ctx.settings.get;
    (world.ctx.settings as { get: typeof original }).get = async () => {
      if (fail) {
        fail = false;
        throw new Error("disk");
      }
      return original();
    };
    internals.handleBadgeCounts(asWc(a.wc), { attention: 1, unread: 0 });
    internals.handleBadgeCounts(asWc(a.wc), { attention: 2, unread: 0 });
    await settle(world);
    expect(state.dock.setBadge).toHaveBeenCalledTimes(1);
    expect(state.dock.setBadge).toHaveBeenLastCalledWith("2");
  });
});

describe("certificate verifier", () => {
  it("installs on default, Lab, signup and every future session", () => {
    const { svc } = setup();
    svc.installCertificateVerifier();
    expect(state.defaultSession.verifyProc).toBeTypeOf("function");
    expect(state.sessions.get("persist:silico")?.verifyProc).toBeTypeOf("function");
    expect(state.sessions.get("persist:silico-signup")?.verifyProc).toBeTypeOf("function");
    const later = new FakeSession("later");
    emitApp("session-created", later);
    expect(later.verifyProc).toBeTypeOf("function");
    const cb = vi.fn();
    later.verifyProc?.({ certificate: { data: "not a cert" } }, cb);
    expect(cb).toHaveBeenCalledWith(-3);
  });
});

describe("permission handlers (wiring)", () => {
  it("installs request+check handlers on Lab and signup partitions", async () => {
    const { world, svc } = setup();
    svc.installPermissionHandlers();
    const lab = state.sessions.get("persist:silico");
    const signup = state.sessions.get("persist:silico-signup");
    expect(lab?.requestHandler && lab.checkHandler && signup?.requestHandler && signup.checkHandler).toBeTruthy();

    const entry = world.addLab("c1", { labOrigin: "https://lab.silico.run" });
    state.focusedWindow = entry.win;
    const cb = vi.fn();
    lab?.requestHandler?.(entry.wc, "media", cb, { isMainFrame: true, mediaTypes: ["audio"], requestingUrl: "https://lab.silico.run/home" });
    await vi.runAllTimersAsync();
    expect(state.showMessageBox).toHaveBeenCalledWith(entry.win, expect.objectContaining({ message: "Allow microphone access for dictation?" }));
    expect(cb).toHaveBeenCalledWith(true);
    expect(lab?.checkHandler?.(entry.wc, "media", "https://lab.silico.run", { isMainFrame: true, mediaType: "audio" })).toBe(true);

    // signup partition never grants media
    const cb2 = vi.fn();
    signup?.requestHandler?.(entry.wc, "media", cb2, { isMainFrame: true, mediaTypes: ["audio"], requestingUrl: "https://lab.silico.run/home" });
    expect(cb2).toHaveBeenCalledWith(false);
    const cb3 = vi.fn();
    signup?.requestHandler?.(entry.wc, "fullscreen", cb3, { isMainFrame: true });
    expect(cb3).toHaveBeenCalledWith(true);
  });

  it("focused-Lab eligibility: unfocused window, hidden Lab, cross-origin requester, unknown origin → deny", async () => {
    const { world, svc } = setup();
    svc.installPermissionHandlers();
    const lab = state.sessions.get("persist:silico");
    const entry = world.addLab("c1");
    const ask = (requestingUrl = "https://lab.silico.run/x") => {
      const cb = vi.fn();
      lab?.requestHandler?.(entry.wc, "media", cb, { isMainFrame: true, mediaTypes: ["audio"], requestingUrl });
      return cb;
    };
    // LabRef.labOrigin null (unknown origin) → deny, even after lab-ready
    state.focusedWindow = entry.win;
    expect(ask()).toHaveBeenCalledWith(false);
    world.fireReady("c1", entry.wc);
    expect(ask()).toHaveBeenCalledWith(false);
    entry.labOrigin = "https://lab.silico.run";
    state.focusedWindow = new FakeWin();
    expect(ask()).toHaveBeenCalledWith(false);
    state.focusedWindow = entry.win;
    entry.shown = false;
    expect(ask()).toHaveBeenCalledWith(false);
    entry.shown = true;
    expect(ask("https://evil.example/")).toHaveBeenCalledWith(false);
    entry.wc.url = "https://other.silico.run/";
    expect(ask("https://lab.silico.run/")).toHaveBeenCalledWith(false);
    expect(state.showMessageBox).not.toHaveBeenCalled();
  });

  it("uses LabRef.labOrigin (set by windows at openLabInWindow) without waiting for lab-ready", async () => {
    const { world, svc } = setup();
    svc.installPermissionHandlers();
    const lab = state.sessions.get("persist:silico");
    const entry = world.addLab("c1", { labOrigin: "https://lab.silico.run" });
    state.focusedWindow = entry.win;
    const cb = vi.fn();
    lab?.requestHandler?.(entry.wc, "media", cb, { isMainFrame: true, mediaTypes: ["audio"], requestingUrl: "https://lab.silico.run/" });
    await vi.runAllTimersAsync();
    expect(cb).toHaveBeenCalledWith(true);
  });
});
