/**
 * Pure updater decision helpers (platform §5, §8). Electron-free.
 */
import type { UpdatePhase } from "@shared/ipc";

export type BlockReason = "needs-move" | "needs-admin";
export type LocationBlock = "none" | BlockReason;
export type DirAccess = "writable" | "read-only-volume" | "denied";
export type MarkerClass = "invalid" | "applied" | "failed";

export interface ExitMarker {
  fromVersion: string;
  toVersion: string;
  /** epoch ms */
  at: number;
}

/** electron-updater / Squirrel error text that means "running from a DMG". */
export function isReadOnlyVolumeError(message: string | undefined | null): boolean {
  return !!message && /read-only volume/i.test(message);
}

/** `Ho`: Linux self-update only for AppImage installs. */
export function selfUpdateSupported(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): boolean {
  return platform !== "linux" ? true : !!env.APPIMAGE;
}

/** Accept only absolute http(s) feed URLs; returns the trimmed URL without trailing slashes, or null. */
export function normalizeFeedUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  try {
    const u = new URL(trimmed);
    return u.protocol === "https:" || u.protocol === "http:" ? trimmed : null;
  } catch {
    return null;
  }
}

/** `au`: classify an update-exit-marker against the running version. */
export function classifyExitMarker(marker: unknown, currentVersion: string): MarkerClass {
  if (typeof marker !== "object" || marker === null) return "invalid";
  const m = marker as Record<string, unknown>;
  if (typeof m.fromVersion !== "string" || m.fromVersion.length === 0) return "invalid";
  if (typeof m.toVersion !== "string" || m.toVersion.length === 0) return "invalid";
  if (typeof m.at !== "number" || !Number.isFinite(m.at)) return "invalid";
  return m.fromVersion === currentVersion ? "failed" : "applied";
}

/** `cu`: relaunch onto the on-disk bundle when it reports a different version. */
export function shouldRelaunchOntoDisk(i: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  alreadyRetried: boolean;
  diskVersion: string | null;
  runningVersion: string;
}): boolean {
  if (i.platform !== "darwin" || !i.isPackaged || i.alreadyRetried || !i.diskVersion) return false;
  return i.diskVersion !== i.runningVersion;
}

/** `lu`: map the .app parent-dir access to an update block (macOS only). */
export function locationBlock(platform: NodeJS.Platform, access: DirAccess): LocationBlock {
  if (platform !== "darwin" || access === "writable") return "none";
  return access === "read-only-volume" ? "needs-move" : "needs-admin";
}

/** `uu`: was native (Squirrel) staging already confirmed for this download cycle? */
export function stagedPhase(i: { downloadCycle: number; nativeConfirmedCycle: number | null }): "downloaded" | "staging" {
  return i.nativeConfirmedCycle === i.downloadCycle ? "downloaded" : "staging";
}

/** `du`: staging patience verdict. */
export function stagingVerdict(i: {
  phase: UpdatePhase;
  now: number;
  stagingStartedAt: number;
  patienceMs: number;
}): "not-staging" | "wait" | "stalled" {
  if (i.phase !== "staging") return "not-staging";
  return i.now - i.stagingStartedAt < i.patienceMs ? "wait" : "stalled";
}

/** `Ir`: time left in the post-install grace window, clamped to [0, graceMs]. */
export function graceRemaining(i: { graceMs: number; markerAt: number; now: number }): number {
  return Math.min(i.graceMs, Math.max(0, i.graceMs - (i.now - i.markerAt)));
}

/** `fu`: will electron-updater install on quit? */
export function willInstallOnQuit(i: { platform: NodeJS.Platform; nativeStaged: boolean; phase: UpdatePhase }): boolean {
  return i.platform === "darwin" ? i.nativeStaged : i.phase === "downloaded";
}

/** Full-installer artifact names published next to the feed (Rea Claude naming). */
export const INSTALLER_FILES: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
  darwin: "Rea-Claude-universal.dmg",
  win32: "Rea-Claude-Setup.exe",
  linux: "Rea-Claude.AppImage",
};

/** `hu`: manual download link for the full installer, or null. */
export function installerDownloadUrl(feed: string | null | undefined, platform: NodeJS.Platform): string | null {
  const file = INSTALLER_FILES[platform];
  if (!file || !feed) return null;
  const base = feed.trim().replace(/\/+$/, "");
  return /^https?:\/\/.+/i.test(base) ? `${base}/${file}` : null;
}

function yamlScalar(key: string, text: string): string | null {
  const m = new RegExp(`^${key}:\\s*['"]?([^'"\\r\\n]+?)['"]?\\s*$`, "m").exec(text);
  return m?.[1]?.trim() ?? null;
}

/** `wu`: the `url:` line of a YAML document. */
export function parseYamlUrl(text: string): string | null {
  return yamlScalar("url", text);
}

/** `mu`: the `version:` line of a YAML document (latest-mac.yml). */
export function parseYamlVersion(text: string): string | null {
  return yamlScalar("version", text);
}

/** `gu`: first scalar of `plutil -extract … xml1` output, XML-unescaped. */
export function plistScalar(xml: string): string | null {
  const m = /<(string|integer|real)>([\s\S]*?)<\/\1>/.exec(xml);
  if (!m || m[2] === undefined) return null;
  return m[2].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
}

/**
 * app-update.yml written to userData so electron-updater gets a generic
 * provider and the `rea-claude-updater` cache dir (X6) without a baked file.
 */
export function appUpdateYml(feedUrl: string, cacheDirName: string): string {
  return [
    "provider: generic",
    `url: ${JSON.stringify(feedUrl)}`,
    "useMultipleRangeRequest: false",
    `updaterCacheDirName: ${JSON.stringify(cacheDirName)}`,
    "",
  ].join("\n");
}
