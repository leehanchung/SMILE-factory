/**
 * settings.json store (platform §4.1/§4.2): sanitized reads, serialized
 * atomic writes (tmp + rename), change listeners. Electron-free; the file
 * path and fs are injected.
 */
import * as fsp from "node:fs/promises";
import { dirname } from "node:path";
import type { Settings, Unsubscribe } from "@shared/ipc";
import type { Logger } from "../services";
import { defaultSettings, mergeSettings, sanitizeSettings, serializeSettings } from "./sanitize";

export interface SettingsFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
}

export const nodeSettingsFs: SettingsFs = {
  readFile: (p, e) => fsp.readFile(p, e),
  writeFile: (p, d, e) => fsp.writeFile(p, d, e),
  rename: (a, b) => fsp.rename(a, b),
  mkdir: (p, o) => fsp.mkdir(p, o),
};

export interface SettingsStore {
  get(): Promise<Settings>;
  set(patch: unknown): Promise<Settings>;
  onChanged(listener: (settings: Settings) => void): Unsubscribe;
}

/** Promise-chain mutex: tasks run one after another; a failure does not block later tasks. */
export function serialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

export function createSettingsStore(opts: { filePath: () => string; fs?: SettingsFs; log?: Logger }): SettingsStore {
  const fs = opts.fs ?? nodeSettingsFs;
  const listeners = new Set<(s: Settings) => void>();
  const enqueue = serialQueue();

  async function read(): Promise<Settings> {
    try {
      return sanitizeSettings(JSON.parse(await fs.readFile(opts.filePath(), "utf8")));
    } catch {
      return defaultSettings();
    }
  }

  return {
    get: read,
    set(patch) {
      return enqueue(async () => {
        const merged = mergeSettings(await read(), patch);
        const file = opts.filePath();
        const tmp = `${file}.tmp`;
        await fs.mkdir(dirname(file), { recursive: true });
        await fs.writeFile(tmp, serializeSettings(merged), "utf8");
        await fs.rename(tmp, file);
        for (const l of [...listeners]) {
          try {
            l(merged);
          } catch (err) {
            opts.log?.error("settings change listener failed", err);
          }
        }
        return merged;
      });
    },
    onChanged(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
