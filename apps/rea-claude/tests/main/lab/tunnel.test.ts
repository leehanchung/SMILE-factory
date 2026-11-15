import { describe, expect, it, vi } from "vitest";
import { TunnelManager, type TunnelDeps } from "../../../src/main/lab/tunnel";
import type { SshService } from "../../../src/main/services";
import { FakeChild, fakeClock, fakeSsh, ok, type RemoteScript } from "./fakes";

function setup(opts: { remote?: RemoteScript; tcp?: (p: number) => Promise<boolean>; port?: () => Promise<number> } = {}) {
  const clock = fakeClock();
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const children: FakeChild[] = [];
  const ssh = fakeSsh(opts.remote ?? (() => ok("10.0.0.5|8123\n")));
  ssh.spawnTool.mockImplementation(async () => {
    const c = new FakeChild();
    children.push(c);
    return { ok: true as const, child: c as never };
  });
  const deps: TunnelDeps = {
    now: clock.now,
    sleep: clock.sleep,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return { clear: () => (t.cleared = true) };
    },
    allocatePort: opts.port ?? (async () => 40001),
    tcpProbe: opts.tcp ?? (async () => true),
  };
  const mgr = new TunnelManager(() => ssh as unknown as SshService, deps);
  return { mgr, ssh, clock, timers, children };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("TunnelManager.open", () => {
  it("rejects option-looking ssh targets before running or spawning anything (D5.6)", async () => {
    const { mgr, ssh } = setup();
    expect(await mgr.open(7, { host: "-oProxyCommand=touch /tmp/pwned" }, false)).toEqual({ ok: false, error: "Invalid host name." });
    expect(await mgr.open(7, { host: "hpc", user: "-oProxyCommand=x" }, false)).toEqual({ ok: false, error: "Invalid user name." });
    expect(await mgr.open(7, { host: "hpc", jump: "ok,-oProxyCommand=x" }, false)).toEqual({ ok: false, error: "Invalid jump host." });
    expect(ssh.runRemote).not.toHaveBeenCalled();
    expect(ssh.spawnTool).not.toHaveBeenCalled();
  });

  it("reads target, allocates port, spawns ssh -L and returns the local URL", async () => {
    const { mgr, ssh, children } = setup();
    const log = vi.fn();
    const r = await mgr.open(7, { host: "hpc", user: "me" }, false, log);
    expect(r).toEqual({ ok: true, localUrl: "http://localhost:40001" });
    expect(ssh.runRemote.mock.calls[0]?.[1]).toContain("$HOME/.silico/state/lab-host.txt");
    expect(ssh.spawnTool).toHaveBeenCalledWith("ssh", [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-N",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      "40001:10.0.0.5:8123",
      "--",
      "me@hpc",
    ]);
    expect(log).toHaveBeenCalledWith("Opening an SSH tunnel to the Lab (localhost:40001)…\n");
    expect(mgr.isActive(7)).toBe(true);
    expect(mgr.get(7)?.armed).toBe(true);
    expect(children).toHaveLength(1);
  });

  it("staging reads the _dev state dir", async () => {
    const { mgr, ssh } = setup();
    await mgr.open(1, { host: "h" }, true);
    expect(ssh.runRemote.mock.calls[0]?.[1]).toContain("state/_dev/lab-host.txt");
  });

  it("error paths", async () => {
    expect(await setup().mgr.open(1, undefined, false)).toEqual({ ok: false, error: "No SSH host configured for the tunnel." });
    expect(await setup({ remote: () => ok("|") }).mgr.open(1, { host: "h" }, false)).toEqual({
      ok: false,
      error: "Couldn't read the Lab's host/port over SSH to open a tunnel.",
    });
    expect(await setup({ remote: () => ({ code: 255, stderr: "no ssh", toolMissing: true }) }).mgr.open(1, { host: "h" }, false)).toEqual({
      ok: false,
      error: "no ssh",
    });
    const noPort = setup({ port: async () => Promise.reject(new Error("x")) });
    expect(await noPort.mgr.open(1, { host: "h" }, false)).toEqual({ ok: false, error: "Could not allocate a local port for the tunnel." });
    expect(noPort.mgr.isActive(1)).toBe(false);
  });

  it("spawn failure (tool missing / throw) closes the state", async () => {
    const s = setup();
    s.ssh.spawnTool.mockResolvedValueOnce({ ok: false, toolMissing: true, message: "install ssh" } as never);
    expect(await s.mgr.open(1, { host: "h" }, false)).toEqual({ ok: false, error: "install ssh" });
    s.ssh.spawnTool.mockRejectedValueOnce(new Error("EACCES"));
    expect(await s.mgr.open(1, { host: "h" }, false)).toEqual({ ok: false, error: "EACCES" });
    expect(s.mgr.isActive(1)).toBe(false);
  });

  it("readiness: polls every 250 ms for 8 s, then fails with the manual command", async () => {
    const tcp = vi.fn(async () => false);
    const { mgr, clock, children } = setup({ tcp });
    const r = await mgr.open(1, { host: "h", port: 2222, identityFile: "/k" }, false);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe(
      "The SSH tunnel to the Lab did not come up. The login node may not reach the compute node. You can try it manually:\n  ssh -N -i /k -p 2222 -L 40001:10.0.0.5:8123 h",
    );
    expect(clock.sleep).toHaveBeenCalledWith(250);
    expect(tcp).toHaveBeenCalledTimes(33); // t=0..8000 step 250
    expect(children[0]?.killed).toEqual(["SIGTERM"]);
    expect(mgr.isActive(1)).toBe(false);
  });

  it("readiness succeeds after a few attempts", async () => {
    let n = 0;
    const { mgr } = setup({ tcp: async () => ++n >= 3 });
    expect((await mgr.open(1, { host: "h" }, false)).ok).toBe(true);
  });

  it("a newer open on the same window replaces the older one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const { mgr } = setup({
      remote: async () => {
        if (calls++ === 0) await gate;
        return ok("n|1");
      },
    });
    const first = mgr.open(1, { host: "h" }, false);
    const second = await mgr.open(1, { host: "h" }, false);
    release();
    expect(await first).toEqual({ ok: false, error: "Tunnel setup was replaced by a newer connect." });
    expect(second.ok).toBe(true);
    expect(mgr.isActive(1)).toBe(true);
  });

  it("close / closeAll kill the child and drop the state", async () => {
    const { mgr, children } = setup();
    await mgr.open(1, { host: "h" }, false);
    await mgr.open(2, { host: "h" }, false);
    mgr.close(1);
    expect(children[0]?.killed).toEqual(["SIGTERM"]);
    expect(mgr.isActive(1)).toBe(false);
    mgr.closeAll();
    expect(children[1]?.killed).toEqual(["SIGTERM"]);
    expect(mgr.isActive(2)).toBe(false);
  });
});

describe("TunnelManager auto-reconnect", () => {
  it("backs off 1,2,4,8,8,8 s then gives up after 6 retries", async () => {
    const { mgr, timers, children, clock } = setup();
    const log = vi.fn();
    await mgr.open(1, { host: "h" }, false, log);
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      children[children.length - 1]?.emit("close");
      const t = timers[timers.length - 1]!;
      delays.push(t.ms);
      clock.t += 1000; // child lived < 60 s
      t.fn();
      await flush();
      await flush();
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
    expect(log).toHaveBeenCalledWith("SSH tunnel dropped. Reconnecting…\n");
    expect(children).toHaveLength(7);
    // respawn on the same local port
    expect(mgr.get(1)?.localPort).toBe(40001);
    children[children.length - 1]?.emit("close");
    expect(log).toHaveBeenLastCalledWith("SSH tunnel dropped and could not be re-established. Reconnect to retry.\n");
    expect(timers).toHaveLength(6);
    expect(mgr.isActive(1)).toBe(false); // X19: giving up tears the state down
  });

  it("a child that lived ≥ 60 s resets the retry counter", async () => {
    const { mgr, timers, children, clock } = setup();
    await mgr.open(1, { host: "h" }, false);
    mgr.get(1)!.retries = 5;
    clock.t += 60_000;
    children[0]?.emit("close");
    expect(timers[0]?.ms).toBe(1000);
  });

  it("does not reconnect when closed or not yet armed", async () => {
    const { mgr, timers, children } = setup();
    await mgr.open(1, { host: "h" }, false);
    mgr.close(1);
    children[0]?.emit("close");
    expect(timers).toHaveLength(0);
  });

  it("unparseable target on retry schedules the next backoff", async () => {
    let calls = 0;
    const { mgr, timers, children } = setup({ remote: () => (calls++ === 0 ? ok("n|1") : ok("garbage")) });
    await mgr.open(1, { host: "h" }, false);
    children[0]?.emit("close");
    timers[0]!.fn();
    await flush();
    expect(timers).toHaveLength(2);
    expect(timers[1]?.ms).toBe(2000);
  });

  it("close clears a pending backoff timer", async () => {
    const { mgr, timers, children } = setup();
    await mgr.open(1, { host: "h" }, false);
    children[0]?.emit("close");
    mgr.close(1);
    expect(timers[0]?.cleared).toBe(true);
  });

  it("a failed respawn (ok:false) counts as an attempt and schedules the next backoff (T2)", async () => {
    const { mgr, timers, children, ssh } = setup();
    const log = vi.fn();
    await mgr.open(1, { host: "h" }, false, log);
    ssh.spawnTool.mockResolvedValue({ ok: false, message: "spawn ssh EAGAIN" } as never);
    children[0]?.emit("close");
    for (let i = 0; i < 6; i++) {
      timers[timers.length - 1]!.fn();
      await flush();
      await flush();
    }
    expect(timers.map((t) => t.ms)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
    expect(log).toHaveBeenCalledWith("spawn ssh EAGAIN\n");
    expect(log).toHaveBeenLastCalledWith("SSH tunnel dropped and could not be re-established. Reconnect to retry.\n");
    expect(mgr.isActive(1)).toBe(false);
  });

  it("a throwing respawn is retried, and a later success re-arms the tunnel", async () => {
    const { mgr, timers, children, ssh } = setup();
    await mgr.open(1, { host: "h" }, false);
    ssh.spawnTool.mockRejectedValueOnce(new Error("EMFILE"));
    children[0]?.emit("close");
    timers[0]!.fn();
    await flush();
    await flush();
    expect(timers).toHaveLength(2);
    timers[1]!.fn();
    await flush();
    await flush();
    expect(children).toHaveLength(2);
    expect(mgr.get(1)?.child).toBe(children[1]);
    expect(mgr.isActive(1)).toBe(true);
  });

  it("toolMissing on the retry read logs and gives up (inactive)", async () => {
    let calls = 0;
    const { mgr, timers, children } = setup({
      remote: () => (calls++ === 0 ? ok("n|1") : { code: 255, stderr: "ssh not found", toolMissing: true }),
    });
    const log = vi.fn();
    await mgr.open(1, { host: "h" }, false, log);
    children[0]?.emit("close");
    timers[0]!.fn();
    await flush();
    await flush();
    expect(log).toHaveBeenLastCalledWith("ssh not found\n");
    expect(timers).toHaveLength(1);
    expect(mgr.isActive(1)).toBe(false);
  });
});

describe("TunnelManager races (T3)", () => {
  it("child that closes before the tunnel is armed: no reconnect timer, manual-command error", async () => {
    let closed = false;
    const s = setup({
      tcp: async () => {
        if (!closed) {
          closed = true;
          const c = s.children[0]!;
          expect(c.listenerCount("close")).toBe(1);
          c.emit("close"); // ssh exits (e.g. forward failure) before readiness
        }
        return false;
      },
    });
    const r = await s.mgr.open(1, { host: "h" }, false);
    expect(!r.ok && r.error).toMatch(/^The SSH tunnel to the Lab did not come up\..*\n {2}ssh -N -L 40001:10\.0\.0\.5:8123 h$/s);
    expect(s.timers).toHaveLength(0);
    expect(s.mgr.isActive(1)).toBe(false);
  });

  it("close(win) while the spawn is pending: the late child is SIGTERM'd and open reports replaced", async () => {
    const s = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const late = new FakeChild();
    s.ssh.spawnTool.mockImplementationOnce(async () => {
      await gate;
      return { ok: true as const, child: late as never };
    });
    const pending = s.mgr.open(1, { host: "h" }, false);
    await flush();
    s.mgr.close(1);
    release();
    expect(await pending).toEqual({ ok: false, error: "Tunnel setup was replaced by a newer connect." });
    expect(late.killed).toEqual(["SIGTERM"]);
    expect(s.mgr.isActive(1)).toBe(false);
  });

  it.each(["allocatePort", "spawn", "waitReady"] as const)("a newer open during %s replaces the older one", async (stage) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const once = async <T>(v: T): Promise<T> => {
      if (first) {
        first = false;
        await gate;
      }
      return v;
    };
    const s = setup({
      port: stage === "allocatePort" ? () => once(40001) : undefined,
      tcp: stage === "waitReady" ? () => once(true) : undefined,
    });
    if (stage === "spawn") {
      s.ssh.spawnTool.mockImplementationOnce(async () => {
        const c = new FakeChild();
        s.children.push(c);
        return once({ ok: true as const, child: c as never });
      });
    }
    const older = s.mgr.open(1, { host: "h" }, false);
    await flush();
    const newer = await s.mgr.open(1, { host: "h" }, false);
    release();
    expect(await older).toEqual({ ok: false, error: "Tunnel setup was replaced by a newer connect." });
    expect(newer.ok).toBe(true);
    expect(s.mgr.isActive(1)).toBe(true);
    if (stage !== "allocatePort") expect(s.children[0]?.killed).toEqual(["SIGTERM"]);
  });
});
