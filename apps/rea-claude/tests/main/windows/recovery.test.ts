import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthState, LabsListResult, RecoveryState } from "@shared/ipc";
import {
  createRecoveryController,
  fetchAuthConfig,
  RecoveryRegistry,
  RecoveryText,
  runRecovery,
} from "../../../src/main/windows/recovery";
import type { ControllerDeps, RecoverableContents, RecoveryDeps } from "../../../src/main/windows/recovery";
import type { Identity } from "../../../src/main/services";

const signedIn = (sub = "u1", gatewayUrl: "https://my.silico.run" | "https://my-staging.silico.run" = "https://my.silico.run"): AuthState => ({
  status: "signed-in",
  login: "l",
  sub,
  gatewayUrl,
  expiresAt: 9e15,
  developer: false,
});

const lab = (deploymentId: string, routeMode: "managed" | "cluster" = "managed") => ({
  deploymentId,
  labPublicHost: `${deploymentId}.silico.run`,
  routeMode,
  stale: false,
  updateAvailable: false,
  updateRequired: false,
});

function recoveryDeps(over: Partial<RecoveryDeps> = {}): RecoveryDeps {
  return {
    authStatus: async () => signedIn(),
    listLabs: async (): Promise<LabsListResult> => ({ ok: true, labs: [lab("d1")], gatewayUrl: "https://my.silico.run", login: "l" }),
    createLabSession: async () => ({ ok: true, token: "TOK", labUrl: "https://d1.silico.run" }),
    waitForLab: async () => "ready",
    fetchAuthConfig: async () => ({ gatewayUrl: "https://my.silico.run", deployment: "d1" }),
    ...over,
  };
}

const target = { originalUrl: "https://old.silico.run/workspace/1", route: "/workspace/1" };
const sig = () => new AbortController().signal;

describe("runRecovery", () => {
  it("happy path builds the callback URL", async () => {
    const out = await runRecovery(target, sig(), undefined, recoveryDeps());
    expect(out).toEqual({
      kind: "ready",
      context: { gatewayUrl: "https://my.silico.run", deployment: "d1", sub: "u1" },
      url: "https://d1.silico.run/auth/callback?return_to=%2Fworkspace%2F1#token=TOK",
    });
  });

  it("signed out → signin (staging flag from context)", async () => {
    const out = await runRecovery(
      { ...target, context: { gatewayUrl: "https://my-staging.silico.run" } },
      sig(),
      undefined,
      recoveryDeps({ authStatus: async () => ({ status: "signed-out" }) }),
    );
    expect(out).toMatchObject({ kind: "blocked", state: { kind: "signin", staging: true, message: RecoveryText.signIn } });
  });

  it("wrong account / environment", async () => {
    const out = await runRecovery(
      { ...target, context: { gatewayUrl: "https://my.silico.run", sub: "other" } },
      sig(),
      undefined,
      recoveryDeps(),
    );
    expect(out).toEqual({ kind: "blocked", state: { kind: "error", message: RecoveryText.wrongAccount } });
  });

  it("deployment selection: choose / none / gone / explicit", async () => {
    const ctxNoDep = { ...target, context: { gatewayUrl: "https://my.silico.run" as const } };
    const two = recoveryDeps({
      listLabs: async () => ({ ok: true, labs: [lab("a"), lab("b"), lab("c", "cluster")], gatewayUrl: "x", login: "l" }),
    });
    expect(await runRecovery(ctxNoDep, sig(), undefined, two)).toMatchObject({
      kind: "blocked",
      state: { kind: "choose", message: RecoveryText.choose, deployments: ["a", "b"] },
    });
    expect(await runRecovery(ctxNoDep, sig(), "zzz", two)).toMatchObject({ state: { message: RecoveryText.labGone } });
    expect(await runRecovery(ctxNoDep, sig(), "b", two)).toMatchObject({ kind: "ready", context: { deployment: "b" } });
    const none = recoveryDeps({ listLabs: async () => ({ ok: true, labs: [lab("c", "cluster")], gatewayUrl: "x", login: "l" }) });
    expect(await runRecovery(ctxNoDep, sig(), undefined, none)).toMatchObject({ state: { message: RecoveryText.noLabs } });
    const needAuth = recoveryDeps({ listLabs: async () => ({ ok: false, error: "x", needsAuth: true }) });
    expect(await runRecovery(ctxNoDep, sig(), undefined, needAuth)).toMatchObject({ state: { kind: "signin" } });
    const err = recoveryDeps({ listLabs: async () => ({ ok: false, error: "boom" }) });
    expect(await runRecovery(ctxNoDep, sig(), undefined, err)).toMatchObject({ state: { kind: "error", message: "boom" } });
  });

  it("lab session errors", async () => {
    expect(
      await runRecovery(target, sig(), undefined, recoveryDeps({ createLabSession: async () => ({ ok: false, error: "e", status: 403 }) })),
    ).toMatchObject({ state: { kind: "error", message: RecoveryText.forbidden } });
    expect(
      await runRecovery(target, sig(), undefined, recoveryDeps({ createLabSession: async () => ({ ok: false, error: "e", needsAuth: true }) })),
    ).toMatchObject({ state: { kind: "signin" } });
    expect(
      await runRecovery(target, sig(), undefined, recoveryDeps({ createLabSession: async () => ({ ok: true, token: "t", labUrl: "https://my.silico.run" }) })),
    ).toMatchObject({ state: { message: RecoveryText.badLabUrl } });
    expect(
      await runRecovery(target, sig(), undefined, recoveryDeps({ createLabSession: async () => ({ ok: true, token: "t", labUrl: "https://example.com" }) })),
    ).toMatchObject({ state: { message: RecoveryText.badLabUrl } });
  });

  it("reach outcomes", async () => {
    expect(await runRecovery(target, sig(), undefined, recoveryDeps({ waitForLab: async () => "still-waking" }))).toMatchObject({
      state: { message: RecoveryText.stillWaking },
    });
    expect(await runRecovery(target, sig(), undefined, recoveryDeps({ waitForLab: async () => "unreachable" }))).toMatchObject({
      state: { message: RecoveryText.unreachable },
    });
    expect(await runRecovery(target, sig(), undefined, recoveryDeps({ waitForLab: async () => "canceled" }))).toEqual({ kind: "canceled" });
  });

  it("identity changing during the wait cancels; thrown errors map to messages; abort → canceled", async () => {
    let n = 0;
    const flip = recoveryDeps({ authStatus: async () => (n++ === 0 ? signedIn("u1") : signedIn("u2")) });
    expect(await runRecovery(target, sig(), undefined, flip)).toEqual({ kind: "canceled" });
    const thrower = recoveryDeps({ fetchAuthConfig: async () => Promise.reject(new Error("routing broke")) });
    expect(await runRecovery(target, sig(), undefined, thrower)).toMatchObject({ state: { message: "routing broke" } });
    const ac = new AbortController();
    ac.abort();
    expect(await runRecovery(target, ac.signal, undefined, recoveryDeps())).toEqual({ kind: "canceled" });
  });
});

describe("fetchAuthConfig", () => {
  const ok = (body: string, url = "https://lab.x/api/auth/config") =>
    Object.assign(new Response(body, { status: 200 }), {}) as Response & { url: string };
  it("parses auth_url + tenant_id", async () => {
    const f = vi.fn(async (_u: string, _i: RequestInit) => ok(JSON.stringify({ auth_url: "https://my.silico.run/x", tenant_id: "d9" })));
    expect(await fetchAuthConfig("https://lab.x/workspace", sig(), f)).toEqual({ gatewayUrl: "https://my.silico.run", deployment: "d9" });
    expect(f.mock.calls[0]?.[0]).toBe("https://lab.x/api/auth/config");
    expect(f.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store" });
  });
  it("rejects bad status, unsupported config, oversize body", async () => {
    await expect(fetchAuthConfig("https://lab.x/", sig(), async () => new Response("", { status: 500 }))).rejects.toThrow(
      RecoveryText.configUnreachable,
    );
    await expect(
      fetchAuthConfig("https://lab.x/", sig(), async () => ok(JSON.stringify({ auth_url: "https://evil.x", tenant_id: "d" }))),
    ).rejects.toThrow(RecoveryText.configUnsupported);
    await expect(fetchAuthConfig("https://lab.x/", sig(), async () => ok("x".repeat(20_000)))).rejects.toThrow(RecoveryText.configInvalid);
    await expect(fetchAuthConfig("https://lab.x/", sig(), async () => ok("{not json"))).rejects.toThrow(RecoveryText.configInvalid);
  });
});

// --------------------------------------------------------------------------- registry + controller

class Wc extends EventEmitter implements RecoverableContents {
  url = "";
  destroyed = false;
  readonly mainFrame = { isDestroyed: () => false };
  isDestroyed() {
    return this.destroyed;
  }
  getURL() {
    return this.url;
  }
  navigate(url: string) {
    this.emit("did-start-navigation", { url, isMainFrame: true, isSameDocument: false });
    this.url = url;
    this.emit("did-navigate", {}, url);
  }
}

describe("RecoveryRegistry", () => {
  it("accepts only eligible, registered main frames", () => {
    const reg = new RecoveryRegistry();
    const wc = new Wc();
    const recover = vi.fn(() => true);
    reg.register(wc, (o) => o === "https://lab.x", recover);
    expect(reg.handle(wc, wc.mainFrame)).toEqual({ status: "unsupported" }); // nothing committed
    wc.navigate("https://lab.x/workspace/1");
    expect(reg.handle(wc, {})).toEqual({ status: "unsupported" }); // sub frame
    expect(reg.handle(wc, wc.mainFrame)).toEqual({ status: "accepted" });
    expect(recover).toHaveBeenCalledTimes(1);
    wc.navigate("https://lab.x/admin"); // route not allow-listed
    expect(reg.handle(wc, wc.mainFrame)).toEqual({ status: "unsupported" });
    wc.navigate("https://other.x/workspace");
    expect(reg.eligible(wc)).toBe(false);
    expect(reg.handle(new Wc(), {})).toEqual({ status: "unsupported" });
  });

  it("in-flight navigation is not eligible; recover false → unsupported; throw → error", () => {
    const reg = new RecoveryRegistry();
    const wc = new Wc();
    let ret: boolean | (() => never) = false;
    reg.register(wc, () => true, () => {
      if (typeof ret === "function") ret();
      return ret as boolean;
    });
    wc.navigate("https://lab.x/home");
    wc.emit("did-start-navigation", { url: "https://my.silico.run/login", isMainFrame: true, isSameDocument: false });
    expect(reg.eligible(wc)).toBe(false);
    expect(reg.navigationEligible(wc)).toBe(true); // auth wall from an eligible page
    reg.navigationCanceled(wc);
    expect(reg.eligible(wc)).toBe(true);
    expect(reg.handle(wc, wc.mainFrame)).toEqual({ status: "unsupported" });
    ret = () => {
      throw new Error("x");
    };
    expect(reg.handle(wc, wc.mainFrame)).toEqual({ status: "error", message: RecoveryText.windowRestoreFailed });
    wc.emit("destroyed");
    expect(reg.handle(wc, wc.mainFrame)).toEqual({ status: "unsupported" });
  });

  it("gateway pages are never eligible", () => {
    const reg = new RecoveryRegistry();
    const wc = new Wc();
    reg.register(wc, () => true, () => true);
    wc.navigate("https://my.silico.run/home");
    expect(reg.eligible(wc)).toBe(false);
  });
});

describe("createRecoveryController", () => {
  afterEach(() => vi.useRealTimers());

  function setup(url: string, over: Partial<ControllerDeps> = {}) {
    const wc = new Wc();
    wc.url = url;
    const states: RecoveryState[] = [];
    const loads: string[] = [];
    let identityCb: ((i: Identity | null) => void) | null = null;
    let signedInCb: ((i: Identity) => void) | null = null;
    let t = 1_000_000;
    const registry = new RecoveryRegistry();
    const deps: ControllerDeps = {
      ...recoveryDeps(),
      registry,
      now: () => t,
      cachedIdentity: () => null,
      onIdentityChanged: (cb) => {
        identityCb = cb;
        return () => (identityCb = null);
      },
      onSignedIn: (cb) => {
        signedInCb = cb;
        return () => (signedInCb = null);
      },
      ...over,
    };
    const c = createRecoveryController(url, { wc, isWindowDestroyed: () => false, onState: (s) => states.push(s), load: (u) => loads.push(u) }, deps);
    return {
      c: c!,
      wc,
      states,
      loads,
      registry,
      advance: (ms: number) => (t += ms),
      identity: (i: Identity | null) => identityCb?.(i),
      signIn: (i: Identity) => signedInCb?.(i),
    };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("returns null for unrecoverable URLs", () => {
    expect(setup("https://example.com/").c).toBeNull();
  });

  it("recover → loading → hands off URL → idle on finish", async () => {
    const s = setup("https://old.silico.run/workspace/1");
    s.c.recover();
    expect(s.states.at(-1)).toEqual({ kind: "loading", message: RecoveryText.restoring });
    expect(s.c.recovering()).toBe(true);
    await flush();
    expect(s.loads).toEqual(["https://d1.silico.run/auth/callback?return_to=%2Fworkspace%2F1#token=TOK"]);
    expect(s.c.ownsOrigin("https://d1.silico.run")).toBe(true);
    expect(s.c.ownsOrigin("https://old.silico.run")).toBe(false);
    // the hand-off navigation is expected → state stays loading
    s.wc.emit("did-start-navigation", { url: s.loads[0], isMainFrame: true, isSameDocument: false });
    expect(s.states.at(-1)?.kind).toBe("loading");
    s.wc.url = "https://d1.silico.run/workspace/1";
    s.wc.emit("did-navigate", {}, s.wc.url);
    s.wc.emit("did-finish-load");
    expect(s.states.at(-1)).toEqual({ kind: "idle" });
    // a second non-forced attempt within 45 s is throttled
    s.c.recover();
    expect(s.states.at(-1)).toEqual({ kind: "error", message: RecoveryText.throttled });
    // error state blocks non-forced; forced retries
    s.advance(50_000);
    s.c.recover();
    expect(s.states.at(-1)?.kind).toBe("error");
    s.c.recover(true);
    expect(s.states.at(-1)?.kind).toBe("loading");
  });

  it("30 s load deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = setup("https://old.silico.run/workspace/1");
    s.c.recover();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.loads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s.states.at(-1)).toEqual({ kind: "error", message: RecoveryText.loadDeadline });
  });

  it("signin state resumes on matching sign-in; account change is terminal", async () => {
    let status: AuthState = { status: "signed-out" };
    const s = setup("https://my.silico.run/x?return_to=/home", { authStatus: async () => status });
    s.c.recover();
    await flush();
    expect(s.states.at(-1)?.kind).toBe("signin");
    status = signedIn("u1");
    s.signIn({ sub: "u1", login: "l", gatewayUrl: "https://my-staging.silico.run" }); // other gateway: ignored
    expect(s.states.at(-1)?.kind).toBe("signin");
    s.signIn({ sub: "u1", login: "l", gatewayUrl: "https://my.silico.run" });
    expect(s.states.at(-1)?.kind).toBe("loading");
    await flush();
    expect(s.loads).toHaveLength(1);
    s.identity(null);
    expect(s.states.at(-1)).toEqual({ kind: "error", message: RecoveryText.accountChanged });
    s.c.recover(true);
    expect(s.states.at(-1)?.kind).toBe("error");
  });

  it("account switch is detected from the cached identity captured at creation", () => {
    const s = setup("https://old.silico.run/workspace/1", { cachedIdentity: () => ({ sub: "u1", gatewayUrl: "https://my.silico.run" }) });
    s.identity({ sub: "u1", login: "l", gatewayUrl: "https://my.silico.run" });
    expect(s.states).toEqual([]);
    s.identity({ sub: "u2", login: "l", gatewayUrl: "https://my.silico.run" });
    expect(s.states.at(-1)).toEqual({ kind: "error", message: RecoveryText.accountChanged });
  });

  it("unexpected navigation cancels and returns to idle; canceled outcome → message; fail()", async () => {
    let resolve: (v: "ready") => void = () => undefined;
    const s = setup("https://old.silico.run/workspace/1", { waitForLab: () => new Promise((r) => (resolve = r)) });
    s.c.recover();
    await flush();
    s.wc.emit("did-start-navigation", { url: "https://old.silico.run/home", isMainFrame: true, isSameDocument: false });
    expect(s.states.at(-1)).toEqual({ kind: "idle" });
    resolve("ready");
    await flush();
    expect(s.loads).toHaveLength(0);
    s.c.fail("boom");
    expect(s.states.at(-1)).toEqual({ kind: "error", message: "boom" });
    s.c.dispose();
  });

  it("route tracking follows eligible in-app navigation", async () => {
    const s = setup("https://old.silico.run/workspace/1");
    s.wc.navigate("https://old.silico.run/workspace/2?x=1");
    s.c.recover();
    await flush();
    expect(s.loads[0]).toContain("return_to=%2Fworkspace%2F2%3Fx%3D1");
  });
});
