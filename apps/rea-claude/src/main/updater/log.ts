/**
 * updater.log writer (platform §4.2, §5.1): `ISO8601 <msg>` lines appended
 * to `<userData>/updater.log`. On the first write of each process a file
 * larger than 1 MiB is renamed to `updater.log.old`. Every line is also
 * logged to the console under the `[updater]` tag. Never throws.
 */
import * as fs from "node:fs";
import { UPDATER_LOG_ROTATE_BYTES } from "@shared/config";

export interface UpdaterLogFs {
  statSync(path: string): { size: number };
  renameSync(from: string, to: string): void;
  appendFileSync(path: string, data: string): void;
}

export interface ElectronUpdaterLogger {
  info(message?: unknown): void;
  warn(message?: unknown): void;
  error(message?: unknown): void;
  debug(message: string): void;
}

export interface UpdaterLog {
  /** Console + file. */
  log(...args: unknown[]): void;
  /** Logger handed to electron-updater (`Su`). */
  readonly electronLogger: ElectronUpdaterLogger;
}

export function formatLogArg(v: unknown): string {
  if (v instanceof Error) return v.stack ?? v.message;
  if (typeof v === "string") return v;
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}

export function createUpdaterLog(opts: {
  path: () => string;
  fs?: UpdaterLogFs;
  now?: () => number;
  console?: (...args: unknown[]) => void;
  rotateBytes?: number;
}): UpdaterLog {
  const f = opts.fs ?? fs;
  const now = opts.now ?? Date.now;
  const out = opts.console ?? ((...a: unknown[]) => console.log(...a));
  const limit = opts.rotateBytes ?? UPDATER_LOG_ROTATE_BYTES;
  let rotated = false;

  function rotateOnce(file: string): void {
    if (rotated) return;
    rotated = true;
    try {
      if (f.statSync(file).size > limit) f.renameSync(file, `${file}.old`);
    } catch {
      /* missing file or rename failure: keep appending */
    }
  }

  function log(...args: unknown[]): void {
    const line = args.map(formatLogArg).join(" ");
    out("[updater]", line);
    try {
      const file = opts.path();
      rotateOnce(file);
      f.appendFileSync(file, `${new Date(now()).toISOString()} ${line}\n`);
    } catch {
      /* logging must never break the updater */
    }
  }

  return {
    log,
    electronLogger: {
      info: (m) => log(m),
      warn: (m) => log("WARN", m),
      error: (m) => log("ERROR", m),
      debug: (m) => {
        if (typeof m === "string" && (m.startsWith("download range:") || m.length > 4096)) {
          out("[updater]", m);
          return;
        }
        log(m);
      },
    },
  };
}
