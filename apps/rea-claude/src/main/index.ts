/**
 * Main-process bootstrap. Skeleton by the architect; final wiring owned by I6.
 *
 * Order follows platform spec §6.1. Phases:
 *   A. create the lazy context and every service (side-effect free)
 *   B. module-load bootstrap (pre-ready): guards, identity (D1), lock, hooks
 *   C. whenReady sequence (steps 1-21 below, numbered as in the spec)
 */
import { app } from "electron";
import { configureShellTrust } from "./ipc/trust";
import { createMainContext } from "./services";
import {
  applyDockIcon,
  createAppEnv,
  createLoggerFactory,
  installAppLifecycleHooks,
  offerMoveToApplications,
  registerAppIpc,
  runPreReadyBootstrap,
} from "./app";
import { createSettingsService, registerSettingsIpc } from "./settings";
import { createUpdaterService, registerUpdaterIpc } from "./updater";
import { createBridgeService, createTelemetryService, registerBridgeIpc } from "./bridge";
import {
  createAuthService,
  createDeepLinkService,
  createReturnsService,
  createSignupService,
  registerAuthIpc,
} from "./auth";
import { createConnectionsService, registerConnectionsIpc } from "./connections";
import { createSshService, registerSshIpc } from "./ssh";
import { createLabLifecycleService, registerLabIpc } from "./lab";
import { createWindowService, registerWindowsIpc } from "./windows";

// --- A. context + services (no side effects; order irrelevant thanks to lazy getters)
const builder = createMainContext();
const { ctx } = builder;
builder.provide("env", createAppEnv());
// Shell IPC trust: the app's own renderer index.html (or the dev server, unpackaged only).
// Resolved once, before any IPC registration or window creation.
configureShellTrust({ rendererUrl: ctx.env.rendererUrl, rendererHtmlPath: ctx.env.rendererHtmlPath() });
builder.provide("logger", createLoggerFactory());
builder.provide("settings", createSettingsService(ctx));
builder.provide("telemetry", createTelemetryService(ctx));
builder.provide("auth", createAuthService(ctx));
builder.provide("signup", createSignupService(ctx));
builder.provide("deepLinks", createDeepLinkService(ctx));
builder.provide("returns", createReturnsService(ctx));
builder.provide("connections", createConnectionsService(ctx));
builder.provide("ssh", createSshService(ctx));
builder.provide("lab", createLabLifecycleService(ctx));
builder.provide("windows", createWindowService(ctx));
builder.provide("bridge", createBridgeService(ctx));
builder.provide("updater", createUpdaterService(ctx));

const missing = builder.missing();
if (missing.length > 0) throw new Error(`services not provided: ${missing.join(", ")}`);

// --- B. module-load bootstrap (platform §6.1 "Module load" 1-12)
const { gotLock } = runPreReadyBootstrap(ctx);

// --- C. whenReady (platform §6.1 "app.whenReady()" 1-21)
if (gotLock) {
  void app.whenReady().then(() => {
    ctx.bridge.installCertificateVerifier(); // 1. TLS verify proc on all sessions
    void ctx.ssh.ensureShellEnv(); // 2. login-shell env import (not awaited)
    ctx.telemetry.installForegroundTracker(); // 3-4. foreground events + shell-event nudge sink
    ctx.bridge.installPermissionHandlers(); // 5. permissions (persist:silico, persist:silico-signup)
    offerMoveToApplications(ctx); // 6. macOS move-to-Applications (skipped in test mode)
    applyDockIcon(ctx); // 7. dock icon
    // 8. IPC registration
    registerAppIpc(ctx);
    registerSettingsIpc(ctx);
    registerUpdaterIpc(ctx);
    registerAuthIpc(ctx);
    registerConnectionsIpc(ctx);
    registerSshIpc(ctx);
    registerLabIpc(ctx);
    registerWindowsIpc(ctx);
    registerBridgeIpc(ctx);
    ctx.auth.logPersistenceMode(); // 9.
    ctx.returns.install(); // 10a. checkout-return lab-ready hook
    ctx.windows.installMenus(); // 10b-12. app menu (dev=false), developer-menu wiring, dock menu
    ctx.windows.createShellWindow({ initial: true }); // 13. first window, marked initial
    ctx.deepLinks.markReady(); // 14. dispatch pending deep link
    ctx.updater.start(); // 15. updater (no-op unless REA_CLAUDE_UPDATE_URL, D4)
    installAppLifecycleHooks(ctx); // 16 + quit hooks: activate, window-all-closed, before-quit
    ctx.windows.startBackgroundMonitors(); // 17-20. watchdog, power, did-become-active, memory
  });
}
