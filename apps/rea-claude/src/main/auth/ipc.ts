/**
 * auth:* and signup:* shell IPC. [auth §2, §4.1 step 9, §4.4]
 */
import type { BrowserWindow, WebContents } from "electron";
import { ShellInvokeChannel } from "@shared/ipc";
import type { AuthState } from "@shared/ipc";
import { handleShell } from "../ipc/trust";
import type { MainContext } from "../services";
import type { AuthModule } from "./module";

/** Focus the window that started a successful sign-in. "Gentle" after a session death. */
export function focusAfterSignIn(
  ctx: MainContext,
  m: AuthModule,
  win: BrowserWindow | null,
  gentle: boolean,
): void {
  const live = win && !win.isDestroyed() ? win : null;
  if (gentle) {
    if (live && !live.isVisible()) live.showInactive();
    m.deps.dockBounce("informational");
    if (ctx.env.platform !== "darwin" && live) {
      live.flashFrame(true);
      live.once("focus", () => live.flashFrame(false));
    }
    return;
  }
  ctx.telemetry.markCause("sign-in");
  m.deps.focusApp();
  if (live) {
    if (live.isMinimized()) live.restore();
    live.show();
    live.focus();
  }
}

export function registerAuthIpcWith(ctx: MainContext, m: AuthModule): void {
  const fromSender = (sender: WebContents): BrowserWindow | null => m.deps.windowFromWebContents(sender);

  handleShell(ShellInvokeChannel.authStatus, () => ctx.auth.status());
  handleShell(ShellInvokeChannel.authPersistence, () => ctx.auth.persistenceMode());

  const focused = new WeakSet<Promise<AuthState>>();
  handleShell(ShellInvokeChannel.authSignIn, async (event, staging, restart) => {
    const attempt = m.core.signIn(!!staging, restart === true);
    const first = !focused.has(attempt);
    focused.add(attempt);
    const state = await attempt;
    if (first && state.status === "signed-in") {
      focusAfterSignIn(ctx, m, fromSender(event.sender), m.core.takeSessionDeath());
    }
    return state;
  });

  handleShell(ShellInvokeChannel.authSignOutAll, async (event) => {
    const win = fromSender(event.sender);
    const anchorBefore = win && !win.isDestroyed() ? (win.getParentWindow() ?? win) : null;
    await m.core.signOutAll();
    const anchor = anchorBefore && !anchorBefore.isDestroyed() ? anchorBefore : null;
    ctx.bridge.clearBadgeCounts();
    ctx.windows.applySignOut(anchor);
  });

  handleShell(ShellInvokeChannel.signupOpen, async (event) => {
    const win = fromSender(event.sender);
    if (win && !win.isDestroyed()) ctx.windows.hideLabView(win);
    await ctx.signup.open(win as BrowserWindow);
  });
  handleShell(ShellInvokeChannel.signupClose, (event) => {
    const win = fromSender(event.sender);
    if (win) ctx.signup.close(win);
  });
  handleShell(ShellInvokeChannel.signupStatus, (event) => {
    const win = fromSender(event.sender);
    return win ? ctx.signup.isOpen(win) : false;
  });
}
