/**
 * Platform/app module entry (owner: I6).
 *
 * Owns: pre-ready bootstrap (launch guard, identity D1, disk-bundle relaunch,
 * single-instance lock, about panel, uncaughtException, web-contents-created,
 * child-process-gone, protocol registration D3, deep-link intake), app IPC
 * (ping, app:isDevBuild), move-to-Applications, dock icon, quit hooks,
 * activate / second-instance handling, AppEnv and logging.
 *
 * Environment variables read here (platform §6.2, renamed per D1/X6):
 * ELECTRON_RENDERER_URL, REA_CLAUDE_E2E_USER_DATA, SSLKEYLOGFILE (deleted in
 * packaged builds), REA_CLAUDE_REGISTER_PROTOCOL. The updater reads
 * REA_CLAUDE_UPDATE_URL and APPIMAGE; SHELL/PATH/SSH_AUTH_SOCK belong to ssh.
 */
import { join } from "node:path";
import { app, dialog, nativeImage } from "electron";
import { BUILD_STRING, ENV_RENDERER_URL } from "@shared/config";
import { ShellInvokeChannel } from "@shared/ipc";
import { handleShell } from "../ipc/trust";
import type { AppEnv, LoggerFactory, MainContext } from "../services";
// I6 owns both app/ and updater/: the disk-bundle relaunch is shared on purpose.
import { relaunchOntoDiskBundleIfNewer } from "../updater/bundle";
import { preReadyBootstrap } from "./bootstrap";
import type { PreReadyHost, PreReadyResult } from "./bootstrap";
import { isTestMode } from "./guards";
import { installLifecycle, offerMove } from "./lifecycle";
import type { LifecycleHost, MoveHost } from "./lifecycle";

export type { PreReadyResult } from "./bootstrap";

/**
 * Dev-server renderer URL: honored only in unpackaged builds, so a packaged app
 * can never be pointed at an arbitrary origin through the environment (X17).
 */
export function resolveRendererUrl(
  env: Readonly<Record<string, string | undefined>>,
  isPackaged: boolean,
): string | undefined {
  if (isPackaged) return undefined;
  const v = env[ENV_RENDERER_URL];
  return v ? v : undefined;
}

/** Build the AppEnv (no side effects; paths are resolved lazily). */
export function createAppEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  isPackaged: boolean = app.isPackaged,
): AppEnv {
  return {
    isPackaged,
    isTestMode: isTestMode(env),
    platform: process.platform,
    appVersion: app.getVersion(),
    build: BUILD_STRING,
    rendererUrl: resolveRendererUrl(env, isPackaged),
    userDataPath: () => app.getPath("userData"),
    preloadPath: (name) => join(__dirname, "../preload", `${name}.js`),
    rendererHtmlPath: () => join(__dirname, "../renderer/index.html"),
    // Packaged: copied by electron-builder `extraResources`; dev: the repo's resources/.
    iconPath: () =>
      isPackaged ? join(process.resourcesPath, "icon.png") : join(app.getAppPath(), "resources", "icon.png"),
  };
}

type ConsoleLike = Pick<Console, "debug" | "log" | "warn" | "error">;

/** Console logger factory with `[tag]` prefixes (platform §6.4). */
export function createLoggerFactory(out: ConsoleLike = console): LoggerFactory {
  return (tag) => ({
    debug: (...a) => out.debug(`[${tag}]`, ...a),
    info: (...a) => out.log(`[${tag}]`, ...a),
    warn: (...a) => out.warn(`[${tag}]`, ...a),
    error: (...a) => out.error(`[${tag}]`, ...a),
  });
}

function electronPreReadyHost(ctx: MainContext): PreReadyHost {
  return {
    isPackaged: app.isPackaged,
    argv: process.argv,
    env: process.env,
    hasSwitch: (s) => app.commandLine.hasSwitch(s),
    processExit: (code) => process.exit(code),
    appExit: (code) => app.exit(code),
    setName: (n) => app.setName(n),
    getAppDataPath: () => app.getPath("appData"),
    setUserDataPath: (p) => app.setPath("userData", p),
    setAppUserModelId: (id) => app.setAppUserModelId(id),
    appVersion: app.getVersion(),
    relaunchIfDiskBundleNewer: (reason) =>
      relaunchOntoDiskBundleIfNewer(
        reason,
        {
          platform: process.platform,
          isPackaged: app.isPackaged,
          execPath: process.execPath,
          runningVersion: app.getVersion(),
          argv: process.argv,
        },
        {
          relaunch: (args) => app.relaunch({ args }),
          exit: (code) => app.exit(code),
          log: (m) => ctx.logger("updater").info(m),
        },
      ),
    requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
    setAboutPanelOptions: (o) => app.setAboutPanelOptions(o),
    onUncaughtException: (h) => void process.on("uncaughtException", h),
    showErrorBox: (t, c) => dialog.showErrorBox(t, c),
    onWebContentsCreated: (h) => void app.on("web-contents-created", (_e, wc) => h(wc)),
    onChildProcessGone: (h) => void app.on("child-process-gone", (_e, d) => h(d)),
    setAsDefaultProtocolClient: (s) => app.setAsDefaultProtocolClient(s),
    onOpenUrl: (h) => void app.on("open-url", (e, url) => h(e, url)),
    onSecondInstance: (h) => void app.on("second-instance", (_e, argv) => h(argv)),
    isReady: () => app.isReady(),
    setTimeout: (fn, ms) => void setTimeout(fn, ms).unref(),
    stderr: (line) => console.error(line),
  };
}

/**
 * Module-load bootstrap (platform §6.1 "Module load" steps 1-12), run before
 * `app.whenReady()`. `host` is injectable for tests.
 */
export function runPreReadyBootstrap(ctx: MainContext, host?: PreReadyHost): PreReadyResult {
  return preReadyBootstrap(ctx, host ?? electronPreReadyHost(ctx));
}

/** ping, app:isDevBuild. */
export function registerAppIpc(ctx: MainContext): void {
  handleShell(ShellInvokeChannel.ping, () => "pong" as const);
  handleShell(ShellInvokeChannel.appIsDevBuild, () => !ctx.env.isPackaged);
}

/** whenReady step 6: macOS offer to move to /Applications (skipped in test mode). */
export function offerMoveToApplications(ctx: MainContext, host?: MoveHost): void {
  offerMove(
    ctx,
    host ?? {
      platform: ctx.env.platform,
      isPackaged: ctx.env.isPackaged,
      testMode: ctx.env.isTestMode,
      isInApplicationsFolder: () => app.isInApplicationsFolder(),
      showMessageBoxSync: (o) => dialog.showMessageBoxSync(o),
      moveToApplicationsFolder: (o) => app.moveToApplicationsFolder(o),
    },
  );
}

/** whenReady step 7: macOS dock icon (skipped when the PNG is missing). */
export function applyDockIcon(ctx: MainContext): void {
  if (ctx.env.platform !== "darwin" || !app.dock) return;
  const img = nativeImage.createFromPath(ctx.env.iconPath());
  if (!img.isEmpty()) app.dock.setIcon(img);
}

/** whenReady step 16 + quit: activate, window-all-closed, before-quit (kill tunnels). */
export function installAppLifecycleHooks(ctx: MainContext, host?: LifecycleHost): void {
  installLifecycle(
    ctx,
    host ?? {
      platform: ctx.env.platform,
      on: (event, listener) => void app.on(event as "activate", listener),
      quit: () => app.quit(),
    },
  );
}
