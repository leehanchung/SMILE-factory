import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: unknown, ...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, Listener>();
  const listeners = new Map<string, Listener>();
  const labSession = { name: "persist:silico" };
  const otherSession = { name: "default" };
  return { handlers, listeners, labSession, otherSession };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle: (ch: string, fn: Listener) => mocks.handlers.set(ch, fn),
    on: (ch: string, fn: Listener) => mocks.listeners.set(ch, fn),
  },
  session: {
    fromPartition: (p: string) => (p === "persist:silico" ? mocks.labSession : { name: p }),
  },
}));

import {
  blockedError,
  configureShellTrust,
  handleLab,
  handleShell,
  isLabSender,
  isTrustedShellSender,
  isTrustedShellUrl,
  isTrustedShellWebContents,
  onLab,
  onShell,
  resetShellTrustForTests,
  sendLab,
  sendShell,
} from "../../src/main/ipc/trust";

interface FakeWc {
  url: string;
  destroyed: boolean;
  session: unknown;
  sent: unknown[][];
  isDestroyed(): boolean;
  getURL(): string;
  send(...a: unknown[]): void;
}

function wc(url: string, opts: { destroyed?: boolean; session?: unknown } = {}): FakeWc {
  return {
    url,
    destroyed: opts.destroyed ?? false,
    session: opts.session ?? mocks.otherSession,
    sent: [],
    isDestroyed() {
      return this.destroyed;
    },
    getURL() {
      return this.url;
    },
    send(...a: unknown[]) {
      this.sent.push(a);
    },
  };
}

function event(sender: FakeWc, frameUrl?: string | null) {
  return { sender, senderFrame: frameUrl === undefined ? undefined : frameUrl === null ? null : { url: frameUrl } };
}

beforeEach(() => {
  mocks.handlers.clear();
  mocks.listeners.clear();
  vi.unstubAllEnvs();
  vi.stubEnv("ELECTRON_RENDERER_URL", undefined);
  vi.restoreAllMocks();
});

const PROD = { rendererUrl: undefined, rendererHtmlPath: "/Applications/X.app/Contents/Resources/app.asar/out/renderer/index.html" };
const DEV = { rendererUrl: "http://localhost:5173/", rendererHtmlPath: "/repo/out/renderer/index.html" };

describe("isTrustedShellUrl", () => {
  it("trusts only the app's own renderer index.html (hash/query allowed)", () => {
    const base = "file:///Applications/X.app/Contents/Resources/app.asar/out/renderer/index.html";
    expect(isTrustedShellUrl(base, PROD)).toBe(true);
    expect(isTrustedShellUrl(`${base}#settings-modal/general`, PROD)).toBe(true);
    expect(isTrustedShellUrl(`${base}?x=1#viewer`, PROD)).toBe(true);
  });
  it("rejects other file: URLs (downloaded/dropped HTML, other paths, remote file hosts)", () => {
    expect(isTrustedShellUrl("file:///Users/me/Downloads/evil.html", PROD)).toBe(false);
    expect(isTrustedShellUrl("file:///Applications/X.app/Contents/Resources/app.asar/out/renderer/other.html", PROD)).toBe(false);
    expect(isTrustedShellUrl("file:///x", PROD)).toBe(false);
    expect(isTrustedShellUrl("file://evil.example/Applications/X.app/Contents/Resources/app.asar/out/renderer/index.html", PROD)).toBe(false);
  });
  it("handles percent-encoded paths", () => {
    const cfg = { rendererUrl: undefined, rendererHtmlPath: "/Apps/My App/out/renderer/index.html" };
    expect(isTrustedShellUrl("file:///Apps/My%20App/out/renderer/index.html", cfg)).toBe(true);
    expect(isTrustedShellUrl("file:///Apps/My%20App/out/renderer/index2.html", cfg)).toBe(false);
  });
  it("trusts the dev renderer origin only", () => {
    expect(isTrustedShellUrl("http://localhost:5173/#viewer", DEV)).toBe(true);
    expect(isTrustedShellUrl("http://localhost:5174/", DEV)).toBe(false);
    expect(isTrustedShellUrl("file:///repo/out/renderer/index.html", DEV)).toBe(true);
  });
  it("rejects remote origins and garbage", () => {
    expect(isTrustedShellUrl("https://my.silico.run/", PROD)).toBe(false);
    expect(isTrustedShellUrl("not a url", DEV)).toBe(false);
    expect(isTrustedShellUrl("", PROD)).toBe(false);
  });
  it("never reads ELECTRON_RENDERER_URL itself (resolved once at startup)", () => {
    vi.stubEnv("ELECTRON_RENDERER_URL", "http://127.0.0.1:5173");
    configureShellTrust(PROD);
    expect(isTrustedShellUrl("http://127.0.0.1:5173/index.html")).toBe(false);
    resetShellTrustForTests();
  });
  it("configureShellTrust governs the gates used by handleShell", () => {
    configureShellTrust(PROD);
    try {
      expect(isTrustedShellUrl("file:///x")).toBe(false);
      expect(isTrustedShellSender(event(wc("file:///x"), "file:///Users/me/Downloads/evil.html") as never)).toBe(false);
      expect(
        isTrustedShellSender(event(wc("x"), "file:///Applications/X.app/Contents/Resources/app.asar/out/renderer/index.html#viewer") as never),
      ).toBe(true);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      handleShell("ping", vi.fn() as never);
      expect(() => mocks.handlers.get("ping")!(event(wc("file:///tmp/evil.html")))).toThrow("Blocked 'ping': untrusted sender.");
      expect(warn).toHaveBeenCalled();
    } finally {
      resetShellTrustForTests();
    }
  });
});

describe("isTrustedShellSender", () => {
  it("prefers the sender frame URL", () => {
    expect(isTrustedShellSender(event(wc("file:///x"), "https://evil.example/") as never)).toBe(false);
    expect(isTrustedShellSender(event(wc("https://evil.example/"), "file:///x") as never)).toBe(true);
  });
  it("falls back to sender.getURL() when no frame", () => {
    expect(isTrustedShellSender(event(wc("file:///x"), null) as never)).toBe(true);
  });
  it("tolerates a throwing senderFrame getter", () => {
    const e = {
      sender: wc("file:///x"),
      get senderFrame(): never {
        throw new Error("Render frame was disposed");
      },
    };
    expect(isTrustedShellSender(e as never)).toBe(true);
  });
  it("isTrustedShellWebContents rejects destroyed contents", () => {
    expect(isTrustedShellWebContents(wc("file:///x") as never)).toBe(true);
    expect(isTrustedShellWebContents(wc("file:///x", { destroyed: true }) as never)).toBe(false);
  });
});

describe("isLabSender", () => {
  it("requires the persist:silico session and a live webContents", () => {
    expect(isLabSender(wc("https://lab.silico.run", { session: mocks.labSession }) as never)).toBe(true);
    expect(isLabSender(wc("https://lab.silico.run") as never)).toBe(false);
    expect(isLabSender(wc("https://lab.silico.run", { session: mocks.labSession, destroyed: true }) as never)).toBe(false);
  });
});

describe("handleShell", () => {
  it("passes args through for trusted senders", async () => {
    const fn = vi.fn((_e: unknown, id: string) => `got ${id}`);
    handleShell("connections:remove", fn as never);
    const h = mocks.handlers.get("connections:remove")!;
    await expect(Promise.resolve(h(event(wc("file:///x")), "abc"))).resolves.toBe("got abc");
    expect(fn).toHaveBeenCalledOnce();
  });
  it("rejects untrusted senders with the exact message and logs", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fn = vi.fn();
    handleShell("settings:set", fn as never);
    const h = mocks.handlers.get("settings:set")!;
    expect(() => h(event(wc("https://evil.example/")), {})).toThrow("Blocked 'settings:set': untrusted sender.");
    expect(fn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[ipc] blocked 'settings:set' from untrusted sender");
  });
  it("rejects Lab pages even though they are in the lab partition", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    handleShell("labs:held-elsewhere", (() => []) as never);
    const h = mocks.handlers.get("labs:held-elsewhere")!;
    expect(() => h(event(wc("https://x.silico.run/", { session: mocks.labSession })))).toThrow(
      blockedError("labs:held-elsewhere").message,
    );
  });
});

describe("handleLab", () => {
  it("accepts lab-partition senders", async () => {
    handleLab("silico:begin-checkout", (() => "nonce") as never);
    const h = mocks.handlers.get("silico:begin-checkout")!;
    expect(await h(event(wc("https://x.silico.run/", { session: mocks.labSession })))).toBe("nonce");
  });
  it("rejects the shell renderer", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    handleLab("silico:shell-events:drain", (() => []) as never);
    const h = mocks.handlers.get("silico:shell-events:drain")!;
    expect(() => h(event(wc("file:///x")))).toThrow("Blocked 'silico:shell-events:drain': untrusted sender.");
  });
});

describe("onLab / onShell", () => {
  it("onLab forwards the raw payload from lab senders and drops others silently", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fn = vi.fn();
    onLab("silico:notify", fn);
    const l = mocks.listeners.get("silico:notify")!;
    l(event(wc("https://x.silico.run/", { session: mocks.labSession })), { kind: "finished" });
    expect(fn).toHaveBeenCalledWith(expect.anything(), { kind: "finished" });
    fn.mockClear();
    expect(l(event(wc("file:///x")), { kind: "finished" })).toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });
  it("onShell only forwards trusted shell senders", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fn = vi.fn();
    onShell("custom:thing", fn);
    const l = mocks.listeners.get("custom:thing")!;
    l(event(wc("https://evil.example/")), 1);
    expect(fn).not.toHaveBeenCalled();
    l(event(wc("file:///x")), 1, 2);
    expect(fn).toHaveBeenCalledWith(expect.anything(), 1, 2);
  });
});

describe("sendShell / sendLab", () => {
  it("sends payloads and skips destroyed webContents", () => {
    const live = wc("file:///x");
    sendShell(live as never, "lab:phase", { id: "c1", phase: "opening" });
    sendShell(live as never, "auth:expired");
    expect(live.sent).toEqual([["lab:phase", { id: "c1", phase: "opening" }], ["auth:expired"]]);
    const dead = wc("file:///x", { destroyed: true });
    sendLab(dead as never, "silico:navigate", "/home");
    expect(dead.sent).toEqual([]);
    const lab = wc("https://x.silico.run/");
    sendLab(lab as never, "silico:report-issue");
    sendLab(lab as never, "silico:checkout-return", "manage");
    expect(lab.sent).toEqual([["silico:report-issue"], ["silico:checkout-return", "manage"]]);
  });
});
