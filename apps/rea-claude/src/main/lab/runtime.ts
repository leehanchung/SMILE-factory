/**
 * Lab lifecycle runtime: op/epoch registries, the shared open flow (`Ge`),
 * connect / update / down / cancel. [lab §3.2, §4.1-§4.8]
 */
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { BrowserWindow } from "electron";
import {
  CONNECT_REACH_BUDGET_MS,
  GATEWAY_STAGING,
  MANAGED_WAKE_TIMEOUT_MS,
  VERSION_POLL_ATTEMPTS,
  VERSION_POLL_INTERVAL_MS,
} from "@shared/config";
import type { Connection, ConnectOutcome, LabPhase, LabsListResult, OpenResult, SshTarget } from "@shared/ipc";
import type { LabSessionResult, LabWaitOutcome, MainContext, OpenLabOptions, RemoteResult } from "../services";
import * as gw from "./gateway";
import { detectLocalStacks, type ExecFileLike } from "./localStacks";
import { labStatus, waitClusterReady, waitManagedWake, type FetchLike } from "./probes";
import {
  DEPLOYMENT_PROBE_CMD,
  STAGING_CLI_PROBE_CMD,
  STAGING_REPO_PROBE_CMD,
  callbackUrl,
  claimTokenCmd,
  cliName,
  depIdFor,
  downCmd,
  exitedMessage,
  gatewayFallbackUrl,
  installCmd,
  isLocal,
  isLoopbackUrl,
  isManaged,
  labTitle,
  needsExactUpdate,
  stripTrailingSlashes,
  updateCmd,
  updateFlags,
  updateLabel,
  upCmd,
  withLocalBin,
} from "./pure";
import { TunnelManager, type TimerHandle } from "./tunnel";

export interface RuntimeDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Node global fetch (lab:status). */
  fetch: FetchLike;
  /** electron.net.fetch (readiness / wake probes). */
  netFetch: FetchLike;
  openExternal: (url: string) => Promise<void>;
  windowFromId: (id: number) => BrowserWindow | null;
  setTimer: (fn: () => void, ms: number) => TimerHandle;
  allocatePort: () => Promise<number>;
  tcpProbe: (port: number) => Promise<boolean>;
  execFile: ExecFileLike;
}

export interface LabSinks {
  onLog: (chunk: string) => void;
  onPhase: (phase: LabPhase) => void;
}

/** Identity captured when a re-auth discovered an expired session. */
export interface ReauthContext {
  sub: string;
  gatewayUrl: string;
}

export interface PendingReauth {
  win: BrowserWindow;
  connId: string;
  returnTo: string | null;
  context: ReauthContext;
  epoch: number;
}

export const STAGING_CLI_MISSING =
  "The dev CLI (silico-dev) isn't installed on this cluster. On its login node, update the Silico CLI, then run `silico-dev setup`.";
export const STAGING_REPO_MISSING =
  "This cluster has no staging (dev) environment yet. SSH to its login node and run:\n  silico-dev setup\nthen try Connect again.";

const FALLBACK_ERROR = "This Lab couldn't be opened right now. If it keeps happening, reach out to Goodfire on Slack.";

export class LabRuntime {
  /** `_e`: per-window open epoch. */
  readonly epochs = new Map<number, number>();
  /** `Re`: abort for the long SSH command of a connection. */
  readonly opAbort = new Map<string, AbortController>();
  /** `ce`: the running ssh child of that command. */
  readonly opChild = new Map<string, ChildProcess>();
  /** `Q`: readiness-poll controllers per connection. */
  readonly waitAborts = new Map<string, Set<AbortController>>();
  /** `le`: re-auths parked until the user signs in again, keyed by window id. */
  readonly pending = new Map<number, PendingReauth>();
  readonly tunnels: TunnelManager;

  constructor(
    readonly ctx: MainContext,
    readonly deps: RuntimeDeps,
  ) {
    this.tunnels = new TunnelManager(() => ctx.ssh, deps);
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  async isStaging(): Promise<boolean> {
    return (await this.ctx.auth.activeGateway()) === GATEWAY_STAGING;
  }

  private alive(win: BrowserWindow | null | undefined): win is BrowserWindow {
    return !!win && !win.isDestroyed();
  }

  /** `es`: bump the window epoch (drops a parked re-auth); null without a live window. */
  bumpEpoch(win: BrowserWindow | null): number | null {
    if (!this.alive(win)) return null;
    const next = (this.epochs.get(win.id) ?? 0) + 1;
    this.epochs.set(win.id, next);
    this.pending.delete(win.id);
    return next;
  }

  /** `$`: is `epoch` still the current one for `win`? (null epoch / no window → true) */
  isCurrent(win: BrowserWindow | null, epoch: number | null): boolean {
    if (epoch === null || !win) return true;
    return !win.isDestroyed() && this.epochs.get(win.id) === epoch;
  }

  /** `Wo` for a window id: clear the view's reauth flags through ctx.windows. */
  clearReauthFlags(winId: number): void {
    const win = this.deps.windowFromId(winId);
    if (this.alive(win)) this.ctx.windows.setReauthing(win, false);
  }

  /** `ts` (user hid the Lab / lab:cancel): drop parked resume, bump epoch, clear flags. */
  cancelWindow(winId: number): void {
    this.pending.delete(winId);
    this.epochs.set(winId, (this.epochs.get(winId) ?? 0) + 1);
    this.clearReauthFlags(winId);
  }

  /** Window closed: forget its epoch and parked re-auth so closed ids do not accumulate (C3). */
  forgetWindow(winId: number): void {
    this.epochs.delete(winId);
    this.pending.delete(winId);
  }

  /** Identity changed (incl. sign-out): supersede every open; drop parked re-auths of other identities. */
  onIdentityChanged(identity: ReauthContext | null): void {
    for (const [winId, epoch] of this.epochs) {
      this.epochs.set(winId, epoch + 1);
      this.clearReauthFlags(winId);
    }
    for (const [winId, p] of this.pending) {
      if (!identity || p.context.sub !== identity.sub || p.context.gatewayUrl !== identity.gatewayUrl) {
        this.pending.delete(winId);
      }
    }
  }

  private async trackWait<T>(connId: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ac = new AbortController();
    const set = this.waitAborts.get(connId) ?? new Set<AbortController>();
    set.add(ac);
    this.waitAborts.set(connId, set);
    try {
      return await fn(ac.signal);
    } finally {
      set.delete(ac);
      if (set.size === 0 && this.waitAborts.get(connId) === set) this.waitAborts.delete(connId);
    }
  }

  /** Cancellable remote command in the connection's single op slot (overwrites a concurrent op). */
  private async runOp(connId: string, target: SshTarget, cmd: string, onLog: (s: string) => void): Promise<RemoteResult> {
    const ac = new AbortController();
    this.opAbort.set(connId, ac);
    try {
      return await this.ctx.ssh.runRemote(target, cmd, {
        onChunk: (text) => onLog(text),
        onSpawn: (child) => this.opChild.set(connId, child),
        signal: ac.signal,
      });
    } finally {
      this.opAbort.delete(connId);
      this.opChild.delete(connId);
    }
  }

  private mount(win: BrowserWindow | null, conn: Connection, url: string): void {
    if (win) this.ctx.windows.openLabInWindow(win, conn.id, url, labTitle(conn));
  }

  /** `Rt`: forbidden result with the signed-in login. */
  private async forbidden(onLog?: (s: string) => void): Promise<{ status: "forbidden"; login?: string }> {
    const st = await this.ctx.auth.status();
    const login = st.status === "signed-in" ? st.login : undefined;
    onLog?.(`Your GitHub account${login ? ` (@${login})` : ""} isn't authorized for this Lab. You may be signed in with the wrong account.\n`);
    return login === undefined ? { status: "forbidden" } : { status: "forbidden", login };
  }

  // -------------------------------------------------------------------------
  // gateway wrappers (public through the service)
  // -------------------------------------------------------------------------

  listLabs(): Promise<LabsListResult> {
    return gw.listLabs(this.ctx.auth);
  }

  async createLabSession(req: { deploymentId: string; managed: boolean; labUrl?: string }): Promise<LabSessionResult> {
    return gw.createLabSession(this.ctx.auth, await this.isStaging(), req);
  }

  waitForLab(
    baseUrl: string,
    labToken: string,
    opts: { managed: boolean; budgetMs: number; signal?: AbortSignal; onPhase?: (p: LabPhase) => void; onLog?: (line: string) => void },
  ): Promise<LabWaitOutcome> {
    if (opts.managed) {
      return waitManagedWake(this.deps.netFetch, this.deps, baseUrl, labToken, {
        unreachableTimeoutMs: opts.budgetMs,
        timeoutMs: MANAGED_WAKE_TIMEOUT_MS,
        signal: opts.signal,
        onLog: opts.onLog,
        onPhase: opts.onPhase,
        warn: (m) => this.ctx.logger("managed-wake").warn(m),
      });
    }
    return waitClusterReady(this.deps.netFetch, this.deps, baseUrl, labToken, {
      budgetMs: opts.budgetMs,
      signal: opts.signal,
      onLog: opts.onLog,
    });
  }

  labStatus(url: unknown): Promise<"up" | "down" | "unknown"> {
    return labStatus(this.deps.fetch, url);
  }

  detectStacks() {
    return detectLocalStacks(this.deps.execFile);
  }

  // -------------------------------------------------------------------------
  // open (`Ge`) [lab §4.7]
  // -------------------------------------------------------------------------

  async openLab(conn: Connection, win: BrowserWindow | null, opts: OpenLabOptions = {}): Promise<OpenResult> {
    const log = opts.onLog;
    const phase = opts.onPhase;
    const budget = opts.reachBudgetMs ?? CONNECT_REACH_BUDGET_MS;
    let epoch: number | null;
    if (opts.recoveryEpoch !== undefined) {
      epoch = opts.recoveryEpoch;
    } else {
      epoch = this.bumpEpoch(win);
      // A fresh open supersedes any in-flight re-auth of this window: clear its
      // reauthing/userLeft flags so the user's own open is not swallowed by a
      // `userLeft` left over from hiding during that re-auth (windows §4.1 step 1).
      if (this.alive(win)) this.ctx.windows.setReauthing(win, false);
    }
    if (!this.isCurrent(win, epoch)) return { status: "canceled" };
    if (isManaged(conn)) return this.openManaged(conn, win, budget, epoch, opts);
    if (isLocal(conn)) return this.openLocal(conn, win, epoch, opts);

    if (conn.deploymentId) {
      let session = await this.createLabSession({ deploymentId: conn.deploymentId, managed: false });
      if (!this.isCurrent(win, epoch)) return { status: "canceled" };
      if (!session.ok && session.status === 409 && conn.ssh?.host) {
        phase?.("claiming");
        const claimed = await this.claim(conn, log);
        if (!this.isCurrent(win, epoch)) return { status: "canceled" };
        if (!claimed.ok) {
          log?.(`${claimed.error}\n`);
          return { status: "other" };
        }
        session = claimed;
      }
      if (session.ok) {
        let base = session.labUrl;
        if (opts.forceTunnel || isLoopbackUrl(session.labUrl)) {
          if (!win) {
            log?.("Cannot open an SSH tunnel without a window.\n");
            return { status: "unreachable", url: session.labUrl };
          }
          phase?.("tunneling");
          const t = await this.tunnels.open(win.id, conn.ssh, await this.isStaging(), log);
          if (!t.ok) {
            log?.(`${t.error}\n`);
            return { status: "unreachable", url: session.labUrl };
          }
          base = t.localUrl;
        } else if (win) {
          this.tunnels.close(win.id);
        }
        phase?.("waiting");
        const token = session.token;
        const reach = await this.trackWait(conn.id, (signal) =>
          waitClusterReady(this.deps.netFetch, this.deps, base, token, { budgetMs: budget, signal, onLog: log }),
        );
        if (!this.isCurrent(win, epoch)) return { status: "canceled" };
        if (reach === "canceled") {
          log?.("Stopped.\n");
          return { status: "canceled" };
        }
        if (reach === "ready") {
          log?.("Authenticated. Opening the Lab.\n");
          this.mount(win, conn, callbackUrl(base, token, opts.returnTo));
          return { status: "opened" };
        }
        log?.(`The Lab is running but the app couldn't reach it at ${base}.\n`);
        return { status: "unreachable", url: base };
      }
      if (session.status === 403) return this.forbidden(log);
      log?.(`${session.error}\n`);
    }

    if (opts.browserFallback === false) {
      log?.("Couldn't re-establish the Lab session automatically.\n");
      return { status: "other" };
    }
    const url = gatewayFallbackUrl(await this.ctx.auth.activeGateway(), conn.deploymentId || undefined, await this.isStaging());
    log?.(`Opening ${url} …\n`);
    await this.deps.openExternal(url);
    return { status: "other" };
  }

  /** `Kl`: managed Lab. */
  private async openManaged(
    conn: Connection,
    win: BrowserWindow | null,
    budget: number,
    epoch: number | null,
    opts: OpenLabOptions,
  ): Promise<OpenResult> {
    const log = opts.onLog;
    if (!conn.deploymentId) {
      log?.("This connection has no deployment to open.\n");
      return { status: "other" };
    }
    opts.onPhase?.("opening");
    const session = await this.createLabSession({ deploymentId: conn.deploymentId, managed: true });
    if (!this.isCurrent(win, epoch)) return { status: "canceled" };
    if (!session.ok) {
      if (session.status === 403) return this.forbidden(log);
      log?.(`${session.error}\n`);
      return { status: "other" };
    }
    const wake = await this.trackWait(conn.id, (signal) =>
      this.waitForLab(session.labUrl, session.token, { managed: true, budgetMs: budget, signal, onLog: log, onPhase: opts.onPhase }),
    );
    if (!this.isCurrent(win, epoch)) return { status: "canceled" };
    if (wake === "canceled") {
      log?.("Stopped.\n");
      return { status: "canceled" };
    }
    if (wake === "unreachable") {
      log?.(`Couldn't reach the Lab at ${session.labUrl}.\n`);
      return { status: "unreachable", url: session.labUrl };
    }
    if (wake === "still-waking") {
      log?.("The Lab is taking longer than usual to start — try again in a moment.\n");
      return { status: "still-waking" };
    }
    if (win) this.tunnels.close(win.id);
    this.mount(win, conn, callbackUrl(session.labUrl, session.token, opts.returnTo));
    return { status: "opened" };
  }

  /** `ql`: local docker stack. */
  private async openLocal(conn: Connection, win: BrowserWindow | null, epoch: number | null, opts: OpenLabOptions): Promise<OpenResult> {
    const log = opts.onLog;
    if (!conn.labUrl) {
      log?.("This local connection has no Lab URL (expected http://localhost:<port>).\n");
      return { status: "other" };
    }
    opts.onPhase?.("opening");
    if ((await this.labStatus(conn.labUrl)) !== "up") {
      log?.(
        `The local dev stack isn't reachable at ${conn.labUrl}.\nStart it from that worktree with \`make local-dev\` (or docker/dev/local-dev.sh up), then try again.\n`,
      );
      return { status: "unreachable", url: conn.labUrl };
    }
    if (!this.isCurrent(win, epoch)) return { status: "canceled" };
    const session = await this.createLabSession({ deploymentId: conn.deploymentId, managed: false, labUrl: conn.labUrl });
    if (!this.isCurrent(win, epoch)) return { status: "canceled" };
    if (!session.ok) {
      if (session.status === 403) return this.forbidden(log);
      log?.(`${session.error}\n`);
      return { status: "other" };
    }
    if (win) this.tunnels.close(win.id);
    this.mount(win, conn, callbackUrl(session.labUrl, session.token, opts.returnTo));
    return { status: "opened" };
  }

  /** `Xl`: bind the route with the cluster's claim token (after a 409). [lab §4.8] */
  private async claim(conn: Connection, log?: (s: string) => void): Promise<LabSessionResult> {
    if (!conn.ssh?.host) return { ok: false, error: "No SSH host configured to bind your Lab route." };
    log?.(
      "First time on this cluster. Binding your Lab to your account automatically (no need to open the claim link above).\n",
    );
    const staging = await this.isStaging();
    const res = await this.ctx.ssh.runRemote(conn.ssh, claimTokenCmd(staging));
    const raw = res.stdout.trim();
    if (res.toolMissing) return { ok: false, error: res.stderr };
    if (res.code !== 0 || !raw) {
      return { ok: false, error: "Couldn't read this cluster's claim token over SSH to bind your route." };
    }
    const hash = createHash("sha256").update(raw).digest("hex");
    const claimed = await gw.claimRoute(this.ctx.auth, staging, conn.deploymentId, hash);
    if (claimed.ok) return claimed;
    if (claimed.status === 409) {
      const gateway = stripTrailingSlashes(await this.ctx.auth.activeGateway());
      return {
        ok: false,
        status: 409,
        error: `This cluster has a stale route from a previous session. Open this once in your browser to re-bind, then reconnect:\n  ${gateway}/claim#t=${raw}`,
      };
    }
    return claimed;
  }

  // -------------------------------------------------------------------------
  // connect (`tu`) [lab §4.1]
  // -------------------------------------------------------------------------

  async connect(
    conn: Connection,
    win: BrowserWindow | null,
    sinks: LabSinks,
    verbose: boolean,
    tunnel: boolean,
    onConnectStart?: (win: BrowserWindow) => void,
  ): Promise<ConnectOutcome> {
    const { onLog, onPhase } = sinks;
    if (win) onConnectStart?.(win);
    const openOpts: OpenLabOptions = { onLog, onPhase, forceTunnel: tunnel };

    if (isManaged(conn) || isLocal(conn)) {
      const r = await this.openLab(conn, win, openOpts);
      switch (r.status) {
        case "opened":
          return { status: "opened", labUrl: conn.labUrl || undefined };
        case "forbidden":
          return { status: "forbidden", login: r.login };
        case "still-waking":
          return { status: "still-waking" };
        case "canceled":
          return { status: "canceled" };
        case "unreachable":
          return {
            status: "error",
            message: `The app couldn't reach this Lab at ${r.url}. Check your internet connection, then try again.`,
          };
        default:
          return { status: "error", message: FALLBACK_ERROR };
      }
    }

    onPhase("checking");
    if (conn.ssh?.host) {
      const ssh = conn.ssh;
      const staging = await this.isStaging();
      onPhase("ssh");
      onLog("Checking the cluster over SSH…\n");
      const probe = await this.ctx.ssh.runRemote(ssh, DEPLOYMENT_PROBE_CMD);
      const hostKey = this.ctx.ssh.classifyHostKey(probe.stderr);
      if (hostKey) return { status: "host-key", host: ssh.host, kind: hostKey };
      if (probe.code === 255) return { status: "error", message: this.ctx.ssh.classifySshError(probe) };

      if (staging) {
        if ((await this.ctx.ssh.runRemote(ssh, STAGING_CLI_PROBE_CMD)).code !== 0) {
          onLog(`${STAGING_CLI_MISSING}\n`);
          return { status: "error", message: STAGING_CLI_MISSING };
        }
        if ((await this.ctx.ssh.runRemote(ssh, STAGING_REPO_PROBE_CMD)).code !== 0) {
          onLog(`${STAGING_REPO_MISSING}\n`);
          return { status: "error", message: STAGING_REPO_MISSING };
        }
      } else if (probe.code !== 0) {
        const setup = await this.firstTimeSetup(conn, sinks);
        if (setup) return setup;
      }

      // Observed: after a successful first-time install the start step is skipped.
      if (staging || probe.code === 0) {
        const settings = await this.ctx.settings.get();
        if (!staging && conn.deploymentId && !settings.previewBuilds && !settings.skipVersionCheck) {
          const list = await this.listLabs();
          const lab = list.ok ? list.labs.find((l) => l.deploymentId === conn.deploymentId) : undefined;
          if (lab?.stale && needsExactUpdate(lab)) {
            onLog("This Lab isn’t confirmed on the latest version. Updating it as it starts.\n");
            return this.update(conn, win, sinks, false, tunnel);
          }
        }
        onPhase("starting");
        const label = upCmd(staging, verbose);
        onLog(`Starting the Lab (\`${label}\`). This can take a few minutes…\n`);
        const res = await this.runOp(conn.id, ssh, withLocalBin(label), onLog);
        if (res.toolMissing) return { status: "error", message: res.stderr.trim() };
        if (res.code !== 0) return { status: "error", message: exitedMessage(`\`${label}\``, res.code, res.stderr) };
      }
    }

    if (conn.ssh?.host && conn.deploymentId) {
      const staging = await this.isStaging();
      const settings = await this.ctx.settings.get();
      if (!settings.skipVersionCheck) {
        const preview = !staging && settings.previewBuilds;
        const pinned = !staging && !preview;
        if (await this.pollOutdated(conn.deploymentId, { pinnedExactCheck: pinned })) {
          return this.update(conn, win, sinks, preview, tunnel);
        }
      }
    }

    onPhase("opening");
    const r = await this.openLab(conn, win, openOpts);
    if (r.status === "unreachable") {
      return {
        status: "error",
        message:
          tunnel || isLoopbackUrl(r.url)
            ? "The Lab started but the app couldn't reach it through the SSH tunnel. The login node may not reach the compute node. See Logs for the manual `ssh -L` command to try directly."
            : `The Lab started but the app can't reach it at ${r.url} yet. It may be behind a VPN/Tailscale, or still coming up. Try Open again in a moment.`,
      };
    }
    if (r.status === "forbidden") return { status: "forbidden", login: r.login };
    if (r.status === "canceled") return { status: "canceled" };
    // Observed quirk: "other" and "still-waking" are reported as opened.
    return { status: "opened", labUrl: conn.labUrl || undefined };
  }

  /** `eu`: up to 4 discovery attempts 1.5 s apart; first non-stale match decides. */
  async pollOutdated(deploymentId: string, opts: { pinnedExactCheck: boolean }): Promise<boolean> {
    for (let i = 0; i < VERSION_POLL_ATTEMPTS; i++) {
      const list = await this.listLabs();
      if (list.ok) {
        const lab = list.labs.find((l) => l.deploymentId === deploymentId);
        if (lab && !lab.stale) return updateFlags(lab, opts).any;
      }
      if (i < VERSION_POLL_ATTEMPTS - 1) await this.deps.sleep(VERSION_POLL_INTERVAL_MS);
    }
    return false;
  }

  /** `Ql`: first-time setup; null on success (caller continues). [lab §4.2] */
  private async firstTimeSetup(conn: Connection, sinks: LabSinks): Promise<ConnectOutcome | null> {
    const { onLog, onPhase } = sinks;
    if (!conn.deploymentId) {
      onLog("This connection has no deployment to set up automatically.\n");
      return { status: "needs-setup" };
    }
    if (!conn.ssh?.host) {
      onLog("This connection has no SSH host to set up over.\n");
      return { status: "needs-setup" };
    }
    onPhase("setup");
    onLog("First time on this cluster. Setting it up…\n");
    const bearer = await gw.setupBearer(this.ctx.auth, await this.isStaging(), conn.deploymentId);
    if (!bearer.ok) {
      if (bearer.status === 403) return this.forbidden(onLog);
      onLog(`Couldn't authorize setup: ${bearer.error}\n`);
      return { status: "needs-setup" };
    }
    const gateway = stripTrailingSlashes(await this.ctx.auth.activeGateway());
    const cmd = installCmd(gateway, conn.deploymentId, bearer.setupBearer);
    onLog("Installing and configuring Silico on the cluster (first time only)…\n");
    const res = await this.runOp(conn.id, conn.ssh, cmd, onLog);
    if (res.toolMissing) return { status: "error", message: res.stderr.trim() };
    if (res.code !== 0) return { status: "error", message: exitedMessage("First-time setup", res.code, res.stderr) };
    return null;
  }

  // -------------------------------------------------------------------------
  // update (`oo`) [lab §4.3]
  // -------------------------------------------------------------------------

  async update(conn: Connection, win: BrowserWindow | null, sinks: LabSinks, preview: boolean, tunnel: boolean): Promise<ConnectOutcome> {
    const { onLog, onPhase } = sinks;
    if (!conn.ssh?.host) {
      onLog("No SSH host configured, so the Lab can’t be updated over SSH.\n");
      return { status: "error", message: "No SSH host configured for this connection." };
    }
    if (!conn.deploymentId) {
      onLog("This connection has no deployment to update.\n");
      return { status: "error", message: "No deployment configured for this connection." };
    }
    const staging = await this.isStaging();
    const usePreview = preview && !staging;
    const label = updateLabel(staging, usePreview);
    onPhase("updating");
    onLog(
      usePreview
        ? "Updating the Lab to the preview (staging) build. This stops it, pulls the staging branch, and restarts. Can take a few minutes.\n"
        : "Updating the Lab. This stops it, pulls the latest build, and restarts. Can take a few minutes.\n",
    );
    onLog("Nothing is lost; your threads, experiments, and data pick up where they were.\n");
    const bearer = await gw.setupBearer(this.ctx.auth, staging, conn.deploymentId);
    if (!bearer.ok) {
      if (bearer.status === 403) return this.forbidden(onLog);
      onLog(`Couldn't authorize the update: ${bearer.error}\n`);
      return { status: "error", message: `Couldn't authorize the update: ${bearer.error}` };
    }
    const cmd = updateCmd(depIdFor(conn.deploymentId, staging), bearer.setupBearer, label);
    const res = await this.runOp(conn.id, conn.ssh, cmd, onLog);
    if (res.toolMissing) return { status: "error", message: res.stderr.trim() };
    if (res.code !== 0) return { status: "error", message: exitedMessage(`\`${label}\``, res.code, res.stderr) };

    onPhase("opening");
    const r = await this.openLab(conn, win, { onLog, onPhase, forceTunnel: tunnel });
    if (r.status === "unreachable") {
      return {
        status: "error",
        message: isLoopbackUrl(r.url)
          ? "Updated, but the app couldn't reach the Lab through the SSH tunnel. See Logs for the manual `ssh -L` command."
          : `Updated, but the app can't reach the Lab at ${r.url} yet. Try Open again in a moment.`,
      };
    }
    if (r.status === "forbidden") return { status: "forbidden", login: r.login };
    if (r.status === "canceled") return { status: "canceled" };
    return { status: "opened", labUrl: conn.labUrl || undefined };
  }

  // -------------------------------------------------------------------------
  // down (`ou`) and cancel (`nu`) [lab §4.4, §4.5]
  // -------------------------------------------------------------------------

  async down(conn: Connection, onLog: (s: string) => void): Promise<void> {
    if (!conn.ssh?.host) {
      onLog("No SSH host configured.\n");
      return;
    }
    const staging = await this.isStaging();
    const cli = cliName(staging);
    onLog(`Stopping the Lab (\`${cli} down\`)…\n`);
    // Not registered for cancellation, no timeout.
    const res = await this.ctx.ssh.runRemote(conn.ssh, downCmd(staging), { onChunk: (t) => onLog(t) });
    if (res.toolMissing) {
      onLog(`${res.stderr}\n`);
      return;
    }
    onLog(res.code === 0 ? "Stopped.\n" : `\`${cli} down\` exited ${res.code}.\n`);
  }

  cancel(connId: string): void {
    for (const [winId, p] of [...this.pending]) if (p.connId === connId) this.cancelWindow(winId);
    this.opAbort.get(connId)?.abort();
    for (const ac of this.waitAborts.get(connId) ?? []) ac.abort();
    const child = this.opChild.get(connId);
    if (child) {
      child.kill("SIGTERM");
      this.opChild.delete(connId);
    }
  }
}
