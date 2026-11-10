import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@shared/config";
import type { Settings } from "@shared/ipc";

type Listener = (event: unknown, ...args: unknown[]) => unknown;
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Listener>() }));
vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: Listener) => mocks.handlers.set(ch, fn), on: () => {} },
  session: { fromPartition: () => ({}) },
}));

import { createSettingsService, registerSettingsIpc } from "../../../src/main/settings";
import { makeTestContext } from "../helpers/context";

const trusted = { sender: { getURL: () => "file:///app/index.html" }, senderFrame: { url: "file:///app/index.html" } };
const untrusted = { sender: { getURL: () => "https://evil.example" }, senderFrame: { url: "https://evil.example" } };

describe("settings IPC", () => {
  it("settings:set broadcasts settings:changed with the merged object after the write", async () => {
    const order: string[] = [];
    const broadcast = vi.fn((_ch: string, _p: unknown) => void order.push("broadcast"));
    const ctx = makeTestContext({
      settings: {
        get: async () => DEFAULT_SETTINGS as Settings,
        set: async (patch) => {
          order.push("set");
          return { ...DEFAULT_SETTINGS, ...patch } as Settings;
        },
      },
      windows: { broadcast },
    });
    registerSettingsIpc(ctx);
    const set = mocks.handlers.get("settings:set");
    const get = mocks.handlers.get("settings:get");
    expect(await get?.(trusted)).toEqual(DEFAULT_SETTINGS);
    const merged = await set?.(trusted, { verbose: true });
    expect(merged).toEqual({ ...DEFAULT_SETTINGS, verbose: true });
    expect(broadcast).toHaveBeenCalledWith("settings:changed", merged);
    expect(order).toEqual(["set", "broadcast"]);
  });

  it("does not broadcast when the write rejects", async () => {
    const broadcast = vi.fn();
    const ctx = makeTestContext({
      settings: {
        set: async () => {
          throw new Error("disk full");
        },
      },
      windows: { broadcast },
    });
    registerSettingsIpc(ctx);
    await expect(mocks.handlers.get("settings:set")?.(trusted, {})).rejects.toThrow("disk full");
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("rejects untrusted senders", () => {
    registerSettingsIpc(makeTestContext());
    expect(() => mocks.handlers.get("settings:get")?.(untrusted)).toThrow("Blocked 'settings:get': untrusted sender.");
  });

  it("createSettingsService resolves <userData>/settings.json lazily and uses the injected fs", async () => {
    const reads: string[] = [];
    const ctx = makeTestContext({ env: { userDataPath: () => "/ud" } });
    const svc = createSettingsService(ctx, {
      fs: {
        readFile: async (p) => {
          reads.push(p);
          return JSON.stringify({ version: 2, verbose: true });
        },
        writeFile: async () => {},
        rename: async () => {},
        mkdir: async () => undefined,
      },
    });
    expect((await svc.get()).verbose).toBe(true);
    expect(reads).toEqual(["/ud/settings.json"]);
    const listener = vi.fn();
    svc.onChanged(listener);
    await svc.set({ developerMode: true });
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ verbose: true, developerMode: true }));
  });
});
