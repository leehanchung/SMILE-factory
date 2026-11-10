/**
 * BridgeService [bridge §4.2, §4.3, §5]: native notifications from Labs,
 * aggregated dock/taskbar badge, permission handlers and the TLS verify proc.
 *
 * Internals used by `registerBridgeIpc` (notify / badge handlers, hook
 * installation) are kept in a WeakMap keyed by the context so the public
 * `BridgeService` interface stays exactly as frozen in services.ts.
 */
import { app, BrowserWindow, dialog, Notification, session } from "electron";
import type { WebContents } from "electron";
import { LAB_PARTITION, NOTIFY_HOLD_MS, SIGNUP_PARTITION } from "@shared/config";
import { LabEventChannel } from "@shared/ipc";
import type { BadgeCounts } from "@shared/ipc";
import { sendLab } from "../ipc/trust";
import type { BridgeService, MainContext } from "../services";
import { aggregateBadge, badgeActionFor, parseBadge } from "./badge";
import { resolveDeps, type BridgeDeps, type ResolvedDeps } from "./deps";
import {
  Batcher,
  Deduper,
  parseNotify,
  suppressedByFocus,
  suppressedBySettings,
  type NotificationRequest,
} from "./notify";
import {
  createPermissionCheckHandler,
  createPermissionRequestHandler,
  MicGrants,
  sameOrigin,
  type CheckDetailsLike,
  type PermissionDeps,
  type RequestDetailsLike,
} from "./permissions";
import { certificateVerdict, type VerifyRequestLike } from "./tls";

export interface BridgeInternals {
  /** `silico:notify` from a Lab-trusted sender. */
  handleNotify(sender: WebContents, payload: unknown): Promise<void>;
  /** `silico:badge-counts` from a Lab-trusted sender. */
  handleBadgeCounts(sender: WebContents, payload: unknown): void;
  /** Lab-ready hook (pending navigate), window-closed + settings-changed badge recompute. Idempotent. */
  installHooks(): void;
  /** Resolves when every queued badge recompute has run (tests). */
  badgeSettled(): Promise<void>;
  /** Current per-connId counts (tests / diagnostics). */
  badgeCounts(): ReadonlyMap<string, BadgeCounts>;
  /** Pending notification routes by connId (tests / diagnostics). */
  pendingRoutes(): ReadonlyMap<string, string>;
}

const internalsByCtx = new WeakMap<MainContext, BridgeInternals>();

export function bridgeInternals(ctx: MainContext): BridgeInternals {
  const i = internalsByCtx.get(ctx);
  if (!i) throw new Error("bridge internals missing: createBridgeService(ctx) was not called with this context");
  return i;
}

type Req = NotificationRequest<WebContents>;


export function createBridgeServiceImpl(ctx: MainContext, deps?: BridgeDeps): BridgeService {
  const d: ResolvedDeps = resolveDeps(deps);
  const log = (): ReturnType<MainContext["logger"]> => ctx.logger("bridge");

  // ---------------------------------------------------------------- notify
  const deduper = new Deduper();
  const live = new Set<Electron.Notification>();
  const pendingNavigate = new Map<string, string>();
  let batcher: Batcher<WebContents> | null = null;

  const focusWindow = (win: BrowserWindow, connId: string | null): void => {
    ctx.telemetry.markCause("notification-click", connId ?? undefined);
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    app.focus({ steal: true });
  };

  const onClick = (req: Req): void => {
    const sender = req.senderWc;
    const target: WebContents | null = !sender.isDestroyed()
      ? sender
      : req.connId
        ? ctx.windows.labWebContentsForConn(req.connId)
        : null;
    const win = (target ? (ctx.windows.findLab(target)?.win ?? null) : null) ?? (req.connId ? ctx.windows.windowForConn(req.connId) : null);
    if (win && !win.isDestroyed()) focusWindow(win, req.connId);
    if (target && !target.isDestroyed()) {
      ctx.windows.revealIfHidden(target);
      sendLab(target, LabEventChannel.navigate, req.route);
    } else if (req.connId) {
      pendingNavigate.set(req.connId, req.route); // latest wins, no TTL
    }
  };

  const show = (req: Req): void => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: req.title, body: req.body, silent: !req.sound });
    live.add(n); // strong reference until close, click or 60 s
    const release = (): void => {
      live.delete(n);
    };
    n.on("close", release);
    n.on("click", () => {
      release();
      try {
        onClick(req);
      } catch (err) {
        log().warn("notification click failed", err);
      }
    });
    d.setTimeout(release, NOTIFY_HOLD_MS);
    ctx.telemetry.markRecent("notification-shown");
    n.show();
  };

  const getBatcher = (): Batcher<WebContents> => {
    batcher ??= new Batcher<WebContents>(show, { setTimeout: d.setTimeout, clearTimeout: d.clearTimeout });
    return batcher;
  };

  // ---------------------------------------------------------------- badge
  const counts = new Map<string, BadgeCounts>();
  const watched = new WeakSet<WebContents>();
  let chain: Promise<void> = Promise.resolve();

  const prune = (): void => {
    for (const connId of [...counts.keys()]) if (!ctx.windows.windowForConn(connId)) counts.delete(connId);
  };
  const applyBadge = async (): Promise<void> => {
    const s = (await ctx.settings.get()).notifications;
    const action = badgeActionFor(ctx.env.platform, aggregateBadge(counts.values(), s));
    if (action.kind === "dock") app.dock?.setBadge(action.text);
    else if (action.kind === "count") app.setBadgeCount(action.count);
  };
  const recompute = (): void => {
    const run = (): Promise<void> =>
      applyBadge().catch((err: unknown) => {
        log().warn("badge recompute failed", err);
      });
    chain = chain.then(run, run);
  };

  // ---------------------------------------------------------------- permissions
  /** Lab origin tracked by windows (origin of the URL given to openLabInWindow); null → deny. */
  const labOriginOf = (wc: WebContents): string | null => ctx.windows.findLab(wc)?.labOrigin ?? null;
  /** `Dn`: focused window whose shown Lab is `wc`, both URLs same-origin as the Lab. */
  const focusedLabWindowFor = (wc: WebContents, url: string | undefined): BrowserWindow | null => {
    if (!wc || wc.isDestroyed()) return null;
    const win = BrowserWindow.getFocusedWindow();
    if (!win || win.isDestroyed()) return null;
    if (ctx.windows.shownLabWebContents(win) !== wc) return null;
    const labOrigin = labOriginOf(wc);
    if (!labOrigin) return null;
    if (!sameOrigin(url, labOrigin) || !sameOrigin(wc.getURL(), labOrigin)) return null;
    return win;
  };
  const grants = new MicGrants<WebContents>();

  // ---------------------------------------------------------------- hooks
  let hooksInstalled = false;

  const internals: BridgeInternals = {
    async handleNotify(sender, payload) {
      const n = parseNotify(payload);
      if (!n) return;
      const s = (await ctx.settings.get()).notifications;
      if (suppressedBySettings(n, s)) return;
      const ref = ctx.windows.findLab(sender);
      const focus = {
        windowFocused: !!ref && !ref.win.isDestroyed() && ref.win.isFocused(),
        labShown: !!ref?.shown,
      };
      if (suppressedByFocus(n, focus, s)) return;
      if (deduper.isDuplicate(n.dedupeKey, d.now())) return;
      const req: Req = {
        title: n.title,
        body: n.body,
        route: n.route,
        senderWc: sender,
        connId: ref?.connId ?? null,
        sound: s.sound,
      };
      if (n.kind === "finished") getBatcher().push(req);
      else show(req);
    },

    handleBadgeCounts(sender, payload) {
      const parsed = parseBadge(payload);
      if (!parsed) return;
      const connId = ctx.windows.findLab(sender)?.connId ?? null;
      if (!connId) return;
      counts.set(connId, parsed);
      if (!watched.has(sender)) {
        watched.add(sender);
        sender.once("destroyed", () => {
          d.setTimeout(() => {
            prune();
            recompute();
          }, 0);
        });
      }
      recompute();
    },

    installHooks() {
      if (hooksInstalled) return;
      hooksInstalled = true;
      ctx.windows.onLabReady((connId, wc) => {
        const route = pendingNavigate.get(connId);
        if (route === undefined) return;
        pendingNavigate.delete(connId);
        sendLab(wc, LabEventChannel.navigate, route);
      });
      app.on("browser-window-created", (_e, win) => {
        win.on("closed", () => {
          prune();
          recompute();
        });
      });
      ctx.settings.onChanged(() => recompute());
    },

    badgeSettled: () => chain,
    badgeCounts: () => counts,
    pendingRoutes: () => pendingNavigate,
  };

  const service: BridgeService = {
    installCertificateVerifier() {
      const proc = (req: Electron.Request, cb: (verdict: number) => void): void => {
        cb(certificateVerdict(req as unknown as VerifyRequestLike));
      };
      const install = (s: Electron.Session): void => s.setCertificateVerifyProc(proc);
      app.on("session-created", install);
      for (const s of [session.defaultSession, session.fromPartition(LAB_PARTITION), session.fromPartition(SIGNUP_PARTITION)]) {
        install(s);
      }
    },

    installPermissionHandlers() {
      for (const partition of [LAB_PARTITION, SIGNUP_PARTITION]) {
        const pdeps: PermissionDeps<WebContents, BrowserWindow> = {
          isLabPartition: partition === LAB_PARTITION,
          focusedLabWindowFor,
          getURL: (wc) => wc.getURL(),
          isDestroyed: (wc) => wc.isDestroyed(),
          showDialog: (win, opts) => dialog.showMessageBox(win, opts),
        };
        const onRequest = createPermissionRequestHandler(pdeps, grants);
        const onCheck = createPermissionCheckHandler(pdeps, grants);
        const s = session.fromPartition(partition);
        s.setPermissionRequestHandler((wc, permission, callback, details) =>
          onRequest(wc, permission, callback, details as unknown as RequestDetailsLike),
        );
        s.setPermissionCheckHandler((wc, permission, requestingOrigin, details) =>
          onCheck(wc, permission, requestingOrigin, details as unknown as CheckDetailsLike),
        );
      }
    },

    clearBadgeCounts() {
      counts.clear();
      recompute();
    },
  };

  internalsByCtx.set(ctx, internals);
  return service;
}
