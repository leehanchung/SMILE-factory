/**
 * Embedded beta-signup view (`persist:silico-signup`) and signup-ready
 * adoption. [auth §4.5; windows §3.1 cross-area]
 */
import type { BrowserWindow, Event, View, WebContents } from "electron";
import { GATEWAY_STAGING, SIGNUP_ADOPT_REACH_BUDGET_MS, SIGNUP_BAR_DEFAULT_PX, SIGNUP_GITHUB_OPEN_THROTTLE_MS, SIGNUP_PARTITION } from "@shared/config";
import { ShellEventChannel } from "@shared/ipc";
import type { ConnectionUpsert } from "@shared/ipc";
import { sendShell } from "../ipc/trust";
import type { MainContext, SignupService } from "../services";
import type { AuthCore } from "./core";
import { parseSignupReady, type SignupReady } from "./deepLinkParse";
import { signupUrl } from "./gateways";
import type { ResolvedAuthDeps, SignupViewLike } from "./platform";
import { classifySignupUrl, isGatewayPage, signupBounds, systemBrowserUrl, type SignupUrlClass } from "./signupPolicy";

export const ERR_WINDOW_GONE = "The Silico window is no longer available.";
export const ERR_UNTRUSTED_SIGNUP = "Refusing to open an untrusted signup destination.";
export const ERR_SIGNUP_NOT_ADOPTED = "The signup identity could not be adopted.";
export const ERR_LAB_NOT_DISCOVERED = "The new Lab was not returned by Silico discovery.";
export const ERR_LAB_NOT_MANAGED = "The new Lab is not app-managed.";
export const ERR_LAB_NOT_OPENED = "The Lab could not be opened automatically.";
export const SETUP_SUB_FAILURE_TEXT =
  "Your Lab is ready, but Silico couldn't open it automatically. Use Back to login and sign in.";

const BAR_MEASURE_JS = "document.querySelector('.signup-shell__bar')?.getBoundingClientRect().height ?? 0";

interface Entry {
  win: BrowserWindow;
  view: SignupViewLike;
}

export interface SignupInternals extends SignupService {
  /** Window currently hosting a live signup view, if any (deep-link window choice). */
  showingWindow(): BrowserWindow | null;
}

export function createSignup(ctx: MainContext, core: AuthCore, deps: ResolvedAuthDeps): SignupInternals {
  const views = new Map<number, Entry>();
  const barHeights = new Map<number, number>();
  const log = (): ReturnType<MainContext["logger"]> => ctx.logger("signup");

  const layout = (win: BrowserWindow, view: SignupViewLike): void => {
    const bar = barHeights.get(win.id) ?? SIGNUP_BAR_DEFAULT_PX;
    view.setBounds(signupBounds(win.getContentSize(), bar, win.webContents.getZoomFactor()));
  };

  const measureBar = async (win: BrowserWindow): Promise<number> => {
    try {
      const h: unknown = await win.webContents.executeJavaScript(BAR_MEASURE_JS);
      if (typeof h === "number" && Number.isFinite(h) && h > 0) return Math.ceil(h);
    } catch {
      // fall through to the cached / default height
    }
    return barHeights.get(win.id) ?? SIGNUP_BAR_DEFAULT_PX;
  };

  const remeasure = async (win: BrowserWindow, view: SignupViewLike): Promise<void> => {
    const h = await measureBar(win);
    barHeights.set(win.id, h);
    if (!win.isDestroyed() && !view.webContents.isDestroyed()) layout(win, view);
  };

  const closeView = (view: SignupViewLike): void => {
    if (view.webContents.isDestroyed()) return;
    try {
      view.webContents.close();
    } catch {
      // already gone
    }
  };

  const close = (win: BrowserWindow): void => {
    if (!win) return;
    const entry = views.get(win.id);
    if (!entry) return;
    views.delete(win.id);
    barHeights.delete(win.id);
    if (!win.isDestroyed()) {
      try {
        win.contentView.removeChildView(entry.view as unknown as View);
      } catch {
        // not attached
      }
    }
    closeView(entry.view);
    if (!win.isDestroyed()) sendShell(win.webContents, ShellEventChannel.signupClosed);
  };

  const isOpen = (win: BrowserWindow): boolean => {
    if (!win || win.isDestroyed()) return false;
    const entry = views.get(win.id);
    return !!entry && !entry.view.webContents.isDestroyed();
  };

  /** Adopt the new account + Lab after `silico://signup-ready`. [auth §4.5 step 5] */
  const adopt = async (win: BrowserWindow, ready: SignupReady, staging: boolean): Promise<void> => {
    const state = await core.adoptSignupProof(ready.proof, staging);
    if (state.status !== "signed-in") throw new Error(ERR_SIGNUP_NOT_ADOPTED);
    const { login, gatewayUrl } = state;
    const labs = await ctx.lab.listLabs();
    if (!labs.ok) throw new Error(labs.error);
    const lab = labs.labs.find((l) => l.deploymentId === ready.deploymentId);
    if (!lab) throw new Error(ERR_LAB_NOT_DISCOVERED);
    if (lab.routeMode !== "managed") throw new Error(ERR_LAB_NOT_MANAGED);
    const existing = (await ctx.connections.list()).find(
      (c) =>
        c.deploymentId === ready.deploymentId &&
        (!c.gatewayUrl || c.gatewayUrl === gatewayUrl) &&
        (!c.owner || c.owner === login),
    );
    const upsert: ConnectionUpsert = {
      ...(existing ?? {}),
      id: existing?.id ?? `managed:${login}:${ready.deploymentId}:${gatewayUrl}`,
      name: existing?.name || ready.deploymentId,
      icon: existing?.icon || "flask",
      deploymentId: ready.deploymentId,
      labUrl: lab.labPublicHost ? `https://${lab.labPublicHost}` : "",
      routeMode: lab.routeMode,
      ssh: undefined,
      owner: login,
      gatewayUrl,
      dismissed: undefined,
    };
    const conn = await ctx.connections.upsert(upsert);
    if (!win.isDestroyed()) sendShell(win.webContents, ShellEventChannel.connectionsChanged);
    close(win);
    if (!win.isDestroyed()) sendShell(win.webContents, ShellEventChannel.authChanged, state);
    const result = await ctx.lab.openLab(conn, win, {
      reachBudgetMs: SIGNUP_ADOPT_REACH_BUDGET_MS,
      browserFallback: false,
      ...(ready.returnTo ? { returnTo: ready.returnTo } : {}),
    });
    if (result.status !== "opened") throw new Error(ERR_LAB_NOT_OPENED);
  };

  const open = async (win: BrowserWindow, url?: string): Promise<void> => {
    if (!win || win.isDestroyed()) throw new Error(ERR_WINDOW_GONE);
    const target = url ?? signupUrl((await ctx.settings.get()).staging);
    if (classifySignupUrl(target) !== "embedded") throw new Error(ERR_UNTRUSTED_SIGNUP);

    const existing = views.get(win.id);
    if (existing && !existing.view.webContents.isDestroyed()) {
      layout(win, existing.view);
      existing.view.setVisible(true);
      sendShell(win.webContents, ShellEventChannel.signupOpened);
      void remeasure(win, existing.view);
      if (existing.view.webContents.getURL() !== target) await existing.view.webContents.loadURL(target);
      return;
    }
    if (existing) close(win);

    const view = deps.createSignupView({
      partition: SIGNUP_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    const wc = view.webContents;
    const isCurrent = (): boolean => views.get(win.id)?.view === view;
    let lastSystemAuthOpen = Number.NEGATIVE_INFINITY;
    let handledReady = false;

    const openOutside = (target: string, cls: SignupUrlClass): void => {
      if (cls === "system-auth") {
        const now = deps.now();
        if (now - lastSystemAuthOpen < SIGNUP_GITHUB_OPEN_THROTTLE_MS) return;
        lastSystemAuthOpen = now;
      }
      const ext = systemBrowserUrl(target);
      if (ext) {
        Promise.resolve()
          .then(() => deps.openExternal(ext))
          .catch((err: unknown) => log().warn("could not open an external signup link", err));
      }
    };

    wc.setWindowOpenHandler(({ url: target }) => {
      const cls = classifySignupUrl(target);
      if (cls === "embedded") wc.loadURL(target).catch(() => {});
      else if (cls === "system-auth" || cls === "external") openOutside(target, cls);
      return { action: "deny" };
    });

    const onNavigate = (event: Event, target: string): void => {
      const ready = parseSignupReady(target);
      if (ready) {
        event.preventDefault();
        const current = wc.getURL();
        if (handledReady || !isGatewayPage(current)) return;
        handledReady = true;
        const staging = new URL(current).origin === GATEWAY_STAGING;
        adopt(win, ready, staging).catch((err: unknown) => {
          log().error("automatic workspace open failed", err);
          if (!wc.isDestroyed()) {
            wc.executeJavaScript(
              `document.getElementById('setup-sub').textContent = ${JSON.stringify(SETUP_SUB_FAILURE_TEXT)}`,
            ).catch(() => {});
          }
        });
        return;
      }
      const cls = classifySignupUrl(target);
      if (cls !== "embedded") {
        event.preventDefault();
        if (cls === "system-auth" || cls === "external") openOutside(target, cls);
      }
    };
    wc.on("will-navigate", (event, target) => onNavigate(event, target));
    wc.on("will-redirect", (event, target) => onNavigate(event, target));
    wc.on("render-process-gone", () => {
      if (isCurrent()) close(win);
    });

    views.set(win.id, { win, view });
    win.contentView.addChildView(view as unknown as View);
    layout(win, view);
    view.setVisible(true);
    sendShell(win.webContents, ShellEventChannel.signupOpened);
    try {
      await wc.loadURL(target);
    } catch (err) {
      if (isCurrent()) close(win);
      throw err;
    }
    if (isCurrent()) void remeasure(win, view);
  };

  return {
    open,
    close,
    isOpen,
    relayout: (win) => {
      if (!win || win.isDestroyed()) return;
      const entry = views.get(win.id);
      if (entry) layout(win, entry.view);
    },
    isSignupWebContents: (wc: WebContents) => {
      for (const e of views.values()) if (e.view.webContents === wc) return true;
      return false;
    },
    showingWindow: () => {
      for (const e of views.values()) if (isOpen(e.win)) return e.win;
      return null;
    },
  };
}
