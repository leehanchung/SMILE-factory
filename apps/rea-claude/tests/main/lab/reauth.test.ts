import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() }, session: { fromPartition: vi.fn() } }));

import { classifyReopenFailure, ReauthController } from "../../../src/main/lab/reauth";
import { LabRuntime } from "../../../src/main/lab/runtime";
import { clusterConn, fakeWin, harness, http, routeFetch, sessionGateway } from "./fakes";

function setup(opts: Parameters<typeof harness>[0] = {}) {
  const h = harness({ gatewayScript: sessionGateway(), ...opts });
  h.connections.push(clusterConn({ ssh: undefined }));
  const rt = new LabRuntime(h.ctx, h.deps);
  const ctl = new ReauthController(rt);
  const win = fakeWin(1);
  h.winsById.set(1, win);
  return { h, rt, ctl, win };
}

function sent(win: ReturnType<typeof fakeWin>): unknown[][] {
  return win.webContents.send.mock.calls;
}

describe("classifyReopenFailure (Pa)", () => {
  it("maps", () => {
    expect(classifyReopenFailure("still-waking", true)).toBe("still-waking");
    expect(classifyReopenFailure("unreachable", true)).toBe("down");
    expect(classifyReopenFailure("other", false)).toBe("expired");
  });
});

describe("reauthOnAuthWall (rs)", () => {
  it("reopens in place: reauthing flag, loading state, hide, open without browser fallback, cooldown", async () => {
    const { h, rt, ctl, win } = setup();
    h.windows.currentLabReturnTo.mockReturnValue("/threads/1");
    await ctl.reauthOnAuthWall(win, "c1");
    expect(h.windows.setReauthing.mock.calls).toEqual([
      [win, true],
      [win, false],
    ]);
    expect(sent(win)[0]).toEqual(["lab:state", { id: "c1", state: "loading" }]);
    expect(h.windows.hideLabView).toHaveBeenCalledTimes(1);
    expect(h.windows.openLabInWindow).toHaveBeenCalledWith(
      win,
      "c1",
      "https://acme.silico.run/auth/callback?return_to=%2Fthreads%2F1#token=TOK",
      "My Lab",
    );
    expect(sent(win)).toContainEqual(["lab:phase", { id: "c1", phase: "waiting" }]);
    expect(h.telemetry.recordShellEvent).toHaveBeenCalledWith("reauth-outcome", {
      connId: "c1",
      details: { trigger: "auth-wall", outcome: "opened" },
    });
    expect(ctl.stateOf(win)).toEqual({ kind: "cooldown", until: h.clock.t + 45_000 });
    expect(rt.epochs.get(1)).toBe(1);
  });

  it("uses the 15 s budget and reports down on failure", async () => {
    const { h, ctl, win } = setup({ netFetch: routeFetch(() => new Error("x")) });
    const start = h.clock.t;
    await ctl.reauthOnAuthWall(win, "c1", "/a");
    expect(h.clock.t - start).toBe(15_000);
    expect(sent(win)).toContainEqual(["lab:state", { id: "c1", state: "down", reason: "error" }]);
    expect(h.windows.hideLabView).toHaveBeenCalledTimes(2);
    expect(h.deps.openExternal).not.toHaveBeenCalled();
  });

  it("in cooldown → cooldown-down, no reopen", async () => {
    const { h, ctl, win } = setup();
    await ctl.reauthOnAuthWall(win, "c1");
    h.windows.openLabInWindow.mockClear();
    h.clock.t += 10_000;
    await ctl.reauthOnAuthWall(win, "c1");
    expect(h.windows.openLabInWindow).not.toHaveBeenCalled();
    expect(h.telemetry.recordShellEvent).toHaveBeenLastCalledWith("reauth-outcome", {
      connId: "c1",
      details: { trigger: "auth-wall", outcome: "cooldown-down" },
    });
    expect(sent(win).at(-1)).toEqual(["lab:state", { id: "c1", state: "down", reason: "error" }]);
    h.clock.t += 40_000;
    await ctl.reauthOnAuthWall(win, "c1");
    expect(h.windows.openLabInWindow).toHaveBeenCalledTimes(1);
  });

  it("skips while already reauthing; skips destroyed windows", async () => {
    const { h, ctl, win } = setup();
    let release: ((v: { reloaded: boolean }) => void) | undefined;
    h.windows.waitForShellRenderer.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const first = ctl.reauthOnAuthWall(win, "c1");
    await ctl.reauthOnAuthWall(win, "c1");
    await vi.waitFor(() => expect(release).toBeDefined());
    release?.({ reloaded: true });
    await first;
    expect(h.windows.openLabInWindow).toHaveBeenCalledTimes(1);
    expect(h.windows.resendLabOpened).toHaveBeenCalledWith(win);
    const dead = fakeWin(2);
    dead.destroyed = true;
    await ctl.reauthOnAuthWall(dead, "c1");
    expect(h.windows.setReauthing).not.toHaveBeenCalledWith(dead, true);
  });

  it("session expired → expired: badge clear, auth:expired, parked for resume, no cooldown", async () => {
    const { h, rt, ctl, win } = setup();
    h.auth.state.signedIn = false;
    await ctl.reauthOnAuthWall(win, "c1", "/r");
    expect(h.auth.recordSessionDeath).toHaveBeenCalledWith("proof-expired-under-lab");
    expect(h.bridge.clearBadgeCounts).toHaveBeenCalled();
    expect(sent(win)).toContainEqual(["auth:expired"]);
    expect(rt.pending.get(1)).toMatchObject({ connId: "c1", returnTo: "/r", context: { sub: "sub-1", gatewayUrl: "https://my.silico.run" }, epoch: 1 });
    expect(ctl.stateOf(win)).toBeUndefined();
  });

  it("parked identity uses the session's own gatewayUrl, not activeGateway()", async () => {
    const { h, rt, ctl, win } = setup();
    h.auth.lastIdentity.mockReturnValue({ sub: "sub-9", gatewayUrl: "https://my-staging.silico.run" });
    h.auth.state.signedIn = false;
    await ctl.reauthOnAuthWall(win, "c1", "/r");
    expect(rt.pending.get(1)?.context).toEqual({ sub: "sub-9", gatewayUrl: "https://my-staging.silico.run" });
  });

  it("unknown connection → down", async () => {
    const { h, ctl, win } = setup();
    await ctl.reauthOnAuthWall(win, "nope");
    expect(h.windows.openLabInWindow).not.toHaveBeenCalled();
    expect(sent(win).at(-1)).toEqual(["lab:state", { id: "nope", state: "down", reason: "error" }]);
  });

  it("still-waking outcome reports reason still-waking", async () => {
    const h0 = setup({ netFetch: routeFetch(() => 503) });
    h0.h.connections[0] = clusterConn({ routeMode: "managed", ssh: undefined });
    await h0.ctl.rewake(h0.win, "c1");
    expect(sent(h0.win)).toContainEqual(["lab:state", { id: "c1", state: "down", reason: "still-waking" }]);
  });

  it("superseded (user hid the Lab) → nothing reported, state cleared", async () => {
    const { h, rt, ctl, win } = setup();
    h.windows.waitForShellRenderer.mockImplementationOnce(async () => {
      rt.cancelWindow(1);
      return { reloaded: false };
    });
    await ctl.reauthOnAuthWall(win, "c1");
    expect(h.windows.openLabInWindow).not.toHaveBeenCalled();
    expect(h.telemetry.recordShellEvent).toHaveBeenCalledWith("reauth-outcome", {
      connId: "c1",
      details: { trigger: "auth-wall", outcome: "superseded" },
    });
    expect(ctl.stateOf(win)).toBeUndefined();
    expect(sent(win).some((c) => c[0] === "lab:state" && (c[1] as { state: string }).state === "down")).toBe(false);
  });

  it("keeps an active tunnel (forceTunnel) when reopening", async () => {
    const { rt, ctl, win } = setup();
    const spy = vi.spyOn(rt, "openLab");
    vi.spyOn(rt.tunnels, "isActive").mockReturnValue(true);
    vi.spyOn(rt.tunnels, "open").mockResolvedValue({ ok: true, localUrl: "http://localhost:1" });
    await ctl.reauthOnAuthWall(win, "c1");
    expect(spy.mock.calls[0]?.[2]).toMatchObject({ forceTunnel: true, browserFallback: false, recoveryEpoch: 1, reachBudgetMs: 15_000 });
  });

  it("exception inside the reopen → down (logged)", async () => {
    const { h, rt, ctl, win } = setup();
    vi.spyOn(rt, "openLab").mockRejectedValue(new Error("kaboom"));
    await ctl.reauthOnAuthWall(win, "c1");
    expect(sent(win).at(-1)).toEqual(["lab:state", { id: "c1", state: "down", reason: "error" }]);
    expect(h.windows.hideLabView).toHaveBeenCalledTimes(2);
  });
});

describe("rewake (xt)", () => {
  it("30 s budget, marks reconnect, restores a previous unexpired cooldown", async () => {
    const { h, ctl, win } = setup();
    await ctl.reauthOnAuthWall(win, "c1");
    const cooldown = ctl.stateOf(win);
    const spy = vi.spyOn((ctl as unknown as { rt: LabRuntime }).rt, "openLab");
    await ctl.rewake(win, "c1", null);
    expect(h.telemetry.markRecent).toHaveBeenCalledWith("reconnect");
    expect(spy.mock.calls[0]?.[2]).toMatchObject({ reachBudgetMs: 30_000 });
    expect(spy.mock.calls[0]?.[2]?.returnTo).toBeUndefined();
    expect(h.windows.currentLabReturnTo).toHaveBeenCalledTimes(1);
    expect(ctl.stateOf(win)).toBe(cooldown);
    expect(h.telemetry.recordShellEvent).toHaveBeenLastCalledWith("reauth-outcome", { connId: "c1", details: { trigger: "wake", outcome: "opened" } });
  });

  it("without a previous cooldown the state is cleared", async () => {
    const { ctl, win } = setup();
    await ctl.rewake(win, "c1");
    expect(ctl.stateOf(win)).toBeUndefined();
  });

  it("lab:connect clearState removes cooldown", async () => {
    const { ctl, win } = setup();
    await ctl.reauthOnAuthWall(win, "c1");
    ctl.clearState(win);
    expect(ctl.stateOf(win)).toBeUndefined();
  });
});

describe("pending resume after sign-in", () => {
  async function parked() {
    const s = setup();
    s.h.auth.state.signedIn = false;
    await s.ctl.reauthOnAuthWall(s.win, "c1", "/r");
    s.h.auth.state.signedIn = true;
    s.h.windows.openLabInWindow.mockClear();
    return s;
  }

  it("onSignedIn with the same identity resumes via rs", async () => {
    const { h, rt, ctl } = await parked();
    ctl.onSignedIn({ sub: "sub-1", gatewayUrl: "https://my.silico.run" });
    expect(rt.pending.size).toBe(0);
    await vi.waitFor(() => expect(h.windows.openLabInWindow).toHaveBeenCalledTimes(1));
    expect(h.windows.openLabInWindow.mock.calls[0]?.[2]).toContain("return_to=%2Fr");
  });

  it("a different identity drops it without reopening", async () => {
    const { h, rt, ctl } = await parked();
    ctl.onSignedIn({ sub: "someone-else", gatewayUrl: "https://my.silico.run" });
    expect(rt.pending.size).toBe(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.windows.openLabInWindow).not.toHaveBeenCalled();
  });

  it("a superseded epoch drops it", async () => {
    const { h, rt, ctl } = await parked();
    rt.epochs.set(1, 99);
    ctl.onSignedIn({ sub: "sub-1", gatewayUrl: "https://my.silico.run" });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.windows.openLabInWindow).not.toHaveBeenCalled();
  });

  it("resumePending retries only when signed in", async () => {
    const { h, rt, ctl } = await parked();
    h.auth.state.signedIn = false;
    await ctl.resumePending();
    expect(rt.pending.size).toBe(1);
    h.auth.state.signedIn = true;
    await ctl.resumePending();
    await vi.waitFor(() => expect(h.windows.openLabInWindow).toHaveBeenCalledTimes(1));
  });

  it("signed out (identity cleared) → expired but nothing parked", async () => {
    const { h, rt, ctl, win } = setup();
    h.auth.state.signedIn = false;
    h.auth.state.identity = null;
    await ctl.reauthOnAuthWall(win, "c1", "/r");
    expect(sent(win)).toContainEqual(["auth:expired"]);
    expect(rt.pending.size).toBe(0);
  });

  it("gateway 403 during reopen is reported as down (no browser)", async () => {
    const { h, ctl, win } = setup({ gatewayScript: () => http(403) });
    await ctl.reauthOnAuthWall(win, "c1");
    expect(sent(win).at(-1)).toEqual(["lab:state", { id: "c1", state: "down", reason: "error" }]);
    expect(h.deps.openExternal).not.toHaveBeenCalled();
  });
});

describe("session drop → expired → park → same-account sign-in reopens (C1)", () => {
  async function dropped() {
    const s = setup();
    // 1. the Lab is open
    expect((await s.rt.openLab(s.h.connections[0]!, s.win, { reachBudgetMs: 30_000 })).status).toBe("opened");
    // 2. the session is dropped (gateway 401 / refresh 401|404 → clearSession): no session object,
    //    but the published identity survives
    s.h.auth.state.signedIn = false;
    expect(s.h.auth.cachedIdentity()).toBeNull();
    // 3. the Lab hits its auth wall → reopen → expired → parked
    await s.ctl.reauthOnAuthWall(s.win, "c1", "/threads/7");
    expect(sent(s.win)).toContainEqual(["auth:expired"]);
    expect(s.rt.pending.get(1)?.context).toEqual({ sub: "sub-1", gatewayUrl: "https://my.silico.run" });
    s.h.windows.openLabInWindow.mockClear();
    s.h.auth.state.signedIn = true;
    return s;
  }

  it("signing in again as the same sub+gateway reopens the Lab at the parked route", async () => {
    const { h, rt, ctl } = await dropped();
    ctl.onSignedIn({ sub: "sub-1", gatewayUrl: "https://my.silico.run" });
    await vi.waitFor(() => expect(h.windows.openLabInWindow).toHaveBeenCalledTimes(1));
    expect(h.windows.openLabInWindow.mock.calls[0]?.[2]).toContain("return_to=%2Fthreads%2F7");
    expect(rt.pending.size).toBe(0);
  });

  it("a different sub (or gateway) does not reopen", async () => {
    const a = await dropped();
    a.ctl.onSignedIn({ sub: "sub-2", gatewayUrl: "https://my.silico.run" });
    const b = await dropped();
    b.ctl.onSignedIn({ sub: "sub-1", gatewayUrl: "https://my-staging.silico.run" });
    await new Promise((r) => setTimeout(r, 0));
    expect(a.h.windows.openLabInWindow).not.toHaveBeenCalled();
    expect(b.h.windows.openLabInWindow).not.toHaveBeenCalled();
  });
});

describe("a fresh (non-recovery) open clears the window's reauth flags", () => {
  it("so a userLeft left by hiding during a re-auth cannot swallow the user's own open", async () => {
    const { h, rt, win } = setup();
    await rt.openLab(h.connections[0]!, win, { reachBudgetMs: 30_000 });
    expect(h.windows.setReauthing).toHaveBeenCalledWith(win, false);
    h.windows.setReauthing.mockClear();
    await rt.openLab(h.connections[0]!, win, { reachBudgetMs: 30_000, recoveryEpoch: rt.epochs.get(1)! });
    expect(h.windows.setReauthing).not.toHaveBeenCalled();
  });
});
