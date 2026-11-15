/**
 * Updater module entry (owner: I6).
 *
 * electron-updater wiring (generic provider from REA_CLAUDE_UPDATE_URL only,
 * decision D4), state machine, dialogs, exit marker, updater.log, and the
 * update:get-state / update:install IPC. While disabled: state is
 * `{phase:"idle", currentVersion}`, install is a no-op, no timers run, and
 * the menu's "Check for Updates…" explains why.
 *
 * Electron and electron-updater are only touched lazily (inside methods), so
 * `createUpdaterService` stays side-effect free.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, app, autoUpdater as nativeAutoUpdater, dialog, nativeImage, net, shell } from "electron";
import type { MessageBoxOptions } from "electron";
import {
  ENV_UPDATE_URL,
  FILE_UPDATE_EXIT_MARKER,
  FILE_UPDATER_LOG,
  UPDATER_CACHE_DIR_NAME,
  UPDATE_LATEST_YML_TIMEOUT_MS,
} from "@shared/config";
import { ShellInvokeChannel } from "@shared/ipc";
import { handleShell } from "../ipc/trust";
import type { MainContext, UpdaterService } from "../services";
import { bundleParentDir, parentDirAccess, relaunchOntoDiskBundleIfNewer, shipItLogTail } from "./bundle";
import type { BundleEnv } from "./bundle";
import { createUpdaterController } from "./controller";
import type { NativeUpdater, UpdaterBackend, UpdaterController, UpdaterControllerDeps } from "./controller";
import { appUpdateYml, normalizeFeedUrl, parseYamlVersion, selfUpdateSupported } from "./decisions";
import { createUpdaterLog } from "./log";
import { createExitMarkerStore } from "./marker";

export interface UpdaterDeps {
  /** Build the controller from custom deps (tests). Receives the default deps to override. */
  controller?: (defaults: () => UpdaterControllerDeps) => UpdaterController;
  /** Process environment (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Resolved enablement inputs (D4). Exposed for tests. */
export function resolveUpdaterConfig(i: {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
}): { isPackaged: boolean; supported: boolean; feedUrl: string | null; enabled: boolean } {
  const supported = selfUpdateSupported(i.platform, i.env);
  const feedUrl = normalizeFeedUrl(i.env[ENV_UPDATE_URL]);
  return { isPackaged: i.isPackaged, supported, feedUrl, enabled: i.isPackaged && supported && feedUrl !== null };
}

function electronBackend(
  ctx: MainContext,
  feedUrl: string,
  logger: ReturnType<typeof createUpdaterLog>,
): UpdaterBackend {
  // Imported lazily: electron-updater instantiates the platform updater on first access.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { autoUpdater } = require("electron-updater") as typeof import("electron-updater");
  autoUpdater.logger = logger.electronLogger;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // No baked app-update.yml (electron-builder.yml has no publish config): write
  // one so electron-updater uses the generic feed and the X6 cache dir.
  const configPath = join(ctx.env.userDataPath(), "app-update.yml");
  writeFileSync(configPath, appUpdateYml(feedUrl, UPDATER_CACHE_DIR_NAME));
  autoUpdater.updateConfigPath = configPath;
  autoUpdater.setFeedURL({ provider: "generic", url: feedUrl, useMultipleRangeRequest: false });
  return {
    onChecking: (cb) => void autoUpdater.on("checking-for-update", cb),
    onNotAvailable: (cb) => void autoUpdater.on("update-not-available", () => cb()),
    onAvailable: (cb) => void autoUpdater.on("update-available", (info) => cb(info.version)),
    onProgress: (cb) => void autoUpdater.on("download-progress", (p) => cb(p.percent)),
    onDownloaded: (cb) => void autoUpdater.on("update-downloaded", (info) => cb(info.version)),
    onError: (cb) => void autoUpdater.on("error", (err) => cb(err)),
    checkForUpdates: () => autoUpdater.checkForUpdates(),
    quitAndInstall: () => autoUpdater.quitAndInstall(),
  };
}

function electronNative(): NativeUpdater {
  return {
    onDownloaded: (cb) => void nativeAutoUpdater.on("update-downloaded", () => cb()),
    onceDownloaded: (cb) => void nativeAutoUpdater.once("update-downloaded", () => cb()),
    onceError: (cb) => void nativeAutoUpdater.once("error", () => cb()),
    checkForUpdates: () => nativeAutoUpdater.checkForUpdates(),
  };
}

function defaultDeps(ctx: MainContext, env: Readonly<Record<string, string | undefined>>): UpdaterControllerDeps {
  const cfg = resolveUpdaterConfig({ isPackaged: ctx.env.isPackaged, platform: ctx.env.platform, env });
  const tagged = ctx.logger("updater");
  const updaterLog = createUpdaterLog({
    path: () => join(ctx.env.userDataPath(), FILE_UPDATER_LOG),
    console: (_tag, line) => tagged.info(line),
  });
  const log = updaterLog.log;
  const bundleEnv = (): BundleEnv => ({
    platform: ctx.env.platform,
    isPackaged: ctx.env.isPackaged,
    execPath: process.execPath,
    runningVersion: ctx.env.appVersion,
    argv: process.argv,
  });
  let backend: UpdaterBackend | null = null;
  let native: NativeUpdater | null = null;
  return {
    platform: ctx.env.platform,
    isPackaged: cfg.isPackaged,
    supported: cfg.supported,
    feedUrl: cfg.feedUrl,
    currentVersion: ctx.env.appVersion,
    now: () => Date.now(),
    log,
    broadcast: (state) => ctx.windows.broadcast("update:state", state),
    showMessageBox: async (opts) => {
      const icon = nativeImage.createFromPath(ctx.env.iconPath());
      const full: MessageBoxOptions = { ...(icon.isEmpty() ? {} : { icon }), ...opts };
      const parent = BrowserWindow.getFocusedWindow();
      const r = parent ? await dialog.showMessageBox(parent, full) : await dialog.showMessageBox(full);
      return { response: r.response };
    },
    hasFocusedWindow: () => BrowserWindow.getFocusedWindow() !== null,
    onceWindowFocus: (cb) => void app.once("browser-window-focus", () => cb()),
    openExternal: (url) => void shell.openExternal(url),
    locationAccess: () => parentDirAccess(process.execPath),
    locationPath: () => bundleParentDir(process.execPath),
    relaunchIfDiskBundleNewer: (reason) =>
      relaunchOntoDiskBundleIfNewer(reason, bundleEnv(), {
        relaunch: (args) => app.relaunch({ args }),
        exit: (code) => app.exit(code),
        log,
      }),
    relaunch: () => app.relaunch(),
    exit: (code) => app.exit(code),
    fetchFeedVersion: async () => {
      if (!cfg.feedUrl) return null;
      try {
        const res = await net.fetch(`${cfg.feedUrl}/latest-mac.yml`, {
          cache: "no-store",
          signal: AbortSignal.timeout(UPDATE_LATEST_YML_TIMEOUT_MS),
        });
        return res.ok ? parseYamlVersion(await res.text()) : null;
      } catch {
        return null;
      }
    },
    shipItLogTail: () => shipItLogTail(bundleEnv()),
    marker: createExitMarkerStore({ path: () => join(ctx.env.userDataPath(), FILE_UPDATE_EXIT_MARKER), log }),
    onBeforeQuit: (cb) => void app.on("before-quit", () => cb()),
    killAllTunnels: () => ctx.lab.killAllTunnels(),
    destroyAllLabViews: () => ctx.windows.destroyAllLabViews(),
    destroyAllWindows: () => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.destroy();
    },
    backend: () => {
      if (!backend) {
        if (!cfg.feedUrl) throw new Error("updater backend requested while disabled");
        backend = electronBackend(ctx, cfg.feedUrl, updaterLog);
      }
      return backend;
    },
    native: () => (native ??= electronNative()),
  };
}

export function createUpdaterService(ctx: MainContext, deps?: UpdaterDeps): UpdaterService {
  let controller: UpdaterController | null = null;
  // Built on first use: ctx.env/ctx.logger may not be readable at create time in tests.
  const c = (): UpdaterController => {
    if (!controller) {
      const defaults = (): UpdaterControllerDeps => defaultDeps(ctx, deps?.env ?? process.env);
      controller = deps?.controller ? deps.controller(defaults) : createUpdaterController(defaults());
    }
    return controller;
  };
  const report = (label: string) => (err: unknown) => ctx.logger("updater").error(`${label} failed`, err);
  return {
    isEnabled: () => c().isEnabled(),
    getState: () => c().getState(),
    install: () => void c().install().catch(report("install")),
    start: () => {
      const ctl = c();
      if (!ctl.isEnabled()) {
        ctx.logger("updater").info(`self-update disabled (set ${ENV_UPDATE_URL} in a packaged build to enable)`);
        return;
      }
      // Never let updater wiring failures (e.g. unwritable app-update.yml) abort whenReady.
      try {
        ctl.start();
      } catch (err) {
        report("start")(err);
      }
    },
    checkInBackground: () => void c().check().catch(report("check")),
    userCheck: () => void c().userCheck().catch(report("userCheck")),
  };
}

export function registerUpdaterIpc(ctx: MainContext): void {
  handleShell(ShellInvokeChannel.updateGetState, () => ctx.updater.getState());
  handleShell(ShellInvokeChannel.updateInstall, () => ctx.updater.install());
}
