import { describe, expect, it, vi } from "vitest";

type Listener = (event: unknown, ...args: unknown[]) => unknown;
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Listener>() }));
vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: Listener) => mocks.handlers.set(ch, fn), on: () => {} },
  session: { fromPartition: () => ({}) },
  app: {},
  autoUpdater: {},
  BrowserWindow: {},
  dialog: {},
  nativeImage: {},
  net: {},
  shell: {},
}));
vi.mock("electron-updater", () => {
  throw new Error("electron-updater must not be loaded while disabled");
});

import { createUpdaterService, registerUpdaterIpc, resolveUpdaterConfig } from "../../../src/main/updater";
import { createMainContext } from "../../../src/main/services";
import { createSettingsService } from "../../../src/main/settings";
import type { UpdaterController } from "../../../src/main/updater/controller";
import { makeTestContext, silentLogger } from "../helpers/context";

const trusted = { sender: { getURL: () => "file:///x" }, senderFrame: { url: "file:///x" } };

describe("resolveUpdaterConfig (D4)", () => {
  it("is enabled only when packaged, supported and REA_CLAUDE_UPDATE_URL is a valid http(s) URL", () => {
    const url = { REA_CLAUDE_UPDATE_URL: "https://feed.example/stable/" };
    expect(resolveUpdaterConfig({ isPackaged: true, platform: "darwin", env: url })).toEqual({
      isPackaged: true,
      supported: true,
      feedUrl: "https://feed.example/stable",
      enabled: true,
    });
    expect(resolveUpdaterConfig({ isPackaged: true, platform: "darwin", env: {} }).enabled).toBe(false);
    expect(resolveUpdaterConfig({ isPackaged: false, platform: "darwin", env: url }).enabled).toBe(false);
    expect(resolveUpdaterConfig({ isPackaged: true, platform: "linux", env: url }).enabled).toBe(false);
    expect(resolveUpdaterConfig({ isPackaged: true, platform: "linux", env: { ...url, APPIMAGE: "/a" } }).enabled).toBe(true);
    expect(
      resolveUpdaterConfig({ isPackaged: true, platform: "darwin", env: { REA_CLAUDE_UPDATE_URL: "javascript:alert(1)" } })
        .enabled,
    ).toBe(false);
    // Never Silico's own variables.
    expect(resolveUpdaterConfig({ isPackaged: true, platform: "darwin", env: { SILICO_UPDATE_URL: "https://x" } }).enabled).toBe(false);
  });
});

describe("updater service", () => {
  it("disabled by default: idle state, no-op install/start/check, no electron-updater load", () => {
    const info = vi.fn();
    const ctx = makeTestContext({
      env: { isPackaged: true, appVersion: "9.9.9" },
      logger: () => ({ ...silentLogger, info }),
    });
    const svc = createUpdaterService(ctx, { env: {} });
    expect(svc.isEnabled()).toBe(false);
    expect(svc.getState()).toEqual({ phase: "idle", currentVersion: "9.9.9" });
    svc.start();
    svc.install();
    svc.checkInBackground();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("self-update disabled"));
  });

  it("create is side-effect free (no service is read at create time)", () => {
    const { ctx } = createMainContext(); // every getter throws until provided
    expect(() => createUpdaterService(ctx)).not.toThrow();
    expect(() => createSettingsService(ctx)).not.toThrow();
  });

  it("delegates to an injected controller", () => {
    const ctl: UpdaterController = {
      isEnabled: () => true,
      getState: () => ({ phase: "checking", currentVersion: "1" }),
      start: vi.fn(),
      check: vi.fn(async () => {}),
      userCheck: vi.fn(async () => {}),
      install: vi.fn(async () => {}),
    };
    const svc = createUpdaterService(makeTestContext(), { controller: () => ctl });
    svc.start();
    svc.checkInBackground();
    svc.userCheck();
    svc.install();
    expect(ctl.start).toHaveBeenCalled();
    expect(ctl.check).toHaveBeenCalled();
    expect(ctl.userCheck).toHaveBeenCalled();
    expect(ctl.install).toHaveBeenCalled();
    expect(svc.getState().phase).toBe("checking");
  });

  it("registers update:get-state / update:install", async () => {
    const install = vi.fn();
    const ctx = makeTestContext({
      updater: { getState: () => ({ phase: "idle", currentVersion: "1" }), install },
    });
    registerUpdaterIpc(ctx);
    expect(await mocks.handlers.get("update:get-state")?.(trusted)).toEqual({ phase: "idle", currentVersion: "1" });
    await mocks.handlers.get("update:install")?.(trusted);
    expect(install).toHaveBeenCalled();
  });
});
