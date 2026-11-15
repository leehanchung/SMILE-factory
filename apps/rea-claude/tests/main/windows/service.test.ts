import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("./fakeElectron")).electron);

import { DEFAULT_SETTINGS } from "@shared/config";
import type { Settings } from "@shared/ipc";
import { createWindowService, registerWindowsIpc } from "../../../src/main/windows";
import type { AuthService, ConnectionsService, MainContext, SettingsService, WindowService } from "../../../src/main/services";
import { createMainContext } from "../../../src/main/services";
import { AUTH_WALL_PROBE_SCRIPT, MOUNT_WAIT_SCRIPT } from "../../../src/main/windows/scripts";
import { silentLoggerFactory, stub, testEnv } from "../helpers/context";
import {
  app,
  dialog,
  FakeWebContents,
  FakeWindow,
  ipcHandlers,
  Menu,
  menus,
  powerMonitor,
  resetFakes,
  shell,
  views,
  webContents as wcModule,
} from "./fakeElectron";

type AnyFn = ReturnType<typeof vi.fn>;

interface Harness {
  ctx: MainContext;
  svc: WindowService;
  lab: Record<string, AnyFn>;
  telemetry: Record<string, AnyFn>;
  signup: Record<string, AnyFn>;
  settingsListeners: ((s: Settings) => void)[];
  devListeners: ((d: boolean) => void)[];
  updater: Record<string, AnyFn>;
  clock: { t: number };
  dir: string;
}

let h: Harness;

function build(env: Partial<ReturnType<typeof testEnv>> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "rea-winsvc-"));
  const clock = { t: 1_000_000 };
  const lab = {
    cancelWindow: vi.fn(),
    forgetWindow: vi.fn(),
    closeTunnel: vi.fn(),
    reauthOnAuthWall: vi.fn(async () => undefined),
    rewake: vi.fn(async () => undefined),
    resumePendingReauths: vi.fn(),
    listLabs: vi.fn(),
    createLabSession: vi.fn(),
    waitForLab: vi.fn(),
  };
  const telemetry = { markCause: vi.fn(), markRecent: vi.fn(), recordShellEvent: vi.fn() };
  const signup = { close: vi.fn(), relayout: vi.fn(), isOpen: vi.fn(() => false) };
  const updater = { userCheck: vi.fn(), checkInBackground: vi.fn() };
  const settingsListeners: ((s: Settings) => void)[] = [];
  const devListeners: ((d: boolean) => void)[] = [];
  const b = createMainContext();
  b.provide("env", testEnv({ userDataPath: () => dir, ...env }));
  b.provide("logger", silentLoggerFactory);
  b.provide("lab", stub("lab", lab as never));
  b.provide("telemetry", stub("telemetry", telemetry as never));
  b.provide("signup", stub("signup", signup as never));
  b.provide("updater", stub("updater", updater as never));
  b.provide(
    "settings",
    stub<SettingsService>("settings", {
      get: async () => DEFAULT_SETTINGS,
      onChanged: (cb: (s: Settings) => void) => {
        settingsListeners.push(cb);
        return () => undefined;
      },
    }),
  );
  b.provide(
    "auth",
    stub<AuthService>("auth", {
      status: async () => ({ status: "signed-out" as const }),
      onDeveloperChanged: (cb: (d: boolean) => void) => {
        devListeners.push(cb);
        return () => undefined;
      },
      cachedIdentity: () => null,
      onIdentityChanged: () => () => undefined,
      onSignedIn: () => () => undefined,
    }),
  );
  b.provide(
    "connections",
    stub<ConnectionsService>("connections", { list: async () => [{ id: "c1", name: "", icon: "", deploymentId: "", labUrl: "", routeMode: "managed" as const }] }),
  );
  for (const n of ["deepLinks", "returns", "ssh", "bridge"] as const) b.provide(n, stub(n) as never);
  const svc = createWindowService(b.ctx, { now: () => clock.t, fetch: vi.fn(async () => new Response("", { status: 200 })), readMemoryLevel: async () => 5 });
  b.provide("windows", svc);
  return { ctx: b.ctx, svc, lab, telemetry, signup, settingsListeners, devListeners, updater, clock, dir };
}

const trustedEvent = (wc: FakeWebContents) => ({ sender: wc, senderFrame: { url: "file:///app/index.html" } });
const invoke = (ch: string, wc: FakeWebContents, ...args: unknown[]) => {
  const fn = ipcHandlers.get(ch);
  if (!fn) throw new Error(`no handler ${ch}`);
  return fn(trustedEvent(wc), ...args);
};
const asWin = (w: unknown) => w as FakeWindow;
const labScripts = (wc: FakeWebContents, authWall = false) => {
  wc.scriptResult = (s) => (s === AUTH_WALL_PROBE_SCRIPT ? authWall : s === MOUNT_WAIT_SCRIPT ? Promise.resolve() : undefined);
};

beforeEach(() => {
  resetFakes();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  h = build();
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(h.dir, { recursive: true, force: true });
});

/** Open a Lab and drive it to "ready". */
async function openReady(win: FakeWindow, connId = "c1", url = "https://lab.silico.run/auth/callback?x#token=t") {
  h.svc.openLabInWindow(win as never, connId, url, "My Lab");
  const view = views.at(-1)!;
  labScripts(view.webContents);
  view.webContents.url = "https://lab.silico.run/workspace/1";
  view.webContents.emit("did-navigate", {}, view.webContents.url, 200, "OK");
  view.webContents.emit("did-finish-load");
  h.clock.t += 2000;
  await vi.advanceTimersByTimeAsync(0);
  return view;
}

describe("shell windows", () => {
  it("creates the window with the spec options and loads the renderer", () => {
    const win = asWin(h.svc.createShellWindow({ initial: true }));
    expect(win.opts).toMatchObject({
      width: 1280,
      height: 840,
      minWidth: 823,
      minHeight: 540,
      show: false,
      autoHideMenuBar: true,
      title: "Rea Claude",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 10 },
      webPreferences: { preload: "/tmp/out/preload/index.js", sandbox: true, contextIsolation: true },
    });
    expect(win.webContents.loaded).toEqual(["file:///tmp/out/renderer/index.html"]);
    expect(h.svc.isShellWindow(win as never)).toBe(true);
    expect(h.svc.shellWindows()).toHaveLength(1);
  });

  it("uses the dev server URL when set", () => {
    resetFakes();
    h = build({ rendererUrl: "http://localhost:5173" });
    const win = asWin(h.svc.createShellWindow());
    expect(win.webContents.loaded).toEqual(["http://localhost:5173"]);
  });

  it("show gate: 500 ms fallback, immediate after the first compact decision", async () => {
    const a = asWin(h.svc.createShellWindow());
    a.emit("ready-to-show");
    expect(a.showInactive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(a.showInactive).toHaveBeenCalledTimes(1);

    registerWindowsIpc(h.ctx);
    const b = asWin(h.svc.createShellWindow());
    b.emit("ready-to-show");
    await invoke("window:set-compact", b.webContents, true, 400);
    expect(b.showInactive).toHaveBeenCalledTimes(1);
    expect(b.bounds.width).toBe(620);
  });

  it("packaged show marks the window-create cause and uses show()", async () => {
    resetFakes();
    h = build({ isPackaged: true });
    const w = asWin(h.svc.createShellWindow());
    w.emit("ready-to-show");
    await vi.advanceTimersByTimeAsync(500);
    expect(w.show).toHaveBeenCalled();
    expect(h.telemetry.markCause).toHaveBeenCalledWith("window-create", undefined);
  });

  it("restores saved bounds only for the first window and saves on resize (debounced)", async () => {
    writeFileSync(join(h.dir, "window-state.json"), JSON.stringify({ x: 50, y: 60, width: 1000, height: 700 }));
    const a = asWin(h.svc.createShellWindow());
    expect(a.opts).toMatchObject({ x: 50, y: 60, width: 1000, height: 700 });
    a.focus();
    const b = asWin(h.svc.createShellWindow());
    expect(b.opts).toMatchObject({ x: 40, y: 40, width: 1280, height: 840 }); // cascade overflow
    b.setBounds({ x: 1, y: 2, width: 900, height: 650 });
    await vi.advanceTimersByTimeAsync(250);
    const { readFileSync } = await import("node:fs");
    expect(JSON.parse(readFileSync(join(h.dir, "window-state.json"), "utf-8"))).toEqual({ x: 1, y: 2, width: 900, height: 650 });
  });

  it("denies window.open from the shell and opens http(s) externally", () => {
    const w = asWin(h.svc.createShellWindow());
    expect(w.webContents.openHandler?.({ url: "https://x.y/" })).toEqual({ action: "deny" });
    expect(shell.openExternal).toHaveBeenCalledWith("https://x.y/");
    w.webContents.openHandler?.({ url: "file:///etc/passwd" });
    expect(shell.openExternal).toHaveBeenCalledTimes(1);
  });

  it("closed tears down lab, signup, compact and tunnel", async () => {
    const w = asWin(h.svc.createShellWindow());
    const view = await openReady(w);
    w.close();
    expect(h.lab.cancelWindow).toHaveBeenCalledWith(w.id);
    expect(h.lab.closeTunnel).toHaveBeenCalledWith(w.id);
    // C3: forget after cancel, so the closed id does not linger in I3's maps
    expect(h.lab.forgetWindow).toHaveBeenCalledWith(w.id);
    expect(h.lab.forgetWindow!.mock.invocationCallOrder[0]).toBeGreaterThan(h.lab.cancelWindow!.mock.invocationCallOrder.at(-1)!);
    expect(h.signup.close).toHaveBeenCalled();
    expect(view.webContents.destroyed).toBe(true);
    expect(h.svc.shellWindows()).toHaveLength(0);
  });

  it("ensureShellWindow / focusOrCreateShellWindow / primaryShellWindow", () => {
    h.svc.ensureShellWindow();
    expect(h.svc.shellWindows()).toHaveLength(1);
    h.svc.ensureShellWindow();
    expect(h.svc.shellWindows()).toHaveLength(1);
    const w = asWin(h.svc.shellWindows()[0]);
    w.minimized = true;
    expect(h.svc.focusOrCreateShellWindow("second-instance")).toBe(w as never);
    expect(w.restore).toHaveBeenCalled();
    expect(app.focus).toHaveBeenCalledWith({ steal: true });
    expect(h.telemetry.markCause).toHaveBeenCalledWith("second-instance", undefined);
    expect(h.svc.primaryShellWindow()).toBe(w as never);
  });

  it("renderer crash: revive with crash-loop guard and resync the Lab", async () => {
    const w = asWin(h.svc.createShellWindow());
    await openReady(w);
    w.webContents.sent.length = 0;
    w.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    expect(w.webContents.reload).toHaveBeenCalledTimes(1);
    w.webContents.emit("did-finish-load");
    expect(w.webContents.sentOn("lab:opened")).toEqual([{ id: "c1", title: "My Lab" }]);
    expect(w.webContents.sentOn("lab:viewvis")).toEqual([{ shown: true, title: "My Lab" }]);
    expect(w.webContents.sentOn("lab:state")).toEqual([{ id: "c1", state: "ready" }]);
    expect(h.telemetry.markRecent).toHaveBeenCalledWith("shell-renderer-gone");
    w.webContents.emit("render-process-gone", {}, { reason: "clean-exit" });
    expect(w.webContents.reload).toHaveBeenCalledTimes(1);
    w.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    w.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    w.webContents.emit("render-process-gone", {}, { reason: "crashed" }); // 4th within 60 s: give up
    expect(w.webContents.reload).toHaveBeenCalledTimes(3);
  });
});

describe("Lab view lifecycle", () => {
  it("open → loading → ready after the 1.5 s minimum", async () => {
    const w = asWin(h.svc.createShellWindow());
    const hook = vi.fn();
    h.svc.onLabReady(hook);
    h.svc.openLabInWindow(w as never, "c1", "https://lab.silico.run/auth/callback#token=t", "My Lab");
    const view = views.at(-1)!;
    expect(view.opts.webPreferences).toEqual({
      partition: "persist:silico",
      preload: "/tmp/out/preload/lab.js",
      backgroundThrottling: false,
    });
    expect(w.children).toContain(view);
    expect(view.visible).toBe(false);
    expect(view.bounds).toEqual({ x: 0, y: 32, width: 1280, height: 780 });
    expect(w.webContents.sentOn("lab:opened")).toEqual([{ id: "c1", title: "My Lab" }]);
    expect(w.webContents.sentOn("lab:state")).toEqual([{ id: "c1", state: "loading" }]);
    labScripts(view.webContents);
    view.webContents.emit("did-navigate", {}, "https://lab.silico.run/home", 200, "OK");
    view.webContents.emit("did-finish-load");
    await vi.advanceTimersByTimeAsync(0);
    expect(view.visible).toBe(false);
    h.clock.t += 1500;
    await vi.advanceTimersByTimeAsync(1500);
    expect(view.visible).toBe(true);
    expect(w.webContents.sentOn("lab:viewvis")).toEqual([{ shown: true, title: "My Lab" }]);
    expect(w.webContents.sentOn("lab:state").at(-1)).toEqual({ id: "c1", state: "ready" });
    expect(hook).toHaveBeenCalledWith("c1", view.webContents);
    expect(h.svc.shownLabWebContents(w as never)).toBe(view.webContents as never);
    expect(h.svc.findLab(view.webContents as never)).toEqual({ win: w, connId: "c1", shown: true, labOrigin: "https://lab.silico.run" });
    expect(h.svc.windowForConn("c1")).toBe(w as never);
    expect(h.svc.labWebContentsForConn("c1")).toBe(view.webContents as never);
    expect(h.svc.classifyFocusedWindow()).toEqual({ kind: "none", connId: null });
    w.focus();
    expect(h.svc.classifyFocusedWindow()).toEqual({ kind: "lab", connId: "c1" });
  });

  it("HTTP ≥400 → down with telemetry once per load", async () => {
    const w = asWin(h.svc.createShellWindow());
    h.svc.openLabInWindow(w as never, "c1", "https://lab.silico.run/", "L");
    const view = views.at(-1)!;
    view.webContents.emit("did-navigate", {}, "https://lab.silico.run/", 502, "Bad");
    view.webContents.emit("did-finish-load");
    await vi.advanceTimersByTimeAsync(0);
    expect(w.webContents.sentOn("lab:state").at(-1)).toEqual({ id: "c1", state: "down", reason: "error" });
    expect(w.webContents.sentOn("lab:viewvis").at(-1)).toEqual({ shown: false });
    expect(h.telemetry.recordShellEvent).toHaveBeenCalledWith("down-panel", {
      connId: "c1",
      details: { lastStatus: 502, msSinceLoad: 0 },
    });
    view.webContents.emit("did-fail-load", {}, -105, "x", "u", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.telemetry.recordShellEvent).toHaveBeenCalledTimes(1);
    view.webContents.emit("did-fail-load", {}, -3, "aborted", "u", true);
  });

  it("auth wall in page → re-auth via ctx.lab", async () => {
    const w = asWin(h.svc.createShellWindow());
    h.svc.openLabInWindow(w as never, "c1", "https://lab.silico.run/", "L");
    const view = views.at(-1)!;
    labScripts(view.webContents, true);
    view.webContents.emit("did-finish-load");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.lab.reauthOnAuthWall).toHaveBeenCalledWith(w, "c1");
  });

  it("switching connId replaces the view; same connId reuses it", async () => {
    const w = asWin(h.svc.createShellWindow());
    const v1 = await openReady(w, "c1");
    h.svc.openLabInWindow(w as never, "c1", "https://lab.silico.run/", "L");
    expect(views.at(-1)).toBe(v1);
    h.svc.openLabInWindow(w as never, "c2", "https://lab2.silico.run/", "L2");
    expect(v1.webContents.destroyed).toBe(true);
    expect(views.at(-1)).not.toBe(v1);
    expect(w.children).not.toContain(v1);
  });

  it("user hide keeps the view; held elsewhere and focus-held reveal it", async () => {
    registerWindowsIpc(h.ctx);
    const a = asWin(h.svc.createShellWindow());
    const view = await openReady(a);
    await invoke("lab:hide", a.webContents);
    expect(h.lab.cancelWindow).toHaveBeenCalledWith(a.id);
    expect(view.visible).toBe(false);
    expect(view.webContents.destroyed).toBe(false);
    expect(a.webContents.sentOn("lab:viewvis").at(-1)).toEqual({ shown: false });
    expect(a.webContents.sentOn("lab:navstate").at(-1)).toEqual({ canGoBack: false, canGoForward: false });

    const b = asWin(h.svc.createShellWindow());
    expect(await invoke("labs:held-elsewhere", b.webContents)).toEqual(["c1"]);
    expect(await invoke("labs:held-elsewhere", a.webContents)).toEqual([]);
    expect(await invoke("labs:focus-held", b.webContents, 42)).toBe(false);
    expect(await invoke("labs:focus-held", b.webContents, "nope")).toBe(false);
    a.webContents.sent.length = 0;
    expect(await invoke("labs:focus-held", b.webContents, "c1")).toBe(true);
    expect(a.show).toHaveBeenCalled();
    expect(view.visible).toBe(true);
    expect(a.webContents.sentOn("lab:opened")).toEqual([{ id: "c1", title: "My Lab" }]);
    expect(a.webContents.sentOn("lab:state")).toEqual([{ id: "c1", state: "ready" }]);
    expect(h.telemetry.markCause).toHaveBeenCalledWith("menu:navigate", "labs:focus-held");
  });

  it("userLeft during re-auth aborts the pending reopen", async () => {
    registerWindowsIpc(h.ctx);
    const a = asWin(h.svc.createShellWindow());
    await openReady(a);
    h.svc.setReauthing(a as never, true);
    await invoke("lab:hide", a.webContents);
    a.webContents.sent.length = 0;
    h.svc.openLabInWindow(a as never, "c1", "https://lab.silico.run/", "L");
    expect(a.webContents.sentOn("lab:opened")).toEqual([]);
    h.svc.openLabInWindow(a as never, "c1", "https://lab.silico.run/", "L");
    expect(a.webContents.sentOn("lab:opened")).toHaveLength(1);
  });

  it("userLeft is recorded even though cancelWindow clears the reauthing flag (C2)", async () => {
    registerWindowsIpc(h.ctx);
    const a = asWin(h.svc.createShellWindow());
    await openReady(a);
    // Real I3 behavior: cancelWindow → clearReauthFlags → windows.setReauthing(win, false).
    h.lab.cancelWindow!.mockImplementation(() => h.svc.setReauthing(a as never, false));
    h.svc.setReauthing(a as never, true);
    await invoke("lab:hide", a.webContents);
    a.webContents.sent.length = 0;
    h.svc.openLabInWindow(a as never, "c1", "https://lab.silico.run/", "L"); // the in-flight reopen lands
    expect(a.webContents.sentOn("lab:opened")).toEqual([]);
  });

  it("set-compact is ignored while a Lab is held and scales by zoom otherwise", async () => {
    registerWindowsIpc(h.ctx);
    const a = asWin(h.svc.createShellWindow());
    await openReady(a);
    await invoke("window:set-compact", a.webContents, true, 400);
    expect(a.bounds.width).toBe(1280);
    const b = asWin(h.svc.createShellWindow());
    b.webContents.zoomFactor = 1.5;
    await invoke("window:set-compact", b.webContents, true, 400);
    expect(b.bounds).toMatchObject({ width: 620, height: 628 });
    await invoke("window:set-compact", b.webContents, false);
    expect(b.bounds).toMatchObject({ width: 1280, height: 840 });
  });

  it("navigation guards: external, document viewer, auth wall, freeze", async () => {
    const w = asWin(h.svc.createShellWindow());
    const view = await openReady(w);
    const nav = (url: string) => {
      const e = { url, isMainFrame: true, preventDefault: vi.fn() };
      view.webContents.emit("will-navigate", e);
      return e.preventDefault;
    };
    expect(nav("https://lab.silico.run/workspace/2")).not.toHaveBeenCalled();
    expect(nav("https://github.com/x")).toHaveBeenCalled();
    expect(shell.openExternal).toHaveBeenCalledWith("https://github.com/x");
    const before = FakeWindow.all.length;
    expect(nav("https://lab.silico.run/api/doc.pdf")).toHaveBeenCalled();
    expect(FakeWindow.all.length).toBe(before + 1);
    const viewer = FakeWindow.all.at(-1)!;
    expect(viewer.webContents.loaded).toEqual(["file:///tmp/out/renderer/index.html#viewer"]);
    expect(h.telemetry.markCause).toHaveBeenCalledWith("doc-window", "lab.silico.run");
    expect(views.at(-1)!.webContents.loaded).toEqual(["https://lab.silico.run/api/doc.pdf"]);
    expect(nav("https://my.silico.run/login")).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.lab.reauthOnAuthWall).toHaveBeenCalledWith(w, "c1");
    h.svc.setReauthing(w as never, true);
    expect(nav("https://lab.silico.run/home")).toHaveBeenCalled();
    // popups: same origin allowed with parent-like size; others denied + external
    expect(view.webContents.openHandler?.({ url: "https://lab.silico.run/x" })).toMatchObject({ action: "allow" });
    expect(view.webContents.openHandler?.({ url: "https://other.x/" })).toEqual({ action: "deny" });
  });

  it("back/forward/navstate target the shown Lab", async () => {
    registerWindowsIpc(h.ctx);
    const w = asWin(h.svc.createShellWindow());
    const view = await openReady(w);
    view.webContents.canBack = true;
    await invoke("lab:goBack", w.webContents);
    expect(view.webContents.navigationHistory.goBack).toHaveBeenCalled();
    await invoke("lab:goForward", w.webContents);
    expect(view.webContents.navigationHistory.goForward).not.toHaveBeenCalled();
    view.webContents.emit("did-navigate-in-page", {}, "https://lab.silico.run/x", true);
    expect(w.webContents.sentOn("lab:navstate").at(-1)).toEqual({ canGoBack: true, canGoForward: false });
    expect(h.svc.currentLabReturnTo(w as never)).toBe("/workspace/1");
  });

  it("recover-session from the Lab view triggers re-auth", async () => {
    const w = asWin(h.svc.createShellWindow());
    const view = await openReady(w);
    const r = await h.svc.handleRecoverSession({ sender: view.webContents, senderFrame: view.webContents.mainFrame } as never);
    expect(r).toEqual({ status: "accepted" });
    expect(h.lab.reauthOnAuthWall).toHaveBeenCalledWith(w, "c1");
    h.svc.hideLabView(w as never);
    expect(await h.svc.handleRecoverSession({ sender: view.webContents, senderFrame: view.webContents.mainFrame } as never)).toEqual({
      status: "unsupported",
    });
  });

  it("applySignOut: auth:expired + hide for the anchor family, close others and aux", async () => {
    const a = asWin(h.svc.createShellWindow());
    const view = await openReady(a);
    const b = asWin(h.svc.createShellWindow());
    view.webContents.emit("will-navigate", { url: "https://lab.silico.run/api/x", isMainFrame: true, preventDefault: vi.fn() });
    const viewer = FakeWindow.all.at(-1)!;
    h.svc.applySignOut(a as never);
    expect(viewer.destroyed).toBe(true);
    expect(b.destroyed).toBe(true);
    expect(a.destroyed).toBe(false);
    expect(a.webContents.sentOn("auth:expired")).toHaveLength(1);
    expect(view.visible).toBe(false);
  });

  it("destroyAllLabViews closes every view", async () => {
    const w = asWin(h.svc.createShellWindow());
    const view = await openReady(w);
    h.svc.destroyAllLabViews();
    expect(view.webContents.destroyed).toBe(true);
    expect(h.svc.shownLabWebContents(w as never)).toBeNull();
  });

  it("bridge-facing: open desktop settings / lab switcher only for Lab senders", async () => {
    const w = asWin(h.svc.createShellWindow());
    const view = await openReady(w);
    const n = FakeWindow.all.length;
    h.svc.openLabSwitcherFor(new FakeWebContents() as never);
    expect(FakeWindow.all.length).toBe(n);
    h.svc.openLabSwitcherFor(view.webContents as never);
    const sw = FakeWindow.all.at(-1)!;
    expect(sw.bounds.width).toBe(620);
    expect(h.svc.isShellWindow(sw as never)).toBe(true);
    h.svc.openDesktopSettingsFor(view.webContents as never);
    const sheet = FakeWindow.all.at(-1)!;
    expect(sheet.opts).toMatchObject({ parent: w, frame: false, title: "Settings" });
    expect(sheet.webContents.loaded).toEqual(["file:///tmp/out/renderer/index.html#settings-modal/notifications"]);
  });
});

describe("settings sheet and menu navigation", () => {
  it("navigateMenu over a shown Lab opens the sheet; re-navigate focuses + app:navigate; blur closes", async () => {
    const w = asWin(h.svc.createShellWindow());
    await openReady(w);
    w.focus();
    h.svc.navigateMenu("settings:profile");
    const [overlay, sheet] = FakeWindow.all.slice(-2) as [FakeWindow, FakeWindow];
    expect(overlay.opts).toMatchObject({ parent: w, focusable: false, backgroundColor: "#1d272a", skipTaskbar: true });
    expect(overlay.setOpacity).toHaveBeenCalledWith(0.3);
    expect(overlay.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    expect(sheet.opts).toMatchObject({ x: 340, y: 180, width: 800, height: 600, title: "Settings" });
    expect(sheet.webContents.loaded[0]).toMatch(/#settings-modal\/profile$/);
    sheet.emit("ready-to-show");
    expect(overlay.showInactive).toHaveBeenCalled();
    expect(sheet.show).toHaveBeenCalled();
    h.svc.navigateMenu("settings:developer");
    expect(sheet.webContents.sentOn("app:navigate")).toEqual(["settings:developer"]);
    // blur with a confirm dialog open keeps it
    registerWindowsIpc(h.ctx);
    let resolveBox: (v: { response: number }) => void = () => undefined;
    dialog.showMessageBox.mockImplementationOnce(() => new Promise((r) => (resolveBox = r)));
    const pending = invoke("dialog:confirm", sheet.webContents, { message: "Sure?", confirmLabel: "Yes" }) as Promise<boolean>;
    sheet.emit("blur");
    expect(sheet.destroyed).toBe(false);
    resolveBox({ response: 1 });
    expect(await pending).toBe(true);
    expect(dialog.showMessageBox).toHaveBeenCalledWith(sheet, expect.objectContaining({ buttons: ["Cancel", "Yes"], defaultId: 1, cancelId: 0 }));
    sheet.emit("blur");
    expect(sheet.destroyed).toBe(true);
    expect(overlay.destroyed).toBe(true);
  });

  it("navigateMenu without a Lab sends app:navigate; connections also hides", async () => {
    const w = asWin(h.svc.createShellWindow());
    h.svc.navigateMenu("settings:notifications");
    expect(w.webContents.sentOn("app:navigate")).toEqual(["settings:notifications"]);
    await openReady(w);
    h.svc.navigateMenu("connections");
    expect(w.webContents.sentOn("app:navigate").at(-1)).toBe("connections");
    expect(h.lab.cancelWindow).toHaveBeenCalledWith(w.id);
    expect(h.svc.shownLabWebContents(w as never)).toBeNull();
  });

  it("navigateMenu with no shell window creates one and navigates after load", () => {
    h.svc.navigateMenu("settings:profile");
    const w = FakeWindow.all.at(-1)!;
    expect(w.webContents.sentOn("app:navigate")).toEqual([]);
    w.webContents.emit("did-finish-load");
    expect(w.webContents.sentOn("app:navigate")).toEqual(["settings:profile"]);
  });

  it("window:open-settings-sheet requires the shell window's own webContents", async () => {
    registerWindowsIpc(h.ctx);
    const w = asWin(h.svc.createShellWindow());
    const n = FakeWindow.all.length;
    await invoke("window:open-settings-sheet", w.webContents);
    expect(FakeWindow.all.length).toBe(n + 2);
  });
});

describe("IPC", () => {
  it("is-initial and the one-shot lastOpened:get", async () => {
    registerWindowsIpc(h.ctx);
    const a = asWin(h.svc.createShellWindow({ initial: true }));
    const b = asWin(h.svc.createShellWindow());
    expect(await invoke("window:is-initial", a.webContents)).toBe(true);
    expect(await invoke("window:is-initial", b.webContents)).toBe(false);
    await invoke("lastOpened:set", b.webContents, "me", "c9");
    expect(await invoke("lastOpened:get", b.webContents, "me")).toBeNull();
    expect(await invoke("lastOpened:get", a.webContents, "me")).toBe("c9");
    expect(await invoke("lastOpened:get", a.webContents, "me")).toBeNull();
  });

  it("rejects untrusted senders", async () => {
    registerWindowsIpc(h.ctx);
    const fn = ipcHandlers.get("labs:held-elsewhere")!;
    expect(() => fn({ sender: new FakeWebContents(), senderFrame: { url: "https://evil.x/" } })).toThrow(
      "Blocked 'labs:held-elsewhere': untrusted sender.",
    );
  });

  it("registers exactly the I4 channels", () => {
    registerWindowsIpc(h.ctx);
    expect([...ipcHandlers.keys()].sort()).toEqual(
      [
        "dialog:confirm",
        "lab:goBack",
        "lab:goForward",
        "lab:hide",
        "labs:focus-held",
        "labs:held-elsewhere",
        "lastOpened:get",
        "lastOpened:set",
        "viewer:retry",
        "window:is-initial",
        "window:open-settings-sheet",
        "window:set-compact",
      ].sort(),
    );
  });
});

describe("menus", () => {
  const appMenuLabels = () => {
    const last = Menu.setApplicationMenu.mock.calls.at(-1)?.[0] as { template: { label?: string; submenu?: { label?: string }[] }[] };
    return last.template.flatMap((m) => [m.label, ...(m.submenu ?? []).map((s) => s.label)]);
  };

  it("builds dev=false first, rebuilds on developer changes, dock menu on macOS", async () => {
    h.svc.installMenus();
    await vi.advanceTimersByTimeAsync(0);
    expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(1);
    expect(appMenuLabels()).not.toContain("Developer settings");
    expect(app.dock.setMenu).toHaveBeenCalled();
    h.devListeners[0]?.(true);
    expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(2);
    expect(appMenuLabels()).toContain("Developer settings");
    h.settingsListeners[0]?.({ ...DEFAULT_SETTINGS, verbose: true });
    expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(2);
    h.devListeners[0]?.(false);
    h.settingsListeners[0]?.(DEFAULT_SETTINGS);
    expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(3);
  });

  it("menu actions: send feedback, check for updates, zoom relayout, new window", async () => {
    const w = asWin(h.svc.createShellWindow());
    const view = await openReady(w);
    h.svc.installMenus();
    const tpl = (Menu.setApplicationMenu.mock.calls.at(-1)?.[0] as { template: { submenu?: { label?: string; click?: () => void }[] }[] })
      .template;
    const item = (l: string) => tpl.flatMap((m) => m.submenu ?? []).find((i) => i.label === l)!;
    w.focus();
    item("Send feedback").click?.();
    expect(view.webContents.sentOn("silico:report-issue")).toHaveLength(1);
    item("Check for Updates…").click?.();
    expect(h.updater.userCheck).toHaveBeenCalled();
    wcModule.focused = w.webContents;
    w.webContents.zoomFactor = 1.25;
    item("Zoom In").click?.();
    expect(w.webContents.zoomLevel).toBe(0.5);
    expect(view.bounds.y).toBe(40);
    expect(h.signup.relayout).toHaveBeenCalled();
    item("Reload").click?.();
    expect(view.webContents.reload).toHaveBeenCalled();
    const n = FakeWindow.all.length;
    item("New Window").click?.();
    expect(FakeWindow.all.length).toBe(n + 1);
    item("Help center").click?.();
    expect(shell.openExternal).toHaveBeenCalledWith("https://docs.silico.run");
  });

  it("context menu pops up over the Lab's window for editable targets", async () => {
    const w = asWin(h.svc.createShellWindow());
    const view = await openReady(w);
    h.svc.attachContextMenu(view.webContents as never);
    const flags = { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canSelectAll: true };
    view.webContents.emit("context-menu", {}, { isEditable: false, misspelledWord: "", dictionarySuggestions: [], editFlags: flags });
    expect(menus).toHaveLength(0);
    view.webContents.emit("context-menu", {}, { isEditable: true, misspelledWord: "", dictionarySuggestions: [], editFlags: flags });
    expect(menus[0]?.popup).toHaveBeenCalledWith({ window: w });
  });
});

describe("background monitors", () => {
  it("memory shedding parks shown Labs while inactive; activation reopens them", async () => {
    const w = asWin(h.svc.createShellWindow());
    const view = await openReady(w);
    h.svc.startBackgroundMonitors();
    app.emit("did-resign-active");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(view.webContents.destroyed).toBe(true);
    expect(w.webContents.sentOn("lab:state").at(-1)).toEqual({ id: "c1", state: "loading" });
    expect(h.svc.windowForConn("c1")).toBe(w as never);
    expect(h.svc.labWebContentsForConn("c1")).toBeNull();
    registerWindowsIpc(h.ctx);
    const b = asWin(h.svc.createShellWindow());
    expect(await invoke("labs:held-elsewhere", b.webContents)).toEqual(["c1"]);
    app.emit("did-become-active");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.lab.rewake).toHaveBeenCalledWith(w, "c1", "/workspace/1");
    expect(h.lab.resumePendingReauths).toHaveBeenCalled();
  });

  it("long sleep: update check + rewake shown Labs after 2 s", async () => {
    const w = asWin(h.svc.createShellWindow());
    const view = await openReady(w);
    h.svc.startBackgroundMonitors();
    powerMonitor.emit("suspend");
    h.clock.t += 61_000;
    powerMonitor.emit("resume");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.updater.checkInBackground).toHaveBeenCalled();
    expect(h.lab.rewake).toHaveBeenCalledWith(w, "c1", undefined);
    expect(view.webContents.invalidate).toHaveBeenCalled();
  });

  it("watchdog rewakes a dead page after two spaced strikes when focused", async () => {
    const w = asWin(h.svc.createShellWindow());
    const view = await openReady(w);
    view.webContents.scriptResult = () => "dead";
    w.focus();
    h.svc.startBackgroundMonitors();
    h.clock.t += 20_000;
    await vi.advanceTimersByTimeAsync(15_000);
    h.clock.t += 15_000;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.telemetry.markRecent).toHaveBeenCalledWith("watchdog-rewake");
    expect(h.lab.rewake).toHaveBeenCalledWith(w, "c1", undefined);
  });
});

describe("viewer windows", () => {
  it("share viewer for a non-Lab page: revealed after activation + ready-to-show; content on load", async () => {
    resetFakes();
    h = build({ platform: "linux" });
    h.svc.openShareViewer("http://localhost:3000/admin");
    const win = FakeWindow.all.at(-1)!;
    const view = views.at(-1)!;
    expect(view.opts.webPreferences).toEqual({ partition: "persist:silico" });
    expect(view.webContents.loaded).toEqual(["http://localhost:3000/admin"]);
    expect(h.telemetry.markCause).toHaveBeenCalledWith("deep-link:share", "localhost:3000");
    win.emit("ready-to-show");
    expect(win.show).toHaveBeenCalled();
    view.webContents.emit("did-finish-load");
    expect(view.visible).toBe(true);
    expect(win.webContents.sentOn("viewer:content-ready")).toEqual([undefined]);
    view.webContents.emit("page-title-updated", {}, "Doc");
    expect(win.title).toBe("Doc");
    expect(win.webContents.sentOn("viewer:title")).toEqual(["Doc"]);
    // navigation away from the initial origin goes to the browser
    const e = { url: "https://elsewhere.x/", isMainFrame: true, preventDefault: vi.fn() };
    view.webContents.emit("will-navigate", e);
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("gateway share link starts recovery (signin when signed out); retry with choose", async () => {
    h.svc.openShareViewer("https://my.silico.run/s?return_to=/home");
    const win = FakeWindow.all.at(-1)!;
    const view = views.at(-1)!;
    expect(view.opts.webPreferences).toMatchObject({ preload: "/tmp/out/preload/lab.js" });
    await vi.advanceTimersByTimeAsync(0);
    expect(win.webContents.sentOn("viewer:recovery")).toEqual([
      { kind: "loading", message: "Restoring this page…" },
      { kind: "signin", staging: false, message: "Sign in to restore this page in Silico." },
    ]);
    expect(win.webContents.sentOn("viewer:content-ready")).toEqual([false, false]);
    // fallback timer must not reveal while recovery is non-idle
    await vi.advanceTimersByTimeAsync(5_000);
    expect(view.visible).toBe(false);
    expect(h.svc.viewerWebContents(win as never)).toBe(view.webContents as never);
    registerWindowsIpc(h.ctx);
    await invoke("viewer:retry", win.webContents, "d1");
    expect(win.webContents.sentOn("viewer:recovery").at(-1)).toEqual({ kind: "loading", message: "Restoring this page…" });
  });

  it("strip reload resends title/navstate/recovery; crash revives", () => {
    h.svc.openShareViewer("http://localhost:3000/x");
    const win = FakeWindow.all.at(-1)!;
    win.webContents.emit("did-finish-load");
    expect(win.webContents.sentOn("viewer:title")).toEqual([""]);
    expect(win.webContents.sentOn("lab:navstate")).toEqual([{ canGoBack: false, canGoForward: false }]);
    win.webContents.emit("render-process-gone", {}, { reason: "oom" });
    expect(win.webContents.reload).toHaveBeenCalled();
    win.close();
    expect(views.at(-1)!.webContents.destroyed).toBe(true);
  });
});

describe("renderer navigation lock (S1)", () => {
  const navOn = (wc: FakeWebContents, ev: "will-navigate" | "will-redirect", url: string) => {
    const e = { url, isMainFrame: true, preventDefault: vi.fn() };
    wc.emit(ev, e);
    return e.preventDefault;
  };
  const OWN = "file:///tmp/out/renderer/index.html";

  it("shell window: only the app's own index.html (any hash) may load; drops and redirects are blocked", () => {
    const w = asWin(h.svc.createShellWindow());
    expect(navOn(w.webContents, "will-navigate", `${OWN}#viewer`)).not.toHaveBeenCalled();
    expect(navOn(w.webContents, "will-navigate", "file:///Users/me/Downloads/dropped.html")).toHaveBeenCalled();
    expect(navOn(w.webContents, "will-navigate", "https://evil.example/")).toHaveBeenCalled();
    expect(navOn(w.webContents, "will-redirect", "https://evil.example/")).toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("settings sheet and viewer strip are locked too", async () => {
    const w = asWin(h.svc.createShellWindow());
    await openReady(w);
    w.focus();
    h.svc.navigateMenu("settings:profile");
    const sheet = FakeWindow.all.at(-1)!;
    expect(navOn(sheet.webContents, "will-navigate", `${OWN}#settings-modal/general`)).not.toHaveBeenCalled();
    expect(navOn(sheet.webContents, "will-navigate", "file:///etc/hosts")).toHaveBeenCalled();
    h.svc.openShareViewer("http://localhost:3000/x");
    const viewer = FakeWindow.all.at(-1)!;
    expect(navOn(viewer.webContents, "will-navigate", "http://localhost:3000/x")).toHaveBeenCalled();
    expect(navOn(viewer.webContents, "will-redirect", "file:///tmp/evil.html")).toHaveBeenCalled();
  });

  it("dev builds allow the dev-server origin only", () => {
    resetFakes();
    h = build({ rendererUrl: "http://localhost:5173" });
    const w = asWin(h.svc.createShellWindow());
    expect(navOn(w.webContents, "will-navigate", "http://localhost:5173/#viewer")).not.toHaveBeenCalled();
    expect(navOn(w.webContents, "will-navigate", "http://localhost:5174/")).toHaveBeenCalled();
  });
});

describe("Lab view edge cases (T4, T18, T29)", () => {
  /** Open and finish loading without advancing the clock: the 1.5 s ready timer is pending. */
  async function loadedPendingReady(w: FakeWindow) {
    h.svc.openLabInWindow(w as never, "c1", "https://lab.silico.run/", "My Lab");
    const view = views.at(-1)!;
    labScripts(view.webContents);
    view.webContents.emit("did-navigate", {}, "https://lab.silico.run/home", 200, "OK");
    view.webContents.emit("did-finish-load");
    await vi.advanceTimersByTimeAsync(0);
    expect(w.webContents.sentOn("lab:state").at(-1)).toEqual({ id: "c1", state: "loading" });
    return view;
  }
  const readyCount = (w: FakeWindow) =>
    w.webContents.sentOn("lab:state").filter((s) => (s as { state: string }).state === "ready").length;

  it("T4: hiding within 1.5 s cancels the pending ready", async () => {
    registerWindowsIpc(h.ctx);
    const w = asWin(h.svc.createShellWindow());
    const view = await loadedPendingReady(w);
    await vi.advanceTimersByTimeAsync(500);
    await invoke("lab:hide", w.webContents);
    h.clock.t += 2000;
    await vi.advanceTimersByTimeAsync(2000);
    expect(readyCount(w)).toBe(0);
    expect(view.visible).toBe(false);
  });

  it("T4: a re-open within 1.5 s (even in the same ms) supersedes the old ready timer", async () => {
    const w = asWin(h.svc.createShellWindow());
    const hook = vi.fn();
    h.svc.onLabReady(hook);
    const view = await loadedPendingReady(w);
    // same connId, same timestamp: a new load of the same view starts
    h.svc.openLabInWindow(w as never, "c1", "https://lab.silico.run/other", "My Lab");
    expect(views.at(-1)).toBe(view);
    h.clock.t += 2000;
    await vi.advanceTimersByTimeAsync(2000);
    expect(readyCount(w)).toBe(0);
    expect(hook).not.toHaveBeenCalled();
    expect(view.visible).toBe(false);
  });

  it("T18: a hidden Lab navigating to the gateway /login is neutralized (about:blank), no re-auth", async () => {
    registerWindowsIpc(h.ctx);
    const w = asWin(h.svc.createShellWindow());
    const view = await openReady(w);
    await invoke("lab:hide", w.webContents);
    const e = { url: "https://my.silico.run/login?next=%2F", isMainFrame: true, preventDefault: vi.fn() };
    view.webContents.emit("will-navigate", e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(view.webContents.loaded.at(-1)).toBe("about:blank");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.lab.reauthOnAuthWall).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it("T29: did-fail-load -3 (aborted) on a loading Lab changes nothing", async () => {
    const w = asWin(h.svc.createShellWindow());
    h.svc.openLabInWindow(w as never, "c1", "https://lab.silico.run/", "L");
    const view = views.at(-1)!;
    const before = [...w.webContents.sent];
    view.webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://lab.silico.run/", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.webContents.sent).toEqual(before);
    expect(h.telemetry.recordShellEvent).not.toHaveBeenCalled();
    // a real failure afterwards still marks it down
    view.webContents.emit("did-fail-load", {}, -105, "NAME_NOT_RESOLVED", "https://lab.silico.run/", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.webContents.sentOn("lab:state").at(-1)).toEqual({ id: "c1", state: "down", reason: "error" });
  });
});

describe("background monitors: negatives (T19, T20, T28)", () => {
  it("T19: a short suspend (< 60 s) neither checks for updates nor rewakes", async () => {
    const w = asWin(h.svc.createShellWindow());
    const view = await openReady(w);
    h.svc.startBackgroundMonitors();
    powerMonitor.emit("suspend");
    h.clock.t += 30_000;
    powerMonitor.emit("resume");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.updater.checkInBackground).not.toHaveBeenCalled();
    expect(h.lab.rewake).not.toHaveBeenCalled();
    expect(view.webContents.invalidate).toHaveBeenCalled(); // still repaints
  });

  it("T20: turning developer mode off closes devtools only in packaged builds", async () => {
    for (const isPackaged of [true, false]) {
      resetFakes();
      h = build({ isPackaged });
      const w = asWin(h.svc.createShellWindow());
      w.webContents.devTools = true;
      vi.spyOn(wcModule, "getAllWebContents").mockReturnValue([w.webContents]);
      h.svc.installMenus();
      await vi.advanceTimersByTimeAsync(0);
      h.devListeners[0]?.(true);
      expect(w.webContents.devTools).toBe(true);
      h.devListeners[0]?.(false);
      expect(w.webContents.devTools).toBe(!isPackaged);
    }
  });

  async function deadPage(opts: { focus: boolean; idleSec?: number; loading?: boolean }) {
    const w = asWin(h.svc.createShellWindow());
    const view = await openReady(w);
    view.webContents.scriptResult = () => "dead";
    view.webContents.loading = opts.loading ?? false;
    if (opts.focus) w.focus();
    powerMonitor.getSystemIdleTime.mockReturnValue(opts.idleSec ?? 0);
    h.svc.startBackgroundMonitors();
    for (let i = 0; i < 4; i++) {
      h.clock.t += 15_000;
      await vi.advanceTimersByTimeAsync(15_000);
    }
    powerMonitor.getSystemIdleTime.mockReturnValue(0);
    return { w, view };
  }

  it("T28: watchdog does not rewake an unfocused window", async () => {
    await deadPage({ focus: false });
    expect(h.lab.rewake).not.toHaveBeenCalled();
  });

  it("T28: watchdog does not rewake when the system is idle ≥ 120 s", async () => {
    await deadPage({ focus: true, idleSec: 120 });
    expect(h.lab.rewake).not.toHaveBeenCalled();
  });

  it("T28: a loading page is 'unknown', never a strike", async () => {
    await deadPage({ focus: true, loading: true });
    expect(h.lab.rewake).not.toHaveBeenCalled();
  });

  it("T28: a hidden Lab is not watched", async () => {
    registerWindowsIpc(h.ctx);
    const w = asWin(h.svc.createShellWindow());
    const view = await openReady(w);
    view.webContents.scriptResult = () => "dead";
    w.focus();
    await invoke("lab:hide", w.webContents);
    h.lab.rewake!.mockClear();
    h.svc.startBackgroundMonitors();
    for (let i = 0; i < 4; i++) {
      h.clock.t += 15_000;
      await vi.advanceTimersByTimeAsync(15_000);
    }
    expect(h.lab.rewake).not.toHaveBeenCalled();
  });
});
