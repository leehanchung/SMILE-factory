import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preReadyBootstrap } from "../../../src/main/app/bootstrap";
import type { PreReadyHost, WebContentsLike } from "../../../src/main/app/bootstrap";
import { makeTestContext } from "../helpers/context";

class Exit extends Error {}

function fakeHost(over: Partial<PreReadyHost> = {}) {
  const calls: string[] = [];
  const h = {
    uncaught: undefined as ((e: unknown) => void) | undefined,
    wcCreated: undefined as ((wc: WebContentsLike) => void) | undefined,
    gone: undefined as ((d: { type: string; reason: string; exitCode: number }) => void) | undefined,
    openUrl: undefined as ((e: { preventDefault(): void }, url: string) => void) | undefined,
    second: undefined as ((argv: readonly string[]) => void) | undefined,
    timers: [] as (() => void)[],
    ready: false,
  };
  const host: PreReadyHost = {
    isPackaged: true,
    argv: ["/exe"],
    env: {},
    hasSwitch: () => false,
    processExit: (c) => {
      calls.push(`processExit ${c}`);
      throw new Exit();
    },
    appExit: (c) => void calls.push(`appExit ${c}`),
    setName: (n) => void calls.push(`setName ${n}`),
    getAppDataPath: () => "/Users/me/Library/Application Support",
    setUserDataPath: (p) => void calls.push(`userData ${p}`),
    setAppUserModelId: (id) => void calls.push(`aumid ${id}`),
    appVersion: "0.1.0",
    relaunchIfDiskBundleNewer: () => false,
    requestSingleInstanceLock: () => true,
    setAboutPanelOptions: (o) => void calls.push(`about ${JSON.stringify(o)}`),
    onUncaughtException: (fn) => void (h.uncaught = fn),
    showErrorBox: (t, c) => void calls.push(`errorBox ${t} :: ${c.split("\n")[0]}`),
    onWebContentsCreated: (fn) => void (h.wcCreated = fn),
    onChildProcessGone: (fn) => void (h.gone = fn),
    setAsDefaultProtocolClient: (s) => {
      calls.push(`protocol ${s}`);
      return true;
    },
    onOpenUrl: (fn) => void (h.openUrl = fn),
    onSecondInstance: (fn) => void (h.second = fn),
    isReady: () => h.ready,
    setTimeout: (fn, ms) => {
      calls.push(`timeout ${ms}`);
      h.timers.push(fn);
    },
    stderr: (l) => void calls.push(`stderr ${l}`),
    ...over,
  };
  return { host, calls, h };
}

function ctxWith(over: Parameters<typeof makeTestContext>[0] = {}) {
  const handled: string[] = [];
  const ctx = makeTestContext({
    deepLinks: {
      findInArgv: (argv) => argv.find((a) => /^silico:/i.test(a)) ?? null,
      handle: (u) => void handled.push(u),
    },
    ...over,
  });
  return { ctx, handled };
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe("pre-ready bootstrap", () => {
  it("refuses forbidden switches in packaged builds with exit 78 before touching identity", () => {
    const { host, calls } = fakeHost({ hasSwitch: (s) => s === "ignore-certificate-errors" });
    expect(() => preReadyBootstrap(ctxWith().ctx, host)).toThrow(Exit);
    expect(calls).toEqual([
      "stderr [launch] refusing to start with --ignore-certificate-errors: it would expose your Rea Claude sign-in",
      "processExit 78",
    ]);
  });

  it("allows remote-debugging-port in test mode", () => {
    const { host } = fakeHost({
      hasSwitch: (s) => s === "remote-debugging-port",
      env: { REA_CLAUDE_E2E_USER_DATA: "/tmp/e2e" },
    });
    expect(preReadyBootstrap(ctxWith().ctx, host)).toEqual({ gotLock: true });
  });

  it("dev builds ignore forbidden switches and the lock", () => {
    const lock = vi.fn(() => false);
    const { host } = fakeHost({ isPackaged: false, hasSwitch: () => true, requestSingleInstanceLock: lock });
    expect(preReadyBootstrap(ctxWith().ctx, host)).toEqual({ gotLock: true });
    expect(lock).not.toHaveBeenCalled();
  });

  it("sets the separate identity (D1) in order and deletes SSLKEYLOGFILE when packaged", () => {
    const env: Record<string, string | undefined> = { SSLKEYLOGFILE: "/tmp/keys" };
    const { host, calls } = fakeHost({ env });
    preReadyBootstrap(ctxWith().ctx, host);
    expect(env.SSLKEYLOGFILE).toBeUndefined();
    expect(calls.slice(0, 3)).toEqual([
      "setName Rea Claude",
      "userData /Users/me/Library/Application Support/rea-claude",
      "aumid dev.smilefactory.rea-claude",
    ]);
    expect(calls).toContain(
      `about ${JSON.stringify({ applicationName: "Rea Claude", applicationVersion: "0.1.0", version: "rea-claude dev build" })}`,
    );
  });

  it("keeps SSLKEYLOGFILE in dev builds and honors the E2E userData override", () => {
    const env: Record<string, string | undefined> = { SSLKEYLOGFILE: "/k", REA_CLAUDE_E2E_USER_DATA: "/e2e" };
    const { host, calls } = fakeHost({ isPackaged: false, env });
    preReadyBootstrap(ctxWith().ctx, host);
    expect(env.SSLKEYLOGFILE).toBe("/k");
    expect(calls).toContain("userData /e2e");
  });

  it("stops after a disk-bundle relaunch, and swallows relaunch errors", () => {
    const a = fakeHost({ relaunchIfDiskBundleNewer: () => true });
    expect(preReadyBootstrap(ctxWith().ctx, a.host)).toEqual({ gotLock: false });
    expect(a.h.uncaught).toBeUndefined();
    const b = fakeHost({
      relaunchIfDiskBundleNewer: () => {
        throw new Error("plutil");
      },
    });
    expect(preReadyBootstrap(ctxWith().ctx, b.host)).toEqual({ gotLock: true });
  });

  it("exits when another instance holds the lock", () => {
    const { host, calls, h } = fakeHost({ requestSingleInstanceLock: () => false });
    expect(preReadyBootstrap(ctxWith().ctx, host)).toEqual({ gotLock: false });
    expect(calls).toContain("appExit 0");
    expect(h.second).toBeUndefined();
  });

  it("uncaughtException: ignores net::ERR_, otherwise reports telemetry and shows the error box", () => {
    const report = vi.fn();
    const { ctx } = ctxWith({ telemetry: { reportMainProcessError: report } });
    const { host, calls, h } = fakeHost();
    preReadyBootstrap(ctx, host);
    h.uncaught?.(new Error("net::ERR_FAILED"));
    expect(report).not.toHaveBeenCalled();
    const err = new Error("kaboom");
    h.uncaught?.(err);
    expect(report).toHaveBeenCalledWith(err);
    expect(calls.some((c) => c.startsWith("errorBox A JavaScript error occurred in the main process :: Error: kaboom"))).toBe(true);
  });

  it("uncaughtException: telemetry failure does not suppress the dialog", () => {
    const { ctx } = ctxWith({
      telemetry: {
        reportMainProcessError: () => {
          throw new Error("t");
        },
      },
    });
    const { host, calls, h } = fakeHost();
    preReadyBootstrap(ctx, host);
    h.uncaught?.("string error");
    expect(calls).toContain("errorBox A JavaScript error occurred in the main process :: string error");
  });

  it("web-contents-created: prevents unload and attaches the context menu", () => {
    const attach = vi.fn();
    const { ctx } = ctxWith({ windows: { attachContextMenu: attach } });
    const { host, h } = fakeHost();
    preReadyBootstrap(ctx, host);
    let unload: ((e: { preventDefault(): void }) => void) | undefined;
    const wc: WebContentsLike = { on: (_ev, l) => (unload = l) };
    h.wcCreated?.(wc);
    expect(attach).toHaveBeenCalledWith(wc);
    const prevent = vi.fn();
    unload?.({ preventDefault: prevent });
    expect(prevent).toHaveBeenCalled();
  });

  it("child-process-gone: abnormal GPU exit invalidates shown views after 1 s", () => {
    const invalidate = vi.fn();
    const { ctx } = ctxWith({ windows: { invalidateShownViews: invalidate } });
    const { host, calls, h } = fakeHost();
    preReadyBootstrap(ctx, host);
    h.gone?.({ type: "GPU", reason: "clean-exit", exitCode: 0 });
    h.gone?.({ type: "Utility", reason: "crashed", exitCode: 1 });
    expect(h.timers).toHaveLength(0);
    h.gone?.({ type: "GPU", reason: "crashed", exitCode: 139 });
    expect(calls).toContain("timeout 1000");
    h.timers[0]?.();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("child-process-gone: GPU invalidate waits GPU_GONE_INVALIDATE_DELAY_MS (fake timers)", () => {
    vi.useFakeTimers();
    try {
      const invalidate = vi.fn();
      const { ctx } = ctxWith({ windows: { invalidateShownViews: invalidate } });
      const { host, h } = fakeHost({ setTimeout: (fn, ms) => void setTimeout(fn, ms) });
      preReadyBootstrap(ctx, host);
      h.gone?.({ type: "GPU", reason: "oom", exitCode: 1 });
      vi.advanceTimersByTime(999);
      expect(invalidate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(invalidate).toHaveBeenCalledTimes(1);
      h.gone?.({ type: "GPU", reason: "clean-exit", exitCode: 0 });
      vi.advanceTimersByTime(5_000);
      expect(invalidate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("protocol registration only with REA_CLAUDE_REGISTER_PROTOCOL=1 in packaged builds (D3)", () => {
    const off = fakeHost();
    preReadyBootstrap(ctxWith().ctx, off.host);
    expect(off.calls.some((c) => c.startsWith("protocol"))).toBe(false);
    const on = fakeHost({ env: { REA_CLAUDE_REGISTER_PROTOCOL: "1" } });
    preReadyBootstrap(ctxWith().ctx, on.host);
    expect(on.calls).toContain("protocol silico");
    const dev = fakeHost({ isPackaged: false, env: { REA_CLAUDE_REGISTER_PROTOCOL: "1" } });
    preReadyBootstrap(ctxWith().ctx, dev.host);
    expect(dev.calls.some((c) => c.startsWith("protocol"))).toBe(false);
  });

  it("routes silico:// from argv, open-url and second-instance to ctx.deepLinks even without registration", () => {
    const { ctx, handled } = ctxWith();
    const { host, h } = fakeHost({ argv: ["/exe", "--x", "silico://welcome"] });
    preReadyBootstrap(ctx, host);
    expect(handled).toEqual(["silico://welcome"]);
    const prevent = vi.fn();
    h.openUrl?.({ preventDefault: prevent }, "silico://open?url=https%3A%2F%2Fa");
    expect(prevent).toHaveBeenCalled();
    h.second?.(["/exe", "SILICO://signup-ready"]);
    expect(handled).toEqual(["silico://welcome", "silico://open?url=https%3A%2F%2Fa", "SILICO://signup-ready"]);
  });

  it("second-instance without a link focuses or creates a shell window once ready", () => {
    const focus = vi.fn();
    const { ctx } = ctxWith({ windows: { focusOrCreateShellWindow: focus } });
    const { host, h } = fakeHost();
    preReadyBootstrap(ctx, host);
    h.second?.(["/exe"]);
    expect(focus).not.toHaveBeenCalled();
    h.ready = true;
    h.second?.(["/exe"]);
    expect(focus).toHaveBeenCalledWith("second-instance");
  });
});
