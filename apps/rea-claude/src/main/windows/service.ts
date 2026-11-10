/**
 * WindowService implementation (owner: I4): Electron glue over the pure
 * helpers in this folder. Behavior: docs/spec/windows-labview-menu.md.
 *
 * Owns shell windows (+ initial window, window-state, compact mode), the
 * per-window Lab WebContentsView (open/ready/down/hide/reveal/park), viewer
 * windows (+ recovery controller), popups, navigation guards, settings sheet,
 * application/dock/context menus, crash revive, watchdog, power and memory
 * hooks.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  app,
  BrowserWindow,
  Menu,
  WebContentsView,
  nativeImage,
  net,
  powerMonitor,
  screen,
  shell,
  webContents as webContentsModule,
} from "electron";
import type {
  BrowserWindowConstructorOptions,
  ContextMenuParams,
  Event as ElectronEvent,
  IpcMainInvokeEvent,
  NativeImage,
  WebContents,
  WebContentsWillFrameNavigateEventParams,
  WebContentsWillNavigateEventParams,
  WebContentsWillRedirectEventParams,
  WebFrameMain,
} from "electron";
import {
  DOCK_BOUNCE_DELAY_MS,
  DOCS_URL,
  LAB_MIN_LOADING_MS,
  LAB_MOUNT_WAIT_MS,
  LAB_PARTITION,
  LAB_PROBE_TIMEOUT_MS,
  MEMORY_POLL_MS,
  RENDERER_WAIT_MS,
  RESUME_ACTION_DELAY_MS,
  SETTINGS_OVERLAY_COLOR,
  SETTINGS_OVERLAY_OPACITY,
  SETTINGS_SHEET_TITLE,
  SHELL_SHOW_FALLBACK_MS,
  VIEWER_REVEAL_FALLBACK_MS,
  WATCHDOG_PAGE_MIN_AGE_MS,
  WATCHDOG_TICK_MS,
  WIN_DEFAULT_H,
  WIN_DEFAULT_W,
  WIN_MIN_H,
  WIN_MIN_W,
  WINDOW_TITLE,
} from "@shared/config";
import type { FocusedWindowKind, LabDownReason, NavigateDest, RecoverSessionResult, RecoveryState } from "@shared/ipc";
import { isTrustedShellWebContents, makeShellUrlMatcher, sendLab, sendShell } from "../ipc/trust";
import type { LabRef, MainContext, WindowService } from "../services";
import { CompactController } from "./compact";
import { cascadePosition, chromeFor, labViewBounds, settingsSheetBounds, sizeLikeParent } from "./geometry";
import type { Rect } from "./geometry";
import { buildContextMenuTemplate, buildDockMenuTemplate, buildMenuTemplate, isDevFromSettings } from "./menuTemplate";
import type { ZoomStep } from "./menuTemplate";
import {
  decideFrameNavigation,
  decideLabNavigation,
  gatewayOf,
  isAuthWall,
  isGatewayRoot,
  isRevealablePath,
  labReturnTo,
  pageLabel,
  sameOrigin,
  urlHost,
  viewerNeedsLabBridge,
} from "./navPolicy";
import { createLastOpenedStore, createWindowStateSaver, readWindowState } from "./persistence";
import { createRecoveryController, fetchAuthConfig, RecoveryRegistry, RecoveryText } from "./recovery";
import type { FetchLike, RecoverableContents, RecoveryController } from "./recovery";
import {
  classifyHealthStatus,
  entryNeedsReplace,
  isLongSuspend,
  isReloadableVis,
  labStateFor,
  normalizePageProbe,
  shouldRevive,
  shouldShedMemory,
  sheetTabFor,
  watchdogPresence,
  windowHoldsLab,
} from "./rules";
import type { LabVis } from "./rules";
import { ARTIFACT_SETTLED_SCRIPT, AUTH_WALL_PROBE_SCRIPT, MOUNT_WAIT_SCRIPT, PAGE_LIVENESS_SCRIPT } from "./scripts";
import { createWatchdog } from "./watchdog";

export interface WindowsDeps {
  /** Clock (ms epoch). */
  now?: () => number;
  /** HTTP fetch used for `/healthz` and `/api/auth/config` (default Electron `net.fetch`). */
  fetch?: FetchLike;
  /** macOS `kern.memorystatus_level` reader (default: `/usr/sbin/sysctl`). */
  readMemoryLevel?: () => Promise<number | null>;
}

/** Extra operations used by `registerWindowsIpc` (not part of the shared interface). */
export interface WindowInternals {
  isInitialWindow(win: BrowserWindow | null): boolean;
  /** One-shot: true only for the first call from the initial window. */
  consumeInitialLastOpened(win: BrowserWindow | null): boolean;
  lastOpenedGet(account: string): Promise<string | null>;
  lastOpenedSet(account: string, connId: string): Promise<void>;
  setCompactFromRenderer(sender: WebContents, compact: unknown, contentHeight: unknown): void;
  heldElsewhere(win: BrowserWindow | null): string[];
  focusHeld(connId: unknown): boolean;
  hideByUser(win: BrowserWindow | null): void;
  goBack(win: BrowserWindow | null): void;
  goForward(win: BrowserWindow | null): void;
  viewerRetry(win: BrowserWindow | null, deployment: unknown): void;
  markDialogOpen(winId: number, open: boolean): void;
  dialogIcon(): NativeImage | undefined;
}

const internalsByService = new WeakMap<WindowService, WindowInternals>();

/** Internals for a service created by `createWindowService`. */
export function windowInternals(svc: WindowService): WindowInternals {
  const i = internalsByService.get(svc);
  if (!i) throw new Error("windows: service was not created by createWindowService");
  return i;
}

interface LabEntry {
  view: WebContentsView;
  connId: string;
  title: string;
  vis: LabVis;
  reauthing: boolean;
  userLeft: boolean;
  lastStatus: number;
  labOrigin: string | null;
  loadStartedAt: number;
  /** Incremented per openLabInWindow load: identifies a load even when two start in the same ms. */
  loadSeq: number;
  downLoadStartedAt?: number;
}

interface ParkedLab {
  connId: string;
  returnTo: string | null;
}

type GuardControl = { preventDefault(): void };
type NavDecider = (url: string, ctl: GuardControl, fromNavigation: boolean) => void;

const ERR_ABORTED = -3;

const execFileAsync = promisify(execFile);

async function defaultReadMemoryLevel(): Promise<number | null> {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync("/usr/sbin/sysctl", ["-n", "kern.memorystatus_level"]);
    const n = Number.parseInt(String(stdout).trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function createWindowService(ctx: MainContext, deps: WindowsDeps = {}): WindowService {
  const now = deps.now ?? Date.now;
  const doFetch: FetchLike = deps.fetch ?? ((url, init) => net.fetch(url, init));
  const readMemoryLevel = deps.readMemoryLevel ?? defaultReadMemoryLevel;

  // --- state (§3.4) ---------------------------------------------------------
  const labs = new Map<number, LabEntry>();
  const parked = new Map<number, ParkedLab>();
  const shellIds = new Set<number>();
  let initialWindowId: number | null = null;
  let initialLastOpenedConsumed = false;
  const auxWindows = new Set<BrowserWindow>();
  const viewerViews = new Map<number, WebContentsView>();
  const viewerControllers = new Map<number, RecoveryController>();
  const sheets = new Map<number, BrowserWindow>();
  const dialogOpenFor = new Set<number>();
  const readyHooks = new Set<(connId: string, wc: WebContents) => void>();
  const registry = new RecoveryRegistry();
  const compact = new CompactController((b) => screen.getDisplayMatching(b).workArea);
  const lastOpened = createLastOpenedStore(() => ctx.env.userDataPath());
  const stateSaver = createWindowStateSaver(() => ctx.env.userDataPath());

  const log = (tag: string) => ctx.logger(tag);

  // --- small helpers --------------------------------------------------------

  const openExternal = (url: string): void => {
    try {
      const p = new URL(url).protocol;
      if (p === "http:" || p === "https:") void shell.openExternal(url).catch(() => undefined);
    } catch {
      /* ignore unparseable */
    }
  };
  const markCause = (cause: string, details?: unknown): void => {
    try {
      ctx.telemetry.markCause(cause, details);
    } catch {
      /* telemetry is best-effort */
    }
  };
  const markRecent = (name: Parameters<MainContext["telemetry"]["markRecent"]>[0]): void => {
    try {
      ctx.telemetry.markRecent(name);
    } catch {
      /* best-effort */
    }
  };
  const fromId = (id: number): BrowserWindow | null => {
    const w = BrowserWindow.fromId(id);
    return w && !w.isDestroyed() ? w : null;
  };
  const isShell = (w: BrowserWindow | null | undefined): w is BrowserWindow => !!w && shellIds.has(w.id);
  const liveShells = (): BrowserWindow[] =>
    BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && shellIds.has(w.id));
  const workAreaFor = (b: Rect): Rect => screen.getDisplayMatching(b).workArea;
  const closeView = (view: WebContentsView): void => {
    if (view.webContents.isDestroyed()) return;
    try {
      view.webContents.close();
    } catch {
      /* already gone */
    }
  };
  const sizeLikeParentFor = (parent: BrowserWindow) => {
    const b = parent.getBounds();
    return sizeLikeParent(b, workAreaFor(b));
  };
  const loadRenderer = (win: BrowserWindow, hash?: string): void => {
    const devUrl = ctx.env.rendererUrl;
    const p = devUrl
      ? win.loadURL(hash ? `${devUrl}#${hash}` : devUrl)
      : win.loadFile(ctx.env.rendererHtmlPath(), hash ? { hash } : undefined);
    void p.catch(() => undefined);
  };
  const appIcon = (): NativeImage | undefined => {
    try {
      const img = nativeImage.createFromPath(ctx.env.iconPath());
      return img.isEmpty() ? undefined : img;
    } catch {
      return undefined;
    }
  };
  const bounceDock = (): void => {
    if (ctx.env.platform !== "darwin") return;
    setTimeout(() => app.dock?.bounce("critical"), DOCK_BOUNCE_DELAY_MS).unref?.();
  };
  /** `Ts`: steal app focus; with `onActive`, call it on activation (macOS waits for did-become-active ≤350 ms). */
  const activateApp = (onActive?: () => void): (() => void) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = (): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      timer = null;
      app.off("did-become-active", fire);
      onActive?.();
    };
    if (ctx.env.platform === "darwin" && onActive) {
      app.once("did-become-active", fire);
      timer = setTimeout(fire, DOCK_BOUNCE_DELAY_MS);
      timer.unref?.();
    } else {
      fire();
    }
    app.focus({ steal: true });
    bounceDock();
    return () => {
      done = true;
      if (timer) clearTimeout(timer);
      app.off("did-become-active", fire);
    };
  };

  // --- Lab view primitives ---------------------------------------------------

  const layoutView = (win: BrowserWindow, view: WebContentsView): void => {
    if (win.isDestroyed()) return;
    view.setBounds(labViewBounds(win.getContentSize(), win.webContents.getZoomFactor()));
  };
  const sendViewVis = (win: BrowserWindow, shown: boolean, title?: string): void => {
    if (win.isDestroyed()) return;
    sendShell(win.webContents, "lab:viewvis", shown ? { shown, title: title ?? "" } : { shown });
  };
  const shownLabWc = (win: BrowserWindow | null | undefined): WebContents | null => {
    const e = win && !win.isDestroyed() ? labs.get(win.id) : undefined;
    if (e?.vis !== "shown" || e.view.webContents.isDestroyed()) return null;
    return e.view.webContents;
  };
  const viewerWc = (win: BrowserWindow | null | undefined): WebContents | null => {
    const v = win && !win.isDestroyed() ? viewerViews.get(win.id) : undefined;
    return !v || v.webContents.isDestroyed() ? null : v.webContents;
  };
  const sendNavState = (win: BrowserWindow | null | undefined): void => {
    if (!win || win.isDestroyed()) return;
    const wc = shownLabWc(win);
    sendShell(win.webContents, "lab:navstate", {
      canGoBack: wc ? wc.navigationHistory.canGoBack() : false,
      canGoForward: wc ? wc.navigationHistory.canGoForward() : false,
    });
  };
  const labOf = (wc: WebContents): { winId: number; entry: LabEntry } | null => {
    for (const [winId, entry] of labs) if (entry.view.webContents === wc) return { winId, entry };
    return null;
  };
  const windowOfLab = (wc: WebContents): BrowserWindow | null => {
    const l = labOf(wc);
    return l ? fromId(l.winId) : null;
  };
  const windowForConn = (connId: string): BrowserWindow | null => {
    for (const [id, e] of labs) if (e.connId === connId) return BrowserWindow.fromId(id);
    for (const [id, p] of parked) if (p.connId === connId) return BrowserWindow.fromId(id);
    return null;
  };
  const revealedLabs = (): { winId: number; connId: string }[] =>
    [...labs].filter(([, e]) => e.vis === "shown").map(([winId, e]) => ({ winId, connId: e.connId }));

  /** Plain hide (`dt`): keep the view alive. */
  const plainHide = (win: BrowserWindow | null | undefined): void => {
    if (!win) return;
    const e = labs.get(win.id);
    if (!e) return;
    if (!win.isDestroyed()) e.view.setVisible(false);
    e.vis = "hidden";
    sendViewVis(win, false);
    sendNavState(win);
  };
  /** User hide (`No`): cancel pending reopen, mark userLeft, hide. */
  const hideByUser = (win: BrowserWindow | null | undefined): void => {
    if (win) {
      // Read `reauthing` first: cancelWindow clears it (via setReauthing(false)).
      const e = labs.get(win.id);
      const wasReauthing = !!e?.reauthing;
      try {
        ctx.lab.cancelWindow(win.id);
      } catch (err) {
        log("labview").warn("cancelWindow failed", err);
      }
      if (e && wasReauthing) e.userLeft = true;
    }
    plainHide(win);
  };
  /** Reveal a hidden Lab (`Vi`). */
  const reveal = (win: BrowserWindow): void => {
    if (win.isDestroyed()) return;
    const e = labs.get(win.id);
    if (!e || e.vis !== "hidden") return;
    sendShell(win.webContents, "lab:opened", { id: e.connId, title: e.title });
    layoutView(win, e.view);
    markRecent("lab-reveal");
    sendViewVis(win, true, e.title);
    e.view.setVisible(true);
    e.vis = "shown";
    sendShell(win.webContents, "lab:state", { id: e.connId, state: "ready" });
    sendNavState(win);
  };
  const resendOpened = (win: BrowserWindow): void => {
    if (win.isDestroyed()) return;
    const e = labs.get(win.id);
    if (e) sendShell(win.webContents, "lab:opened", { id: e.connId, title: e.title });
  };
  /** Window close teardown (`gl`). */
  const teardownLab = (winId: number): void => {
    try {
      ctx.lab.cancelWindow(winId);
    } catch {
      /* best-effort */
    }
    const e = labs.get(winId);
    if (e) closeView(e.view);
    labs.delete(winId);
    parked.delete(winId);
  };
  const relayoutAll = (): void => {
    for (const [id, e] of labs) {
      const w = fromId(id);
      if (w) layoutView(w, e.view);
    }
    for (const [id, v] of viewerViews) {
      const w = fromId(id);
      if (w) layoutView(w, v);
    }
    for (const w of liveShells()) {
      try {
        ctx.signup.relayout(w);
      } catch {
        /* signup is optional */
      }
    }
  };
  const invalidateShown = (): void => {
    for (const [id, e] of labs) {
      if (e.vis !== "shown") continue;
      const w = fromId(id);
      if (!w) continue;
      try {
        if (!w.webContents.isDestroyed()) w.webContents.invalidate();
        if (!e.view.webContents.isDestroyed()) e.view.webContents.invalidate();
      } catch {
        /* ignore */
      }
    }
  };
  const destroyAllViews = (): void => {
    for (const [id, e] of [...labs]) {
      const w = fromId(id);
      if (w) w.contentView.removeChildView(e.view);
      closeView(e.view);
      labs.delete(id);
    }
    for (const [id, v] of [...viewerViews]) {
      const w = fromId(id);
      if (w) w.contentView.removeChildView(v);
      closeView(v);
      viewerViews.delete(id);
    }
  };
  /** Wait for a usable shell renderer (`Gi`): reload a crashed one and wait ≤8 s. */
  const waitShell = async (win: BrowserWindow): Promise<boolean> => {
    const wc = win.webContents;
    if (wc.isDestroyed()) return false;
    if (!wc.isLoading()) {
      if (!wc.isCrashed()) return false;
      wc.reload();
    }
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        wc.off("did-finish-load", finish);
        wc.off("did-fail-load", onFail);
        wc.off("destroyed", finish);
        resolve();
      };
      const onFail = (_e: unknown, code: number, _d: string, _u: string, isMainFrame: boolean): void => {
        if (!isMainFrame || code === ERR_ABORTED) return;
        finish();
      };
      const timer = setTimeout(finish, RENDERER_WAIT_MS);
      timer.unref?.();
      wc.on("did-finish-load", finish);
      wc.on("did-fail-load", onFail);
      wc.once("destroyed", finish);
    });
    return true;
  };
  /** Report "down" once the shell can show it (`Tl`). */
  const reportDown = async (win: BrowserWindow, entry: LabEntry, reason: LabDownReason): Promise<void> => {
    const loadStartedAt = entry.loadStartedAt;
    const seq = entry.loadSeq;
    const reloaded = await waitShell(win);
    if (win.isDestroyed()) return;
    const cur = labs.get(win.id);
    if (!cur || cur !== entry || cur.loadSeq !== seq || cur.loadStartedAt !== loadStartedAt || cur.vis !== "loading") return;
    if (reloaded) resendOpened(win);
    sendShell(win.webContents, "lab:state", { id: cur.connId, state: "down", reason });
    cur.view.setVisible(false);
    sendViewVis(win, false);
    sendNavState(win);
  };
  const reauth = (win: BrowserWindow, connId: string): void => {
    void Promise.resolve()
      .then(() => ctx.lab.reauthOnAuthWall(win, connId))
      .catch((err) => log("labview").error("re-auth failed", err));
  };
  const rewake = (win: BrowserWindow, connId: string, returnTo?: string | null): void => {
    void Promise.resolve()
      .then(() => ctx.lab.rewake(win, connId, returnTo))
      .catch((err) => log("labview").error("rewake failed", err));
  };
  const focusViewIfWindowFocused = (win: BrowserWindow, wc: WebContents | null): void => {
    if (win.isDestroyed() || !win.isFocused() || !wc || wc.isDestroyed() || wc.isFocused()) return;
    wc.focus();
  };

  // --- guards (§6.2, §6.3) -----------------------------------------------------

  const installNavGuard = (wc: WebContents, decide: NavDecider): void => {
    const ctl = (e: ElectronEvent): GuardControl => ({
      preventDefault: () => {
        e.preventDefault();
        registry.navigationCanceled(wc);
      },
    });
    wc.on("will-navigate", (e: ElectronEvent<WebContentsWillNavigateEventParams>) => decide(e.url, ctl(e), true));
    wc.on("will-redirect", (e: ElectronEvent<WebContentsWillRedirectEventParams>) => {
      if (e.isMainFrame) decide(e.url, ctl(e), false);
    });
  };
  /**
   * Windows that load the index preload (shell, settings sheet, viewer strip)
   * may only ever show the app's own renderer: block renderer-initiated
   * navigations and redirects anywhere else, including the file:// navigation
   * Chromium performs when a file is dropped on the window (X17).
   */
  let ownRenderer: ((url: string) => boolean) | null = null;
  const isOwnRendererUrl = (url: string): boolean => {
    ownRenderer ??= makeShellUrlMatcher({ rendererUrl: ctx.env.rendererUrl, rendererHtmlPath: ctx.env.rendererHtmlPath() });
    return ownRenderer(url);
  };
  const installRendererNavLock = (wc: WebContents): void => {
    const block = (e: ElectronEvent<{ url: string }>): void => {
      if (isOwnRendererUrl(e.url)) return;
      e.preventDefault();
      log("shell").warn(`blocked renderer navigation to ${pageLabel(e.url) || "<non-http url>"}`);
    };
    wc.on("will-navigate", block);
    wc.on("will-redirect", block);
  };
  const frameUrl = (frame: WebFrameMain | null): string | null => {
    try {
      return !frame || frame.isDestroyed() ? null : frame.url;
    } catch {
      return null;
    }
  };
  const registerAux = (w: BrowserWindow): void => {
    auxWindows.add(w);
    w.on("closed", () => auxWindows.delete(w));
  };
  const installPopupGuards = (wc: WebContents, host: BrowserWindow): void => {
    wc.setWindowOpenHandler((d) => {
      if (sameOrigin(d.url, wc.getURL())) {
        return { action: "allow", overrideBrowserWindowOptions: sizeLikeParentFor(host) };
      }
      openExternal(d.url);
      return { action: "deny" };
    });
    wc.on("will-frame-navigate", (e: ElectronEvent<WebContentsWillFrameNavigateEventParams>) => {
      if (e.isMainFrame) return;
      const fu = frameUrl(e.frame);
      if (fu === null) return;
      if (decideFrameNavigation(fu, e.url, wc.getURL()) === "block-external") {
        e.preventDefault();
        openExternal(e.url);
      }
    });
    wc.on("did-create-window", (child, details) => {
      markCause("popup");
      child.setMenuBarVisibility(false);
      registerAux(child);
      installPopupGuards(child.webContents, child);
      const initialUrl = details.url;
      installNavGuard(child.webContents, (url, ctl) => {
        if (!sameOrigin(url, initialUrl)) {
          ctl.preventDefault();
          openExternal(url);
        }
      });
    });
  };

  // --- open a Lab (§4.1) ---------------------------------------------------------

  const markReady = (win: BrowserWindow, e: LabEntry): void => {
    if (e.vis === "hidden") return;
    markRecent("lab-reveal");
    sendViewVis(win, true, e.title);
    e.view.setVisible(true);
    e.vis = "shown";
    sendNavState(win);
    for (const hook of [...readyHooks]) {
      try {
        hook(e.connId, e.view.webContents);
      } catch (err) {
        log("labview").error("lab-ready hook failed", err);
      }
    }
    if (!win.isDestroyed()) sendShell(win.webContents, "lab:state", { id: e.connId, state: "ready" });
  };
  const markDown = (win: BrowserWindow, e: LabEntry): void => {
    e.vis = "loading";
    const first = e.downLoadStartedAt !== e.loadStartedAt;
    e.downLoadStartedAt = e.loadStartedAt;
    if (first) {
      try {
        ctx.telemetry.recordShellEvent("down-panel", {
          connId: e.connId,
          details: { lastStatus: e.lastStatus, msSinceLoad: e.loadStartedAt > 0 ? now() - e.loadStartedAt : null },
        });
      } catch {
        /* best-effort */
      }
    }
    void reportDown(win, e, "error");
  };

  const createLabView = (win: BrowserWindow, connId: string, title: string): LabEntry => {
    const view = new WebContentsView({
      webPreferences: { partition: LAB_PARTITION, preload: ctx.env.preloadPath("lab"), backgroundThrottling: false },
    });
    const wc = view.webContents;
    view.setVisible(false);
    installPopupGuards(wc, win);
    installNavGuard(wc, (url, ctl, fromNavigation) => handleLabNavigation(win, wc, url, ctl, fromNavigation));
    registry.register(
      wc as unknown as RecoverableContents,
      (origin) => labs.get(win.id)?.labOrigin === origin,
      () => {
        const cur = labs.get(win.id);
        if (!cur || cur.view.webContents !== wc || cur.vis === "hidden") return false;
        reauth(win, cur.connId);
        return true;
      },
    );
    const current = (): LabEntry | undefined => {
      const e = labs.get(win.id);
      return e && e.view === view ? e : undefined;
    };
    wc.on("did-navigate", (_e, _url, status) => {
      const e = current();
      if (!e) return;
      e.lastStatus = status;
      sendNavState(win);
    });
    wc.on("did-navigate-in-page", (_e, _url, isMainFrame) => {
      if (isMainFrame && current()) sendNavState(win);
    });
    wc.on("did-finish-load", () => {
      const e = current();
      if (!e || e.vis === "hidden") return;
      if (e.lastStatus >= 400) {
        markDown(win, e);
        return;
      }
      void checkReadiness(win, wc, current);
    });
    wc.on("did-fail-load", (_e, code, _desc, _url, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED) return;
      const e = current();
      if (e) markDown(win, e);
    });
    wc.on("render-process-gone", () => {
      const e = current();
      if (e) markDown(win, e);
    });
    const entry: LabEntry = {
      view,
      connId,
      title,
      vis: "hidden",
      reauthing: false,
      userLeft: false,
      lastStatus: 0,
      labOrigin: null,
      loadStartedAt: 0,
      loadSeq: 0,
    };
    labs.set(win.id, entry);
    win.contentView.addChildView(view);
    return entry;
  };

  const checkReadiness = async (
    win: BrowserWindow,
    wc: WebContents,
    current: () => LabEntry | undefined,
  ): Promise<void> => {
    let authWall = false;
    try {
      authWall = !!(await wc.executeJavaScript(AUTH_WALL_PROBE_SCRIPT));
    } catch {
      authWall = false;
    }
    const e1 = current();
    if (!e1 || e1.vis === "hidden") return;
    if (authWall) {
      reauth(win, e1.connId);
      return;
    }
    const startedAt = e1.loadStartedAt;
    const seq = e1.loadSeq;
    let mountTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        wc.executeJavaScript(MOUNT_WAIT_SCRIPT),
        new Promise<void>((r) => {
          mountTimer = setTimeout(r, LAB_MOUNT_WAIT_MS);
        }),
      ]);
    } catch {
      /* page threw: treat as mounted-or-timeout */
    } finally {
      if (mountTimer) clearTimeout(mountTimer);
    }
    const stillValid = (): LabEntry | undefined => {
      const e = current();
      return e && e.vis !== "hidden" && e.loadSeq === seq && e.loadStartedAt === startedAt && e.downLoadStartedAt !== startedAt
        ? e
        : undefined;
    };
    const e2 = stillValid();
    if (!e2) return;
    const remaining = Math.max(0, LAB_MIN_LOADING_MS - (now() - startedAt));
    if (remaining === 0) {
      markReady(win, e2);
      return;
    }
    setTimeout(() => {
      const e3 = stillValid();
      if (e3) markReady(win, e3);
    }, remaining);
  };

  const handleLabNavigation = (
    win: BrowserWindow,
    wc: WebContents,
    url: string,
    ctl: GuardControl,
    fromNavigation: boolean,
  ): void => {
    const e = labs.get(win.id);
    const decision = decideLabNavigation(url, wc.getURL(), {
      reauthing: !!e?.reauthing,
      fromNavigation,
      shown: e?.vis === "shown",
      labOrigin: e?.labOrigin ?? null,
    });
    switch (decision) {
      case "in-app":
        return;
      case "freeze":
        ctl.preventDefault();
        return;
      case "open-document":
        ctl.preventDefault();
        openDocumentViewer(win, url);
        return;
      case "browser":
        ctl.preventDefault();
        openExternal(url);
        return;
      case "auth-wall-reauth":
        ctl.preventDefault();
        if (e) reauth(win, e.connId);
        return;
      case "auth-wall-neutralize":
        ctl.preventDefault();
        if (e) e.vis = "hidden";
        void wc.loadURL("about:blank").catch(() => undefined);
        return;
    }
  };

  const openLabInWindow = (win: BrowserWindow, connId: string, url: string, title: string): void => {
    if (!win || win.isDestroyed()) return;
    const existing = labs.get(win.id);
    if (existing?.userLeft) {
      existing.userLeft = false;
      existing.reauthing = false;
      return;
    }
    try {
      sendShell(win.webContents, "lab:opened", { id: connId, title });
      let entry = existing;
      if (entry && entryNeedsReplace({ connId: entry.connId, destroyed: entry.view.webContents.isDestroyed() }, connId)) {
        win.contentView.removeChildView(entry.view);
        sendViewVis(win, false);
        closeView(entry.view);
        labs.delete(win.id);
        entry = undefined;
      }
      if (!entry) entry = createLabView(win, connId, title);
      entry.connId = connId;
      entry.title = title;
      entry.vis = "loading";
      entry.reauthing = false;
      entry.lastStatus = 0;
      try {
        entry.labOrigin = new URL(url).origin;
      } catch {
        entry.labOrigin = null;
      }
      entry.loadStartedAt = now();
      entry.loadSeq += 1;
      // Pre-layout while visible so the first paint has the right size.
      entry.view.setVisible(true);
      layoutView(win, entry.view);
      entry.view.setVisible(false);
      if (!win.isDestroyed()) sendShell(win.webContents, "lab:state", { id: connId, state: "loading" });
      void entry.view.webContents.loadURL(url).catch(() => undefined);
    } catch (err) {
      log("labview").error("openLabInWindow failed", err);
      try {
        if (!win.isDestroyed()) sendShell(win.webContents, "lab:state", { id: connId, state: "down", reason: "error" });
      } catch {
        /* ignore */
      }
    }
  };

  /** After a shell renderer reload (`Sl`): resync, returning a connId to rewake when the Lab page is gone. */
  const resyncAfterShellReload = (win: BrowserWindow): string | null => {
    if (win.isDestroyed()) return null;
    const e = labs.get(win.id);
    if (!e) return null;
    if (e.vis === "hidden") {
      if (e.reauthing && !e.userLeft) resendOpened(win);
      return null;
    }
    resendOpened(win);
    if (e.vis === "shown") sendViewVis(win, true, e.title);
    const wc = e.view.webContents;
    if (wc.isDestroyed() || wc.isCrashed()) return e.connId;
    const state = labStateFor(e.vis, e.downLoadStartedAt === e.loadStartedAt);
    sendShell(win.webContents, "lab:state", { id: e.connId, state, ...(state === "down" ? { reason: "error" as const } : {}) });
    return null;
  };

  // --- memory shedding (§4.9) ------------------------------------------------------

  const shedMemory = (): number => {
    let n = 0;
    for (const [id, e] of [...labs]) {
      if (e.vis !== "shown" || e.reauthing) continue;
      const w = fromId(id);
      if (w) {
        sendShell(w.webContents, "lab:state", { id: e.connId, state: "loading" });
        w.contentView.removeChildView(e.view);
        sendViewVis(w, false);
      }
      const returnTo = e.view.webContents.isDestroyed() ? null : labReturnTo(e.view.webContents.getURL());
      closeView(e.view);
      parked.set(id, { connId: e.connId, returnTo });
      labs.delete(id);
      n++;
    }
    return n;
  };

  // --- navigation targets ----------------------------------------------------------

  const navTarget = (win: BrowserWindow | null | undefined): WebContents | null => shownLabWc(win) ?? viewerWc(win);
  const goBack = (win: BrowserWindow | null | undefined): void => {
    const wc = navTarget(win);
    if (wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  };
  const goForward = (win: BrowserWindow | null | undefined): void => {
    const wc = navTarget(win);
    if (wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  };
  const reloadTarget = (win: BrowserWindow | null, ignoreCache: boolean): void => {
    if (!win || win.isDestroyed()) return;
    const e = labs.get(win.id);
    const wc = e && isReloadableVis(e.vis) ? e.view.webContents : (viewerWc(win) ?? win.webContents);
    if (wc.isDestroyed()) return;
    if (ignoreCache) wc.reloadIgnoringCache();
    else wc.reload();
  };
  const toggleDevTools = (): void => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win || win.isDestroyed()) return;
    const wc = shownLabWc(win) ?? viewerWc(win) ?? win.webContents;
    if (wc.isDestroyed()) return;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: "detach" });
  };
  const zoom = (step: ZoomStep): void => {
    const wc = webContentsModule.getFocusedWebContents();
    if (!wc || wc.isDestroyed()) return;
    wc.zoomLevel = step === "reset" ? 0 : wc.zoomLevel + step;
    relayoutAll();
  };
  const sendFeedback = (win: BrowserWindow | null): void => {
    const wc = shownLabWc(win);
    if (wc) sendLab(wc, "silico:report-issue");
  };

  // --- settings sheet (§4.7) -------------------------------------------------------------

  const openSettingsSheet = (win: BrowserWindow, dest: NavigateDest): void => {
    if (!win || win.isDestroyed()) return;
    const tab = sheetTabFor(dest);
    const existing = sheets.get(win.id);
    if (existing && !existing.isDestroyed()) {
      markCause("menu:settings", dest);
      existing.focus();
      sendShell(existing.webContents, "app:navigate", dest);
      return;
    }
    const parentId = win.id;
    const pb = win.getBounds();
    const overlay = new BrowserWindow({
      parent: win,
      x: pb.x,
      y: pb.y,
      width: pb.width,
      height: pb.height,
      show: false,
      frame: false,
      focusable: false,
      hasShadow: false,
      backgroundColor: SETTINGS_OVERLAY_COLOR,
      resizable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
    });
    overlay.setIgnoreMouseEvents(true);
    overlay.setOpacity(SETTINGS_OVERLAY_OPACITY);
    const sb = settingsSheetBounds(pb);
    const sheet = new BrowserWindow({
      parent: win,
      ...sb,
      show: false,
      frame: false,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: SETTINGS_SHEET_TITLE,
      webPreferences: { preload: ctx.env.preloadPath("index"), sandbox: true, contextIsolation: true },
    });
    const sheetId = sheet.id;
    installRendererNavLock(sheet.webContents);
    sheets.set(parentId, sheet);
    sheet.on("closed", () => {
      if (sheets.get(parentId) === sheet) sheets.delete(parentId);
      if (!overlay.isDestroyed()) overlay.destroy();
    });
    sheet.on("blur", () => {
      if (sheet.isDestroyed() || dialogOpenFor.has(sheetId) || sheet.webContents.isDevToolsOpened()) return;
      sheet.close();
    });
    sheet.once("ready-to-show", () => {
      if (!overlay.isDestroyed()) overlay.showInactive();
      markCause("menu:settings");
      sheet.show();
      sheet.focus();
    });
    loadRenderer(sheet, `settings-modal/${tab}`);
  };

  // --- viewer windows (§4.11) ------------------------------------------------------------

  const createViewerWindow = (
    url: string,
    parent: BrowserWindow | null,
    opts: { labBridge: boolean; reveal: (w: BrowserWindow) => void },
  ): BrowserWindow => {
    const win = new BrowserWindow({
      ...(parent && !parent.isDestroyed() ? sizeLikeParentFor(parent) : { autoHideMenuBar: true, title: WINDOW_TITLE }),
      show: false,
      ...chromeFor(ctx.env.platform),
      webPreferences: { preload: ctx.env.preloadPath("index"), sandbox: true, contextIsolation: true },
    });
    const winId = win.id;
    installRendererNavLock(win.webContents);
    win.setMenuBarVisibility(false);
    registerAux(win);
    const view = new WebContentsView({
      webPreferences: {
        partition: LAB_PARTITION,
        ...(opts.labBridge ? { preload: ctx.env.preloadPath("lab"), backgroundThrottling: false } : {}),
      },
    });
    const vwc = view.webContents;
    win.contentView.addChildView(view);
    layoutView(win, view);
    win.on("resize", () => layoutView(win, view));
    win.webContents.once("did-finish-load", () => {
      if (!win.isDestroyed()) layoutView(win, view);
    });
    installPopupGuards(vwc, win);
    viewerViews.set(winId, view);
    view.setVisible(false);

    let revealedWindow = false;
    win.once("ready-to-show", () => {
      if (revealedWindow || win.isDestroyed()) return;
      revealedWindow = true;
      opts.reveal(win);
    });

    let fallback: ReturnType<typeof setTimeout> | null = null;
    let contentShown = false;
    let controller: RecoveryController | null = null;
    let loadedOnce = false;

    const revealContent = (): void => {
      if (contentShown || win.isDestroyed()) return;
      if (controller && controller.state().kind !== "idle") return;
      contentShown = true;
      if (fallback) clearTimeout(fallback);
      fallback = null;
      if (!vwc.isDestroyed()) view.setVisible(true);
      sendShell(win.webContents, "viewer:content-ready", undefined);
    };
    const maybeReveal = (pageUrl: string): void => {
      if (!loadedOnce || (opts.labBridge && !isRevealablePath(pageUrl))) return;
      if (!opts.labBridge) {
        revealContent();
        return;
      }
      vwc
        .executeJavaScript(ARTIFACT_SETTLED_SCRIPT)
        .then(() => {
          if (!vwc.isDestroyed() && isRevealablePath(vwc.getURL())) revealContent();
        })
        .catch(() => undefined);
    };
    vwc.on("did-finish-load", () => {
      loadedOnce = true;
      maybeReveal(vwc.getURL());
    });

    let strandedReported = false;
    const reportStranded = (surface: string, page: string): void => {
      if (strandedReported) return;
      strandedReported = true;
      try {
        ctx.telemetry.recordShellEvent("viewer-stranded", {
          details: { surface, page: pageLabel(page), labBridge: opts.labBridge },
        });
      } catch {
        /* best-effort */
      }
    };
    const onRecoveryState = (state: RecoveryState): void => {
      if (win.isDestroyed() || vwc.isDestroyed()) return;
      sendShell(win.webContents, "viewer:recovery", state);
      if (state.kind !== "idle") {
        contentShown = false;
        view.setVisible(false);
        sendShell(win.webContents, "viewer:content-ready", false);
        if (fallback) clearTimeout(fallback);
        fallback = null;
      } else {
        maybeReveal(vwc.getURL());
      }
    };

    if (opts.labBridge) {
      controller = createRecoveryController(
        url,
        {
          wc: vwc as unknown as RecoverableContents,
          isWindowDestroyed: () => win.isDestroyed(),
          onState: onRecoveryState,
          load: (next) => {
            loadedOnce = false;
            vwc.loadURL(next).catch(() => controller?.fail(RecoveryText.loadFailed));
          },
        },
        {
          registry,
          now,
          authStatus: () => ctx.auth.status(),
          listLabs: () => ctx.lab.listLabs(),
          createLabSession: (req) => ctx.lab.createLabSession(req),
          waitForLab: (base, token, o) => ctx.lab.waitForLab(base, token, o),
          fetchAuthConfig: (u, signal) => fetchAuthConfig(u, signal, doFetch),
          cachedIdentity: () => ctx.auth.cachedIdentity(),
          onIdentityChanged: (cb) => ctx.auth.onIdentityChanged(cb),
          onSignedIn: (cb) => ctx.auth.onSignedIn(cb),
        },
      );
      if (controller) viewerControllers.set(winId, controller);
    }

    installNavGuard(vwc, (target, ctl) => {
      if (controller && registry.navigationEligible(vwc as unknown as RecoverableContents) && (isAuthWall(target) || isGatewayRoot(target))) {
        ctl.preventDefault();
        controller.recover();
        return;
      }
      let allowed: boolean;
      if (controller) {
        try {
          allowed = controller.ownsOrigin(new URL(target).origin);
        } catch {
          allowed = false;
        }
      } else {
        allowed = sameOrigin(target, url);
      }
      if (!allowed) {
        ctl.preventDefault();
        openExternal(target);
      }
    });
    vwc.on("did-finish-load", () => {
      if (!controller || !registry.eligible(vwc as unknown as RecoverableContents)) return;
      const pageUrl = vwc.getURL();
      vwc
        .executeJavaScript(AUTH_WALL_PROBE_SCRIPT)
        .then((wall: unknown) => {
          if (vwc.isDestroyed() || vwc.getURL() !== pageUrl || !registry.eligible(vwc as unknown as RecoverableContents)) return;
          if (wall) {
            reportStranded("spa-wall", pageUrl);
            controller?.recover();
          } else {
            strandedReported = false;
          }
        })
        .catch(() => undefined);
    });
    vwc.on("did-navigate-in-page", (_e, pageUrl, isMainFrame) => {
      if (isMainFrame) maybeReveal(pageUrl);
    });
    vwc.on("did-fail-load", (_e, code, _d, _u, isMainFrame) => {
      if (!isMainFrame || code === ERR_ABORTED) return;
      if (controller?.recovering()) controller.fail(RecoveryText.loadFailed);
      else revealContent();
    });
    fallback = setTimeout(revealContent, VIEWER_REVEAL_FALLBACK_MS);
    fallback.unref?.();
    win.on("closed", () => {
      if (fallback) clearTimeout(fallback);
      viewerViews.delete(winId);
      controller?.dispose();
      viewerControllers.delete(winId);
      closeView(view);
    });

    let pageTitle = "";
    const sendTitle = (): void => {
      if (win.isDestroyed()) return;
      win.setTitle(pageTitle || WINDOW_TITLE);
      sendShell(win.webContents, "viewer:title", pageTitle);
    };
    vwc.on("page-title-updated", (_e, t) => {
      pageTitle = t;
      sendTitle();
    });
    const sendViewerNav = (): void => {
      if (win.isDestroyed() || vwc.isDestroyed()) return;
      sendShell(win.webContents, "lab:navstate", {
        canGoBack: vwc.navigationHistory.canGoBack(),
        canGoForward: vwc.navigationHistory.canGoForward(),
      });
    };
    vwc.on("did-navigate", sendViewerNav);
    vwc.on("did-navigate-in-page", sendViewerNav);
    win.webContents.on("did-finish-load", () => {
      sendTitle();
      sendViewerNav();
      if (contentShown) sendShell(win.webContents, "viewer:content-ready", undefined);
      if (controller) sendShell(win.webContents, "viewer:recovery", controller.state());
    });
    const crashes: number[] = [];
    win.webContents.on("render-process-gone", (_e, details) => {
      if (win.isDestroyed()) return;
      const revive = shouldRevive(details.reason, crashes, now());
      if (details.reason !== "clean-exit") {
        log("viewer").error(
          `window ${winId} strip renderer gone (${details.reason}); ${revive ? "reviving" : "crash-looping — giving up"}`,
        );
      }
      if (revive) {
        crashes.push(now());
        win.webContents.reload();
      }
    });
    win.on("focus", () => {
      if (contentShown) focusViewIfWindowFocused(win, vwc);
    });
    vwc.once("did-finish-load", () => focusViewIfWindowFocused(win, vwc));
    win.on("app-command", (_e, cmd) => {
      if (cmd === "browser-backward") goBack(win);
      else if (cmd === "browser-forward") goForward(win);
    });

    loadRenderer(win, "viewer");
    if (gatewayOf(url)) {
      if (controller) controller.recover();
      else onRecoveryState({ kind: "error", message: RecoveryText.notOpenable });
    } else {
      void vwc.loadURL(url).catch(() => undefined);
    }
    return win;
  };

  const openDocumentViewer = (parent: BrowserWindow, url: string): void => {
    markCause("doc-window", urlHost(url));
    createViewerWindow(url, parent, { labBridge: false, reveal: (w) => w.show() });
  };

  const openShareViewer = (url: string): void => {
    const host = urlHost(url);
    markCause("deep-link:share", host);
    let viewer: BrowserWindow | null = null;
    const pending = new Set(["activation", "viewer"]);
    let canceled = false;
    const mark = (k: string): void => {
      if (canceled) return;
      pending.delete(k);
      if (pending.size > 0) return;
      canceled = true;
      const w = viewer;
      if (!w || w.isDestroyed()) return;
      markCause("deep-link:share", host);
      if (ctx.env.platform === "darwin") {
        w.showInactive();
        w.focus();
      } else {
        w.show();
      }
    };
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    const win = createViewerWindow(url, parent, {
      labBridge: viewerNeedsLabBridge(url),
      reveal: (w) => {
        viewer = w;
        mark("viewer");
      },
    });
    const stopActivation = activateApp(() => mark("activation"));
    win.once("closed", () => {
      stopActivation();
      canceled = true;
    });
  };

  // --- shell windows (§4.8) ------------------------------------------------------------------

  const createShellWindow: WindowService["createShellWindow"] = (opts = {}) => {
    let saved: Rect | undefined;
    if (BrowserWindow.getAllWindows().length === 0) {
      try {
        saved = readWindowState(
          ctx.env.userDataPath(),
          screen.getAllDisplays().map((d) => d.workArea),
        );
      } catch {
        saved = undefined;
      }
    }
    let position: { x: number; y: number } | undefined;
    if (saved) {
      position = { x: saved.x, y: saved.y };
    } else {
      const focused = BrowserWindow.getFocusedWindow();
      if (focused && !focused.isDestroyed()) {
        const [fx = 0, fy = 0] = focused.getPosition();
        position = cascadePosition({ x: fx, y: fy }, workAreaFor(focused.getBounds()), WIN_DEFAULT_W, WIN_DEFAULT_H);
      }
    }
    const icon = appIcon();
    const options: BrowserWindowConstructorOptions = {
      width: saved?.width ?? WIN_DEFAULT_W,
      height: saved?.height ?? WIN_DEFAULT_H,
      minWidth: WIN_MIN_W,
      minHeight: WIN_MIN_H,
      ...(position ?? {}),
      show: false,
      autoHideMenuBar: true,
      title: WINDOW_TITLE,
      ...(icon ? { icon } : {}),
      ...chromeFor(ctx.env.platform),
      webPreferences: { preload: ctx.env.preloadPath("index"), sandbox: true, contextIsolation: true },
    };
    const win = new BrowserWindow(options);
    const id = win.id;

    // Show gate: wait (≤500 ms after ready-to-show) for the first compact decision.
    let readySeen = false;
    let shown = false;
    let compactDecided = false;
    const showNow = (): void => {
      if (shown || !readySeen || win.isDestroyed()) return;
      shown = true;
      if (ctx.env.isPackaged) {
        markCause("window-create");
        win.show();
      } else {
        win.showInactive();
      }
    };
    compact.onNextApply(id, () => {
      compactDecided = true;
      showNow();
    });
    win.on("ready-to-show", () => {
      readySeen = true;
      if (compactDecided) showNow();
      else setTimeout(showNow, SHELL_SHOW_FALLBACK_MS);
    });
    win.webContents.setWindowOpenHandler((d) => {
      openExternal(d.url);
      return { action: "deny" };
    });
    installRendererNavLock(win.webContents);
    const saveState = (): void => {
      if (!compact.isCompact(id) && !win.isDestroyed()) stateSaver.save(win.getBounds());
    };
    win.on("resize", () => {
      const e = labs.get(id);
      if (e) layoutView(win, e.view);
      try {
        ctx.signup.relayout(win);
      } catch {
        /* optional */
      }
      saveState();
    });
    win.on("moved", saveState);
    shellIds.add(id);
    win.on("closed", () => {
      shellIds.delete(id);
      teardownLab(id);
      try {
        ctx.lab.forgetWindow(id);
      } catch {
        /* optional */
      }
      try {
        ctx.signup.close(win);
      } catch {
        /* optional */
      }
      compact.clear(id);
      try {
        ctx.lab.closeTunnel(id);
      } catch {
        /* optional */
      }
    });
    win.webContents.on("did-start-loading", () => {
      try {
        ctx.signup.close(win);
      } catch {
        /* optional */
      }
    });
    const crashes: number[] = [];
    win.webContents.on("render-process-gone", (_e, details) => {
      if (win.isDestroyed()) return;
      const revive = shouldRevive(details.reason, crashes, now());
      if (details.reason !== "clean-exit") {
        log("shell").error(
          `window ${id} renderer gone (${details.reason}); ${revive ? "reviving" : "crash-looping — giving up"}`,
        );
      }
      if (!revive) return;
      crashes.push(now());
      markRecent("shell-renderer-gone");
      win.webContents.reload();
      const onFail = (_ev: unknown, code: number, desc: string, _u: string, isMainFrame: boolean): void => {
        if (!isMainFrame || code === ERR_ABORTED) return;
        log("shell").error(`window ${id} revive load failed (${code} ${desc})`);
        win.webContents.off("did-fail-load", onFail);
      };
      win.webContents.on("did-fail-load", onFail);
      win.webContents.once("did-finish-load", () => {
        win.webContents.off("did-fail-load", onFail);
        if (win.isDestroyed()) return;
        const connId = resyncAfterShellReload(win);
        if (connId) rewake(win, connId);
      });
    });
    win.on("app-command", (_e, cmd) => {
      if (cmd === "browser-backward") goBack(win);
      else if (cmd === "browser-forward") goForward(win);
    });
    win.on("focus", () => focusViewIfWindowFocused(win, shownLabWc(win)));
    loadRenderer(win);

    if (opts.initial) {
      initialWindowId = id;
      initialLastOpenedConsumed = false;
    }
    if (opts.compact) compact.apply(win, true);
    return win;
  };

  const focusOrCreateShellWindow = (cause: string): BrowserWindow => {
    const existing = liveShells()[0];
    if (!existing) return createShellWindow({ initial: true });
    markCause(cause);
    if (existing.isMinimized()) existing.restore();
    app.focus({ steal: true });
    existing.show();
    existing.focus();
    return existing;
  };

  const primaryShellWindow = (): BrowserWindow | null => {
    const f = BrowserWindow.getFocusedWindow();
    if (f && !f.isDestroyed() && isShell(f)) return f;
    return liveShells()[0] ?? null;
  };

  const navigateMenu = (dest: NavigateDest): void => {
    const target = primaryShellWindow();
    if (target) {
      if (target.isMinimized()) target.restore();
      markCause("menu:navigate", dest);
      target.show();
      if (dest !== "connections" && labs.get(target.id)?.vis === "shown") {
        openSettingsSheet(target, dest);
        return;
      }
      sendShell(target.webContents, "app:navigate", dest);
      if (dest === "connections") hideByUser(target);
      return;
    }
    const win = createShellWindow();
    if (dest !== "connections") {
      win.webContents.once("did-finish-load", () => {
        if (!win.isDestroyed()) sendShell(win.webContents, "app:navigate", dest);
      });
    }
  };

  // --- menus -------------------------------------------------------------------------------------

  const buildMenu = (dev: boolean): void => {
    const template = buildMenuTemplate(
      { platform: ctx.env.platform, dev, isPackaged: ctx.env.isPackaged, appName: app.name },
      {
        navigate: navigateMenu,
        checkForUpdates: () => ctx.updater.userCheck(),
        newWindow: () => void createShellWindow(),
        reload: (ignoreCache) => reloadTarget(BrowserWindow.getFocusedWindow(), ignoreCache),
        toggleDevTools,
        zoom,
        back: () => goBack(BrowserWindow.getFocusedWindow()),
        forward: () => goForward(BrowserWindow.getFocusedWindow()),
        openHelp: () => void shell.openExternal(DOCS_URL).catch(() => undefined),
        sendFeedback: () => sendFeedback(BrowserWindow.getFocusedWindow()),
      },
    );
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  };

  const installMenus = (): void => {
    buildMenu(false);
    let settingsDev = false;
    let signedInDev = false;
    let applied = false;
    const update = (): void => {
      const dev = settingsDev || signedInDev;
      if (dev === applied) return;
      applied = dev;
      buildMenu(dev);
      if (!dev && ctx.env.isPackaged) {
        for (const wc of webContentsModule.getAllWebContents()) {
          if (!wc.isDestroyed() && wc.isDevToolsOpened()) wc.closeDevTools();
        }
      }
    };
    void ctx.settings
      .get()
      .then((s) => {
        settingsDev = isDevFromSettings(s);
        update();
      })
      .catch(() => undefined);
    ctx.settings.onChanged((s) => {
      settingsDev = isDevFromSettings(s);
      update();
    });
    void ctx.auth
      .status()
      .then((s) => {
        signedInDev = s.status === "signed-in" && s.developer;
        update();
      })
      .catch(() => undefined);
    ctx.auth.onDeveloperChanged((d) => {
      signedInDev = d;
      update();
    });
    if (ctx.env.platform === "darwin" && app.dock) {
      app.dock.setMenu(Menu.buildFromTemplate(buildDockMenuTemplate(() => void createShellWindow())));
    }
  };

  const attachContextMenu = (wc: WebContents): void => {
    wc.on("context-menu", (_e, params: ContextMenuParams) => {
      const template = buildContextMenuTemplate(params, {
        replaceMisspelling: (w) => {
          if (!wc.isDestroyed()) wc.replaceMisspelling(w);
        },
        addToDictionary: (w) => {
          if (!wc.isDestroyed()) wc.session.addWordToSpellCheckerDictionary(w);
        },
      });
      if (!template) return;
      const win = windowOfLab(wc) ?? BrowserWindow.fromWebContents(wc) ?? BrowserWindow.getFocusedWindow() ?? undefined;
      Menu.buildFromTemplate(template).popup(win ? { window: win } : {});
    });
  };

  // --- background monitors (§4.9) -----------------------------------------------------------------

  const probePage = async (winId: number): Promise<"alive" | "dead" | "unknown"> => {
    const e = labs.get(winId);
    if (!e) return "unknown";
    const wc = e.view.webContents;
    if (wc.isDestroyed() || wc.isLoading() || now() - e.loadStartedAt < WATCHDOG_PAGE_MIN_AGE_MS) return "unknown";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      wc.executeJavaScript(PAGE_LIVENESS_SCRIPT).catch(() => undefined),
      new Promise<undefined>((r) => {
        timer = setTimeout(() => r(undefined), LAB_PROBE_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return normalizePageProbe(result);
  };
  const probeHealth = async (origin: string): Promise<"up" | "down" | "unknown"> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), LAB_PROBE_TIMEOUT_MS);
    try {
      const res = await doFetch(new URL("/healthz", origin).toString(), { signal: ac.signal });
      return classifyHealthStatus(res.status);
    } catch {
      return "unknown";
    } finally {
      clearTimeout(timer);
    }
  };

  const startBackgroundMonitors = (): void => {
    const dog = createWatchdog({
      now,
      revealed: revealedLabs,
      presence: (winId) => {
        const w = fromId(winId);
        if (!w) return false;
        const sheet = sheets.get(winId);
        const focused = w.isFocused() || !!(sheet && !sheet.isDestroyed() && sheet.isFocused());
        return watchdogPresence(focused, powerMonitor.getSystemIdleTime());
      },
      labOrigin: (winId) => {
        const e = labs.get(winId);
        if (!e) return null;
        try {
          return new URL(e.view.webContents.getURL()).origin;
        } catch {
          return null;
        }
      },
      isManaged: async (connId) => {
        try {
          const c = (await ctx.connections.list()).find((x) => x.id === connId);
          return !!c && c.routeMode === "managed";
        } catch {
          return false;
        }
      },
      probe: probeHealth,
      probePage,
      rewake: (winId, connId) => {
        markRecent("watchdog-rewake");
        const w = fromId(winId);
        if (w) rewake(w, connId);
      },
    });
    setInterval(() => void dog.tick(), WATCHDOG_TICK_MS).unref?.();
    app.on("browser-window-focus", () => {
      invalidateShown();
      void dog.tick();
    });

    let suspendedAt = 0;
    powerMonitor.on("suspend", () => {
      suspendedAt = now();
    });
    powerMonitor.on("resume", () => {
      const long = isLongSuspend(suspendedAt, now());
      suspendedAt = 0;
      setTimeout(() => {
        if (long) {
          try {
            ctx.updater.checkInBackground();
          } catch {
            /* optional */
          }
          for (const { winId, connId } of revealedLabs()) {
            const w = fromId(winId);
            if (w) rewake(w, connId);
          }
        }
        invalidateShown();
        void dog.tick();
      }, RESUME_ACTION_DELAY_MS).unref?.();
    });

    let active = true;
    app.on("did-become-active", () => {
      active = true;
      if (parked.size > 0) {
        const items = [...parked].map(([winId, p]) => ({ winId, ...p }));
        parked.clear();
        for (const { winId, connId, returnTo } of items) {
          const w = fromId(winId);
          if (w) rewake(w, connId, returnTo);
        }
      }
      try {
        ctx.lab.resumePendingReauths();
      } catch (err) {
        log("labview").warn("resumePendingReauths failed", err);
      }
    });
    app.on("did-resign-active", () => {
      active = false;
    });
    if (ctx.env.platform === "darwin") {
      setInterval(() => {
        if (active) return;
        void (async () => {
          const level = await readMemoryLevel();
          if (active || !shouldShedMemory(level)) return;
          const n = shedMemory();
          if (n > 0) log("memory").info(`shed ${n} backgrounded Lab view(s) at ${level}% available`);
        })();
      }, MEMORY_POLL_MS).unref?.();
    }
  };

  // --- bridge-facing --------------------------------------------------------------------------------

  const classifyFocusedWindow = (): { kind: FocusedWindowKind; connId: string | null } => {
    const f = BrowserWindow.getFocusedWindow();
    if (!f || f.isDestroyed()) return { kind: "none", connId: null };
    for (const s of sheets.values()) if (s === f) return { kind: "settings-sheet", connId: null };
    if (isShell(f)) {
      let signup = false;
      try {
        signup = ctx.signup.isOpen(f);
      } catch {
        signup = false;
      }
      if (signup) return { kind: "signup", connId: null };
      const e = labs.get(f.id);
      return e?.vis === "shown" ? { kind: "lab", connId: e.connId } : { kind: "app-shell", connId: null };
    }
    return { kind: "aux", connId: null };
  };

  const handleRecoverSession = async (event: IpcMainInvokeEvent): Promise<RecoverSessionResult> =>
    registry.handle(event.sender as unknown as RecoverableContents, event.senderFrame);

  // --- internals for IPC -----------------------------------------------------------------------------

  const internals: WindowInternals = {
    isInitialWindow: (win) => win !== null && win.id === initialWindowId,
    consumeInitialLastOpened: (win) => {
      if (!win || win.id !== initialWindowId || initialLastOpenedConsumed) return false;
      initialLastOpenedConsumed = true;
      return true;
    },
    lastOpenedGet: (account) => lastOpened.get(account),
    lastOpenedSet: (account, connId) => lastOpened.set(account, connId),
    setCompactFromRenderer: (sender, flag, contentHeight) => {
      if (sender.isDestroyed()) return;
      const win = BrowserWindow.fromWebContents(sender);
      if (flag && win && windowHoldsLab(labs.get(win.id), parked.has(win.id))) return;
      const h =
        typeof contentHeight === "number" && contentHeight > 0 ? contentHeight * sender.getZoomFactor() : undefined;
      compact.apply(win, !!flag, h);
    },
    heldElsewhere: (win) => {
      const out: string[] = [];
      for (const [id, e] of labs) if (id !== win?.id) out.push(e.connId);
      for (const [id, p] of parked) if (id !== win?.id) out.push(p.connId);
      return out;
    },
    focusHeld: (connId) => {
      if (typeof connId !== "string") return false;
      const w = windowForConn(connId);
      if (!w || w.isDestroyed()) return false;
      if (w.isMinimized()) w.restore();
      markCause("menu:navigate", "labs:focus-held");
      w.show();
      w.focus();
      reveal(w);
      return true;
    },
    hideByUser,
    goBack,
    goForward,
    viewerRetry: (win, deployment) => {
      const c = win && !win.isDestroyed() ? viewerControllers.get(win.id) : undefined;
      if (!c) return;
      const st = c.state();
      const chosen =
        typeof deployment === "string" && st.kind === "choose" && st.deployments.includes(deployment) ? deployment : undefined;
      c.recover(true, chosen);
    },
    markDialogOpen: (winId, open) => {
      if (open) dialogOpenFor.add(winId);
      else dialogOpenFor.delete(winId);
    },
    dialogIcon: appIcon,
  };

  // --- the service ---------------------------------------------------------------------------------------

  const service: WindowService = {
    createShellWindow,
    focusOrCreateShellWindow,
    ensureShellWindow: () => {
      if (liveShells().length === 0) createShellWindow({ initial: true });
    },
    isShellWindow: (w) => isShell(w),
    shellWindows: liveShells,
    primaryShellWindow,
    activateWindow: (win, cause) => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      markCause(cause);
      activateApp();
      win.focus();
      if (ctx.env.platform === "darwin" && win.isVisible()) win.showInactive();
    },
    broadcast: (channel, payload) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(channel, payload);
      }
    },
    broadcastToTrustedShells: (channel, payload) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed() && isTrustedShellWebContents(w.webContents)) w.webContents.send(channel, payload);
      }
    },
    applySignOut: (anchor) => {
      const root = anchor && !anchor.isDestroyed() ? (anchor.getParentWindow() ?? anchor) : null;
      const r = root && !root.isDestroyed() ? root : null;
      for (const w of [...auxWindows]) if (!w.isDestroyed()) w.close();
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.isDestroyed()) continue;
        if (!r || w === r || w.getParentWindow() === r) {
          sendShell(w.webContents, "auth:expired");
          plainHide(w);
        } else {
          w.close();
        }
      }
    },
    attachContextMenu,
    openLabInWindow,
    hideLabView: (win) => plainHide(win),
    revealIfHidden: (wc) => {
      const w = windowOfLab(wc);
      if (w) reveal(w);
    },
    findLab: (wc): LabRef | null => {
      const l = labOf(wc);
      if (!l) return null;
      const win = fromId(l.winId);
      return win ? { win, connId: l.entry.connId, shown: l.entry.vis === "shown", labOrigin: l.entry.labOrigin } : null;
    },
    windowForConn: (connId) => {
      const w = windowForConn(connId);
      return w && !w.isDestroyed() ? w : null;
    },
    labWebContentsForConn: (connId) => {
      for (const e of labs.values()) if (e.connId === connId) return e.view.webContents;
      return null;
    },
    shownLabWebContents: (win) => shownLabWc(win),
    viewerWebContents: (win) => viewerWc(win),
    onLabReady: (cb) => {
      readyHooks.add(cb);
      return () => {
        readyHooks.delete(cb);
      };
    },
    setReauthing: (win, reauthing) => {
      const e = labs.get(win.id);
      if (!e) return;
      e.reauthing = reauthing;
      if (!reauthing) e.userLeft = false;
    },
    waitForShellRenderer: async (win) => ({ reloaded: win.isDestroyed() ? false : await waitShell(win) }),
    resendLabOpened: (win) => resendOpened(win),
    currentLabReturnTo: (win) => {
      const e = labs.get(win.id);
      return !e || e.view.webContents.isDestroyed() ? null : labReturnTo(e.view.webContents.getURL());
    },
    destroyAllLabViews: destroyAllViews,
    invalidateShownViews: invalidateShown,
    handleRecoverSession,
    openDesktopSettingsFor: (wc) => {
      const w = windowOfLab(wc);
      if (w) openSettingsSheet(w, "settings:notifications");
    },
    openLabSwitcherFor: (wc) => {
      if (windowOfLab(wc)) createShellWindow({ compact: true });
    },
    classifyFocusedWindow,
    openSettingsSheet,
    navigateMenu,
    openShareViewer,
    installMenus,
    startBackgroundMonitors,
  };
  internalsByService.set(service, internals);
  return service;
}
