import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, GATEWAY_STAGING } from "@shared/config";
import type { Settings } from "@shared/ipc";
import { createSettingsStore, nodeSettingsFs, serialQueue } from "../../../src/main/settings/store";
import type { SettingsFs } from "../../../src/main/settings/store";
import { silentLogger } from "../helpers/context";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rea-settings-"));
  file = join(dir, "nested", "settings.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("settings store", () => {
  it("returns defaults when the file is missing or corrupt", async () => {
    const store = createSettingsStore({ filePath: () => file });
    expect(await store.get()).toEqual(DEFAULT_SETTINGS);
    await store.set({}); // creates nested dir
    await writeFile(file, "{ nope", "utf8");
    expect(await store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it("reads and migrates a v1 file", async () => {
    const store = createSettingsStore({ filePath: () => file });
    await store.set({});
    await writeFile(file, JSON.stringify({ gatewayUrl: GATEWAY_STAGING, previewBuilds: true, verbose: true }), "utf8");
    expect(await store.get()).toEqual({ ...DEFAULT_SETTINGS, staging: true, verbose: true });
  });

  it("writes {version:2,...merged} atomically and drops legacy keys on first write", async () => {
    const store = createSettingsStore({ filePath: () => file });
    await store.set({});
    await writeFile(file, JSON.stringify({ gatewayUrl: GATEWAY_STAGING }), "utf8");
    const merged = await store.set({ verbose: true });
    expect(merged).toEqual({ ...DEFAULT_SETTINGS, staging: true, verbose: true });
    const onDisk = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(onDisk).toEqual({ version: 2, ...DEFAULT_SETTINGS, staging: true, verbose: true });
    expect(await readFile(file, "utf8")).toContain('\n  "version": 2');
    expect(await readdir(join(dir, "nested"))).toEqual(["settings.json"]); // tmp renamed away
  });

  it("previewBuilds survives a round trip once written as v2", async () => {
    const store = createSettingsStore({ filePath: () => file });
    await store.set({ previewBuilds: true });
    expect((await store.get()).previewBuilds).toBe(true);
  });

  it("returns the merged (unsanitized) object but sanitizes on the next read", async () => {
    const store = createSettingsStore({ filePath: () => file });
    const merged = await store.set({ notifications: { enabled: false } } as unknown as Partial<Settings>);
    expect(merged.notifications).toEqual({ enabled: false });
    expect((await store.get()).notifications).toEqual({ ...DEFAULT_SETTINGS.notifications, enabled: false });
  });

  it("serializes concurrent writes (no lost update)", async () => {
    const store = createSettingsStore({ filePath: () => file });
    await Promise.all([
      store.set({ verbose: true }),
      store.set({ developerMode: true }),
      store.set({ skipVersionCheck: true }),
    ]);
    expect(await store.get()).toEqual({ ...DEFAULT_SETTINGS, verbose: true, developerMode: true, skipVersionCheck: true });
  });

  it("calls listeners with the merged object after a successful write; unsubscribe works", async () => {
    const store = createSettingsStore({ filePath: () => file });
    const seen: Settings[] = [];
    const off = store.onChanged((s) => seen.push(s));
    const merged = await store.set({ verbose: true });
    expect(seen).toEqual([merged]);
    off();
    await store.set({ verbose: false });
    expect(seen).toHaveLength(1);
  });

  it("isolates listener errors", async () => {
    const error = vi.fn();
    const store = createSettingsStore({ filePath: () => file, log: { ...silentLogger, error } });
    const second = vi.fn();
    store.onChanged(() => {
      throw new Error("boom");
    });
    store.onChanged(second);
    await expect(store.set({ verbose: true })).resolves.toMatchObject({ verbose: true });
    expect(second).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
  });

  it("propagates write errors, skips listeners, and keeps the queue usable", async () => {
    let fail = true;
    const fs: SettingsFs = {
      ...nodeSettingsFs,
      rename: async (a, b) => {
        if (fail) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return nodeSettingsFs.rename(a, b);
      },
    };
    const store = createSettingsStore({ filePath: () => file, fs });
    const listener = vi.fn();
    store.onChanged(listener);
    await expect(store.set({ verbose: true })).rejects.toThrow("EACCES");
    expect(listener).not.toHaveBeenCalled();
    fail = false;
    await expect(store.set({ developerMode: true })).resolves.toMatchObject({ developerMode: true, verbose: false });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("writes the tmp file next to the target then renames", async () => {
    const calls: string[] = [];
    const fs: SettingsFs = {
      readFile: async () => {
        throw new Error("ENOENT");
      },
      mkdir: async (p) => void calls.push(`mkdir ${p}`),
      writeFile: async (p) => void calls.push(`write ${p}`),
      rename: async (a, b) => void calls.push(`rename ${a} ${b}`),
    };
    await createSettingsStore({ filePath: () => "/u/settings.json", fs }).set({});
    expect(calls).toEqual(["mkdir /u", "write /u/settings.json.tmp", "rename /u/settings.json.tmp /u/settings.json"]);
  });
});

describe("serialQueue", () => {
  it("runs tasks in order and continues after a failure", async () => {
    const q = serialQueue();
    const order: number[] = [];
    const a = q(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(1);
      throw new Error("x");
    });
    const b = q(async () => {
      order.push(2);
      return 2;
    });
    await expect(a).rejects.toThrow("x");
    await expect(b).resolves.toBe(2);
    expect(order).toEqual([1, 2]);
  });
});
