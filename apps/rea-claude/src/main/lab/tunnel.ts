/**
 * Per-window SSH `-L` tunnel registry with auto-reconnect. [lab §5.2]
 */
import type { ChildProcess } from "node:child_process";
import {
  TUNNEL_MAX_RETRIES,
  TUNNEL_READY_POLL_MS,
  TUNNEL_READY_TIMEOUT_MS,
  TUNNEL_RETRY_RESET_AFTER_MS,
} from "@shared/config";
import type { SshTarget } from "@shared/ipc";
import { sshTargetError } from "@shared/sshTarget";
import type { SshService } from "../services";
import { backoffMs, manualTunnelCmd, parseTunnelTarget, readTunnelTargetCmd, tunnelArgs } from "./pure";

export interface TimerHandle {
  clear(): void;
}

export interface TunnelDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Unref'd one-shot timer. */
  setTimer: (fn: () => void, ms: number) => TimerHandle;
  /** Grab a free port on 127.0.0.1 (listen(0) then close). Rejects on failure. */
  allocatePort: () => Promise<number>;
  /** One TCP connect attempt to 127.0.0.1:<port>. */
  tcpProbe: (port: number) => Promise<boolean>;
}

/** Child surface the registry needs (a real ChildProcess satisfies it). */
type TunnelChild = Pick<ChildProcess, "on" | "kill">;

export interface TunnelState {
  winId: number;
  ssh: SshTarget;
  staging: boolean;
  localPort: number;
  child: TunnelChild | null;
  closed: boolean;
  armed: boolean;
  onLog?: (s: string) => void;
  retries: number;
  lastSpawnAt: number;
  backoff: TimerHandle | null;
}

export type TunnelResult = { ok: true; localUrl: string } | { ok: false; error: string };

const REPLACED = "Tunnel setup was replaced by a newer connect.";

type TargetRead = { host: string; port: number } | { missing: string } | null;

export class TunnelManager {
  private readonly tunnels = new Map<number, TunnelState>();

  constructor(
    private readonly ssh: () => SshService,
    private readonly deps: TunnelDeps,
  ) {}

  /** For tests / diagnostics. */
  get(winId: number): TunnelState | undefined {
    return this.tunnels.get(winId);
  }

  /** `Vl`: does this window own a live tunnel? */
  isActive(winId: number): boolean {
    const t = this.tunnels.get(winId);
    return !!t && !t.closed;
  }

  /** Teardown (`B`). */
  close(winId: number): void {
    const t = this.tunnels.get(winId);
    if (!t) return;
    t.closed = true;
    t.backoff?.clear();
    t.backoff = null;
    t.child?.kill("SIGTERM");
    t.child = null;
    this.tunnels.delete(winId);
  }

  closeAll(): void {
    for (const id of [...this.tunnels.keys()]) this.close(id);
  }

  private async readTarget(target: SshTarget, staging: boolean): Promise<TargetRead> {
    const res = await this.ssh().runRemote(target, readTunnelTargetCmd(staging));
    if (res.toolMissing) return { missing: res.stderr };
    if (res.code !== 0) return null;
    return parseTunnelTarget(res.stdout);
  }

  /** Spawn the forwarding child (`Yi`). */
  private async spawn(state: TunnelState, host: string, port: number): Promise<{ ok: true } | { ok: false; error: string }> {
    const invalid = sshTargetError(state.ssh);
    if (invalid) return { ok: false, error: invalid };
    const ssh = this.ssh();
    const args = tunnelArgs(ssh.sshArgs(state.ssh), ssh.sshDest(state.ssh), state.localPort, host, port);
    let child: TunnelChild;
    try {
      const r = await ssh.spawnTool("ssh", args);
      if (!r.ok) return { ok: false, error: r.message };
      child = r.child;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (state.closed) {
      child.on("error", () => {});
      child.kill("SIGTERM");
      return { ok: true };
    }
    state.child = child;
    state.lastSpawnAt = this.deps.now();
    child.on("error", () => {});
    child.on("close", () => {
      if (state.child === child) state.child = null;
      if (state.closed || !state.armed) return;
      if (this.deps.now() - state.lastSpawnAt >= TUNNEL_RETRY_RESET_AFTER_MS) state.retries = 0;
      this.scheduleReconnect(state);
    });
    return { ok: true };
  }

  /**
   * Give up on auto-reconnect: log and tear the state down so `isActive` no
   * longer reports a dead tunnel (X19; the original kept the dead state).
   */
  private giveUp(state: TunnelState, message: string): void {
    state.onLog?.(message);
    if (this.tunnels.get(state.winId) === state) this.close(state.winId);
    else state.closed = true;
  }

  /** Reconnect with backoff (`Zi`). */
  private scheduleReconnect(state: TunnelState): void {
    if (state.closed || state.backoff) return;
    if (state.retries >= TUNNEL_MAX_RETRIES) {
      this.giveUp(state, "SSH tunnel dropped and could not be re-established. Reconnect to retry.\n");
      return;
    }
    const delay = backoffMs(state.retries);
    state.retries += 1;
    state.backoff = this.deps.setTimer(() => {
      state.backoff = null;
      if (state.closed) return;
      void (async () => {
        const target = await this.readTarget(state.ssh, state.staging);
        if (state.closed || state.backoff) return;
        if (target && "missing" in target) {
          // ssh itself is gone: retrying cannot help.
          this.giveUp(state, `${target.missing}\n`);
          return;
        }
        if (!target) {
          this.scheduleReconnect(state);
          return;
        }
        state.onLog?.("SSH tunnel dropped. Reconnecting…\n");
        const r = await this.spawn(state, target.host, target.port);
        if (r.ok || state.closed) return;
        // A failed respawn counts as another failed attempt (X19).
        if (r.error) state.onLog?.(`${r.error}\n`);
        this.scheduleReconnect(state);
      })().catch(() => {
        // Unexpected throw (e.g. runRemote rejected): treat as a failed attempt.
        if (!state.closed && !state.backoff && !state.child) this.scheduleReconnect(state);
      });
    }, delay);
  }

  /** `Nl`: TCP connect every 250 ms for up to 8 s. */
  private async waitReady(state: TunnelState): Promise<boolean> {
    const deadline = this.deps.now() + TUNNEL_READY_TIMEOUT_MS;
    for (;;) {
      if (state.closed) return false;
      if (await this.deps.tcpProbe(state.localPort)) return true;
      if (state.closed || this.deps.now() >= deadline) return false;
      await this.deps.sleep(TUNNEL_READY_POLL_MS);
    }
  }

  /** Open a tunnel for `winId` (`Hl`), replacing any existing one. */
  async open(winId: number, target: SshTarget | undefined, staging: boolean, onLog?: (s: string) => void): Promise<TunnelResult> {
    if (!target?.host) return { ok: false, error: "No SSH host configured for the tunnel." };
    const invalid = sshTargetError(target);
    if (invalid) return { ok: false, error: invalid };
    this.close(winId);
    const state: TunnelState = {
      winId,
      ssh: target,
      staging,
      localPort: 0,
      child: null,
      closed: false,
      armed: false,
      onLog,
      retries: 0,
      lastSpawnAt: 0,
      backoff: null,
    };
    this.tunnels.set(winId, state);

    const lab = await this.readTarget(target, staging);
    if (state.closed) return { ok: false, error: REPLACED };
    if (lab && "missing" in lab) {
      this.close(winId);
      return { ok: false, error: lab.missing };
    }
    if (!lab) {
      this.close(winId);
      return { ok: false, error: "Couldn't read the Lab's host/port over SSH to open a tunnel." };
    }

    const port = await this.deps.allocatePort().catch(() => 0);
    if (state.closed) return { ok: false, error: REPLACED };
    if (!port) {
      this.close(winId);
      return { ok: false, error: "Could not allocate a local port for the tunnel." };
    }
    state.localPort = port;
    onLog?.(`Opening an SSH tunnel to the Lab (localhost:${port})…\n`);

    const spawned = await this.spawn(state, lab.host, lab.port);
    if (state.closed) return { ok: false, error: REPLACED };
    if (!spawned.ok) {
      this.close(winId);
      return { ok: false, error: spawned.error || "Could not start ssh for the tunnel." };
    }

    const up = await this.waitReady(state);
    if (state.closed) return { ok: false, error: REPLACED };
    if (!up) {
      this.close(winId);
      const manual = manualTunnelCmd(target, this.ssh().sshDest(target), port, lab.host, lab.port);
      return {
        ok: false,
        error: `The SSH tunnel to the Lab did not come up. The login node may not reach the compute node. You can try it manually:\n  ${manual}`,
      };
    }
    state.armed = true;
    return { ok: true, localUrl: `http://localhost:${port}` };
  }
}
