import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }));

vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: Handler) => mocks.handlers.set(ch, fn), on: vi.fn() },
  session: { fromPartition: vi.fn() },
  BrowserWindow: { fromId: vi.fn(), fromWebContents: vi.fn() },
  net: { fetch: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

import { createMainContext } from "../../../src/main/services";
import { createLabLifecycleService, labInternals, registerLabIpc } from "../../../src/main/lab";
import { makeTestContext } from "../helpers/context";
import { clusterConn, fakeAuth, fakeClock, fakeSsh, fakeWin, fakeWindows, ok, routeFetch, sessionGateway } from "./fakes";
import { DEFAULT_SETTINGS } from "@shared/config";

function setup() {
  mocks.handlers.clear();
  const clock = fakeClock();
  const auth = fakeAuth({ script: sessionGateway() });
  const ssh = fakeSsh(() => ok());
  const windows = fakeWindows();
  const telemetry = { recordShellEvent: vi.fn(), markRecent: vi.fn() };
  const base = makeTestContext({
    auth,
    ssh,
    windows,
    telemetry,
    settings: { get: async () => DEFAULT_SETTINGS },
    connections: { list: async () => [] },
  });
  // Rebuild a context whose `lab` is the real service.
  const b = createMainContext();
  for (const k of ["env", "logger", "settings", "telemetry", "auth", "signup", "deepLinks", "returns", "connections", "ssh", "windows", "bridge", "updater"] as const) {
    b.provide(k, base[k] as never);
  }
  const win = fakeWin(11);
  const execFile = vi.fn(async () => ({ stdout: "silico-local-a-web-1\t0.0.0.0:5175->5173/tcp\t\t\n" }));
  const lab = createLabLifecycleService(b.ctx, {
    now: clock.now,
    sleep: clock.sleep,
    fetch: routeFetch(() => 200),
    netFetch: routeFetch(() => 200),
    openExternal: vi.fn(async () => {}),
    windowFromId: () => win,
    windowFromWebContents: () => win,
    execFile,
    allocatePort: async () => 1,
    tcpProbe: async () => true,
    setTimer: () => ({ clear() {} }),
  });
  b.provide("lab", lab);
  registerLabIpc(b.ctx);
  const sender = { send: vi.fn(), isDestroyed: () => false };
  const event = { sender, senderFrame: { url: "file:///app/index.html" } };
  const invoke = (ch: string, ...args: unknown[]) => {
    const h = mocks.handlers.get(ch);
    if (!h) throw new Error(`no handler ${ch}`);
    return h(event, ...args);
  };
  return { ctx: b.ctx, lab, auth, ssh, windows, telemetry, win, sender, invoke, execFile };
}

describe("registerLabIpc", () => {
  beforeEach(() => mocks.handlers.clear());

  it("registers exactly the I3 channels", () => {
    setup();
    expect([...mocks.handlers.keys()].sort()).toEqual(
      ["lab:status", "lab:open", "lab:connect", "lab:update", "lab:cancel", "lab:down", "local:detectStacks", "labs:list"].sort(),
    );
  });

  it("subscribes to auth identity / sign-in hooks once", () => {
    const { auth, ctx } = setup();
    expect(auth.onIdentityChanged).toHaveBeenCalledTimes(1);
    expect(auth.onSignedIn).toHaveBeenCalledTimes(1);
    registerLabIpc(ctx);
    expect(auth.onIdentityChanged).toHaveBeenCalledTimes(1);
  });

  it("rejects untrusted senders", async () => {
    setup();
    const h = mocks.handlers.get("lab:status")!;
    expect(() => h({ sender: { getURL: () => "https://evil" }, senderFrame: { url: "https://evil" } }, "http://x")).toThrow(
      "Blocked 'lab:status': untrusted sender.",
    );
  });

  it("lab:status", async () => {
    const { invoke } = setup();
    expect(await invoke("lab:status", "http://x:1")).toBe("up");
    expect(await invoke("lab:status", "")).toBe("unknown");
  });

  it("lab:connect streams lab:output / lab:phase to the sender and records telemetry", async () => {
    const { invoke, sender, telemetry, windows, win } = setup();
    const res = await invoke("lab:connect", clusterConn(), false, { tunnel: false });
    expect(res).toEqual({ status: "opened", labUrl: "https://acme.silico.run" });
    expect(sender.send).toHaveBeenCalledWith("lab:phase", { id: "c1", phase: "checking" });
    expect(sender.send).toHaveBeenCalledWith("lab:output", { id: "c1", chunk: "Checking the cluster over SSH…\n" });
    expect(windows.openLabInWindow.mock.calls[0]?.[0]).toBe(win);
    await vi.waitFor(() =>
      expect(telemetry.recordShellEvent).toHaveBeenCalledWith("connect-outcome", {
        connId: "c1",
        details: { path: "connect", managed: false, status: "opened", ms: expect.any(Number) },
      }),
    );
  });

  it("lab:open clamps the budget, emits phases only (no output), records telemetry", async () => {
    const { invoke, sender, telemetry } = setup();
    expect(await invoke("lab:open", clusterConn(), { reachTimeoutMs: 5 })).toEqual({ status: "opened" });
    expect(sender.send).toHaveBeenCalledWith("lab:phase", { id: "c1", phase: "waiting" });
    expect(sender.send.mock.calls.some((c) => c[0] === "lab:output")).toBe(false);
    await vi.waitFor(() =>
      expect(telemetry.recordShellEvent).toHaveBeenCalledWith("connect-outcome", {
        connId: "c1",
        details: { path: "open", budgetMs: 1000, managed: false, status: "opened", ms: expect.any(Number) },
      }),
    );
  });

  it("lab:update never forces a tunnel; lab:down streams output", async () => {
    const { invoke, sender, lab } = setup();
    const rt = labInternals(lab)!.rt;
    const spy = vi.spyOn(rt, "update");
    await invoke("lab:update", clusterConn(), { preview: true });
    expect(spy.mock.calls[0]?.[3]).toBe(true);
    expect(spy.mock.calls[0]?.[4]).toBe(false);
    sender.send.mockClear();
    await invoke("lab:down", clusterConn());
    expect(sender.send).toHaveBeenCalledWith("lab:output", { id: "c1", chunk: "Stopped.\n" });
  });

  it("lab:cancel, local:detectStacks, labs:list", async () => {
    const { invoke, lab, execFile } = setup();
    const spy = vi.spyOn(labInternals(lab)!.rt, "cancel");
    await invoke("lab:cancel", "c1");
    expect(spy).toHaveBeenCalledWith("c1");
    expect(await invoke("local:detectStacks")).toEqual([{ project: "silico-local-a", port: 5175, worktree: undefined, branch: undefined }]);
    expect(execFile).toHaveBeenCalled();
    expect(await invoke("labs:list")).toEqual({ ok: true, labs: [], gatewayUrl: "https://my.silico.run", login: "octo" });
  });

  it("malformed connection rejects cleanly", async () => {
    const { invoke } = setup();
    expect(() => invoke("lab:connect", null)).toThrow("Invalid connection.");
  });

  it("service surface delegates (tunnels, cancelWindow, resume)", async () => {
    const { lab, win } = setup();
    const rt = labInternals(lab)!.rt;
    const close = vi.spyOn(rt.tunnels, "close");
    const closeAll = vi.spyOn(rt.tunnels, "closeAll");
    lab.closeTunnel(3);
    lab.killAllTunnels();
    expect(close).toHaveBeenCalledWith(3);
    expect(closeAll).toHaveBeenCalled();
    lab.cancelWindow(win.id);
    expect(rt.epochs.get(win.id)).toBe(1);
    lab.resumePendingReauths();
    expect(await lab.createLabSession({ deploymentId: "acme", managed: false })).toEqual({ ok: true, token: "TOK", labUrl: "https://acme.silico.run" });
    expect(await lab.waitForLab("https://l", "T", { managed: false, budgetMs: 1000 })).toBe("ready");
  });

  it("cancelWindow (user hide) also clears the 45 s re-auth cooldown (C2)", async () => {
    const { lab, win, telemetry } = setup();
    const { reauth } = labInternals(lab)!;
    await lab.reauthOnAuthWall(win as never, "c1"); // unknown conn → down → cooldown
    expect(reauth.stateOf(win as never)?.kind).toBe("cooldown");
    lab.cancelWindow(win.id);
    expect(reauth.stateOf(win as never)).toBeUndefined();
    await lab.reauthOnAuthWall(win as never, "c1");
    expect(telemetry.recordShellEvent).not.toHaveBeenCalledWith("reauth-outcome", expect.objectContaining({ details: expect.objectContaining({ outcome: "cooldown-down" }) }));
  });

  it("forgetWindow drops the epoch, parked re-auth and re-auth state of a closed window (C3)", async () => {
    const { lab, win } = setup();
    const { rt, reauth } = labInternals(lab)!;
    await lab.reauthOnAuthWall(win as never, "c1");
    rt.pending.set(win.id, { win: win as never, connId: "c1", returnTo: null, context: { sub: "s", gatewayUrl: "https://my.silico.run" }, epoch: 9 });
    lab.cancelWindow(win.id); // the windows close path cancels first…
    expect(rt.epochs.has(win.id)).toBe(true);
    lab.forgetWindow(win.id); // …then forgets
    expect(rt.epochs.has(win.id)).toBe(false);
    expect(rt.pending.has(win.id)).toBe(false);
    expect(reauth.stateOf(win as never)).toBeUndefined();
  });
});
