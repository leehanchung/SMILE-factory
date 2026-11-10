import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bundleParentDir,
  bundlePath,
  parentDirAccess,
  readBundlePlistKey,
  relaunchOntoDiskBundleIfNewer,
  shipItLogTail,
} from "../../../src/main/updater/bundle";
import type { BundleEnv, BundleIo } from "../../../src/main/updater/bundle";
import { createUpdaterLog, formatLogArg } from "../../../src/main/updater/log";
import { createExitMarkerStore } from "../../../src/main/updater/marker";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rea-updater-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("updater.log", () => {
  it("appends ISO-stamped lines and echoes to the console", () => {
    const file = join(dir, "updater.log");
    const out = vi.fn();
    const log = createUpdaterLog({ path: () => file, now: () => Date.UTC(2026, 0, 2, 3, 4, 5), console: out });
    log.log("hello", { a: 1 });
    log.log(new Error("bad"));
    const lines = readFileSync(file, "utf8").split("\n");
    expect(lines[0]).toBe('2026-01-02T03:04:05.000Z hello {"a":1}');
    expect(lines[1]).toMatch(/^2026-01-02T03:04:05.000Z Error: bad/);
    expect(out).toHaveBeenCalledWith("[updater]", 'hello {"a":1}');
  });

  it("rotates a >1 MiB log to .old once per process", () => {
    const file = join(dir, "updater.log");
    writeFileSync(file, "x".repeat(1024 * 1024 + 1));
    const log = createUpdaterLog({ path: () => file, console: () => {} });
    log.log("first");
    expect(statSync(`${file}.old`).size).toBe(1024 * 1024 + 1);
    expect(readFileSync(file, "utf8")).toMatch(/ first\n$/);
    // Growing past the limit again in the same process does not rotate again.
    writeFileSync(file, "y".repeat(1024 * 1024 + 5));
    log.log("second");
    expect(statSync(`${file}.old`).size).toBe(1024 * 1024 + 1);
  });

  it("does not rotate files at or below the limit", () => {
    const file = join(dir, "updater.log");
    writeFileSync(file, "x".repeat(1024 * 1024));
    createUpdaterLog({ path: () => file, console: () => {} }).log("a");
    expect(existsSync(`${file}.old`)).toBe(false);
  });

  it("never throws when the file cannot be written", () => {
    const log = createUpdaterLog({ path: () => join(dir, "missing-dir", "x", "updater.log"), console: () => {} });
    expect(() => log.log("x")).not.toThrow();
  });

  it("electron logger maps levels and keeps noisy debug lines out of the file", () => {
    const file = join(dir, "updater.log");
    const out = vi.fn();
    const { electronLogger } = createUpdaterLog({ path: () => file, console: out });
    electronLogger.info("i");
    electronLogger.warn("w");
    electronLogger.error("e");
    electronLogger.debug("download range: 1-2");
    electronLogger.debug("z".repeat(4097));
    electronLogger.debug("d");
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(/ i\n/);
    expect(text).toMatch(/ WARN w\n/);
    expect(text).toMatch(/ ERROR e\n/);
    expect(text).toMatch(/ d\n/);
    expect(text).not.toContain("download range");
    expect(text).not.toContain("zzzz");
    expect(out).toHaveBeenCalledWith("[updater]", "download range: 1-2");
  });

  it("formatLogArg", () => {
    expect(formatLogArg("s")).toBe("s");
    expect(formatLogArg(5)).toBe("5");
    expect(formatLogArg(undefined)).toBe("undefined");
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    expect(formatLogArg(circ)).toBe("[object Object]");
  });
});

describe("exit marker", () => {
  const mk = () => {
    const log = vi.fn();
    const file = join(dir, "update-exit-marker.json");
    return { file, log, store: createExitMarkerStore({ path: () => file, log, now: () => 1234 }) };
  };

  it("write then takeFailed for the same version keeps it", () => {
    const { file, store } = mk();
    store.write("1.0.0", "1.1.0");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ fromVersion: "1.0.0", toVersion: "1.1.0", at: 1234 });
    expect(store.takeFailed("1.0.0")).toEqual({ fromVersion: "1.0.0", toVersion: "1.1.0", at: 1234 });
    expect(existsSync(file)).toBe(true);
    store.clear();
    expect(existsSync(file)).toBe(false);
  });

  it("applied and invalid markers are deleted", () => {
    const { file, store, log } = mk();
    store.write("1.0.0", "1.1.0");
    expect(store.takeFailed("1.1.0")).toBeNull();
    expect(existsSync(file)).toBe(false);
    expect(log).toHaveBeenCalledWith("previous exit expected 1.0.0 → 1.1.0; now running 1.1.0 (applied)");
    writeFileSync(file, "{garbage");
    expect(store.takeFailed("1.0.0")).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it("missing marker gives null; clear tolerates absence", () => {
    const { store } = mk();
    expect(store.takeFailed("1")).toBeNull();
    expect(() => store.clear()).not.toThrow();
  });

  it("write failure is logged, not thrown", () => {
    const log = vi.fn();
    const store = createExitMarkerStore({ path: () => join(dir, "no", "such", "m.json"), log });
    expect(() => store.write("1", "2")).not.toThrow();
    expect(log).toHaveBeenCalledWith("WARN could not write exit marker", expect.anything());
  });
});

describe("bundle helpers", () => {
  const env: BundleEnv = {
    platform: "darwin",
    isPackaged: true,
    execPath: "/Applications/Rea Claude.app/Contents/MacOS/Rea Claude",
    runningVersion: "0.1.0",
    argv: ["/exe", "--foo"],
  };
  const io = (over: Partial<BundleIo> = {}): BundleIo => ({
    execFileSync: () => "<string>0.2.0</string>",
    accessSync: () => {},
    readFileSync: () => "",
    homedir: () => "/Users/me",
    ...over,
  });

  it("paths", () => {
    expect(bundlePath(env.execPath)).toBe("/Applications/Rea Claude.app");
    expect(bundleParentDir(env.execPath)).toBe("/Applications");
  });

  it("parentDirAccess maps EROFS and other errors", () => {
    expect(parentDirAccess(env.execPath, io())).toBe("writable");
    const erofs = io({ accessSync: () => { throw Object.assign(new Error("ro"), { code: "EROFS" }); } });
    expect(parentDirAccess(env.execPath, erofs)).toBe("read-only-volume");
    const eacces = io({ accessSync: () => { throw Object.assign(new Error("no"), { code: "EACCES" }); } });
    expect(parentDirAccess(env.execPath, eacces)).toBe("denied");
  });

  it("readBundlePlistKey uses plutil on darwin+packaged only", () => {
    const exec = vi.fn(() => "<string>v</string>");
    expect(readBundlePlistKey("K", env, io({ execFileSync: exec }))).toBe("v");
    expect(exec).toHaveBeenCalledWith(
      "/usr/bin/plutil",
      ["-extract", "K", "xml1", "-o", "-", "/Applications/Rea Claude.app/Contents/Info.plist"],
      { encoding: "utf8", timeout: 5000 },
    );
    expect(readBundlePlistKey("K", { ...env, isPackaged: false }, io({ execFileSync: exec }))).toBeNull();
    expect(readBundlePlistKey("K", { ...env, platform: "linux" }, io())).toBeNull();
    expect(readBundlePlistKey("K", env, io({ execFileSync: () => { throw new Error("t"); } }))).toBeNull();
  });

  it("relaunchOntoDiskBundleIfNewer relaunches with the marker flag", () => {
    const ops = { relaunch: vi.fn(), exit: vi.fn(), log: vi.fn() };
    expect(relaunchOntoDiskBundleIfNewer("why", env, ops, io())).toBe(true);
    expect(ops.log).toHaveBeenCalledWith("why");
    expect(ops.relaunch).toHaveBeenCalledWith(["--foo", "--relaunched-onto-disk-bundle"]);
    expect(ops.exit).toHaveBeenCalledWith(0);
  });

  it("does not relaunch for the same version or when already retried", () => {
    const ops = { relaunch: vi.fn(), exit: vi.fn(), log: vi.fn() };
    expect(relaunchOntoDiskBundleIfNewer("x", env, ops, io({ execFileSync: () => "<string>0.1.0</string>" }))).toBe(false);
    expect(relaunchOntoDiskBundleIfNewer("x", { ...env, argv: ["/exe", "--relaunched-onto-disk-bundle"] }, ops, io())).toBe(false);
    expect(ops.relaunch).not.toHaveBeenCalled();
  });

  it("shipItLogTail returns the last N lines", () => {
    const read = vi.fn(() => "a\nb\nc\nd\n");
    const tail = shipItLogTail(env, io({ execFileSync: () => "<string>dev.smilefactory.rea-claude</string>", readFileSync: read }), 2);
    expect(tail).toBe("c\nd");
    expect(read).toHaveBeenCalledWith("/Users/me/Library/Caches/dev.smilefactory.rea-claude.ShipIt/ShipIt_stderr.log", "utf8");
    expect(shipItLogTail(env, io({ readFileSync: () => { throw new Error("x"); } }))).toBeNull();
  });
});
