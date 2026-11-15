import { describe, expect, it } from "vitest";
import {
  appUpdateYml,
  classifyExitMarker,
  graceRemaining,
  installerDownloadUrl,
  isReadOnlyVolumeError,
  locationBlock,
  normalizeFeedUrl,
  parseYamlUrl,
  parseYamlVersion,
  plistScalar,
  selfUpdateSupported,
  shouldRelaunchOntoDisk,
  stagedPhase,
  stagingVerdict,
  willInstallOnQuit,
} from "../../../src/main/updater/decisions";

describe("updater decisions", () => {
  it("classifyExitMarker", () => {
    expect(classifyExitMarker(null, "1")).toBe("invalid");
    expect(classifyExitMarker("x", "1")).toBe("invalid");
    expect(classifyExitMarker({ fromVersion: "", toVersion: "2", at: 1 }, "1")).toBe("invalid");
    expect(classifyExitMarker({ fromVersion: "1", toVersion: "", at: 1 }, "1")).toBe("invalid");
    expect(classifyExitMarker({ fromVersion: "1", toVersion: "2", at: Number.NaN }, "1")).toBe("invalid");
    expect(classifyExitMarker({ fromVersion: "1", toVersion: "2", at: "1" }, "1")).toBe("invalid");
    expect(classifyExitMarker({ fromVersion: "1", toVersion: "2", at: 1 }, "1")).toBe("failed");
    expect(classifyExitMarker({ fromVersion: "1", toVersion: "2", at: 1 }, "2")).toBe("applied");
  });

  it("shouldRelaunchOntoDisk", () => {
    const base = { platform: "darwin" as const, isPackaged: true, alreadyRetried: false, diskVersion: "0.138.0", runningVersion: "0.137.0" };
    expect(shouldRelaunchOntoDisk(base)).toBe(true);
    expect(shouldRelaunchOntoDisk({ ...base, platform: "linux" })).toBe(false);
    expect(shouldRelaunchOntoDisk({ ...base, isPackaged: false })).toBe(false);
    expect(shouldRelaunchOntoDisk({ ...base, alreadyRetried: true })).toBe(false);
    expect(shouldRelaunchOntoDisk({ ...base, diskVersion: null })).toBe(false);
    expect(shouldRelaunchOntoDisk({ ...base, diskVersion: "0.137.0" })).toBe(false);
  });

  it("locationBlock", () => {
    expect(locationBlock("linux", "denied")).toBe("none");
    expect(locationBlock("win32", "read-only-volume")).toBe("none");
    expect(locationBlock("darwin", "writable")).toBe("none");
    expect(locationBlock("darwin", "read-only-volume")).toBe("needs-move");
    expect(locationBlock("darwin", "denied")).toBe("needs-admin");
  });

  it("stagingVerdict", () => {
    const p = 600_000;
    expect(stagingVerdict({ phase: "downloaded", now: 0, stagingStartedAt: 0, patienceMs: p })).toBe("not-staging");
    expect(stagingVerdict({ phase: "staging", now: p - 1, stagingStartedAt: 0, patienceMs: p })).toBe("wait");
    expect(stagingVerdict({ phase: "staging", now: p, stagingStartedAt: 0, patienceMs: p })).toBe("stalled");
  });

  it("graceRemaining", () => {
    expect(graceRemaining({ graceMs: 30000, markerAt: 0, now: 10000 })).toBe(20000);
    expect(graceRemaining({ graceMs: 30000, markerAt: 0, now: 40000 })).toBe(0);
    expect(graceRemaining({ graceMs: 30000, markerAt: 50000, now: 0 })).toBe(30000);
  });

  it("willInstallOnQuit / stagedPhase", () => {
    expect(willInstallOnQuit({ platform: "darwin", nativeStaged: true, phase: "idle" })).toBe(true);
    expect(willInstallOnQuit({ platform: "darwin", nativeStaged: false, phase: "downloaded" })).toBe(false);
    expect(willInstallOnQuit({ platform: "win32", nativeStaged: false, phase: "downloaded" })).toBe(true);
    expect(willInstallOnQuit({ platform: "win32", nativeStaged: true, phase: "staging" })).toBe(false);
    expect(stagedPhase({ downloadCycle: 2, nativeConfirmedCycle: 2 })).toBe("downloaded");
    expect(stagedPhase({ downloadCycle: 2, nativeConfirmedCycle: 1 })).toBe("staging");
    expect(stagedPhase({ downloadCycle: 1, nativeConfirmedCycle: null })).toBe("staging");
  });

  it("installerDownloadUrl", () => {
    expect(installerDownloadUrl("https://x/stable/", "darwin")).toBe("https://x/stable/Rea-Claude-universal.dmg");
    expect(installerDownloadUrl("https://x", "win32")).toBe("https://x/Rea-Claude-Setup.exe");
    expect(installerDownloadUrl("https://x", "linux")).toBe("https://x/Rea-Claude.AppImage");
    expect(installerDownloadUrl("ftp://x", "darwin")).toBeNull();
    expect(installerDownloadUrl("https://x", "aix")).toBeNull();
    expect(installerDownloadUrl(null, "darwin")).toBeNull();
  });

  it("yaml and plist scalars", () => {
    expect(parseYamlUrl("provider: generic\nurl: 'https://a/b'\n")).toBe("https://a/b");
    expect(parseYamlVersion("version: 0.138.0\nfiles: []")).toBe("0.138.0");
    expect(parseYamlVersion('version: "1.2.3"\r\n')).toBe("1.2.3");
    expect(parseYamlVersion("nothing")).toBeNull();
    expect(plistScalar("<plist><string>a&amp;b</string></plist>")).toBe("a&b");
    expect(plistScalar("<integer> 7 </integer>")).toBe("7");
    expect(plistScalar("<dict/>")).toBeNull();
  });

  it("selfUpdateSupported", () => {
    expect(selfUpdateSupported("darwin", {})).toBe(true);
    expect(selfUpdateSupported("win32", {})).toBe(true);
    expect(selfUpdateSupported("linux", {})).toBe(false);
    expect(selfUpdateSupported("linux", { APPIMAGE: "/a.AppImage" })).toBe(true);
  });

  it("normalizeFeedUrl accepts only http(s)", () => {
    expect(normalizeFeedUrl(undefined)).toBeNull();
    expect(normalizeFeedUrl("")).toBeNull();
    expect(normalizeFeedUrl("not a url")).toBeNull();
    expect(normalizeFeedUrl("file:///tmp/feed")).toBeNull();
    expect(normalizeFeedUrl(" https://feed.example/stable// ")).toBe("https://feed.example/stable");
    expect(normalizeFeedUrl("http://localhost:8080")).toBe("http://localhost:8080");
  });

  it("isReadOnlyVolumeError", () => {
    expect(isReadOnlyVolumeError("Cannot update while running on a read-only volume")).toBe(true);
    expect(isReadOnlyVolumeError("READ-ONLY VOLUME")).toBe(true);
    expect(isReadOnlyVolumeError("timeout")).toBe(false);
    expect(isReadOnlyVolumeError(undefined)).toBe(false);
  });

  it("appUpdateYml uses the generic provider and the rea-claude cache dir", () => {
    const yml = appUpdateYml("https://feed.example/stable", "rea-claude-updater");
    expect(yml).toContain("provider: generic");
    expect(parseYamlUrl(yml)).toBe("https://feed.example/stable");
    expect(yml).toContain('updaterCacheDirName: "rea-claude-updater"');
    expect(yml).toContain("useMultipleRangeRequest: false");
  });
});
