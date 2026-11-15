import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoke: [] as unknown[][],
  send: [] as unknown[][],
  listeners: new Map<string, Set<(...a: unknown[]) => void>>(),
  invokeResult: undefined as unknown,
  invokeError: null as Error | null,
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: (k: string, v: unknown) => m.exposed.set(k, v) },
  ipcRenderer: {
    invoke: (...a: unknown[]) => {
      m.invoke.push(a);
      return m.invokeError ? Promise.reject(m.invokeError) : Promise.resolve(m.invokeResult);
    },
    send: (...a: unknown[]) => m.send.push(a),
    on: (ch: string, fn: (...a: unknown[]) => void) => {
      if (!m.listeners.has(ch)) m.listeners.set(ch, new Set());
      m.listeners.get(ch)!.add(fn);
    },
    removeListener: (ch: string, fn: (...a: unknown[]) => void) => m.listeners.get(ch)?.delete(fn),
  },
}));

import type { SilicoApi, SilicoDesktopApi } from "../../src/shared/ipc";

function emit(ch: string, ...payload: unknown[]): void {
  for (const fn of m.listeners.get(ch) ?? []) fn({ sender: "evt" }, ...payload);
}

beforeEach(() => {
  m.invoke.length = 0;
  m.send.length = 0;
  m.invokeResult = undefined;
  m.invokeError = null;
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

Object.defineProperty(process, "contextIsolated", { value: true, configurable: true });

describe("preload/index (window.silico)", async () => {
  await import("../../src/preload/index");
  const api = m.exposed.get("silico") as SilicoApi;

  it("exposes platform and invoke channels with original defaults", async () => {
    expect(api.platform).toBe(process.platform);
    await api.lab.connect({ id: "c" } as never);
    await api.auth.signIn(true);
    await api.lab.hostKey.accept({ host: "h" }, "SHA256:abc");
    await api.setCompact(true, 400);
    expect(m.invoke).toEqual([
      ["lab:connect", { id: "c" }, false, undefined],
      ["auth:signIn", true, false],
      ["lab:hostKey:accept", { host: "h" }, "SHA256:abc"],
      ["window:set-compact", true, 400],
    ]);
  });

  it("forwards payloads, hides the event, and unsubscribes", () => {
    const seen: unknown[] = [];
    const off = api.lab.onPhase((e) => seen.push(e));
    emit("lab:phase", { id: "c", phase: "opening" });
    off();
    emit("lab:phase", { id: "c", phase: "waiting" });
    expect(seen).toEqual([{ id: "c", phase: "opening" }]);
  });

  it("maps viewer:content-ready payload !== false to boolean and signals carry no args", () => {
    const ready: boolean[] = [];
    api.viewer.onContentReady((r) => ready.push(r));
    emit("viewer:content-ready");
    emit("viewer:content-ready", false);
    expect(ready).toEqual([true, false]);
    const calls: unknown[][] = [];
    api.auth.onExpired((...a: unknown[]) => calls.push(a));
    emit("auth:expired", "ignored");
    expect(calls).toEqual([[]]);
  });
});

describe("preload/lab (window.silicoDesktop)", async () => {
  await import("../../src/preload/lab");
  const api = m.exposed.get("silicoDesktop") as SilicoDesktopApi;

  it("uses send for fire-and-forget calls and exposes manageReturn", () => {
    api.notify({ kind: "finished", title: "t", route: "/", dedupeKey: "k" });
    api.setBadgeCounts({ attention: 1, unread: 0 });
    api.openLabSwitcher();
    expect(m.send.map((s) => s[0])).toEqual(["silico:notify", "silico:badge-counts", "silico:open-lab-switcher"]);
    expect(api.manageReturn).toBe(true);
  });

  it("pulls MCP returns on the nudge and only forwards non-null results", async () => {
    const got: unknown[] = [];
    api.onMcpOauthReturn((r) => got.push(r));
    m.invokeResult = null;
    emit("silico:mcp-oauth-return");
    await Promise.resolve();
    await Promise.resolve();
    m.invokeResult = { outcome: "error", error: "access_denied" };
    emit("silico:mcp-oauth-return");
    await Promise.resolve();
    await Promise.resolve();
    expect(m.invoke.map((i) => i[0])).toEqual(["silico:take-mcp-oauth-return", "silico:take-mcp-oauth-return"]);
    expect(got).toEqual([{ outcome: "error", error: "access_denied" }]);
  });

  it("pulls GitHub connect returns on the nudge (take-github-connect-return), unsubscribe stops it", async () => {
    const got: unknown[] = [];
    const off = api.onGithubConnectReturn((r) => got.push(r));
    m.invokeResult = { outcome: "success" };
    emit("silico:github-connect-return");
    await settle();
    expect(m.invoke.map((i) => i[0])).toEqual(["silico:take-github-connect-return"]);
    expect(got).toEqual([{ outcome: "success" }]);
    off();
    emit("silico:github-connect-return");
    await settle();
    expect(m.invoke).toHaveLength(1);
  });

  it("forwards the checkout-return payload as-is", () => {
    const got: unknown[] = [];
    const off = api.onCheckoutReturn((o) => got.push(o));
    emit("silico:checkout-return", "success");
    emit("silico:checkout-return", "cancel");
    off();
    emit("silico:checkout-return", "success");
    expect(got).toEqual(["success", "cancel"]);
  });

  it("a rejected take is logged and swallowed (no unhandled rejection, callback not called) (T21)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown): void => void unhandled.push(r);
    process.on("unhandledRejection", onUnhandled);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const got: unknown[] = [];
      api.onGithubConnectReturn((r) => got.push(r));
      api.onMcpOauthReturn((r) => got.push(r));
      m.invokeError = new Error("Blocked 'silico:take-github-connect-return': untrusted sender.");
      emit("silico:github-connect-return");
      emit("silico:mcp-oauth-return");
      await settle();
      await new Promise((r) => setTimeout(r, 0));
      expect(got).toEqual([]);
      expect(unhandled).toEqual([]);
      expect(warn).toHaveBeenCalledWith("[silicoDesktop] silico:take-github-connect-return failed", m.invokeError);
      expect(warn).toHaveBeenCalledWith("[silicoDesktop] silico:take-mcp-oauth-return failed", m.invokeError);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      warn.mockRestore();
    }
  });
});
