/**
 * Cross-area IPC wiring: run every register*Ipc(ctx) call that
 * src/main/index.ts makes (whenReady step 8), in the same order, against one
 * fake ipcMain, with every service built by its real create*Service exactly as
 * index.ts does (env/logger come from the test helpers instead of Electron).
 *
 * Asserts the contract from src/shared/ipc.ts: every ShellInvokeChannel and
 * LabInvokeChannel has exactly one `ipcMain.handle`, nothing is registered
 * twice (Electron throws on a second handle), and every LabSendChannel has an
 * `ipcMain.on` listener.
 *
 * Electron is replaced by a permissive fake: create* is side-effect free and
 * register* only wires handlers, so no real Electron object is ever used.
 */
import { describe, expect, it, vi } from "vitest";

const reg = vi.hoisted(() => ({
  handles: [] as string[],
  listeners: [] as string[],
}));

vi.mock("electron", () => {
  // Any member not listed explicitly is a callable, constructible, deeply
  // permissive no-op, so module-level `import { X } from "electron"` works.
  const anything = (): unknown =>
    new Proxy(function () {}, {
      get: (_t, prop) => (prop === "then" ? undefined : anything()),
      apply: () => anything(),
      construct: () => anything() as object,
    });
  const ipcMain = {
    handle: (channel: string) => {
      if (reg.handles.includes(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
      reg.handles.push(channel);
    },
    on: (channel: string) => {
      reg.listeners.push(channel);
    },
    removeHandler: () => {},
    removeAllListeners: () => {},
  };
  const mod: Record<string, unknown> = { ipcMain };
  const proxy = new Proxy(mod, {
    get: (t, prop) => {
      if (prop === "then") return undefined;
      if (prop in t) return t[prop as string];
      return anything();
    },
    has: () => true,
  });
  return { ...Object.fromEntries(
    [
      "app",
      "autoUpdater",
      "BrowserWindow",
      "WebContentsView",
      "dialog",
      "Menu",
      "MenuItem",
      "nativeImage",
      "nativeTheme",
      "net",
      "Notification",
      "powerMonitor",
      "safeStorage",
      "screen",
      "session",
      "shell",
      "clipboard",
      "protocol",
      "webContents",
    ].map((k) => [k, proxy[k as keyof typeof proxy]]),
  ), ipcMain, default: proxy };
});

import { LabInvokeChannel, LabSendChannel, ShellInvokeChannel } from "@shared/ipc";
import { createMainContext } from "../../src/main/services";
import { registerAppIpc } from "../../src/main/app";
import { createSettingsService, registerSettingsIpc } from "../../src/main/settings";
import { createUpdaterService, registerUpdaterIpc } from "../../src/main/updater";
import { createBridgeService, createTelemetryService, registerBridgeIpc } from "../../src/main/bridge";
import {
  createAuthService,
  createDeepLinkService,
  createReturnsService,
  createSignupService,
  registerAuthIpc,
} from "../../src/main/auth";
import { createConnectionsService, registerConnectionsIpc } from "../../src/main/connections";
import { createSshService, registerSshIpc } from "../../src/main/ssh";
import { createLabLifecycleService, registerLabIpc } from "../../src/main/lab";
import { createWindowService, registerWindowsIpc } from "../../src/main/windows";
import { silentLoggerFactory, testEnv } from "./helpers/context";

function buildContextLikeIndex() {
  const builder = createMainContext();
  const { ctx } = builder;
  builder.provide("env", testEnv({ userDataPath: () => "/nonexistent/rea-claude-ipc-wiring" }));
  builder.provide("logger", silentLoggerFactory);
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
  expect(builder.missing()).toEqual([]);
  return ctx;
}

describe("IPC wiring across all areas (index.ts step 8)", () => {
  const ctx = buildContextLikeIndex();
  // Same order as src/main/index.ts. A duplicate `handle` throws here.
  registerAppIpc(ctx);
  registerSettingsIpc(ctx);
  registerUpdaterIpc(ctx);
  registerAuthIpc(ctx);
  registerConnectionsIpc(ctx);
  registerSshIpc(ctx);
  registerLabIpc(ctx);
  registerWindowsIpc(ctx);
  registerBridgeIpc(ctx);

  const count = (list: string[], ch: string) => list.filter((c) => c === ch).length;

  it.each(Object.values(ShellInvokeChannel))("shell invoke %s has exactly one handler", (ch) => {
    expect(count(reg.handles, ch)).toBe(1);
  });

  it.each(Object.values(LabInvokeChannel))("lab invoke %s has exactly one handler", (ch) => {
    expect(count(reg.handles, ch)).toBe(1);
  });

  it.each(Object.values(LabSendChannel))("lab send %s has a listener", (ch) => {
    expect(count(reg.listeners, ch)).toBeGreaterThanOrEqual(1);
  });

  it("registers no duplicate handlers and nothing outside the contract", () => {
    expect(new Set(reg.handles).size).toBe(reg.handles.length);
    const known = new Set<string>([...Object.values(ShellInvokeChannel), ...Object.values(LabInvokeChannel)]);
    expect(reg.handles.filter((c) => !known.has(c))).toEqual([]);
    const sends = new Set<string>(Object.values(LabSendChannel));
    expect(reg.listeners.filter((c) => !sends.has(c))).toEqual([]);
    expect(reg.handles.length).toBe(Object.keys(ShellInvokeChannel).length + Object.keys(LabInvokeChannel).length);
  });
});
