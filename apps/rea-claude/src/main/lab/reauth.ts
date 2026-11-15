/**
 * Re-auth / reopen in place (`rs` / `xt` / `ns` / `Zl` / `os`).
 * [windows §4.4; lab cross-area notes; architecture "Cross-area responsibilities"]
 *
 * I3 owns the logic, the per-window epoch and the cooldown map; the view is
 * driven through ctx.windows.
 */
import type { BrowserWindow } from "electron";
import { REAUTH_AUTH_WALL_BUDGET_MS, REAUTH_COOLDOWN_MS, REWAKE_BUDGET_MS } from "@shared/config";
import { ShellEventChannel } from "@shared/ipc";
import { sendShell } from "../ipc/trust";
import type { Identity } from "../services";
import type { LabRuntime, ReauthContext } from "./runtime";

export type ReauthOutcome = "opened" | "superseded" | "expired" | "down" | "still-waking";

type WindowReauthState = { kind: "reauthing" } | { kind: "cooldown"; until: number };

/** `Pa`: map a non-opened open result once we know whether the session is still signed in. */
export function classifyReopenFailure(status: string, signedIn: boolean): ReauthOutcome {
  if (!signedIn) return "expired";
  return status === "still-waking" ? "still-waking" : "down";
}

export class ReauthController {
  /** `z`: per-window re-auth state, keyed by window id (cleared on user hide and window close). */
  private readonly state = new Map<number, WindowReauthState>();

  constructor(private readonly rt: LabRuntime) {}

  private get ctx() {
    return this.rt.ctx;
  }

  /** lab:connect clears the window's cooldown. */
  clearState(win: BrowserWindow): void {
    this.state.delete(win.id);
  }

  /** User hid the Lab / window closed: drop the reauthing flag and the 45 s cooldown. */
  clearStateById(winId: number): void {
    this.state.delete(winId);
  }

  /** For tests. */
  stateOf(win: BrowserWindow): WindowReauthState | undefined {
    return this.state.get(win.id);
  }

  /**
   * Identity snapshot (`Ii`) recorded with a parked re-auth: the module-level
   * published identity (auth §3.1), which survives the session drop that makes
   * the reopen "expired" and is cleared only by sign-out. Never activeGateway()'s
   * settings fallback (X16).
   */
  private identityContext(): ReauthContext | null {
    const id = this.ctx.auth.lastIdentity();
    return id ? { sub: id.sub, gatewayUrl: id.gatewayUrl } : null;
  }

  /** `Zl`: re-run the connection open without browser fallback. */
  private async reopenLabInPlace(
    win: BrowserWindow,
    connId: string,
    budgetMs: number,
    returnTo: string | null,
    epoch: number | null,
  ): Promise<ReauthOutcome> {
    try {
      const st = await this.ctx.auth.status();
      if (!this.rt.isCurrent(win, epoch)) return "superseded";
      if (st.status !== "signed-in") {
        this.ctx.auth.recordSessionDeath("proof-expired-under-lab");
        return "expired";
      }
      const conn = connId ? (await this.ctx.connections.list()).find((c) => c.id === connId) : undefined;
      if (!this.rt.isCurrent(win, epoch)) return "superseded";
      if (!conn) return "down";
      const r = await this.rt.openLab(conn, win, {
        reachBudgetMs: budgetMs,
        onPhase: (phase) => {
          if (connId && !win.isDestroyed()) sendShell(win.webContents, ShellEventChannel.labPhase, { id: connId, phase });
        },
        forceTunnel: this.rt.tunnels.isActive(win.id),
        browserFallback: false,
        ...(returnTo !== null ? { returnTo } : {}),
        ...(epoch !== null ? { recoveryEpoch: epoch } : {}),
      });
      if (r.status === "opened") return "opened";
      if (r.status === "canceled") return "superseded";
      const signedIn = (await this.ctx.auth.status()).status === "signed-in";
      return this.rt.isCurrent(win, epoch) ? classifyReopenFailure(r.status, signedIn) : "superseded";
    } catch (err) {
      this.ctx.logger("lab").error("[lab] reopenLabInPlace failed", err);
      return this.rt.isCurrent(win, epoch) ? "down" : "superseded";
    }
  }

  /** `os`: report the outcome to the shell and hide the view (except opened/superseded). */
  private report(win: BrowserWindow, connId: string, outcome: ReauthOutcome): void {
    if (outcome === "opened" || outcome === "superseded" || win.isDestroyed()) return;
    if (outcome === "expired") {
      this.ctx.bridge.clearBadgeCounts();
      sendShell(win.webContents, ShellEventChannel.authExpired);
    } else {
      sendShell(win.webContents, ShellEventChannel.labState, {
        id: connId,
        state: "down",
        reason: outcome === "still-waking" ? "still-waking" : "error",
      });
    }
    this.ctx.windows.hideLabView(win);
  }

  /** `ns`: reopen in place. */
  private async reopen(win: BrowserWindow, connId: string, budgetMs: number, returnToArg: string | null | undefined): Promise<ReauthOutcome> {
    const returnTo = returnToArg === undefined ? this.ctx.windows.currentLabReturnTo(win) : returnToArg;
    const epoch = this.rt.bumpEpoch(win);
    this.ctx.windows.setReauthing(win, true);
    const context = this.identityContext();
    if (!this.rt.isCurrent(win, epoch)) return "superseded";
    const { reloaded } = await this.ctx.windows.waitForShellRenderer(win);
    if (!this.rt.isCurrent(win, epoch)) return "superseded";
    if (reloaded) this.ctx.windows.resendLabOpened(win);
    sendShell(win.webContents, ShellEventChannel.labState, { id: connId, state: "loading" });
    this.ctx.windows.hideLabView(win);
    const outcome = await this.reopenLabInPlace(win, connId, budgetMs, returnTo, epoch);
    if (!this.rt.isCurrent(win, epoch)) return "superseded";
    if (outcome === "expired" && connId && context && epoch !== null) {
      this.rt.pending.set(win.id, { win, connId, returnTo, context, epoch });
    }
    this.ctx.windows.setReauthing(win, false);
    this.report(win, connId, outcome);
    return outcome;
  }

  /** `rs`: auth wall seen. Skip while reauthing; cooldown → down; else 15 s reopen then 45 s cooldown. */
  async reauthOnAuthWall(win: BrowserWindow, connId: string, returnTo?: string | null): Promise<void> {
    if (win.isDestroyed()) return;
    const winId = win.id;
    const cur = this.state.get(winId);
    if (cur?.kind === "reauthing") return;
    if (cur?.kind === "cooldown" && this.rt.deps.now() < cur.until) {
      this.ctx.telemetry.recordShellEvent("reauth-outcome", {
        connId,
        details: { trigger: "auth-wall", outcome: "cooldown-down" },
      });
      this.report(win, connId, "down");
      return;
    }
    const mine: WindowReauthState = { kind: "reauthing" };
    this.state.set(winId, mine);
    const outcome = await this.reopen(win, connId, REAUTH_AUTH_WALL_BUDGET_MS, returnTo);
    this.ctx.telemetry.recordShellEvent("reauth-outcome", { connId, details: { trigger: "auth-wall", outcome } });
    // A user hide / window close (clearStateById) or a newer run owns the state now.
    if (this.state.get(winId) !== mine) return;
    if (outcome === "expired" || outcome === "superseded") this.state.delete(winId);
    else this.state.set(winId, { kind: "cooldown", until: this.rt.deps.now() + REAUTH_COOLDOWN_MS });
  }

  /** `xt`: wake / crash / watchdog / memory reopen with 30 s budget; restores a previous cooldown. */
  async rewake(win: BrowserWindow, connId: string, returnTo?: string | null): Promise<void> {
    if (win.isDestroyed()) return;
    const winId = win.id;
    const prev = this.state.get(winId);
    if (prev?.kind === "reauthing") return;
    this.ctx.telemetry.markRecent("reconnect");
    const mine: WindowReauthState = { kind: "reauthing" };
    this.state.set(winId, mine);
    const outcome = await this.reopen(win, connId, REWAKE_BUDGET_MS, returnTo);
    this.ctx.telemetry.recordShellEvent("reauth-outcome", { connId, details: { trigger: "wake", outcome } });
    if (this.state.get(winId) !== mine) return;
    if (outcome !== "superseded" && outcome !== "expired" && prev?.kind === "cooldown" && this.rt.deps.now() < prev.until) {
      this.state.set(winId, prev);
    } else {
      this.state.delete(winId);
    }
  }

  /** Signed in again (`Oo` hook): resume parked re-auths for the same identity whose epoch is still current. */
  onSignedIn(identity: Pick<Identity, "sub" | "gatewayUrl">): void {
    for (const [winId, p] of [...this.rt.pending]) {
      this.rt.pending.delete(winId);
      if (p.context.sub !== identity.sub || p.context.gatewayUrl !== identity.gatewayUrl) continue;
      if (!this.rt.isCurrent(p.win, p.epoch)) continue;
      void this.reauthOnAuthWall(p.win, p.connId, p.returnTo);
    }
  }

  /**
   * App became active: retry parked re-auths if the user is signed in again
   * with the same identity (same rules as onSignedIn). No-op otherwise.
   */
  async resumePending(): Promise<void> {
    if (this.rt.pending.size === 0) return;
    const st = await this.ctx.auth.status();
    if (st.status !== "signed-in") return;
    this.onSignedIn({ sub: st.sub, gatewayUrl: st.gatewayUrl });
  }
}
