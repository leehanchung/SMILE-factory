import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_PROD, GATEWAY_STAGING } from "@shared/config";
import type { AuthService, MainContext, ReturnsService, SignupService, WindowService, DeepLinkService } from "../../../src/main/services";
import type { Connection, DiscoveredLab, LabsListResult, OpenResult } from "@shared/ipc";

const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...a: unknown[]) => unknown>() }));
vi.mock("electron", async () => (await import("./fakes")).electronMock(mocks.handlers));

import { buildAuthModule, getAuthModule, type AuthModule } from "../../../src/main/auth/module";
import {
  createAuthService,
  createDeepLinkService,
  createReturnsService,
  createSignupService,
  registerAuthIpc,
} from "../../../src/main/auth";
import { registerAuthIpcWith } from "../../../src/main/auth/ipc";
import { FakeView, FakeWc, FakeWin } from "./fakes";
import { flush, json, makeCtx, makeProof, tempDir, type Recorded } from "./helpers";
import type { AuthDeps } from "../../../src/main/auth/platform";

const NOW = 1_700_000_000_000;
const SEC = NOW / 1000;

interface Harness {
  ctx: MainContext;
  rec: Recorded;
  m: AuthModule;
  views: FakeView[];
  opened: string[];
  focusApp: ReturnType<typeof vi.fn>;
  dock: string[];
  winCalls: Record<string, unknown[][]>;
  dir: string;
}

function harness(o: {
  windows?: Partial<WindowService>;
  staging?: boolean;
  lab?: Record<string, unknown>;
  connections?: Record<string, unknown>;
  bridge?: Record<string, unknown>;
  deps?: AuthDeps;
  fromWc?: (wc: unknown) => unknown;
} = {}): Harness {
  const dir = tempDir();
  const winCalls: Record<string, unknown[][]> = {};
  const record =
    (name: string, ret?: unknown) =>
    (...args: unknown[]) => {
      (winCalls[name] ??= []).push(args);
      return ret;
    };
  const authHolder: Partial<AuthService> = {};
  const signupHolder: Partial<SignupService> = {};
  const returnsHolder: Partial<ReturnsService> = {};
  const deepHolder: Partial<DeepLinkService> = {};
  const { ctx, rec } = makeCtx({
    dir,
    staging: o.staging ?? false,
    windows: {
      hideLabView: record("hideLabView"),
      activateWindow: record("activateWindow"),
      revealIfHidden: record("revealIfHidden"),
      focusOrCreateShellWindow: record("focusOrCreateShellWindow") as never,
      openShareViewer: record("openShareViewer"),
      applySignOut: record("applySignOut"),
      ...o.windows,
    },
    extra: {
      auth: authHolder,
      signup: signupHolder,
      returns: returnsHolder,
      deepLinks: deepHolder,
      lab: o.lab ?? {},
      connections: o.connections ?? {},
      bridge: o.bridge ?? { clearBadgeCounts: record("clearBadgeCounts") },
    },
  });
  const views: FakeView[] = [];
  const opened: string[] = [];
  const dock: string[] = [];
  const focusApp = vi.fn();
  const m = buildAuthModule(ctx, {
    now: () => NOW,
    fetch: async () => json(404, {}),
    randomBytes: (n) => Buffer.alloc(n, 1),
    randomUUID: (() => {
      let i = 0;
      return () => `00000000-0000-4000-8000-00000000000${i++}`;
    })(),
    safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => "" },
    openExternal: (u) => void opened.push(u),
    focusApp,
    dockBounce: (t) => void dock.push(t),
    createSignupView: () => {
      const v = new FakeView();
      views.push(v);
      return v as never;
    },
    windowFromWebContents: (o.fromWc ?? (() => null)) as never,
    ...o.deps,
  });
  Object.assign(authHolder, m.auth);
  Object.assign(signupHolder, m.signup);
  Object.assign(returnsHolder, m.returns);
  Object.assign(deepHolder, m.deepLinks);
  return { ctx, rec, m, views, opened, focusApp, dock, winCalls, dir };
}

function proof(extra: Record<string, unknown> = {}): string {
  return makeProof({ sub: "u1", login: "bob", exp: SEC + 3600, purpose: "labs", iss: "silico-lab-auth", ...extra }, 120);
}

afterEach(() => {
  vi.useRealTimers();
  mocks.handlers.clear();
});

// ---------------------------------------------------------------------------
describe("entry exports", () => {
  it("share one module per context and keep the frozen service shapes", () => {
    const { ctx } = makeCtx({ dir: tempDir() });
    const auth = createAuthService(ctx);
    expect(createAuthService(ctx)).toBe(auth);
    expect(getAuthModule(ctx).auth).toBe(auth);
    expect(Object.keys(createDeepLinkService(ctx)).sort()).toEqual(["findInArgv", "handle", "markReady"]);
    expect(Object.keys(createReturnsService(ctx)).sort()).toEqual(["begin", "install", "takeGithubConnectReturn", "takeMcpOauthReturn"]);
    expect(createSignupService(ctx)).toBe(getAuthModule(ctx).signup);
    expect(createDeepLinkService(ctx).findInArgv(["x", "silico://welcome"])).toBe("silico://welcome");
  });
});

// ---------------------------------------------------------------------------
describe("signup view", () => {
  it("opens a sandboxed view on persist:silico-signup at the settings gateway, below the measured bar", async () => {
    const h = harness({ staging: true });
    const createSpy = vi.fn((_prefs: unknown) => {
      const v = new FakeView();
      h.views.push(v);
      return v;
    });
    const m = buildAuthModule(h.ctx, { createSignupView: createSpy as never, now: () => NOW });
    const win = new FakeWin();
    win.webContents.jsResult = 90.2;
    await m.signup.open(win as never);
    expect(createSpy.mock.calls[0]?.[0]).toEqual({ partition: "persist:silico-signup", sandbox: true, contextIsolation: true, nodeIntegration: false });
    const view = h.views[0] as FakeView;
    expect(view.webContents.loads).toEqual([`${GATEWAY_STAGING}/beta-signup`]);
    expect(win.children).toEqual([view]);
    expect(view.visible).toBe(true);
    expect(win.webContents.sent).toEqual([["signup:opened"]]);
    await flush();
    expect(view.bounds).toEqual({ x: 0, y: 91, width: 1000, height: 709 });
    expect(m.signup.isOpen(win as never)).toBe(true);
    expect(m.signup.isSignupWebContents(view.webContents as never)).toBe(true);
    expect(m.signup.showingWindow()).toBe(win);
    win.webContents.zoom = 2;
    m.signup.relayout(win as never);
    expect(view.bounds).toEqual({ x: 0, y: 182, width: 1000, height: 618 });
  });

  it("defaults the bar to 78 px when it cannot be measured", async () => {
    const h = harness();
    const win = new FakeWin();
    win.webContents.jsResult = "nope";
    await h.m.signup.open(win as never);
    await flush();
    expect(h.views[0]?.bounds).toEqual({ x: 0, y: 78, width: 1000, height: 722 });
  });

  it("errors: destroyed window, untrusted destination, load failure closes the view", async () => {
    const h = harness();
    const gone = new FakeWin();
    gone.destroyed = true;
    await expect(h.m.signup.open(gone as never)).rejects.toThrow("The Silico window is no longer available.");
    await expect(h.m.signup.open(null as never)).rejects.toThrow("The Silico window is no longer available.");
    const win = new FakeWin();
    await expect(h.m.signup.open(win as never, "https://example.com/x")).rejects.toThrow("Refusing to open an untrusted signup destination.");
    await expect(h.m.signup.open(win as never, "https://my.silico.run/beta-signup/github")).rejects.toThrow("Refusing to open an untrusted signup destination.");
    const h2 = harness({
      deps: {
        createSignupView: () => {
          const v = new FakeView();
          v.webContents.loadError = new Error("ERR_FAILED");
          return v as never;
        },
      },
    });
    await expect(h2.m.signup.open(win as never)).rejects.toThrow("ERR_FAILED");
    expect(h2.m.signup.isOpen(win as never)).toBe(false);
    expect(win.webContents.sent).toEqual([["signup:opened"], ["signup:closed"]]);
  });

  it("re-shows an existing view and navigates only when the URL differs", async () => {
    const h = harness();
    const win = new FakeWin();
    await h.m.signup.open(win as never);
    await h.m.signup.open(win as never);
    await h.m.signup.open(win as never, `${GATEWAY_PROD}/beta-signup/confirm?token=x`);
    expect(h.views).toHaveLength(1);
    expect(h.views[0]?.webContents.loads).toEqual([`${GATEWAY_PROD}/beta-signup`, `${GATEWAY_PROD}/beta-signup/confirm?token=x`]);
    expect(win.webContents.sent.filter((s) => s[0] === "signup:opened")).toHaveLength(3);
  });

  it("close removes the view, closes its webContents and emits signup:closed", async () => {
    const h = harness();
    const win = new FakeWin();
    await h.m.signup.open(win as never);
    const view = h.views[0] as FakeView;
    h.m.signup.close(win as never);
    expect(win.children).toEqual([]);
    expect(view.webContents.destroyed).toBe(true);
    expect(win.webContents.sent.at(-1)).toEqual(["signup:closed"]);
    expect(h.m.signup.isOpen(win as never)).toBe(false);
    h.m.signup.close(win as never); // idempotent
    expect(win.webContents.sent.filter((s) => s[0] === "signup:closed")).toHaveLength(1);
  });

  it("renderer crash closes the view", async () => {
    const h = harness();
    const win = new FakeWin();
    await h.m.signup.open(win as never);
    h.views[0]?.webContents.emit("render-process-gone");
    expect(h.m.signup.isOpen(win as never)).toBe(false);
  });

  it("window.open is always denied; embedded loads in place, others go to the system browser (github throttled)", async () => {
    let now = NOW;
    const h = harness({ deps: { now: () => now } });
    const win = new FakeWin();
    await h.m.signup.open(win as never);
    const wc = h.views[0]?.webContents as FakeWc;
    const open = (url: string) => wc.openHandler?.({ url });
    expect(open("https://github.com/login")).toEqual({ action: "deny" });
    expect(wc.loads.at(-1)).toBe("https://github.com/login");
    expect(open("https://example.com/terms")).toEqual({ action: "deny" });
    expect(open(`${GATEWAY_PROD}/beta-signup/github`)).toEqual({ action: "deny" });
    expect(open(`${GATEWAY_PROD}/beta-signup/github`)).toEqual({ action: "deny" });
    now += 2_500;
    open(`${GATEWAY_PROD}/beta-signup/github`);
    expect(open("file:///etc/passwd")).toEqual({ action: "deny" });
    await flush();
    expect(h.opened).toEqual([
      "https://example.com/terms",
      `${GATEWAY_PROD}/beta-signup/github?desktop=1`,
      `${GATEWAY_PROD}/beta-signup/github?desktop=1`,
    ]);
  });

  it("navigation policy: embedded allowed, external/blocked prevented", async () => {
    const h = harness();
    const win = new FakeWin();
    await h.m.signup.open(win as never);
    const wc = h.views[0]?.webContents as FakeWc;
    const nav = (url: string, ev = "will-navigate") => {
      const e = { prevented: false, preventDefault() { this.prevented = true; } };
      wc.emit(ev, e, url);
      return e.prevented;
    };
    expect(nav(`${GATEWAY_PROD}/beta-signup/x`)).toBe(false);
    expect(nav("https://github.com/x", "will-redirect")).toBe(false);
    expect(nav("https://example.com/")).toBe(true);
    expect(nav("javascript:void 0")).toBe(true);
    await flush();
    expect(h.opened).toEqual(["https://example.com/"]);
  });

  describe("signup-ready adoption", () => {
    const lab = (over: Partial<DiscoveredLab> = {}): DiscoveredLab => ({
      deploymentId: "lab-1",
      labPublicHost: "lab-1.silico.run",
      routeMode: "managed",
      stale: false,
      updateAvailable: false,
      updateRequired: false,
      ...over,
    });

    function adoptHarness(opts: { labs?: LabsListResult; existing?: Connection[]; open?: OpenResult } = {}) {
      const upserts: unknown[] = [];
      const openCalls: unknown[][] = [];
      const h = harness({
        lab: {
          listLabs: async () => opts.labs ?? { ok: true, labs: [lab()], gatewayUrl: GATEWAY_STAGING, login: "bob" },
          openLab: async (...a: unknown[]) => {
            openCalls.push(a);
            return opts.open ?? { status: "opened" };
          },
        },
        connections: {
          list: async () => opts.existing ?? [],
          upsert: async (c: Connection) => {
            upserts.push(c);
            return { ...c, id: c.id ?? "gen" };
          },
        },
      });
      return { h, upserts, openCalls };
    }

    async function openAt(h: Harness, pageUrl: string) {
      const win = new FakeWin();
      await h.m.signup.open(win as never);
      const wc = h.views[0]?.webContents as FakeWc;
      wc.url = pageUrl;
      const fire = (url: string) => {
        const e = { prevented: false, preventDefault() { this.prevented = true; } };
        wc.emit("will-navigate", e, url);
        return e.prevented;
      };
      return { win, wc, fire };
    }

    const readyUrl = (p: string, extra = "") => `silico://signup-ready?deployment_id=lab-1&proof=${p}${extra}`;

    it("adopts identity, saves the managed connection, closes signup and opens the Lab", async () => {
      const { h, upserts, openCalls } = adoptHarness();
      const { win, fire } = await openAt(h, `${GATEWAY_STAGING}/beta-signup/done`);
      expect(fire(readyUrl(proof(), "&return_to=/onboarding/compute"))).toBe(true);
      await vi.waitFor(() => expect(openCalls).toHaveLength(1));
      expect(upserts).toEqual([
        {
          id: `managed:bob:lab-1:${GATEWAY_STAGING}`,
          name: "lab-1",
          icon: "flask",
          deploymentId: "lab-1",
          labUrl: "https://lab-1.silico.run",
          routeMode: "managed",
          ssh: undefined,
          owner: "bob",
          gatewayUrl: GATEWAY_STAGING,
          dismissed: undefined,
        },
      ]);
      const sent = win.webContents.sent.map((s) => s[0]);
      expect(sent).toEqual(["signup:opened", "connections:changed", "signup:closed", "auth:changed"]);
      expect(win.webContents.sent[3]?.[1]).toMatchObject({ status: "signed-in", login: "bob", gatewayUrl: GATEWAY_STAGING });
      expect(openCalls[0]?.[1]).toBe(win);
      expect(openCalls[0]?.[2]).toEqual({ reachBudgetMs: 3000, browserFallback: false, returnTo: "/onboarding/compute" });
      expect(await h.m.core.status()).toMatchObject({ status: "signed-in", expiresAt: (SEC + 3600) * 1000 });
    });

    it("reuses a matching existing connection (keeps id/name/icon)", async () => {
      const existing: Connection = { id: "c1", name: "Mine", icon: "rocket", deploymentId: "lab-1", labUrl: "", owner: "bob", gatewayUrl: GATEWAY_PROD };
      const { h, upserts } = adoptHarness({ existing: [existing], labs: { ok: true, labs: [lab()], gatewayUrl: GATEWAY_PROD, login: "bob" } });
      const { fire } = await openAt(h, `${GATEWAY_PROD}/beta-signup`);
      fire(readyUrl(proof()));
      await vi.waitFor(() => expect(upserts).toHaveLength(1));
      expect(upserts[0]).toMatchObject({ id: "c1", name: "Mine", icon: "rocket", gatewayUrl: GATEWAY_PROD });
    });

    it("ignored (but prevented) from a non-gateway page and handled only once per view", async () => {
      const { h, openCalls } = adoptHarness();
      const { wc, fire } = await openAt(h, "https://github.com/x");
      expect(fire(readyUrl(proof()))).toBe(true);
      await flush();
      expect(openCalls).toHaveLength(0);
      wc.url = `${GATEWAY_PROD}/beta-signup`;
      fire(readyUrl(proof()));
      fire(readyUrl(proof()));
      await vi.waitFor(() => expect(openCalls).toHaveLength(1));
      await flush();
      expect(openCalls).toHaveLength(1);
    });

    it.each([
      ["not discovered", { labs: { ok: true, labs: [], gatewayUrl: GATEWAY_PROD, login: "bob" } as LabsListResult }],
      ["not managed", { labs: { ok: true, labs: [lab({ routeMode: "cluster" })], gatewayUrl: GATEWAY_PROD, login: "bob" } as LabsListResult }],
      ["discovery error", { labs: { ok: false, error: "Discovery failed (HTTP 500)." } as LabsListResult }],
    ])("failure (%s) writes the fallback text into #setup-sub", async (_n, opts) => {
      const { h } = adoptHarness(opts);
      const { wc, fire } = await openAt(h, `${GATEWAY_PROD}/beta-signup`);
      fire(readyUrl(proof()));
      await vi.waitFor(() => expect(wc.js.some((j) => j.includes("setup-sub"))).toBe(true));
      expect(wc.js.find((j) => j.includes("setup-sub"))).toBe(
        `document.getElementById('setup-sub').textContent = ${JSON.stringify("Your Lab is ready, but Silico couldn't open it automatically. Use Back to login and sign in.")}`,
      );
    });

    it("open failure after the view closed: connection kept, no page text (view is gone)", async () => {
      const { h, upserts, openCalls } = adoptHarness({ open: { status: "unreachable", url: "x" } as OpenResult });
      const { wc, fire } = await openAt(h, `${GATEWAY_PROD}/beta-signup`);
      fire(readyUrl(proof()));
      await vi.waitFor(() => expect(openCalls).toHaveLength(1));
      await flush();
      expect(upserts).toHaveLength(1);
      expect(wc.destroyed).toBe(true);
      expect(wc.js.some((j) => j.includes("setup-sub"))).toBe(false);
    });

    it("invalid signup proof is rejected and nothing is saved", async () => {
      const { h, upserts } = adoptHarness();
      const { wc, fire } = await openAt(h, `${GATEWAY_PROD}/beta-signup`);
      fire(readyUrl(proof({ iss: "nope" })));
      await vi.waitFor(() => expect(wc.js.some((j) => j.includes("setup-sub"))).toBe(true));
      expect(upserts).toEqual([]);
      expect(await h.m.core.status()).toEqual({ status: "signed-out" });
    });
  });
});

// ---------------------------------------------------------------------------
describe("returns", () => {
  function retHarness(winFor: FakeWin | null = new FakeWin(), labWc: FakeWc | null = null) {
    let readyCb: ((connId: string, wc: unknown) => void) | null = null;
    const h = harness({
      windows: {
        findLab: (() => (winFor ? { win: winFor, connId: "c1", shown: true } : null)) as never,
        windowForConn: (() => winFor) as never,
        labWebContentsForConn: (() => labWc) as never,
        onLabReady: ((cb: (c: string, w: unknown) => void) => {
          readyCb = cb;
          return () => {};
        }) as never,
      },
    });
    return { h, win: winFor, fireReady: (c: string, wc: unknown) => readyCb?.(c, wc) };
  }

  it("MCP OAuth: focus, enqueue, reveal, payload-less nudge; take pops newest; stale nonce swallowed", () => {
    const { h, win } = retHarness();
    const sender = new FakeWc();
    const n1 = h.m.returns.begin("mcp-oauth", sender as never, "c1");
    const n2 = h.m.returns.begin("mcp-oauth", sender as never, "c1");
    expect(n1).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.m.returns.handleDeepLink(`silico://mcp-oauth-return?outcome=code&code=A&state=S&s=${n1}`)).toBe(true);
    expect(h.m.returns.handleDeepLink(`silico://mcp-oauth-return?outcome=error&error=access_denied&s=${n2}`)).toBe(true);
    expect(h.rec.causes).toContainEqual({ cause: "deep-link:mcp-oauth", details: "c1" });
    expect(h.winCalls.activateWindow?.[0]).toEqual([win, "deep-link:mcp-oauth"]);
    expect(win?.calls).toContain("show");
    expect(h.winCalls.revealIfHidden).toHaveLength(2);
    expect(sender.sent).toEqual([["silico:mcp-oauth-return"], ["silico:mcp-oauth-return"]]);
    expect(h.m.returns.takeMcpOauthReturn("c1")).toEqual({ outcome: "error", error: "access_denied" });
    expect(h.m.returns.takeMcpOauthReturn("c1")).toEqual({ outcome: "code", code: "A", state: "S" });
    expect(h.m.returns.takeMcpOauthReturn("c1")).toBeNull();
    expect(h.m.returns.takeMcpOauthReturn(null)).toBeNull();
    // reused nonce: swallowed (true) without effects
    expect(h.m.returns.handleDeepLink(`silico://mcp-oauth-return?outcome=code&code=A&state=S&s=${n1}`)).toBe(true);
    expect(sender.sent).toHaveLength(2);
  });

  it("MCP OAuth with connId null drops the payload (focus only)", () => {
    const { h } = retHarness();
    const sender = new FakeWc();
    const n = h.m.returns.begin("mcp-oauth", sender as never, null);
    h.m.returns.handleDeepLink(`silico://mcp-oauth-return?outcome=code&code=A&state=S&s=${n}`);
    expect(sender.sent).toEqual([]);
  });

  it("MCP nonce expires after 15 minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let now = NOW;
    const h = harness({ deps: { now: () => now } });
    const n = h.m.returns.begin("mcp-oauth", new FakeWc() as never, "c1");
    now += 15 * 60_000 + 1;
    expect(h.m.returns.handleDeepLink(`silico://mcp-oauth-return?outcome=code&code=A&state=S&s=${n}`)).toBe(true);
    expect(h.m.returns.takeMcpOauthReturn("c1")).toBeNull();
  });

  it("GitHub connect: success is sticky against later errors; take clears", () => {
    const { h } = retHarness();
    const sender = new FakeWc();
    const a = h.m.returns.begin("github-connect", sender as never, "c1");
    const b = h.m.returns.begin("github-connect", sender as never, "c1");
    h.m.returns.handleDeepLink(`silico://github-connect-return?outcome=success&s=${a}`);
    h.m.returns.handleDeepLink(`silico://github-connect-return?outcome=error&error=denied&s=${b}`);
    expect(sender.sent).toEqual([["silico:github-connect-return"], ["silico:github-connect-return"]]);
    expect(h.rec.causes.map((c) => c.cause)).toContain("deep-link:github-connect");
    expect(h.m.returns.takeGithubConnectReturn("c1")).toEqual({ outcome: "success" });
    expect(h.m.returns.takeGithubConnectReturn("c1")).toBeNull();
    expect(h.m.returns.takeGithubConnectReturn(null)).toBeNull();
  });

  it("checkout: live sender gets the outcome; dead sender → pending until the Lab is ready", () => {
    const win = new FakeWin();
    win.minimized = true;
    const { h, fireReady } = retHarness(win, null);
    h.m.returns.install();
    const live = new FakeWc();
    const n1 = h.m.returns.begin("checkout", live as never, "c1");
    h.m.returns.handleDeepLink(`silico://checkout-return?outcome=success&s=${n1}`);
    expect(live.sent).toEqual([["silico:checkout-return", "success"]]);
    expect(win.calls).toEqual(["restore", "show", "focus"]);
    expect(h.focusApp).toHaveBeenCalledTimes(1);
    expect(h.rec.causes).toContainEqual({ cause: "deep-link:checkout", details: "c1" });

    const dead = new FakeWc();
    dead.destroyed = true;
    const n2 = h.m.returns.begin("checkout", dead as never, "c1");
    h.m.returns.handleDeepLink(`silico://checkout-return?outcome=cancel&s=${n2}`);
    const n3 = h.m.returns.begin("checkout", dead as never, "c1");
    h.m.returns.handleDeepLink(`silico://checkout-return?outcome=manage&s=${n3}`);
    expect(dead.sent).toEqual([]);
    const readyWc = new FakeWc();
    fireReady("c2", readyWc);
    expect(readyWc.sent).toEqual([]);
    fireReady("c1", readyWc);
    expect(readyWc.sent).toEqual([["silico:checkout-return", "manage"]]);
    fireReady("c1", readyWc);
    expect(readyWc.sent).toHaveLength(1);
    // single use
    h.m.returns.handleDeepLink(`silico://checkout-return?outcome=success&s=${n1}`);
    expect(live.sent).toHaveLength(1);
  });

  it("checkout falls back to the connection's live Lab view", () => {
    const labWc = new FakeWc();
    const { h } = retHarness(new FakeWin(), labWc);
    const dead = new FakeWc();
    dead.destroyed = true;
    const n = h.m.returns.begin("checkout", dead as never, "c1");
    h.m.returns.handleDeepLink(`silico://checkout-return?outcome=success&s=${n}`);
    expect(labWc.sent).toEqual([["silico:checkout-return", "success"]]);
  });

  it("unmatched links are not claimed", () => {
    const { h } = retHarness();
    expect(h.m.returns.handleDeepLink("silico://nothing")).toBe(false);
    expect(h.m.returns.handleDeepLink("silico://mcp-oauth-return?outcome=code&s=a_b")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("deep links", () => {
  it("stashes only the latest link before ready and dispatches it on markReady", async () => {
    const h = harness();
    h.m.deepLinks.handle("silico://welcome");
    h.m.deepLinks.handle("silico://open?url=https%3A%2F%2Fa.silico.run%2Fx");
    expect(h.winCalls.openShareViewer).toBeUndefined();
    h.m.deepLinks.markReady();
    await flush();
    expect(h.winCalls.openShareViewer).toEqual([["https://a.silico.run/x"]]);
    expect(h.winCalls.focusOrCreateShellWindow).toBeUndefined();
    h.m.deepLinks.handle("silico://welcome");
    await flush();
    expect(h.winCalls.focusOrCreateShellWindow).toEqual([["deep-link:welcome"]]);
    expect(h.rec.causes.filter((c) => c.cause === "deep-link:delivered").map((c) => c.details)).toEqual(["open", "welcome"]);
    expect(h.rec.causes).toContainEqual({ cause: "deep-link:share", details: "a.silico.run" });
  });

  function signupHarness(opts: { signedIn?: boolean; resume?: string | null; staging?: boolean }) {
    const win = new FakeWin();
    const created: FakeWin[] = [];
    const fetchCalls: string[] = [];
    const h = harness({
      staging: opts.staging ?? false,
      windows: {
        primaryShellWindow: (() => win) as never,
        createShellWindow: (() => {
          const w = new FakeWin();
          created.push(w);
          return w;
        }) as never,
      },
      deps: {
        fetch: async (url) => {
          fetchCalls.push(url);
          return opts.resume ? json(200, { resume_token: opts.resume }) : json(500, {});
        },
      },
    });
    return { h, win, created, fetchCalls };
  }

  const TOKEN = "t".repeat(43);

  it("signup?token: signed in on the settings gateway → desktop-continue → resume URL in the signup view", async () => {
    const rt = "R".repeat(85);
    const { h, win, fetchCalls } = signupHarness({ resume: rt });
    await h.m.core.adoptSignupProof(proof(), false);
    await h.m.deepLinks.dispatch(`silico://signup?token=${TOKEN}`);
    expect(fetchCalls).toEqual([`${GATEWAY_PROD}/beta-signup/desktop-continue`]);
    expect(h.views[0]?.webContents.loads).toEqual([`${GATEWAY_PROD}/beta-signup/resume?token=${rt}`]);
    expect(win.webContents.sent[0]).toEqual(["app:navigate", "connections"]);
    expect(h.winCalls.hideLabView).toEqual([[win]]);
    expect(win.calls).toEqual(["show", "focus"]);
    expect(h.focusApp).toHaveBeenCalled();
    expect(h.rec.causes.map((c) => c.cause)).toContain("deep-link:signup");
  });

  it("signup?token: signed out → confirm URL", async () => {
    const { h } = signupHarness({ staging: true });
    await h.m.deepLinks.dispatch(`silico://signup?token=${TOKEN}`);
    expect(h.views[0]?.webContents.loads).toEqual([`${GATEWAY_STAGING}/beta-signup/confirm?token=${TOKEN}`]);
  });

  it("signup-resume → resume URL; reuses the window already showing signup", async () => {
    const { h, win } = signupHarness({});
    const other = new FakeWin();
    await h.m.signup.open(other as never);
    const rt = "Q".repeat(80);
    await h.m.deepLinks.dispatch(`silico://signup-resume?token=${rt}`);
    expect(h.views[0]?.webContents.loads.at(-1)).toBe(`${GATEWAY_PROD}/beta-signup/resume?token=${rt}`);
    expect(win.webContents.sent).toEqual([]);
    expect(other.webContents.sent.some((s) => s[0] === "app:navigate")).toBe(true);
  });

  it("creates a shell window when none exists", async () => {
    const created: FakeWin[] = [];
    const h = harness({
      windows: {
        primaryShellWindow: (() => null) as never,
        createShellWindow: (() => {
          const w = new FakeWin();
          created.push(w);
          return w;
        }) as never,
      },
    });
    await h.m.deepLinks.dispatch(`silico://signup-resume?token=${"Q".repeat(80)}`);
    expect(created).toHaveLength(1);
  });

  it("routes return links to the return handlers; ignores unknown links", async () => {
    const h = harness({ windows: { findLab: (() => null) as never, windowForConn: (() => null) as never } });
    const wc = new FakeWc();
    const n = h.m.returns.begin("github-connect", wc as never, "c9");
    await h.m.deepLinks.dispatch(`silico://github-connect-return?outcome=success&s=${n}`);
    expect(wc.sent).toEqual([["silico:github-connect-return"]]);
    await h.m.deepLinks.dispatch("silico://unknown-thing");
    await h.m.deepLinks.dispatch("silico://signup?token=short");
    expect(h.views).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe("IPC", () => {
  const trusted = (sender: FakeWc) => ({ sender, senderFrame: { url: "file:///index.html" } });

  function ipcHarness(fromWc: (wc: unknown) => unknown, extra: Parameters<typeof harness>[0] = {}) {
    const h = harness({ fromWc, ...extra });
    registerAuthIpcFor(h);
    return h;
  }

  function registerAuthIpcFor(h: Harness): void {
    registerAuthIpcWith(h.ctx, h.m);
  }

  const invoke = (ch: string, event: unknown, ...args: unknown[]) => {
    const fn = mocks.handlers.get(ch);
    if (!fn) throw new Error(`no handler ${ch}`);
    return fn(event, ...args) as Promise<unknown>;
  };

  it("registers every auth/signup channel behind the shell trust gate", async () => {
    const authHolder: Partial<AuthService> = {};
    const { ctx } = makeCtx({ dir: tempDir(), extra: { auth: authHolder } });
    Object.assign(authHolder, createAuthService(ctx));
    registerAuthIpc(ctx);
    expect([...mocks.handlers.keys()].sort()).toEqual(
      ["auth:persistence", "auth:signIn", "auth:signOutAll", "auth:status", "signup:close", "signup:open", "signup:status"].sort(),
    );
    const untrusted = { sender: new FakeWc(), senderFrame: { url: "https://evil.example" } };
    expect(() => invoke("auth:status", untrusted)).toThrow("Blocked 'auth:status': untrusted sender.");
    expect(await invoke("auth:status", trusted(new FakeWc()))).toEqual({ status: "signed-out" });
    expect(await invoke("auth:persistence", trusted(new FakeWc()))).toBe("plaintext-dev");
  });

  it("auth:signIn: joiners share the attempt; only the first caller focuses its window", async () => {
    const win = new FakeWin();
    win.minimized = true;
    const h = ipcHarness(() => win);
    await flush();
    let resolve: (s: unknown) => void = () => {};
    const attempt = new Promise((r) => (resolve = r));
    const spy = vi.spyOn(h.m.core, "signIn").mockReturnValue(attempt as never);
    const a = invoke("auth:signIn", trusted(win.webContents), 1, "yes");
    const b = invoke("auth:signIn", trusted(win.webContents), true, true);
    expect(spy.mock.calls).toEqual([[true, false], [true, true]]);
    resolve({ status: "signed-in", login: "l", sub: "s", gatewayUrl: GATEWAY_PROD, expiresAt: 1, developer: false });
    await Promise.all([a, b]);
    expect(win.calls).toEqual(["restore", "show", "focus"]);
    expect(h.focusApp).toHaveBeenCalledTimes(1);
    expect(h.rec.causes).toContainEqual({ cause: "sign-in", details: undefined });
  });

  it("auth:signIn after a session death focuses gently", async () => {
    const win = new FakeWin();
    win.visible = false;
    const h = ipcHarness(() => win);
    await flush();
    h.m.core.recordSessionDeath("proof-expired");
    vi.spyOn(h.m.core, "signIn").mockResolvedValue({ status: "signed-in", login: "l", sub: "s", gatewayUrl: GATEWAY_PROD, expiresAt: 1, developer: false });
    await invoke("auth:signIn", trusted(win.webContents), false);
    expect(win.calls).toEqual(["showInactive"]);
    expect(h.dock).toEqual(["informational"]);
    expect(h.focusApp).not.toHaveBeenCalled();
  });

  it("auth:signIn failure does not focus", async () => {
    const win = new FakeWin();
    const h = ipcHarness(() => win);
    await flush();
    vi.spyOn(h.m.core, "signIn").mockRejectedValue(new Error("Sign-in timed out. Please try again."));
    await expect(invoke("auth:signIn", trusted(win.webContents), false)).rejects.toThrow("Sign-in timed out. Please try again.");
    expect(win.calls).toEqual([]);
  });

  it("auth:signOutAll: signs out, clears badges, applies window effects with the parent as anchor", async () => {
    const parent = new FakeWin();
    const child = new FakeWin();
    child.parent = parent;
    const h = ipcHarness(() => child);
    await flush();
    const spy = vi.spyOn(h.m.core, "signOutAll");
    await invoke("auth:signOutAll", trusted(child.webContents));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(h.winCalls.clearBadgeCounts).toEqual([[]]);
    expect(h.winCalls.applySignOut).toEqual([[parent]]);
  });

  it("auth:signOutAll with no window → anchor null", async () => {
    const h = ipcHarness(() => null);
    await flush();
    await invoke("auth:signOutAll", trusted(new FakeWc()));
    expect(h.winCalls.applySignOut).toEqual([[null]]);
  });

  it("signup:open hides the Lab first; status/close resolve the sender window", async () => {
    const win = new FakeWin();
    const h = ipcHarness(() => win);
    await flush();
    await invoke("signup:open", trusted(win.webContents));
    expect(h.winCalls.hideLabView).toEqual([[win]]);
    expect(await invoke("signup:status", trusted(win.webContents))).toBe(true);
    await invoke("signup:close", trusted(win.webContents));
    expect(await invoke("signup:status", trusted(win.webContents))).toBe(false);
  });

  it("signup:open without a window rejects; status is false", async () => {
    ipcHarness(() => null);
    await flush();
    await expect(invoke("signup:open", trusted(new FakeWc()))).rejects.toThrow("The Silico window is no longer available.");
    expect(await invoke("signup:status", trusted(new FakeWc()))).toBe(false);
  });
});
