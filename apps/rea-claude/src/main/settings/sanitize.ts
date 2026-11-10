/**
 * Pure settings helpers (platform §4.1). Electron-free so they unit-test
 * without mocks.
 *
 *  - Reads sanitize field by field; anything malformed falls back to the
 *    per-field default.
 *  - v1 migration: a file without `version >= 2` ignores `previewBuilds`, and
 *    a missing `staging` boolean is derived from the legacy `gatewayUrl`.
 *  - Writes are a SHALLOW, value-unvalidated merge (a partial `notifications`
 *    object replaces the whole sub-object, as in the original). Patch keys are
 *    restricted to the six known setting keys so unknown keys, `version` or
 *    `__proto__` never reach the file or the broadcast.
 */
import { DEFAULT_NOTIFICATIONS, DEFAULT_SETTINGS, GATEWAY_STAGING, SETTINGS_FILE_VERSION } from "@shared/config";
import type { NotificationSettings, Settings } from "@shared/ipc";

export const SETTINGS_KEYS = [
  "staging",
  "verbose",
  "previewBuilds",
  "notifications",
  "developerMode",
  "skipVersionCheck",
] as const satisfies readonly (keyof Settings)[];

const NOTIFICATION_KEYS = [
  "enabled",
  "needsInput",
  "experimentFinished",
  "sound",
  "notifyWhenActive",
  "badge",
] as const satisfies readonly (keyof NotificationSettings)[];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** Fresh, mutable copy of the defaults. */
export function defaultSettings(): Settings {
  return { ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_NOTIFICATIONS } };
}

/** `qs`: each field is a boolean or its default; a non-object gives all defaults. */
export function sanitizeNotifications(raw: unknown): NotificationSettings {
  const src = isRecord(raw) ? raw : {};
  const out = { ...DEFAULT_NOTIFICATIONS };
  for (const k of NOTIFICATION_KEYS) out[k] = bool(src[k], DEFAULT_NOTIFICATIONS[k]);
  return out;
}

/** `ne`: sanitize a parsed settings.json (any shape) into `Settings`. */
export function sanitizeSettings(raw: unknown): Settings {
  if (!isRecord(raw)) return defaultSettings();
  const version = typeof raw.version === "number" ? raw.version : 0;
  return {
    staging: typeof raw.staging === "boolean" ? raw.staging : raw.gatewayUrl === GATEWAY_STAGING,
    verbose: bool(raw.verbose, DEFAULT_SETTINGS.verbose),
    previewBuilds: version >= 2 ? bool(raw.previewBuilds, DEFAULT_SETTINGS.previewBuilds) : DEFAULT_SETTINGS.previewBuilds,
    notifications: sanitizeNotifications(raw.notifications),
    developerMode: bool(raw.developerMode, DEFAULT_SETTINGS.developerMode),
    skipVersionCheck: bool(raw.skipVersionCheck, DEFAULT_SETTINGS.skipVersionCheck),
  };
}

/**
 * `{...current, ...patch}` restricted to known keys. Values are NOT validated
 * (spec: the renderer is trusted to send well-formed values; the next read
 * sanitizes). A non-object patch is treated as empty.
 */
export function mergeSettings(current: Settings, patch: unknown): Settings {
  const merged: Record<string, unknown> = { ...current };
  if (isRecord(patch)) {
    for (const k of SETTINGS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) merged[k] = patch[k];
    }
  }
  return merged as unknown as Settings;
}

/** On-disk text: `{version: 2, ...settings}` pretty-printed with 2 spaces. */
export function serializeSettings(settings: Settings): string {
  return JSON.stringify({ version: SETTINGS_FILE_VERSION, ...settings }, null, 2);
}
