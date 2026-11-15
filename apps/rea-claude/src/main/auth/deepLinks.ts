/**
 * `silico://` intake: pre-ready stash + ordered dispatch. [auth §4.6]
 * URL collection (argv, open-url, second-instance) is I6's; this file parses
 * and routes.
 */
import type { BrowserWindow } from "electron";
import { ShellEventChannel } from "@shared/ipc";
import { sendShell } from "../ipc/trust";
import type { DeepLinkService, MainContext } from "../services";
import type { AuthCore } from "./core";
import {
  deepLinkLabel,
  findDeepLinkInArgv,
  isWelcomeLink,
  parseOpenLink,
  parseSignupLink,
  parseSignupResumeLink,
} from "./deepLinkParse";
import { signupConfirmUrl, signupResumeUrl } from "./gateways";
import type { ResolvedAuthDeps } from "./platform";
import type { ReturnsInternals } from "./returns";
import type { SignupInternals } from "./signupView";

export function createDeepLinks(
  ctx: MainContext,
  core: AuthCore,
  signup: SignupInternals,
  returns: ReturnsInternals,
  deps: ResolvedAuthDeps,
): DeepLinkService & { dispatch(url: string): Promise<void> } {
  let ready = false;
  let pending: string | null = null;

  /** 4.6.a: window showing signup, else focused/first shell window, else a new one. */
  const openSignupFromLink = async (resolveUrl: (staging: boolean) => Promise<string>): Promise<void> => {
    const win: BrowserWindow =
      signup.showingWindow() ?? ctx.windows.primaryShellWindow() ?? ctx.windows.createShellWindow();
    ctx.telemetry.markCause("deep-link:signup");
    deps.focusApp();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    sendShell(win.webContents, ShellEventChannel.appNavigate, "connections");
    ctx.windows.hideLabView(win);
    try {
      const url = await resolveUrl((await ctx.settings.get()).staging);
      await signup.open(win, url);
    } catch (err) {
      ctx.logger("signup").error("could not resume confirmation in app", err);
    }
  };

  const dispatch = async (url: string): Promise<void> => {
    ctx.telemetry.markCause("deep-link:delivered", deepLinkLabel(url));
    const signupToken = parseSignupLink(url);
    if (signupToken) {
      await openSignupFromLink(async (staging) => {
        const resume = await core.desktopContinue(signupToken, staging);
        return resume ? signupResumeUrl(staging, resume) : signupConfirmUrl(staging, signupToken);
      });
      return;
    }
    const resumeToken = parseSignupResumeLink(url);
    if (resumeToken) {
      await openSignupFromLink(async (staging) => signupResumeUrl(staging, resumeToken));
      return;
    }
    if (isWelcomeLink(url)) {
      ctx.windows.focusOrCreateShellWindow("deep-link:welcome");
      return;
    }
    const share = parseOpenLink(url);
    if (share) {
      ctx.telemetry.markCause("deep-link:share", deepLinkLabel(share));
      ctx.windows.openShareViewer(share);
      return;
    }
    returns.handleDeepLink(url); // MCP OAuth, GitHub connect, checkout; unmatched links are ignored
  };

  const run = (url: string): void => {
    dispatch(url).catch((err: unknown) => ctx.logger("auth").error("deep link failed", err));
  };

  return {
    handle: (url) => {
      if (!ready) {
        pending = url;
        return;
      }
      run(url);
    },
    markReady: () => {
      ready = true;
      const url = pending;
      pending = null;
      if (url) run(url);
    },
    findInArgv: (argv) => findDeepLinkInArgv(argv),
    dispatch,
  };
}
