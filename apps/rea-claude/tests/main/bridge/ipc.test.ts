import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", async () => (await import("./fakes")).electronMock);

import { LabInvokeChannel, LabSendChannel } from "@shared/ipc";
import { createBridgeService, registerBridgeIpc } from "../../../src/main/bridge";
import { bridgeInternals } from "../../../src/main/bridge/service";
import { makeTestContext } from "../helpers/context";
import { FakeNotification, FakeSession, FakeWc, resetElectron, state } from "./fakes";
import { makeWorld } from "./world";

type Fn = (...a: unknown[]) => unknown;

function setup() {
  const returns = {
    begin: vi.fn((kind: string) => `nonce-${kind}`),
    takeMcpOauthReturn: vi.fn((c: string | null) => (c ? { outcome: "error" as const, error: "x" } : null)),
    takeGithubConnectReturn: vi.fn((c: string | null) => (c ? { outcome: "success" as const } : null)),
  };
  const world = makeWorld({ ctxOverrides: { returns } });
  world.telemetry.drainShellEvents.mockReturnValue([{ event: "desktop_shell", kind: "down-panel" }]);
  createBridgeService(world.ctx);
  registerBridgeIpc(world.ctx);
  const invoke = (ch: string, sender: FakeWc) => (state.handlers.get(ch) as Fn)({ sender, senderFrame: null });
  const send = (ch: string, sender: FakeWc, payload?: unknown) => (state.listeners.get(ch) as Fn)({ sender }, payload);
  return { world, returns, invoke, send };
}

beforeEach(() => {
  resetElectron();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("registerBridgeIpc", () => {
  it("registers every silico:* Lab channel", () => {
    setup();
    for (const ch of Object.values(LabInvokeChannel)) expect(state.handlers.has(ch)).toBe(true);
    for (const ch of Object.values(LabSendChannel)) expect(state.listeners.has(ch)).toBe(true);
  });

  it("rejects untrusted invokes with the exact error and drops untrusted sends", async () => {
    const { world, invoke, send } = setup();
    const outsider = new FakeWc("file:///index.html", new FakeSession("default"));
    for (const ch of Object.values(LabInvokeChannel)) {
      expect(() => invoke(ch, outsider)).toThrow(`Blocked '${ch}': untrusted sender.`);
    }
    send(LabSendChannel.openDesktopSettings, outsider);
    send(LabSendChannel.openLabSwitcher, outsider);
    send(LabSendChannel.notify, outsider, { kind: "needsInput", title: "t", route: "/", dedupeKey: "k" });
    await new Promise((r) => setTimeout(r, 0));
    expect(world.windows.openDesktopSettingsFor).not.toHaveBeenCalled();
    expect(world.windows.openLabSwitcherFor).not.toHaveBeenCalled();
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("begin-* and take-* delegate to ctx.returns with the sender's connId (null for viewers)", async () => {
    const { world, returns, invoke } = setup();
    const lab = world.addLab("c1");
    const viewer = new FakeWc();
    expect(await invoke(LabInvokeChannel.beginCheckout, lab.wc)).toBe("nonce-checkout");
    expect(returns.begin).toHaveBeenLastCalledWith("checkout", lab.wc, "c1");
    expect(await invoke(LabInvokeChannel.beginMcpOauth, viewer)).toBe("nonce-mcp-oauth");
    expect(returns.begin).toHaveBeenLastCalledWith("mcp-oauth", viewer, null);
    expect(await invoke(LabInvokeChannel.beginGithubConnect, lab.wc)).toBe("nonce-github-connect");
    expect(returns.begin).toHaveBeenLastCalledWith("github-connect", lab.wc, "c1");
    expect(await invoke(LabInvokeChannel.takeMcpOauthReturn, lab.wc)).toEqual({ outcome: "error", error: "x" });
    expect(await invoke(LabInvokeChannel.takeMcpOauthReturn, viewer)).toBeNull();
    expect(await invoke(LabInvokeChannel.takeGithubConnectReturn, lab.wc)).toEqual({ outcome: "success" });
    expect(returns.takeGithubConnectReturn).toHaveBeenLastCalledWith("c1");
  });

  it("drain delegates to ctx.telemetry (any Lab-trusted sender, incl. viewers)", async () => {
    const { world, invoke } = setup();
    expect(await invoke(LabInvokeChannel.shellEventsDrain, new FakeWc())).toEqual([{ event: "desktop_shell", kind: "down-panel" }]);
    expect(world.telemetry.drainShellEvents).toHaveBeenCalledTimes(1);
  });

  it("recover-session delegates to ctx.windows and maps a throw to the error result", async () => {
    const { world, invoke } = setup();
    const lab = world.addLab("c1");
    expect(await invoke(LabInvokeChannel.recoverSession, lab.wc)).toEqual({ status: "accepted" });
    (world.windows.handleRecoverSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    expect(await invoke(LabInvokeChannel.recoverSession, lab.wc)).toEqual({
      status: "error",
      message: "Could not restore this window. Please try again.",
    });
  });

  it("open-desktop-settings / open-lab-switcher forward the sender to ctx.windows", () => {
    const { world, send } = setup();
    const lab = world.addLab("c1");
    send(LabSendChannel.openDesktopSettings, lab.wc);
    send(LabSendChannel.openLabSwitcher, lab.wc);
    expect(world.windows.openDesktopSettingsFor).toHaveBeenCalledWith(lab.wc);
    expect(world.windows.openLabSwitcherFor).toHaveBeenCalledWith(lab.wc);
  });

  it("notify and badge-counts reach the pipelines; garbage never throws", async () => {
    const { world, send } = setup();
    const lab = world.addLab("c1");
    send(LabSendChannel.notify, lab.wc, { kind: "needsInput", title: "Hi", route: "/r", dedupeKey: "k" });
    send(LabSendChannel.notify, lab.wc, "garbage");
    send(LabSendChannel.badgeCounts, lab.wc, { attention: 2, unread: 0 });
    send(LabSendChannel.badgeCounts, lab.wc, undefined);
    await new Promise((r) => setTimeout(r, 0));
    await bridgeInternals(world.ctx).badgeSettled();
    expect(FakeNotification.instances).toHaveLength(1);
    expect(state.dock.setBadge).toHaveBeenLastCalledWith("2");
  });

  it("throws a clear error when the bridge service was not created for this context", () => {
    expect(() => registerBridgeIpc(makeTestContext())).toThrow(/createBridgeService/);
  });
});
