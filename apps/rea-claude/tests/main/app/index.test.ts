import { describe, expect, it, vi } from "vitest";

type Listener = (event: unknown, ...args: unknown[]) => unknown;
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Listener>(),
  app: {
    isPackaged: false,
    getVersion: () => "0.1.0",
    getPath: (n: string) => `/paths/${n}`,
    getAppPath: () => "/repo",
    dock: { setIcon: vi.fn() },
  },
  image: { isEmpty: (): boolean => false },
}));
vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: Listener) => mocks.handlers.set(ch, fn), on: () => {} },
  session: { fromPartition: () => ({}) },
  app: mocks.app,
  dialog: {},
  nativeImage: { createFromPath: () => mocks.image },
}));

import { applyDockIcon, createAppEnv, createLoggerFactory, registerAppIpc, resolveRendererUrl } from "../../../src/main/app";
import { makeTestContext } from "../helpers/context";

const trusted = { sender: { getURL: () => "file:///x" }, senderFrame: { url: "file:///x" } };

describe("app entry", () => {
  it("createAppEnv reads renamed env vars", () => {
    const env = createAppEnv({ REA_CLAUDE_E2E_USER_DATA: "/e2e", ELECTRON_RENDERER_URL: "http://localhost:5173" });
    expect(env.isTestMode).toBe(true);
    expect(env.rendererUrl).toBe("http://localhost:5173");
    expect(env.appVersion).toBe("0.1.0");
    expect(env.build).toBe("rea-claude dev build");
    expect(env.userDataPath()).toBe("/paths/userData");
    expect(env.iconPath()).toBe("/repo/resources/icon.png");
    expect(createAppEnv({ SILICO_E2E_USER_DATA: "/x" }).isTestMode).toBe(false);
  });

  it("ignores ELECTRON_RENDERER_URL in packaged builds (S2)", () => {
    const env = { ELECTRON_RENDERER_URL: "https://evil.example" };
    expect(createAppEnv(env, true).rendererUrl).toBeUndefined();
    expect(createAppEnv(env, false).rendererUrl).toBe("https://evil.example");
    expect(resolveRendererUrl({ ELECTRON_RENDERER_URL: "" }, false)).toBeUndefined();
    expect(resolveRendererUrl(env, true)).toBeUndefined();
  });

  it("logger prefixes tags", () => {
    const out = { debug: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const l = createLoggerFactory(out)("updater");
    l.info("a", 1);
    l.warn("w");
    l.error("e");
    l.debug("d");
    expect(out.log).toHaveBeenCalledWith("[updater]", "a", 1);
    expect(out.warn).toHaveBeenCalledWith("[updater]", "w");
    expect(out.error).toHaveBeenCalledWith("[updater]", "e");
    expect(out.debug).toHaveBeenCalledWith("[updater]", "d");
  });

  it("ping and app:isDevBuild", async () => {
    registerAppIpc(makeTestContext({ env: { isPackaged: false } }));
    expect(await mocks.handlers.get("ping")?.(trusted)).toBe("pong");
    expect(await mocks.handlers.get("app:isDevBuild")?.(trusted)).toBe(true);
    registerAppIpc(makeTestContext({ env: { isPackaged: true } }));
    expect(await mocks.handlers.get("app:isDevBuild")?.(trusted)).toBe(false);
  });

  it("applyDockIcon sets the dock icon on macOS only when the image loads", () => {
    applyDockIcon(makeTestContext({ env: { platform: "linux" } }));
    expect(mocks.app.dock.setIcon).not.toHaveBeenCalled();
    applyDockIcon(makeTestContext({ env: { platform: "darwin" } }));
    expect(mocks.app.dock.setIcon).toHaveBeenCalledTimes(1);
    mocks.image.isEmpty = () => true;
    applyDockIcon(makeTestContext({ env: { platform: "darwin" } }));
    expect(mocks.app.dock.setIcon).toHaveBeenCalledTimes(1);
  });
});
