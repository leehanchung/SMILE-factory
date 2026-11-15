/**
 * Lab lifecycle module entry (owner: I3).
 *
 * Owns: connect / update / down / cancel / open (`Ge`) with phases, op and
 * epoch registries, gateway /labs, /labs/session, /labs/claim,
 * /labs/setup-bearer, readiness + managed wake polls, SSH tunnels (per
 * window), local docker stack detection, re-auth in place (`rs`/`xt`/`ns`,
 * pending resume after sign-in). IPC: lab:status, lab:connect, lab:update,
 * lab:cancel, lab:down, lab:open, local:detectStacks, labs:list.
 */
import { execFile as nodeExecFile } from "node:child_process";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { BrowserWindow, net, shell } from "electron";
import type { WebContents } from "electron";
import { ShellEventChannel, ShellInvokeChannel } from "@shared/ipc";
import type { LabPhase } from "@shared/ipc";
import { handleShell, sendShell } from "../ipc/trust";
import type { LabLifecycleService, MainContext } from "../services";
import type { ExecFileLike } from "./localStacks";
import type { FetchLike } from "./probes";
import { clampReachBudget, isManaged, normalizeConnection } from "./pure";
import { ReauthController } from "./reauth";
import { LabRuntime, type LabSinks, type RuntimeDeps } from "./runtime";
import type { TimerHandle } from "./tunnel";

export interface LabDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Global fetch used by lab:status. */
  fetch?: FetchLike;
  /** electron.net.fetch used by readiness/wake probes. */
  netFetch?: FetchLike;
  openExternal?: (url: string) => Promise<void>;
  windowFromId?: (id: number) => BrowserWindow | null;
  windowFromWebContents?: (wc: WebContents) => BrowserWindow | null;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  allocatePort?: () => Promise<number>;
  tcpProbe?: (port: number) => Promise<boolean>;
  execFile?: ExecFileLike;
}

// ---------------------------------------------------------------------------
// Real-world defaults (never used by tests)
// ---------------------------------------------------------------------------

function defaultAllocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function defaultTcpProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    sock.on("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

function defaultSetTimer(fn: () => void, ms: number): TimerHandle {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { clear: () => clearTimeout(t) };
}

const defaultExecFile: ExecFileLike = (file, args, opts) =>
  new Promise((resolve, reject) => {
    nodeExecFile(file, args, { timeout: opts.timeout }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout) });
    });
  });

function resolveDeps(deps: LabDeps = {}): RuntimeDeps & { windowFromWebContents: (wc: WebContents) => BrowserWindow | null } {
  return {
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
    netFetch: deps.netFetch ?? ((url, init) => net.fetch(url, init)),
    openExternal: deps.openExternal ?? ((url) => shell.openExternal(url)),
    windowFromId: deps.windowFromId ?? ((id) => BrowserWindow.fromId(id)),
    windowFromWebContents: deps.windowFromWebContents ?? ((wc) => BrowserWindow.fromWebContents(wc)),
    setTimer: deps.setTimer ?? defaultSetTimer,
    allocatePort: deps.allocatePort ?? defaultAllocatePort,
    tcpProbe: deps.tcpProbe ?? defaultTcpProbe,
    execFile: deps.execFile ?? defaultExecFile,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

interface LabInternals {
  rt: LabRuntime;
  reauth: ReauthController;
  windowFromWebContents: (wc: WebContents) => BrowserWindow | null;
  hooksInstalled: boolean;
}

const internalsByService = new WeakMap<LabLifecycleService, LabInternals>();

/** Test/IPC access to the runtime behind a service created by `createLabLifecycleService`. */
export function labInternals(service: LabLifecycleService): LabInternals | undefined {
  return internalsByService.get(service);
}

export function createLabLifecycleService(ctx: MainContext, deps?: LabDeps): LabLifecycleService {
  const resolved = resolveDeps(deps);
  const rt = new LabRuntime(ctx, resolved);
  const reauth = new ReauthController(rt);
  const service: LabLifecycleService = {
    openLab: (conn, win, opts) => rt.openLab(conn, win, opts),
    reauthOnAuthWall: (win, connId, returnTo) => reauth.reauthOnAuthWall(win, connId, returnTo),
    rewake: (win, connId, returnTo) => reauth.rewake(win, connId, returnTo),
    resumePendingReauths: () => {
      void reauth.resumePending().catch((err: unknown) => ctx.logger("lab").warn("resume pending re-auths failed", err));
    },
    cancelWindow: (winId) => {
      rt.cancelWindow(winId);
      reauth.clearStateById(winId); // a user hide also ends the reauthing flag and the 45 s cooldown
    },
    forgetWindow: (winId) => {
      rt.forgetWindow(winId);
      reauth.clearStateById(winId);
    },
    closeTunnel: (winId) => rt.tunnels.close(winId),
    killAllTunnels: () => rt.tunnels.closeAll(),
    listLabs: () => rt.listLabs(),
    createLabSession: (req) => rt.createLabSession(req),
    waitForLab: (baseUrl, token, opts) => rt.waitForLab(baseUrl, token, opts),
  };
  internalsByService.set(service, { rt, reauth, windowFromWebContents: resolved.windowFromWebContents, hooksInstalled: false });
  return service;
}

/** Subscribe to auth identity / sign-in events (once; called from registerLabIpc, i.e. after whenReady). */
export function installLabAuthHooks(ctx: MainContext, internals: LabInternals): void {
  if (internals.hooksInstalled) return;
  internals.hooksInstalled = true;
  ctx.auth.onIdentityChanged((identity) => internals.rt.onIdentityChanged(identity ? { sub: identity.sub, gatewayUrl: identity.gatewayUrl } : null));
  ctx.auth.onSignedIn((identity) => internals.reauth.onSignedIn(identity));
}

function sinksFor(wc: WebContents, connId: string): LabSinks {
  return {
    onLog: (chunk) => sendShell(wc, ShellEventChannel.labOutput, { id: connId, chunk }),
    onPhase: (phase: LabPhase) => sendShell(wc, ShellEventChannel.labPhase, { id: connId, phase }),
  };
}

export function registerLabIpc(ctx: MainContext): void {
  const internals = labInternals(ctx.lab);
  if (!internals) throw new Error("registerLabIpc: ctx.lab was not created by createLabLifecycleService");
  const { rt, reauth } = internals;
  installLabAuthHooks(ctx, internals);
  const winOf = (wc: WebContents): BrowserWindow | null => internals.windowFromWebContents(wc);

  handleShell(ShellInvokeChannel.labStatus, (_e, url) => rt.labStatus(url));

  handleShell(ShellInvokeChannel.labOpen, (e, rawConn, opts) => {
    const conn = normalizeConnection(rawConn);
    const started = rt.deps.now();
    const budgetMs = clampReachBudget(opts?.reachTimeoutMs);
    const p = rt.openLab(conn, winOf(e.sender), {
      reachBudgetMs: budgetMs,
      onPhase: (phase) => sendShell(e.sender, ShellEventChannel.labPhase, { id: conn.id, phase }),
    });
    p.then((r) =>
      ctx.telemetry.recordShellEvent("connect-outcome", {
        connId: conn.id,
        details: { path: "open", budgetMs, managed: isManaged(conn), status: r.status, ms: rt.deps.now() - started },
      }),
    ).catch(() => {});
    return p;
  });

  handleShell(ShellInvokeChannel.labConnect, (e, rawConn, verbose, opts) => {
    const conn = normalizeConnection(rawConn);
    const started = rt.deps.now();
    const p = rt.connect(conn, winOf(e.sender), sinksFor(e.sender, conn.id), !!verbose, opts?.tunnel ?? false, (win) =>
      reauth.clearState(win),
    );
    p.then((r) =>
      ctx.telemetry.recordShellEvent("connect-outcome", {
        connId: conn.id,
        details: { path: "connect", managed: isManaged(conn), status: r.status, ms: rt.deps.now() - started },
      }),
    ).catch(() => {});
    return p;
  });

  handleShell(ShellInvokeChannel.labUpdate, (e, rawConn, opts) => {
    const conn = normalizeConnection(rawConn);
    return rt.update(conn, winOf(e.sender), sinksFor(e.sender, conn.id), opts?.preview ?? false, false);
  });

  handleShell(ShellInvokeChannel.labCancel, (_e, connId) => {
    rt.cancel(String(connId));
  });

  handleShell(ShellInvokeChannel.labDown, (e, rawConn) => {
    const conn = normalizeConnection(rawConn);
    return rt.down(conn, sinksFor(e.sender, conn.id).onLog);
  });

  handleShell(ShellInvokeChannel.localDetectStacks, () => rt.detectStacks());
  handleShell(ShellInvokeChannel.labsList, () => ctx.lab.listLabs());
}
