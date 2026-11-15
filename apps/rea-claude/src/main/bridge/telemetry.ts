/**
 * TelemetryService [bridge §4.9-4.10, platform §6.4]: `desktop_shell` event
 * queue (cap 100, transport-failure limiter, nudge one Lab) and the
 * `app_foreground` tracker (cause marks, recency markers, delivery to the
 * focused window's shown Lab).
 */
import { app, BrowserWindow, powerMonitor } from "electron";
import { ERROR_DETAILS_MAX, ERROR_STACK_MAX } from "@shared/config";
import { LabEventChannel } from "@shared/ipc";
import type { DesktopShellEvent, ForegroundEvent, ShellEventKind } from "@shared/ipc";
import { sendLab } from "../ipc/trust";
import type { MainContext, RecentMarker, TelemetryService } from "../services";
import { resolveDeps, type BridgeDeps } from "./deps";
import { ForegroundState, type ForegroundDraft } from "./foreground";
import { ShellEventQueue, TransportFailureLimiter } from "./shell-events";

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function createTelemetryServiceImpl(ctx: MainContext, deps?: BridgeDeps): TelemetryService {
  const { now } = resolveDeps(deps);
  const queue = new ShellEventQueue<DesktopShellEvent>();
  const limiter = new TransportFailureLimiter();
  const fg = new ForegroundState();
  let installed = false;

  const identity = (): { login?: string; sub?: string } => {
    const id = safe(() => ctx.auth.cachedIdentity(), null);
    return id ? { login: id.login, sub: id.sub } : {};
  };
  const stamp = () => ({
    build: safe(() => ctx.env.build, "unknown"),
    appVersion: safe(() => ctx.env.appVersion, "unknown"),
    platform: safe(() => ctx.env.platform as string, process.platform as string),
  });
  const log = (tag: string, obj: unknown): void => {
    safe(() => ctx.logger(tag).info(JSON.stringify(obj)), undefined);
  };

  /** One recipient: first window with a shown Lab, else first window with a viewer view. */
  const nudge = (): void => {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    const alive = <T extends { isDestroyed(): boolean } | null>(wc: T): boolean => !!wc && !wc.isDestroyed();
    const target =
      wins.map((w) => ctx.windows.shownLabWebContents(w)).find(alive) ??
      wins.map((w) => ctx.windows.viewerWebContents(w)).find(alive);
    if (target) sendLab(target, LabEventChannel.shellEventNudge);
  };

  const buildForeground = (d: ForegroundDraft): ForegroundEvent => {
    const focused = safe(() => ctx.windows.classifyFocusedWindow(), { kind: "none" as const, connId: null });
    const s = stamp();
    return {
      event: "app_foreground",
      cause: d.cause,
      details: d.details,
      stack: d.stack,
      msSinceResign: d.msSinceResign,
      systemIdleSeconds: safe(() => powerMonitor.getSystemIdleTime(), -1),
      focusedWindow: focused.kind,
      connId: focused.connId,
      recent: d.recent,
      build: s.build,
      appVersion: s.appVersion,
      platform: s.platform,
      ts: new Date(d.at).toISOString(),
      ...identity(),
    };
  };

  /** Log `[foreground] {json}` and send to the focused window's shown Lab only. */
  const emitForeground = (d: ForegroundDraft): void => {
    const evt = buildForeground(d);
    log("foreground", evt);
    try {
      const win = BrowserWindow.getFocusedWindow();
      const wc = win && !win.isDestroyed() ? ctx.windows.shownLabWebContents(win) : null;
      if (wc && !wc.isDestroyed()) sendLab(wc, LabEventChannel.foreground, evt);
    } catch {
      /* delivery is best effort */
    }
  };

  return {
    recordShellEvent(kind: ShellEventKind, opts = {}) {
      if (kind === "gateway-transport-failure" && !limiter.admit(opts.details, now())) return;
      const evt: DesktopShellEvent = {
        event: "desktop_shell",
        kind,
        ...(opts.connId ? { connId: opts.connId } : {}),
        ...(opts.details ? { details: opts.details } : {}),
        ...stamp(),
        ...identity(),
        ts: new Date(now()).toISOString(),
      };
      log("shell", evt);
      queue.push(evt);
      if (installed) {
        try {
          nudge();
        } catch {
          /* ignore */
        }
      }
    },
    drainShellEvents() {
      return queue.drain();
    },
    markCause(cause: string, details?: unknown) {
      fg.markCause(cause, details, new Error().stack, now());
    },
    markRecent(name: RecentMarker) {
      fg.markRecent(name, now());
    },
    installForegroundTracker() {
      if (installed) return;
      installed = true;
      app.on("did-resign-active", () => fg.onResignActive(now()));
      app.on("did-become-active", () => {
        const draft = fg.onBecomeActive(now());
        if (draft) emitForeground(draft);
      });
    },
    reportMainProcessError(err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("net::ERR_")) return;
      const stack = err instanceof Error ? err.stack?.slice(0, ERROR_STACK_MAX) : undefined;
      emitForeground(fg.onError(message.slice(0, ERROR_DETAILS_MAX), stack, now()));
    },
  };
}
