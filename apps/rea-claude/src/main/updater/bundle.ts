/**
 * macOS bundle helpers (platform §4.3, §5.4): bundle location, parent-dir
 * writability, Info.plist scalars via plutil, disk-bundle relaunch, ShipIt
 * stderr tail. Electron-free; everything is injected so the pre-ready
 * bootstrap (src/main/app) and the updater share one implementation.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PLUTIL_TIMEOUT_MS, RELAUNCHED_ONTO_DISK_FLAG, SHIPIT_LOG_TAIL_LINES } from "@shared/config";
import { plistScalar, shouldRelaunchOntoDisk } from "./decisions";
import type { DirAccess } from "./decisions";

export interface BundleEnv {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  execPath: string;
  runningVersion: string;
  argv: readonly string[];
}

export interface BundleIo {
  execFileSync(file: string, args: readonly string[], opts: { encoding: "utf8"; timeout: number }): string;
  accessSync(path: string, mode: number): void;
  readFileSync(path: string, encoding: "utf8"): string;
  homedir(): string;
}

export const nodeBundleIo: BundleIo = {
  execFileSync: (file, args, opts) => execFileSync(file, [...args], opts),
  accessSync: (p, m) => fs.accessSync(p, m),
  readFileSync: (p, e) => fs.readFileSync(p, e),
  homedir: () => homedir(),
};

/** `<X>.app` path from `<X>.app/Contents/MacOS/<exe>`. */
export function bundlePath(execPath: string): string {
  return resolve(execPath, "..", "..", "..");
}

/** Directory holding the .app (must be writable for in-place updates). */
export function bundleParentDir(execPath: string): string {
  return dirname(bundlePath(execPath));
}

/** `ku`: parent dir access. */
export function parentDirAccess(execPath: string, io: BundleIo = nodeBundleIo): DirAccess {
  try {
    io.accessSync(bundleParentDir(execPath), fs.constants.W_OK);
    return "writable";
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === "EROFS" ? "read-only-volume" : "denied";
  }
}

/** `ls`: one Info.plist key of the bundle on disk (darwin + packaged only). */
export function readBundlePlistKey(key: string, env: BundleEnv, io: BundleIo = nodeBundleIo): string | null {
  if (env.platform !== "darwin" || !env.isPackaged) return null;
  try {
    const plist = join(bundlePath(env.execPath), "Contents", "Info.plist");
    const xml = io.execFileSync("/usr/bin/plutil", ["-extract", key, "xml1", "-o", "-", plist], {
      encoding: "utf8",
      timeout: PLUTIL_TIMEOUT_MS,
    });
    return plistScalar(xml);
  } catch {
    return null;
  }
}

export function diskBundleVersion(env: BundleEnv, io: BundleIo = nodeBundleIo): string | null {
  return readBundlePlistKey("CFBundleShortVersionString", env, io);
}

/**
 * `En`: when the bundle on disk reports a different version than the running
 * build, log `reason`, relaunch with `--relaunched-onto-disk-bundle` and exit.
 * Returns true when it relaunched.
 */
export function relaunchOntoDiskBundleIfNewer(
  reason: string,
  env: BundleEnv,
  ops: { relaunch(args: string[]): void; exit(code: number): void; log(msg: string): void },
  io: BundleIo = nodeBundleIo,
): boolean {
  const relaunch = shouldRelaunchOntoDisk({
    platform: env.platform,
    isPackaged: env.isPackaged,
    runningVersion: env.runningVersion,
    diskVersion: diskBundleVersion(env, io),
    alreadyRetried: env.argv.includes(RELAUNCHED_ONTO_DISK_FLAG),
  });
  if (!relaunch) return false;
  ops.log(reason);
  ops.relaunch([...env.argv.slice(1), RELAUNCHED_ONTO_DISK_FLAG]);
  ops.exit(0);
  return true;
}

/** `_u`: last lines of Squirrel's ShipIt stderr log, or null. */
export function shipItLogTail(env: BundleEnv, io: BundleIo = nodeBundleIo, lines = SHIPIT_LOG_TAIL_LINES): string | null {
  const bundleId = readBundlePlistKey("CFBundleIdentifier", env, io);
  if (!bundleId) return null;
  try {
    const text = io.readFileSync(join(io.homedir(), "Library", "Caches", `${bundleId}.ShipIt`, "ShipIt_stderr.log"), "utf8");
    return text.trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return null;
  }
}
