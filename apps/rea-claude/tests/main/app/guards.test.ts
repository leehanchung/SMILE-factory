import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  forbiddenSwitch,
  forbiddenSwitchMessage,
  isAbnormalGpuExit,
  isIgnorableMainError,
  isTestMode,
  shouldOfferMove,
  shouldRegisterProtocol,
  userDataPathFor,
} from "../../../src/main/app/guards";

describe("launch guards", () => {
  const has = (...on: string[]) => (s: string) => on.includes(s);

  it("forbiddenSwitch: unpackaged builds are never refused", () => {
    expect(forbiddenSwitch({ isPackaged: false, testMode: false, hasSwitch: has("remote-debugging-port") })).toBeNull();
  });

  it("forbiddenSwitch: every listed switch is refused in packaged builds", () => {
    for (const s of [
      "remote-debugging-port",
      "remote-debugging-pipe",
      "ignore-certificate-errors",
      "ignore-certificate-errors-spki-list",
      "log-net-log",
      "ssl-key-log-file",
    ]) {
      expect(forbiddenSwitch({ isPackaged: true, testMode: false, hasSwitch: has(s) })).toBe(s);
    }
    expect(forbiddenSwitch({ isPackaged: true, testMode: false, hasSwitch: has("enable-logging") })).toBeNull();
  });

  it("forbiddenSwitch: test mode allows only remote-debugging-port", () => {
    expect(forbiddenSwitch({ isPackaged: true, testMode: true, hasSwitch: has("remote-debugging-port") })).toBeNull();
    expect(forbiddenSwitch({ isPackaged: true, testMode: true, hasSwitch: has("remote-debugging-pipe") })).toBe(
      "remote-debugging-pipe",
    );
  });

  it("message names the product", () => {
    expect(forbiddenSwitchMessage("log-net-log")).toBe(
      "[launch] refusing to start with --log-net-log: it would expose your Rea Claude sign-in",
    );
  });

  it("isTestMode reads REA_CLAUDE_E2E_USER_DATA only", () => {
    expect(isTestMode({ REA_CLAUDE_E2E_USER_DATA: "/tmp/x" })).toBe(true);
    expect(isTestMode({ REA_CLAUDE_E2E_USER_DATA: "" })).toBe(false);
    expect(isTestMode({ SILICO_E2E_USER_DATA: "/tmp/x" })).toBe(false);
  });

  it("userDataPathFor (D1)", () => {
    expect(userDataPathFor("/AS", {}, join)).toBe("/AS/rea-claude");
    expect(userDataPathFor("/AS", { REA_CLAUDE_E2E_USER_DATA: "/e2e" }, join)).toBe("/e2e");
  });

  it("shouldRegisterProtocol (D3)", () => {
    expect(shouldRegisterProtocol(true, { REA_CLAUDE_REGISTER_PROTOCOL: "1" })).toBe(true);
    expect(shouldRegisterProtocol(true, { REA_CLAUDE_REGISTER_PROTOCOL: "true" })).toBe(false);
    expect(shouldRegisterProtocol(true, {})).toBe(false);
    expect(shouldRegisterProtocol(false, { REA_CLAUDE_REGISTER_PROTOCOL: "1" })).toBe(false);
  });

  it("isIgnorableMainError", () => {
    expect(isIgnorableMainError(new Error("net::ERR_CONNECTION_RESET"))).toBe(true);
    expect(isIgnorableMainError("net::ERR_ABORTED")).toBe(true);
    expect(isIgnorableMainError(new Error("TypeError: x"))).toBe(false);
    expect(isIgnorableMainError({})).toBe(false);
  });

  it("shouldOfferMove", () => {
    const b = { platform: "darwin" as const, isPackaged: true, testMode: false, isInApplicationsFolder: false };
    expect(shouldOfferMove(b)).toBe(true);
    expect(shouldOfferMove({ ...b, isInApplicationsFolder: true })).toBe(false);
    expect(shouldOfferMove({ ...b, testMode: true })).toBe(false);
    expect(shouldOfferMove({ ...b, isPackaged: false })).toBe(false);
    expect(shouldOfferMove({ ...b, platform: "win32" })).toBe(false);
  });

  it("isAbnormalGpuExit", () => {
    expect(isAbnormalGpuExit({ type: "GPU", reason: "crashed" })).toBe(true);
    expect(isAbnormalGpuExit({ type: "GPU", reason: "clean-exit" })).toBe(false);
    expect(isAbnormalGpuExit({ type: "Utility", reason: "crashed" })).toBe(false);
  });
});
