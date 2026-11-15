import { describe, expect, it, vi } from "vitest";
import { GATEWAY_STAGING } from "@shared/config";
import type { RunRemoteOptions } from "../../../src/main/services";
import { LabRuntime, STAGING_CLI_MISSING, STAGING_REPO_MISSING } from "../../../src/main/lab/runtime";
import { FakeChild, clusterConn, fakeWin, harness, http, ok, routeFetch, sessionGateway, type GatewayScript, type RemoteScript } from "./fakes";

const T40 = "0123456789abcdef0123456789abcdef01234567";

function sinks() {
  const phases: string[] = [];
  const logs: string[] = [];
  return { phases, logs, s: { onLog: (c: string) => logs.push(c), onPhase: (p: string) => phases.push(p) } as never };
}

/** Remote script: deployment.toml present, everything else ok. */
const present: RemoteScript = () => ok();

function make(opts: Parameters<typeof harness>[0] = {}) {
  const h = harness({ gatewayScript: sessionGateway(), remote: present, ...opts });
  return { h, r: new LabRuntime(h.ctx, h.deps) };
}

function cmds(h: ReturnType<typeof harness>): string[] {
  return h.ssh.runRemote.mock.calls.map((c) => c[1]);
}

describe("connect: cluster happy path", () => {
  it("checking → ssh → starting → opening → waiting; returns opened with conn.labUrl", async () => {
    const { h, r } = make();
    const k = sinks();
    const win = fakeWin(1);
    const onStart = vi.fn();
    expect(await r.connect(clusterConn(), win, k.s, false, false, onStart)).toEqual({ status: "opened", labUrl: "https://acme.silico.run" });
    expect(onStart).toHaveBeenCalledWith(win);
    expect(k.phases).toEqual(["checking", "ssh", "starting", "opening", "waiting"]);
    expect(cmds(h)).toEqual(['test -f "$HOME/.silico/deployment.toml"', 'PATH="$PATH:$HOME/.local/bin" silico up']);
    expect(k.logs).toContain("Checking the cluster over SSH…\n");
    expect(k.logs).toContain("Starting the Lab (`silico up`). This can take a few minutes…\n");
  });

  it("verbose adds --verbose; streams chunks to the log", async () => {
    const { h, r } = make({
      remote: (cmd, o?: RunRemoteOptions) => {
        if (cmd.includes(" up")) o?.onChunk?.("booting\n", "stdout");
        return ok();
      },
    });
    const k = sinks();
    await r.connect(clusterConn(), fakeWin(), k.s, true, false);
    expect(cmds(h)[1]).toBe('PATH="$PATH:$HOME/.local/bin" silico up --verbose');
    expect(k.logs).toContain("booting\n");
  });

  it("no ssh host → checking → opening directly", async () => {
    const { h, r } = make();
    const k = sinks();
    expect(await r.connect(clusterConn({ ssh: undefined, labUrl: "" }), fakeWin(), k.s, false, false)).toEqual({
      status: "opened",
      labUrl: undefined,
    });
    expect(k.phases).toEqual(["checking", "opening", "waiting"]);
    expect(h.ssh.runRemote).not.toHaveBeenCalled();
  });
});

describe("connect: ssh failures", () => {
  it("host-key changed / unknown", async () => {
    let { r } = make({ remote: () => ({ code: 255, stderr: "@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @" }) });
    expect(await r.connect(clusterConn(), fakeWin(), sinks().s, false, false)).toEqual({ status: "host-key", host: "hpc", kind: "changed" });
    ({ r } = make({ remote: () => ({ code: 255, stderr: "Host key verification failed." }) }));
    expect(await r.connect(clusterConn(), fakeWin(), sinks().s, false, false)).toEqual({ status: "host-key", host: "hpc", kind: "unknown" });
  });
  it("exit 255 → classifySshError", async () => {
    const { r } = make({ remote: () => ({ code: 255, stderr: "Permission denied (publickey)." }) });
    expect(await r.connect(clusterConn(), fakeWin(), sinks().s, false, false)).toEqual({ status: "error", message: "SSH was refused" });
  });
  it("silico up non-zero → error with stderr tail; null code → (stopped)", async () => {
    let { r } = make({ remote: (c) => (c.includes(" up") ? { code: 2, stderr: "boom\n" } : ok()) });
    expect(await r.connect(clusterConn(), fakeWin(), sinks().s, false, false)).toEqual({ status: "error", message: "`silico up` exited 2.\nboom" });
    ({ r } = make({ remote: (c) => (c.includes(" up") ? { code: null, stderr: "" } : ok()) }));
    expect(await r.connect(clusterConn(), fakeWin(), sinks().s, false, false)).toEqual({ status: "error", message: "`silico up` exited (stopped).\n" });
  });
  it("tool missing during up → stderr", async () => {
    const { r } = make({ remote: (c) => (c.includes(" up") ? { code: 255, stderr: " install ssh ", toolMissing: true } : ok()) });
    expect(await r.connect(clusterConn(), fakeWin(), sinks().s, false, false)).toEqual({ status: "error", message: "install ssh" });
  });
});

describe("connect: staging", () => {
  it("probes silico-dev and repo, then runs silico-dev up even without deployment.toml", async () => {
    const { h, r } = make({ gateway: GATEWAY_STAGING, remote: (c) => (c.startsWith("test -f") ? { code: 1 } : ok()) });
    const k = sinks();
    expect((await r.connect(clusterConn(), fakeWin(), k.s, false, false)).status).toBe("opened");
    expect(cmds(h)).toEqual([
      'test -f "$HOME/.silico/deployment.toml"',
      'PATH="$PATH:$HOME/.local/bin" command -v silico-dev >/dev/null 2>&1',
      'test -d "$HOME/silico-repo-dev"',
      'PATH="$PATH:$HOME/.local/bin" silico-dev up',
    ]);
  });
  it("missing dev CLI / repo", async () => {
    let { r } = make({ gateway: GATEWAY_STAGING, remote: (c) => (c.includes("command -v") ? { code: 1 } : ok()) });
    const k = sinks();
    expect(await r.connect(clusterConn(), fakeWin(), k.s, false, false)).toEqual({ status: "error", message: STAGING_CLI_MISSING });
    expect(k.logs).toContain(`${STAGING_CLI_MISSING}\n`);
    ({ r } = make({ gateway: GATEWAY_STAGING, remote: (c) => (c.includes("silico-repo-dev") ? { code: 1 } : ok()) }));
    expect(await r.connect(clusterConn(), fakeWin(), sinks().s, false, false)).toEqual({ status: "error", message: STAGING_REPO_MISSING });
  });
});

describe("connect: first-time setup", () => {
  const missing: RemoteScript = (c) => (c.startsWith("test -f") ? { code: 1 } : ok());

  it("installs via curl|bash with env, then skips start and opens", async () => {
    const { h, r } = make({ remote: missing });
    const k = sinks();
    expect((await r.connect(clusterConn(), fakeWin(), k.s, false, false)).status).toBe("opened");
    expect(k.phases).toEqual(["checking", "ssh", "setup", "opening", "waiting"]);
    expect(cmds(h)[1]).toBe(
      "curl -fsSL 'https://my.silico.run/install' | SILICO_LAB_AUTH_URL='https://my.silico.run' SILICO_CLUSTER_ID='acme' SILICO_SETUP_BEARER='BEAR' bash -s -- --tenant 'acme'",
    );
    expect(cmds(h).some((c) => c.includes(" up"))).toBe(false);
    expect(k.logs).toContain("First time on this cluster. Setting it up…\n");
    expect(k.logs).toContain("Installing and configuring Silico on the cluster (first time only)…\n");
  });

  it("no deployment → needs-setup", async () => {
    const { r } = make({ remote: missing });
    const k = sinks();
    expect(await r.connect(clusterConn({ deploymentId: "" }), fakeWin(), k.s, false, false)).toEqual({ status: "needs-setup" });
    expect(k.logs).toContain("This connection has no deployment to set up automatically.\n");
  });

  it("bearer 403 → forbidden; other failure → needs-setup", async () => {
    const bearer = (status: number): GatewayScript => (req) => (req.path === "/labs/setup-bearer" ? http(status) : http(200, { token: "T", lab_url: "https://l" }));
    let { r } = make({ remote: missing, gatewayScript: bearer(403) });
    expect(await r.connect(clusterConn(), fakeWin(), sinks().s, false, false)).toEqual({ status: "forbidden", login: "octo" });
    ({ r } = make({ remote: missing, gatewayScript: bearer(500) }));
    const k = sinks();
    expect(await r.connect(clusterConn(), fakeWin(), k.s, false, false)).toEqual({ status: "needs-setup" });
    expect(k.logs).toContain("Couldn't authorize setup: Could not authorize setup (HTTP 500).\n");
  });

  it("installer failure → error", async () => {
    const { r } = make({ remote: (c) => (c.startsWith("test -f") ? { code: 1 } : c.startsWith("curl") ? { code: 22, stderr: "404" } : ok()) });
    expect(await r.connect(clusterConn(), fakeWin(), sinks().s, false, false)).toEqual({ status: "error", message: "First-time setup exited 22.\n404" });
  });
});

describe("connect: version checks", () => {
  const listing = (lab: Record<string, unknown>): GatewayScript => (req) =>
    req.path === "/labs"
      ? http(200, { labs: [{ kind: "cluster", deployment_id: "acme", ...lab }] })
      : req.path === "/labs/setup-bearer"
        ? http(200, { setup_bearer: "BEAR" })
        : http(200, { token: "T", lab_url: "https://l" });

  it("pre-start: stale + exact sha mismatch → update instead of up", async () => {
    const { h, r } = make({ gatewayScript: listing({ stale: true, target_sha: T40 }) });
    const k = sinks();
    expect((await r.connect(clusterConn(), fakeWin(), k.s, false, false)).status).toBe("opened");
    expect(k.logs).toContain("This Lab isn’t confirmed on the latest version. Updating it as it starts.\n");
    expect(k.phases).toEqual(["checking", "ssh", "updating", "opening", "waiting"]);
    expect(cmds(h)[1]).toBe(`PATH="$PATH:$HOME/.local/bin" SILICO_CLUSTER_ID='acme' SILICO_SETUP_BEARER='BEAR' silico update`);
  });

  it("pre-start check skipped with previewBuilds / skipVersionCheck", async () => {
    const { h, r } = make({ gatewayScript: listing({ stale: true, target_sha: T40 }), settings: { skipVersionCheck: true } });
    await r.connect(clusterConn(), fakeWin(), sinks().s, false, false);
    expect(cmds(h)[1]).toContain("silico up");
    expect(h.auth.gatewayRequest.mock.calls.some((c) => c[0].path === "/labs")).toBe(false);
  });

  it("post-start: non-stale lab with update_available → update (pinned)", async () => {
    const { h, r } = make({ gatewayScript: listing({ stale: false, update_available: true }) });
    const k = sinks();
    await r.connect(clusterConn(), fakeWin(), k.s, false, false);
    expect(k.phases).toEqual(["checking", "ssh", "starting", "updating", "opening", "waiting"]);
    expect(cmds(h)[2]).toContain("silico update");
    expect(cmds(h)[2]).not.toContain("--preview");
  });

  it("post-start with previewBuilds → update --preview", async () => {
    const { h, r } = make({ gatewayScript: listing({ stale: false, update_required: true }), settings: { previewBuilds: true } });
    await r.connect(clusterConn(), fakeWin(), sinks().s, false, false);
    expect(cmds(h)[2]).toContain("silico update --preview");
  });

  it("pollOutdated: 4 attempts 1.5 s apart while stale, then false", async () => {
    const { h, r } = make({ gatewayScript: listing({ stale: true }) });
    expect(await r.pollOutdated("acme", { pinnedExactCheck: true })).toBe(false);
    expect(h.auth.gatewayRequest).toHaveBeenCalledTimes(4);
    expect(h.clock.sleep.mock.calls).toEqual([[1500], [1500], [1500]]);
  });
});

describe("connect: open result mapping", () => {
  it("unreachable via public URL vs tunnel", async () => {
    let { r } = make({ netFetch: routeFetch(() => new Error("x")) });
    expect(await r.connect(clusterConn(), fakeWin(), sinks().s, false, false)).toEqual({
      status: "error",
      message: "The Lab started but the app can't reach it at https://acme.silico.run yet. It may be behind a VPN/Tailscale, or still coming up. Try Open again in a moment.",
    });
    ({ r } = make({ remote: (c) => (c.startsWith("echo") ? ok("n|1") : ok()), netFetch: routeFetch(() => new Error("x")) }));
    expect((await r.connect(clusterConn(), fakeWin(), sinks().s, false, true)).status).toBe("error");
  });

  it("observed quirk: other (session error) still reports opened", async () => {
    const { h, r } = make({ gatewayScript: () => http(500) });
    expect(await r.connect(clusterConn(), fakeWin(), sinks().s, false, false)).toEqual({ status: "opened", labUrl: "https://acme.silico.run" });
    expect(h.deps.openExternal).toHaveBeenCalled();
  });

  it("forbidden passes through", async () => {
    const { r } = make({ gatewayScript: (req) => (req.path === "/labs/session" ? http(403) : http(200, { labs: [] })) });
    expect(await r.connect(clusterConn(), fakeWin(), sinks().s, false, false)).toEqual({ status: "forbidden", login: "octo" });
  });
});

describe("connect: managed / local", () => {
  const managed = clusterConn({ routeMode: "managed", ssh: undefined });
  it("maps open results", async () => {
    let { r } = make();
    expect(await r.connect(managed, fakeWin(), sinks().s, false, false)).toEqual({ status: "opened", labUrl: "https://acme.silico.run" });
    ({ r } = make({ netFetch: routeFetch(() => new Error("x")) }));
    const res = await r.connect(managed, fakeWin(), sinks().s, false, false);
    expect(res).toEqual({
      status: "error",
      message: "The app couldn't reach this Lab at https://acme.silico.run. Check your internet connection, then try again.",
    });
    ({ r } = make({ gatewayScript: () => http(500) }));
    expect(await r.connect(managed, fakeWin(), sinks().s, false, false)).toEqual({
      status: "error",
      message: "This Lab couldn't be opened right now. If it keeps happening, reach out to Goodfire on Slack.",
    });
    ({ r } = make({ netFetch: routeFetch(() => 503) }));
    expect(await r.connect(managed, fakeWin(), sinks().s, false, false)).toEqual({ status: "still-waking" });
  });
});

describe("update", () => {
  it("guards", async () => {
    const { r } = make();
    const k = sinks();
    expect(await r.update(clusterConn({ ssh: undefined }), null, k.s, false, false)).toEqual({
      status: "error",
      message: "No SSH host configured for this connection.",
    });
    expect(await r.update(clusterConn({ deploymentId: "" }), null, k.s, false, false)).toEqual({
      status: "error",
      message: "No deployment configured for this connection.",
    });
  });

  it("staging: -dev cluster id, silico-dev, preview ignored", async () => {
    const { h, r } = make({ gateway: GATEWAY_STAGING });
    const k = sinks();
    expect((await r.update(clusterConn(), fakeWin(), k.s, true, false)).status).toBe("opened");
    expect(cmds(h)[0]).toBe(`PATH="$PATH:$HOME/.local/bin" SILICO_CLUSTER_ID='acme-dev' SILICO_SETUP_BEARER='BEAR' silico-dev update`);
    expect(k.logs[0]).toMatch(/^Updating the Lab\. This stops it/);
    expect(k.logs[1]).toBe("Nothing is lost; your threads, experiments, and data pick up where they were.\n");
    expect(h.auth.gatewayRequest.mock.calls[0]?.[0].body).toEqual({ deployment_id: "acme-dev" });
  });

  it("preview on prod", async () => {
    const { h, r } = make();
    const k = sinks();
    await r.update(clusterConn(), fakeWin(), k.s, true, false);
    expect(cmds(h)[0]).toMatch(/silico update --preview$/);
    expect(k.logs[0]).toMatch(/^Updating the Lab to the preview \(staging\) build/);
  });

  it("bearer failure / non-zero exit / unreachable", async () => {
    let { r } = make({ gatewayScript: () => http(500) });
    expect(await r.update(clusterConn(), null, sinks().s, false, false)).toEqual({
      status: "error",
      message: "Couldn't authorize the update: Could not authorize setup (HTTP 500).",
    });
    ({ r } = make({ remote: () => ({ code: 1, stderr: "nope" }) }));
    expect(await r.update(clusterConn(), null, sinks().s, false, false)).toEqual({ status: "error", message: "`silico update` exited 1.\nnope" });
    ({ r } = make({ netFetch: routeFetch(() => new Error("x")) }));
    expect(await r.update(clusterConn(), fakeWin(), sinks().s, false, false)).toEqual({
      status: "error",
      message: "Updated, but the app can't reach the Lab at https://acme.silico.run yet. Try Open again in a moment.",
    });
  });
});

describe("down", () => {
  it("runs silico down --yes and reports", async () => {
    const { h, r } = make();
    const logs: string[] = [];
    await r.down(clusterConn(), (c) => logs.push(c));
    expect(cmds(h)).toEqual(['PATH="$PATH:$HOME/.local/bin" silico down --yes']);
    expect(logs).toEqual(["Stopping the Lab (`silico down`)…\n", "Stopped.\n"]);
    expect(h.ssh.runRemote.mock.calls[0]?.[2]?.signal).toBeUndefined();
  });
  it("non-zero, tool missing, no host", async () => {
    let logs: string[] = [];
    let { r } = make({ remote: () => ({ code: 3 }) });
    await r.down(clusterConn(), (c) => logs.push(c));
    expect(logs[1]).toBe("`silico down` exited 3.\n");
    logs = [];
    ({ r } = make({ remote: () => ({ code: 255, stderr: "no ssh", toolMissing: true }) }));
    await r.down(clusterConn(), (c) => logs.push(c));
    expect(logs[1]).toBe("no ssh\n");
    logs = [];
    await r.down(clusterConn({ ssh: undefined }), (c) => logs.push(c));
    expect(logs).toEqual(["No SSH host configured.\n"]);
  });
  it("staging uses silico-dev", async () => {
    const { h, r } = make({ gateway: GATEWAY_STAGING });
    await r.down(clusterConn(), () => {});
    expect(cmds(h)[0]).toContain("silico-dev down --yes");
  });
});

describe("cancel", () => {
  it("SIGTERMs the running op child, aborts its signal; result shows (stopped)", async () => {
    let release!: (v: { code: number | null }) => void;
    const child = new FakeChild();
    let signal: AbortSignal | undefined;
    const { r } = make({
      remote: (c, o) => {
        if (!c.includes(" up")) return ok();
        o?.onSpawn?.(child as never);
        signal = o?.signal;
        return new Promise((res) => (release = res));
      },
    });
    const p = r.connect(clusterConn(), fakeWin(), sinks().s, false, false);
    await new Promise((res) => setTimeout(res, 0));
    expect(r.opChild.get("c1")).toBe(child);
    r.cancel("c1");
    expect(child.killed).toEqual(["SIGTERM"]);
    expect(signal?.aborted).toBe(true);
    expect(r.opChild.has("c1")).toBe(false);
    release({ code: null });
    expect(await p).toEqual({ status: "error", message: "`silico up` exited (stopped).\n" });
    expect(r.opAbort.has("c1")).toBe(false);
  });

  it("aborts readiness polls → canceled with 'Stopped.'", async () => {
    let r!: LabRuntime;
    const h = harness({
      gatewayScript: sessionGateway(),
      netFetch: routeFetch(() => {
        r.cancel("c1");
        return 503;
      }),
    });
    r = new LabRuntime(h.ctx, h.deps);
    const log = vi.fn();
    expect(await r.openLab(clusterConn(), fakeWin(), { onLog: log })).toEqual({ status: "canceled" });
    expect(log).toHaveBeenLastCalledWith("Stopped.\n");
    expect(r.waitAborts.size).toBe(0);
  });

  it("cancels parked re-auths for that connection", () => {
    const { h, r } = make();
    const win = fakeWin(6);
    h.winsById.set(6, win);
    r.pending.set(6, { win, connId: "c1", returnTo: null, context: { sub: "s", gatewayUrl: "g" }, epoch: 1 });
    r.pending.set(7, { win: fakeWin(7), connId: "other", returnTo: null, context: { sub: "s", gatewayUrl: "g" }, epoch: 1 });
    r.cancel("c1");
    expect([...r.pending.keys()]).toEqual([7]);
    expect(r.epochs.get(6)).toBe(1);
  });

  it("a second op on the same id overwrites the slot", async () => {
    const releases: ((v: { code: number }) => void)[] = [];
    const { r } = make({
      remote: (c, o) => {
        if (!c.includes(" up")) return ok();
        o?.onSpawn?.(new FakeChild() as never);
        return new Promise((res) => releases.push(res));
      },
    });
    const a = r.connect(clusterConn(), null, sinks().s, false, false);
    await new Promise((res) => setTimeout(res, 0));
    const firstAbort = r.opAbort.get("c1");
    const b = r.connect(clusterConn(), null, sinks().s, false, false);
    await new Promise((res) => setTimeout(res, 0));
    expect(r.opAbort.get("c1")).not.toBe(firstAbort);
    releases.forEach((f) => f({ code: 1 }));
    await Promise.all([a, b]);
  });
});
