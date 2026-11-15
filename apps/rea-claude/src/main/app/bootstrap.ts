/**
 * Module-load bootstrap (platform §6.1 "Module load" steps 1-12), written
 * against an injected Electron/process surface so every branch is testable.
 */
import { join } from "node:path";
import {
  APP_ID,
  BUILD_STRING,
  FORBIDDEN_SWITCH_EXIT_CODE,
  GPU_GONE_INVALIDATE_DELAY_MS,
  PRODUCT_NAME,
  PROTOCOL_SCHEME,
} from "@shared/config";
import type { MainContext } from "../services";
import {
  forbiddenSwitch,
  forbiddenSwitchMessage,
  isAbnormalGpuExit,
  isIgnorableMainError,
  isTestMode,
  shouldRegisterProtocol,
  userDataPathFor,
} from "./guards";

interface Preventable {
  preventDefault(): void;
}

export interface WebContentsLike {
  on(event: "will-prevent-unload", listener: (e: Preventable) => void): unknown;
}

/** The subset of `app`, `process` and `dialog` used before ready. */
export interface PreReadyHost {
  isPackaged: boolean;
  argv: readonly string[];
  env: Record<string, string | undefined>;
  hasSwitch(name: string): boolean;
  /** `process.exit` (hard exit, used for the launch guard). */
  processExit(code: number): void;
  /** `app.exit`. */
  appExit(code: number): void;
  setName(name: string): void;
  getAppDataPath(): string;
  setUserDataPath(path: string): void;
  setAppUserModelId(id: string): void;
  appVersion: string;
  /** `En` at module load; true when it relaunched (process exiting). Errors are swallowed by the caller. */
  relaunchIfDiskBundleNewer(reason: string): boolean;
  requestSingleInstanceLock(): boolean;
  setAboutPanelOptions(opts: { applicationName: string; applicationVersion: string; version: string }): void;
  onUncaughtException(handler: (err: unknown) => void): void;
  showErrorBox(title: string, content: string): void;
  onWebContentsCreated(handler: (wc: WebContentsLike) => void): void;
  onChildProcessGone(handler: (details: { type: string; reason: string; exitCode: number }) => void): void;
  setAsDefaultProtocolClient(scheme: string): boolean;
  onOpenUrl(handler: (e: Preventable, url: string) => void): void;
  onSecondInstance(handler: (argv: readonly string[]) => void): void;
  isReady(): boolean;
  setTimeout(fn: () => void, ms: number): void;
  stderr(line: string): void;
}

export interface PreReadyResult {
  /** False when another instance holds the single-instance lock (app is exiting). */
  gotLock: boolean;
}

export function preReadyBootstrap(ctx: MainContext, host: PreReadyHost): PreReadyResult {
  const testMode = isTestMode(host.env);
  const log = ctx.logger("app");

  // 1. Launch guard: refuse switches that would expose the sign-in (exit 78).
  const sw = forbiddenSwitch({ isPackaged: host.isPackaged, testMode, hasSwitch: (s) => host.hasSwitch(s) });
  if (sw) {
    host.stderr(forbiddenSwitchMessage(sw));
    host.processExit(FORBIDDEN_SWITCH_EXIT_CODE);
    return { gotLock: false };
  }

  // 2. Never let a packaged build dump TLS keys.
  if (host.isPackaged) delete host.env.SSLKEYLOGFILE;

  // 3-4. Identity (D1): name, userData (never the real Silico's), AUMID.
  host.setName(PRODUCT_NAME);
  host.setUserDataPath(userDataPathFor(host.getAppDataPath(), host.env, join));
  host.setAppUserModelId(APP_ID);

  // 5. Relaunch onto a newer bundle on disk (errors swallowed).
  try {
    if (host.relaunchIfDiskBundleNewer(`bundle on disk is not the running build (running ${host.appVersion}) — relaunching into it`)) {
      return { gotLock: false };
    }
  } catch {
    /* ignore */
  }

  // 6. Single-instance lock (packaged only; dev builds allow multiple instances).
  const gotLock = !host.isPackaged || host.requestSingleInstanceLock();
  if (!gotLock) {
    host.appExit(0);
    return { gotLock: false };
  }

  // 7. About panel.
  host.setAboutPanelOptions({ applicationName: PRODUCT_NAME, applicationVersion: host.appVersion, version: BUILD_STRING });

  // 8. Uncaught exceptions (no unhandledRejection handler, as in the original).
  host.onUncaughtException((err) => {
    if (isIgnorableMainError(err)) {
      console.error("Ignoring async network-stack error:", err instanceof Error ? err.message : String(err));
      return;
    }
    console.error("Uncaught exception in the main process:", err);
    try {
      ctx.telemetry.reportMainProcessError(err);
    } catch {
      /* telemetry must not mask the dialog */
    }
    try {
      host.showErrorBox(
        "A JavaScript error occurred in the main process",
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      );
    } catch {
      /* dialog unavailable (e.g. before ready on some platforms) */
    }
  });

  // 9. Every webContents: ignore beforeunload, attach the context menu.
  host.onWebContentsCreated((wc) => {
    wc.on("will-prevent-unload", (e) => e.preventDefault());
    try {
      ctx.windows.attachContextMenu(wc as never);
    } catch (err) {
      log.warn("context menu attach failed", err);
    }
  });

  // 10. GPU process gone → repaint shown views 1 s later.
  host.onChildProcessGone((details) => {
    if (!isAbnormalGpuExit(details)) return;
    log.error(`GPU process gone (${details.reason}, exit ${details.exitCode})`);
    host.setTimeout(() => {
      try {
        ctx.windows.invalidateShownViews();
      } catch (err) {
        log.warn("invalidateShownViews failed", err);
      }
    }, GPU_GONE_INVALIDATE_DELAY_MS);
  });

  // 11. Protocol registration (D3): opt-in only, so the real Silico is not hijacked.
  if (shouldRegisterProtocol(host.isPackaged, host.env)) {
    const ok = host.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
    log.info(`registered as default ${PROTOCOL_SCHEME}:// handler: ${ok}`);
  }

  // 12. Deep-link intake: always routed internally (ctx.deepLinks stashes until ready).
  const fromArgv = ctx.deepLinks.findInArgv(host.argv);
  if (fromArgv) ctx.deepLinks.handle(fromArgv);
  host.onOpenUrl((e, url) => {
    e.preventDefault();
    ctx.deepLinks.handle(url);
  });
  host.onSecondInstance((argv) => {
    const link = ctx.deepLinks.findInArgv(argv);
    if (link) {
      ctx.deepLinks.handle(link);
      return;
    }
    if (!host.isReady()) return;
    ctx.windows.focusOrCreateShellWindow("second-instance");
  });

  return { gotLock: true };
}
