import { describe, expect, it, vi } from "vitest";
import { GATEWAY_STAGING } from "@shared/config";
import { createHash } from "node:crypto";
import { LabRuntime } from "../../../src/main/lab/runtime";
import { clusterConn, fakeWin, harness, http, ok, routeFetch, sessionGateway } from "./fakes";

function rt(h: ReturnType<typeof harness>) {
  return new LabRuntime(h.ctx, h.deps);
}

describe("openLab: cluster", () => {
  it("session → waiting → mount callback URL; no tunnel for a public URL", async () => {
    const h = harness({ gatewayScript: sessionGateway() });
    const r = rt(h);
    const win = fakeWin(3);
    const phases: string[] = [];
    const log = vi.fn();
    const res = await r.openLab(clusterConn(), win, { onPhase: (p) => phases.push(p), onLog: log, returnTo: "/x" });
    expect(res).toEqual({ status: "opened" });
    expect(phases).toEqual(["waiting"]);
    expect(log).toHaveBeenCalledWith("Authenticated. Opening the Lab.\n");
    expect(h.windows.openLabInWindow).toHaveBeenCalledWith(win, "c1", "https://acme.silico.run/auth/callback?return_to=%2Fx#token=TOK", "My Lab");
    expect(h.auth.gatewayRequest.mock.calls[0]?.[0].body).toEqual({ deployment_id: "acme" });
    expect(r.epochs.get(3)).toBe(1);
  });

  it("staging applies -dev to the session deployment id", async () => {
    const h = harness({ gateway: GATEWAY_STAGING, gatewayScript: sessionGateway() });
    await rt(h).openLab(clusterConn(), fakeWin(), {});
    expect(h.auth.gatewayRequest.mock.calls[0]?.[0].body).toEqual({ deployment_id: "acme-dev" });
  });

  it("localhost lab_url → tunneling then waiting against the local port", async () => {
    const netFetch = routeFetch(() => 200);
    const h = harness({ gatewayScript: sessionGateway("http://localhost:8000"), remote: () => ok("n1|8000"), netFetch });
    const r = rt(h);
    const win = fakeWin(5);
    const phases: string[] = [];
    expect(await r.openLab(clusterConn(), win, { onPhase: (p) => phases.push(p) })).toEqual({ status: "opened" });
    expect(phases).toEqual(["tunneling", "waiting"]);
    expect(netFetch.mock.calls[0]?.[0]).toBe("http://localhost:45678/api/cluster/version");
    expect(h.windows.openLabInWindow.mock.calls[0]?.[2]).toBe("http://localhost:45678/auth/callback?return_to=%2F#token=TOK");
    expect(r.tunnels.isActive(5)).toBe(true);
  });

  it("[::1] lab_url also tunnels (D5.4)", async () => {
    const h = harness({ gatewayScript: sessionGateway("http://[::1]:8000"), remote: () => ok("n1|8000") });
    const phases: string[] = [];
    await rt(h).openLab(clusterConn(), fakeWin(), { onPhase: (p) => phases.push(p) });
    expect(phases).toContain("tunneling");
  });

  it("forceTunnel without a window → unreachable", async () => {
    const h = harness({ gatewayScript: sessionGateway() });
    const log = vi.fn();
    expect(await rt(h).openLab(clusterConn(), null, { forceTunnel: true, onLog: log })).toEqual({
      status: "unreachable",
      url: "https://acme.silico.run",
    });
    expect(log).toHaveBeenCalledWith("Cannot open an SSH tunnel without a window.\n");
  });

  it("tunnel failure → unreachable with the session URL", async () => {
    const h = harness({ gatewayScript: sessionGateway(), remote: () => ok("bad") });
    const log = vi.fn();
    expect(await rt(h).openLab(clusterConn(), fakeWin(), { forceTunnel: true, onLog: log })).toEqual({
      status: "unreachable",
      url: "https://acme.silico.run",
    });
    expect(log).toHaveBeenCalledWith("Couldn't read the Lab's host/port over SSH to open a tunnel.\n");
  });

  it("a public open closes the window's existing tunnel", async () => {
    const h = harness({ gatewayScript: sessionGateway(), remote: () => ok("n|1") });
    const r = rt(h);
    const win = fakeWin(2);
    await r.openLab(clusterConn(), win, { forceTunnel: true });
    expect(r.tunnels.isActive(2)).toBe(true);
    await r.openLab(clusterConn(), win, {});
    expect(r.tunnels.isActive(2)).toBe(false);
  });

  it("readiness unreachable → unreachable at base", async () => {
    const h = harness({ gatewayScript: sessionGateway(), netFetch: routeFetch(() => new Error("x")) });
    const log = vi.fn();
    expect(await rt(h).openLab(clusterConn(), fakeWin(), { reachBudgetMs: 2000, onLog: log })).toEqual({
      status: "unreachable",
      url: "https://acme.silico.run",
    });
    expect(log).toHaveBeenCalledWith("The Lab is running but the app couldn't reach it at https://acme.silico.run.\n");
    expect(h.windows.openLabInWindow).not.toHaveBeenCalled();
  });

  it("409 + ssh host → claim with sha256(token) then proceed", async () => {
    const h = harness({
      remote: (cmd) => (cmd.includes("claim.token") ? ok("RAWTOKEN\n") : ok()),
      gatewayScript: (req) =>
        req.path === "/labs/session" ? http(409) : req.path === "/labs/claim" ? http(200, { token: "CT", lab_url: "https://c" }) : http(404),
    });
    const phases: string[] = [];
    const log = vi.fn();
    expect(await rt(h).openLab(clusterConn(), fakeWin(), { onPhase: (p) => phases.push(p), onLog: log })).toEqual({ status: "opened" });
    expect(phases).toEqual(["claiming", "waiting"]);
    const hash = createHash("sha256").update("RAWTOKEN").digest("hex");
    expect(h.auth.gatewayRequest.mock.calls[1]?.[0].body).toEqual({ deployment_id: "acme", claim_token_hash: hash });
    expect(h.windows.openLabInWindow.mock.calls[0]?.[2]).toBe("https://c/auth/callback?return_to=%2F#token=CT");
    expect(log.mock.calls[0]?.[0]).toMatch(/^First time on this cluster. Binding your Lab/);
  });

  it("claim 409 → stale route message with browser link; status other", async () => {
    const h = harness({
      remote: () => ok("RAW"),
      gatewayScript: (req) => (req.path === "/labs/session" ? http(409) : http(409)),
    });
    const log = vi.fn();
    expect(await rt(h).openLab(clusterConn(), fakeWin(), { onLog: log })).toEqual({ status: "other" });
    expect(log).toHaveBeenCalledWith(
      "This cluster has a stale route from a previous session. Open this once in your browser to re-bind, then reconnect:\n  https://my.silico.run/claim#t=RAW\n",
    );
  });

  it("claim token unreadable", async () => {
    const h = harness({ remote: () => ({ code: 1 }), gatewayScript: () => http(409) });
    const log = vi.fn();
    expect(await rt(h).openLab(clusterConn(), fakeWin(), { onLog: log })).toEqual({ status: "other" });
    expect(log).toHaveBeenCalledWith("Couldn't read this cluster's claim token over SSH to bind your route.\n");
  });

  it("403 → forbidden with login", async () => {
    const h = harness({ gatewayScript: () => http(403) });
    const log = vi.fn();
    expect(await rt(h).openLab(clusterConn(), fakeWin(), { onLog: log })).toEqual({ status: "forbidden", login: "octo" });
    expect(log).toHaveBeenCalledWith(
      "Your GitHub account (@octo) isn't authorized for this Lab. You may be signed in with the wrong account.\n",
    );
  });

  it("session error → browser fallback (other)", async () => {
    const h = harness({ gatewayScript: () => http(500) });
    const log = vi.fn();
    expect(await rt(h).openLab(clusterConn(), fakeWin(), { onLog: log })).toEqual({ status: "other" });
    expect(log).toHaveBeenCalledWith("Could not get a Lab session (HTTP 500).\n");
    expect(h.deps.openExternal).toHaveBeenCalledWith("https://my.silico.run/?return_to=%2F&deployment=acme");
  });

  it("no deployment id → browser fallback without deployment param", async () => {
    const h = harness();
    await rt(h).openLab(clusterConn({ deploymentId: "" }), fakeWin(), {});
    expect(h.deps.openExternal).toHaveBeenCalledWith("https://my.silico.run/?return_to=%2F");
  });

  it("browserFallback:false → other, never opens the browser", async () => {
    const h = harness({ gatewayScript: () => http(500) });
    const log = vi.fn();
    expect(await rt(h).openLab(clusterConn(), fakeWin(), { browserFallback: false, onLog: log })).toEqual({ status: "other" });
    expect(log).toHaveBeenLastCalledWith("Couldn't re-establish the Lab session automatically.\n");
    expect(h.deps.openExternal).not.toHaveBeenCalled();
  });
});

describe("openLab: managed", () => {
  const managed = clusterConn({ routeMode: "managed", deploymentId: "m-1", ssh: undefined });

  it("opening → wake poll → closes tunnel and mounts", async () => {
    const h = harness({ gateway: GATEWAY_STAGING, gatewayScript: sessionGateway("https://m.silico.run") });
    const r = rt(h);
    const close = vi.spyOn(r.tunnels, "close");
    const phases: string[] = [];
    expect(await r.openLab(managed, fakeWin(9), { onPhase: (p) => phases.push(p) })).toEqual({ status: "opened" });
    expect(phases).toEqual(["opening"]);
    expect(h.auth.gatewayRequest.mock.calls[0]?.[0].body).toEqual({ deployment_id: "m-1" });
    expect(close).toHaveBeenCalledWith(9);
    expect(h.windows.openLabInWindow.mock.calls[0]?.[2]).toBe("https://m.silico.run/auth/callback?return_to=%2F#token=TOK");
  });

  it("warming → waking; still-waking after 90 s", async () => {
    const h = harness({ gatewayScript: sessionGateway("https://m"), netFetch: routeFetch(() => 503) });
    const phases: string[] = [];
    const log = vi.fn();
    expect(await rt(h).openLab(managed, fakeWin(), { onPhase: (p) => phases.push(p), onLog: log, reachBudgetMs: 3000 })).toEqual({
      status: "still-waking",
    });
    expect(phases).toEqual(["opening", "waking"]);
    expect(log).toHaveBeenLastCalledWith("The Lab is taking longer than usual to start — try again in a moment.\n");
    expect(h.clock.t - 1_000_000).toBe(90_000);
  });

  it("unreachable within the reach budget", async () => {
    const h = harness({ gatewayScript: sessionGateway("https://m"), netFetch: routeFetch(() => new Error("x")) });
    const log = vi.fn();
    expect(await rt(h).openLab(managed, fakeWin(), { onLog: log, reachBudgetMs: 3000 })).toEqual({ status: "unreachable", url: "https://m" });
    expect(log).toHaveBeenLastCalledWith("Couldn't reach the Lab at https://m.\n");
  });

  it("missing deployment / 403 / other errors", async () => {
    const log = vi.fn();
    expect(await rt(harness()).openLab({ ...managed, deploymentId: "" }, fakeWin(), { onLog: log })).toEqual({ status: "other" });
    expect(log).toHaveBeenCalledWith("This connection has no deployment to open.\n");
    expect(await rt(harness({ gatewayScript: () => http(403) })).openLab(managed, fakeWin(), {})).toMatchObject({ status: "forbidden" });
    const h = harness({ gatewayScript: () => http(500) });
    expect(await rt(h).openLab(managed, fakeWin(), {})).toEqual({ status: "other" });
    expect(h.deps.openExternal).not.toHaveBeenCalled();
  });
});

describe("openLab: local", () => {
  const local = clusterConn({ id: "local:x", routeMode: "local", deploymentId: "goodfire-local", labUrl: "http://localhost:5174", ssh: undefined });

  it("healthz up → session with lab_url → mount", async () => {
    const h = harness({ gatewayScript: sessionGateway("http://localhost:5174") });
    expect(await rt(h).openLab(local, fakeWin(), {})).toEqual({ status: "opened" });
    expect(h.auth.gatewayRequest.mock.calls[0]?.[0].body).toEqual({ deployment_id: "goodfire-local", lab_url: "http://localhost:5174" });
  });

  it("stack down → unreachable with guidance", async () => {
    const h = harness({ fetch: routeFetch(() => new Error("refused")) });
    const log = vi.fn();
    expect(await rt(h).openLab(local, fakeWin(), { onLog: log })).toEqual({ status: "unreachable", url: "http://localhost:5174" });
    expect(log.mock.calls[0]?.[0]).toMatch(/^The local dev stack isn't reachable at http:\/\/localhost:5174\.\nStart it/);
  });

  it("no labUrl → other", async () => {
    expect(await rt(harness()).openLab({ ...local, labUrl: "" }, fakeWin(), {})).toEqual({ status: "other" });
  });
});

describe("epochs / supersession", () => {
  it("a newer open on the same window makes the older resolve canceled", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const h = harness({
      gatewayScript: async (req) => {
        if (req.path === "/labs/session" && n++ === 0) await gate;
        return http(200, { token: "T", lab_url: "https://l" });
      },
    });
    const r = rt(h);
    const win = fakeWin(1);
    const first = r.openLab(clusterConn(), win, {});
    const second = await r.openLab(clusterConn(), win, {});
    release();
    expect(await first).toEqual({ status: "canceled" });
    expect(second).toEqual({ status: "opened" });
    expect(h.windows.openLabInWindow).toHaveBeenCalledTimes(1);
  });

  it("recoveryEpoch is used instead of bumping; a stale one cancels immediately", async () => {
    const h = harness({ gatewayScript: sessionGateway() });
    const r = rt(h);
    const win = fakeWin(1);
    r.epochs.set(1, 4);
    expect(await r.openLab(clusterConn(), win, { recoveryEpoch: 4 })).toEqual({ status: "opened" });
    expect(r.epochs.get(1)).toBe(4);
    expect(await r.openLab(clusterConn(), win, { recoveryEpoch: 3 })).toEqual({ status: "canceled" });
  });

  it("a destroyed window has no epoch and never cancels", async () => {
    const h = harness({ gatewayScript: sessionGateway() });
    const r = rt(h);
    const win = fakeWin(1);
    win.destroyed = true;
    expect(r.bumpEpoch(win)).toBeNull();
    expect(r.isCurrent(win, null)).toBe(true);
    expect(r.isCurrent(null, 5)).toBe(true);
  });

  it("cancelWindow bumps the epoch, drops the parked re-auth and clears reauth flags", () => {
    const h = harness();
    const r = rt(h);
    const win = fakeWin(4);
    h.winsById.set(4, win);
    r.pending.set(4, { win, connId: "c1", returnTo: null, context: { sub: "s", gatewayUrl: "g" }, epoch: 1 });
    r.cancelWindow(4);
    expect(r.epochs.get(4)).toBe(1);
    expect(r.pending.size).toBe(0);
    expect(h.windows.setReauthing).toHaveBeenCalledWith(win, false);
  });

  it("identity change supersedes all opens and drops parked re-auths of other identities", () => {
    const h = harness();
    const r = rt(h);
    const w1 = fakeWin(1);
    const w2 = fakeWin(2);
    r.epochs.set(1, 1);
    r.epochs.set(2, 7);
    r.pending.set(1, { win: w1, connId: "a", returnTo: null, context: { sub: "s1", gatewayUrl: "g" }, epoch: 1 });
    r.pending.set(2, { win: w2, connId: "b", returnTo: null, context: { sub: "s2", gatewayUrl: "g" }, epoch: 7 });
    r.onIdentityChanged({ sub: "s1", gatewayUrl: "g" });
    expect([r.epochs.get(1), r.epochs.get(2)]).toEqual([2, 8]);
    expect([...r.pending.keys()]).toEqual([1]);
    r.onIdentityChanged(null);
    expect(r.pending.size).toBe(0);
  });
});
