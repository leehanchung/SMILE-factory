import { describe, expect, it } from "vitest";
import { createMainContext } from "../../src/main/services";
import type { SettingsService } from "../../src/main/services";
import { makeTestContext } from "./helpers/context";
import { DEFAULT_SETTINGS } from "../../src/shared/config";

describe("createMainContext", () => {
  it("throws on access before a service is provided", () => {
    const { ctx } = createMainContext();
    expect(() => ctx.settings).toThrow("service 'settings' accessed before it was created");
  });

  it("supports lazy cross-references between services", async () => {
    const b = createMainContext();
    // A service capturing ctx at creation time and using it later (no circular init).
    const settings: SettingsService = {
      get: async () => DEFAULT_SETTINGS,
      set: async () => {
        throw new Error("x");
      },
      onChanged: () => () => {},
    };
    const usesLater = { read: () => b.ctx.settings };
    b.provide("settings", settings);
    expect(usesLater.read()).toBe(settings);
    expect(b.missing()).toContain("auth");
    expect(() => b.provide("settings", settings)).toThrow("provided twice");
  });
});

describe("makeTestContext", () => {
  it("fills unspecified services with throwing stubs", () => {
    const ctx = makeTestContext({ auth: { isDeveloper: () => true } });
    expect(ctx.auth.isDeveloper()).toBe(true);
    expect(() => ctx.auth.cachedIdentity()).toThrow("not stubbed: auth.cachedIdentity");
    expect(() => ctx.windows.shellWindows()).toThrow("not stubbed: windows.shellWindows");
    expect(ctx.env.isTestMode).toBe(true);
  });
});
