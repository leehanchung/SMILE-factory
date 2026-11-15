import { describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATIONS, DEFAULT_SETTINGS, GATEWAY_PROD, GATEWAY_STAGING } from "@shared/config";
import {
  defaultSettings,
  mergeSettings,
  sanitizeNotifications,
  sanitizeSettings,
  serializeSettings,
} from "../../../src/main/settings/sanitize";

describe("sanitizeSettings", () => {
  it("returns defaults for {} and non-objects", () => {
    expect(sanitizeSettings({})).toEqual(DEFAULT_SETTINGS);
    for (const raw of [null, undefined, 42, "x", [], true]) expect(sanitizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it("defaults match the spec per field", () => {
    expect(defaultSettings()).toEqual({
      staging: false,
      verbose: false,
      previewBuilds: false,
      notifications: {
        enabled: true,
        needsInput: true,
        experimentFinished: true,
        sound: true,
        notifyWhenActive: false,
        badge: true,
      },
      developerMode: false,
      skipVersionCheck: false,
    });
  });

  it("defaultSettings returns a fresh mutable copy", () => {
    const a = defaultSettings();
    a.notifications.sound = false;
    expect(defaultSettings().notifications.sound).toBe(true);
    expect(DEFAULT_NOTIFICATIONS.sound).toBe(true);
  });

  it("honors previewBuilds only for version >= 2 (v1 migration)", () => {
    expect(sanitizeSettings({ version: 1, previewBuilds: true }).previewBuilds).toBe(false);
    expect(sanitizeSettings({ previewBuilds: true }).previewBuilds).toBe(false);
    expect(sanitizeSettings({ version: "2", previewBuilds: true }).previewBuilds).toBe(false);
    expect(sanitizeSettings({ version: 2, previewBuilds: true }).previewBuilds).toBe(true);
    expect(sanitizeSettings({ version: 3, previewBuilds: true }).previewBuilds).toBe(true);
    expect(sanitizeSettings({ version: 2, previewBuilds: "yes" }).previewBuilds).toBe(false);
  });

  it("migrates legacy gatewayUrl to staging when staging is not a boolean", () => {
    expect(sanitizeSettings({ gatewayUrl: GATEWAY_STAGING }).staging).toBe(true);
    expect(sanitizeSettings({ gatewayUrl: GATEWAY_PROD }).staging).toBe(false);
    expect(sanitizeSettings({ staging: false, gatewayUrl: GATEWAY_STAGING }).staging).toBe(false);
    expect(sanitizeSettings({ staging: true, gatewayUrl: GATEWAY_PROD }).staging).toBe(true);
    expect(sanitizeSettings({ staging: "true", gatewayUrl: GATEWAY_STAGING }).staging).toBe(true);
    expect(sanitizeSettings({ staging: "true" }).staging).toBe(false);
  });

  it("keeps stored booleans and drops unknown/legacy keys", () => {
    const s = sanitizeSettings({
      version: 2,
      verbose: true,
      developerMode: true,
      skipVersionCheck: true,
      gatewayUrl: GATEWAY_STAGING,
      extra: 1,
    });
    expect(s).toEqual({ ...DEFAULT_SETTINGS, staging: true, verbose: true, developerMode: true, skipVersionCheck: true });
    expect(Object.keys(s).sort()).toEqual(
      ["developerMode", "notifications", "previewBuilds", "skipVersionCheck", "staging", "verbose"].sort(),
    );
  });

  it("falls back per field for non-boolean values", () => {
    expect(sanitizeSettings({ verbose: 1, developerMode: "true", skipVersionCheck: null })).toEqual(DEFAULT_SETTINGS);
  });
});

describe("sanitizeNotifications", () => {
  it("non-object gives all defaults", () => {
    for (const raw of [null, undefined, 3, "x", []]) expect(sanitizeNotifications(raw)).toEqual(DEFAULT_NOTIFICATIONS);
  });

  it("each non-boolean field falls back to its default", () => {
    expect(sanitizeNotifications({ sound: "yes" }).sound).toBe(true);
    expect(sanitizeNotifications({ notifyWhenActive: 1 }).notifyWhenActive).toBe(false);
    expect(
      sanitizeNotifications({
        enabled: false,
        needsInput: false,
        experimentFinished: false,
        sound: false,
        notifyWhenActive: true,
        badge: false,
        junk: true,
      }),
    ).toEqual({
      enabled: false,
      needsInput: false,
      experimentFinished: false,
      sound: false,
      notifyWhenActive: true,
      badge: false,
    });
  });

  it("is applied inside sanitizeSettings", () => {
    expect(sanitizeSettings({ notifications: { sound: "yes", badge: false } }).notifications).toEqual({
      ...DEFAULT_NOTIFICATIONS,
      badge: false,
    });
    expect(sanitizeSettings({ notifications: null }).notifications).toEqual(DEFAULT_NOTIFICATIONS);
  });
});

describe("mergeSettings", () => {
  it("is shallow: a partial notifications object replaces the whole sub-object", () => {
    const merged = mergeSettings(defaultSettings(), { notifications: { enabled: false } });
    expect(merged.notifications).toEqual({ enabled: false });
  });

  it("does not validate values", () => {
    const merged = mergeSettings(defaultSettings(), { verbose: "loud" });
    expect((merged as unknown as Record<string, unknown>).verbose).toBe("loud");
  });

  it("keeps only known keys (no version, unknown or __proto__ keys)", () => {
    const patch = JSON.parse('{"verbose":true,"version":1,"gatewayUrl":"x","__proto__":{"polluted":true}}') as unknown;
    const merged = mergeSettings(defaultSettings(), patch) as unknown as Record<string, unknown>;
    expect(merged.verbose).toBe(true);
    expect("version" in merged).toBe(false);
    expect("gatewayUrl" in merged).toBe(false);
    expect((merged as { polluted?: boolean }).polluted).toBeUndefined();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("treats a non-object patch as empty", () => {
    for (const p of [null, undefined, 5, "x", [true]]) expect(mergeSettings(defaultSettings(), p)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("serializeSettings", () => {
  it("writes version 2 first, pretty-printed with 2 spaces", () => {
    const text = serializeSettings(defaultSettings());
    expect(text.startsWith('{\n  "version": 2,\n  "staging": false')).toBe(true);
    expect(JSON.parse(text)).toEqual({ version: 2, ...DEFAULT_SETTINGS });
  });
});
