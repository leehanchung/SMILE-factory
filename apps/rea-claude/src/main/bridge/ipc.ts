/**
 * Registration of every `silico:*` Lab-bridge channel [bridge §3].
 * Invokes go through `handleLab` (exact `Blocked '<ch>': untrusted sender.`
 * rejection), sends through `onLab` (silent drop). recover-session also uses
 * the partition gate (deviation X1) on top of I4's recovery-registry gate.
 */
import type { WebContents } from "electron";
import { LabInvokeChannel, LabSendChannel } from "@shared/ipc";
import type { RecoverSessionResult } from "@shared/ipc";
import { handleLab, onLab } from "../ipc/trust";
import type { MainContext } from "../services";
import { bridgeInternals } from "./service";

export const RECOVER_ERROR_MESSAGE = "Could not restore this window. Please try again.";

export function registerBridgeIpcImpl(ctx: MainContext): void {
  const internals = bridgeInternals(ctx);
  internals.installHooks();
  const connIdOf = (wc: WebContents): string | null => ctx.windows.findLab(wc)?.connId ?? null;

  handleLab(LabInvokeChannel.recoverSession, async (event): Promise<RecoverSessionResult> => {
    try {
      return await ctx.windows.handleRecoverSession(event);
    } catch {
      return { status: "error", message: RECOVER_ERROR_MESSAGE };
    }
  });
  handleLab(LabInvokeChannel.beginCheckout, (e) => ctx.returns.begin("checkout", e.sender, connIdOf(e.sender)));
  handleLab(LabInvokeChannel.beginMcpOauth, (e) => ctx.returns.begin("mcp-oauth", e.sender, connIdOf(e.sender)));
  handleLab(LabInvokeChannel.beginGithubConnect, (e) =>
    ctx.returns.begin("github-connect", e.sender, connIdOf(e.sender)),
  );
  handleLab(LabInvokeChannel.takeMcpOauthReturn, (e) => ctx.returns.takeMcpOauthReturn(connIdOf(e.sender)));
  handleLab(LabInvokeChannel.takeGithubConnectReturn, (e) => ctx.returns.takeGithubConnectReturn(connIdOf(e.sender)));
  handleLab(LabInvokeChannel.shellEventsDrain, () => ctx.telemetry.drainShellEvents());

  const log = ctx.logger("bridge");
  onLab(LabSendChannel.notify, (e, payload) => {
    internals.handleNotify(e.sender, payload).catch((err: unknown) => log.warn("notify failed", err));
  });
  onLab(LabSendChannel.badgeCounts, (e, payload) => {
    try {
      internals.handleBadgeCounts(e.sender, payload);
    } catch (err) {
      log.warn("badge-counts failed", err);
    }
  });
  onLab(LabSendChannel.openDesktopSettings, (e) => ctx.windows.openDesktopSettingsFor(e.sender));
  onLab(LabSendChannel.openLabSwitcher, (e) => ctx.windows.openLabSwitcherFor(e.sender));
}
