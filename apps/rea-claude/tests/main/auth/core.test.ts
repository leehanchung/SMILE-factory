import { get as httpGet } from "node:http";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_PROD, GATEWAY_STAGING } from "@shared/config";
import { AuthCore } from "../../../src/main/auth/core";
import { hashToken } from "../../../src/main/auth/activation";
import { fakeFetch, fakeSafeStorage, flush, json, makeCtx, makeProof, netError, tempDir, type Route } from "./helpers";

const NOW = 1_700_000_000_000;
const SEC = NOW / 1000;

function proof(extra: Record<string, unknown> = {}): string {
  return makeProof({ sub: "u1", login: "alice", exp: SEC + 3600, purpose: "labs", iss: "silico-lab-auth", ...extra });
}

/** Simulate the browser: follow redirect_uri with the given params. */
function browser(params: string): (url: string) => void {
  return (url) => {
    const redirect = new URL(url).searchParams.get("redirect_uri") as string;
    httpGet(`${redirect}&${params}`, (res) => res.resume()).on("error", () => {});
  };
}

interface SetupOpts {
  route?: Route;
  packaged?: boolean;
  testMode?: boolean;
  keyring?: boolean;
  platform?: NodeJS.Platform;
  staging?: boolean;
  onOpen?: (url: string) => unknown;
  timeoutMs?: number;
  dir?: string;
  /** Logger factory override (to assert on logs). */
  logger?: Parameters<typeof makeCtx>[0]["extra"] extends infer E ? (E extends { logger?: infer L } ? L : never) : never;
}

function setup(o: SetupOpts = {}) {
  const dir = o.dir ?? tempDir();
  const { ctx, rec } = makeCtx({
    dir,
    isPackaged: o.packaged ?? false,
    isTestMode: o.testMode ?? false,
    platform: o.platform ?? "darwin",
    staging: o.staging ?? false,
    ...(o.logger ? { extra: { logger: o.logger } } : {}),
  });
  const clock = { now: NOW };
  const ff = fakeFetch(o.route ?? (() => json(404, {})));
  const opened: string[] = [];
  const safe = fakeSafeStorage(o.keyring ?? true);
  const core = new AuthCore(ctx, {
    now: () => clock.now,
    fetch: ff.fetch,
    randomBytes: (n) => Buffer.alloc(n, 7),
    safeStorage: safe,
    openExternal: (url) => {
      opened.push(url);
      return o.onOpen?.(url);
    },
    signInTimeoutMs: o.timeoutMs ?? 5_000,
  });
  return { dir, ctx, rec, clock, ff, opened, core, safe, idFile: join(dir, "identity.json") };
}

function writeIdentity(dir: string, rec: Record<string, unknown>): void {
  writeFileSync(join(dir, "identity.json"), JSON.stringify({ version: 1, gatewayUrl: GATEWAY_PROD, sub: "u1", login: "alice", encrypted: false, ...rec }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("load / status / persistence", () => {
  it("signed-out without a file; loads a plaintext record lazily", async () => {
    const a = setup();
    expect(await a.core.status()).toEqual({ status: "signed-out" });
    const b = setup();
    writeIdentity(b.dir, { exp: SEC + 60, proof: proof(), developer: true });
    expect(await b.core.status()).toEqual({ status: "signed-in", login: "alice", sub: "u1", gatewayUrl: GATEWAY_PROD, expiresAt: (SEC + 60) * 1000, developer: true });
    expect(b.core.isDeveloper()).toBe(true);
    expect(b.core.cachedIdentity()).toEqual({ login: "alice", sub: "u1", gatewayUrl: GATEWAY_PROD });
  });

  it("expired proof without refresh token reports signed-out; with refresh token never expires", async () => {
    const a = setup();
    writeIdentity(a.dir, { exp: SEC - 1, proof: proof() });
    expect(await a.core.status()).toEqual({ status: "signed-out" });
    const b = setup();
    writeIdentity(b.dir, { exp: SEC - 1, proof: proof(), refreshToken: "sdr_x.y" });
    expect(await b.core.status()).toMatchObject({ status: "signed-in", expiresAt: 8.64e15 });
  });

  it("persistence modes", () => {
    expect(setup().core.persistenceMode()).toBe("plaintext-dev");
    expect(setup({ packaged: true, testMode: true }).core.persistenceMode()).toBe("none-test-mode");
    expect(setup({ packaged: true }).core.persistenceMode()).toBe("keychain");
    expect(setup({ packaged: true, keyring: false }).core.persistenceMode()).toBe("none-no-keyring");
  });

  it("logs the persistence mode and backend", () => {
    const lines: unknown[][] = [];
    const a = setup({ platform: "linux" });
    (a.ctx as { logger: unknown }).logger; // touch
    const core = new AuthCore(
      { ...a.ctx, logger: () => ({ debug() {}, info: (...x: unknown[]) => lines.push(x), warn() {}, error() {} }) } as never,
      { now: () => NOW, fetch: a.ff.fetch, randomBytes: (n) => Buffer.alloc(n), safeStorage: fakeSafeStorage(true, "kwallet5"), openExternal: () => {} },
    );
    core.logPersistenceMode();
    expect(lines[0]?.[0]).toBe('identity persistence: plaintext-dev (safeStorage backend "kwallet5")');
  });

  it("packaged + keyring: encrypted file, mode 0600, backend recorded, round-trips", async () => {
    const a = setup({ packaged: true });
    const p = proof();
    await a.core.persist({ gatewayUrl: GATEWAY_PROD, sub: "u1", login: "alice", exp: SEC + 60, proof: p, refreshToken: "sdr_a.b" });
    const raw = JSON.parse(readFileSync(a.idFile, "utf-8")) as Record<string, unknown>;
    expect(raw).toMatchObject({ version: 1, encrypted: true, backend: "keychain" });
    expect(raw.proof).toBe(Buffer.from(`enc:${p}`).toString("base64"));
    expect(statSync(a.idFile).mode & 0o777).toBe(0o600);
    expect(existsSync(`${a.idFile}.tmp`)).toBe(false);
    const b = setup({ packaged: true, dir: a.dir });
    expect(await b.core.status()).toMatchObject({ status: "signed-in", expiresAt: 8.64e15 });
  });

  it("no keyring (packaged): memory only, warns, deletes an existing file unless told not to", async () => {
    const warns: unknown[][] = [];
    const a = setup({ packaged: true, keyring: false });
    const core = new AuthCore(
      { ...a.ctx, env: a.ctx.env, logger: () => ({ debug() {}, info() {}, warn: (...x: unknown[]) => warns.push(x), error() {} }) } as never,
      { now: () => NOW, fetch: a.ff.fetch, randomBytes: (n) => Buffer.alloc(n), safeStorage: a.safe, openExternal: () => {} },
    );
    const s = { gatewayUrl: GATEWAY_PROD, sub: "u1", login: "a", exp: SEC + 60, proof: "p" } as const;
    writeFileSync(a.idFile, "{}");
    await core.persist(s, { removeExistingOnFailure: false });
    expect(existsSync(a.idFile)).toBe(true);
    await core.persist(s);
    expect(existsSync(a.idFile)).toBe(false);
    expect(warns[0]?.[0]).toBe("keychain encryption unavailable; session kept in memory, not persisted");
  });

  it("test mode never persists", async () => {
    const a = setup({ packaged: true, testMode: true });
    await a.core.persist({ gatewayUrl: GATEWAY_PROD, sub: "u1", login: "a", exp: SEC + 60, proof: "p" });
    expect(existsSync(a.idFile)).toBe(false);
  });

  it("encrypted file + undecryptable keyring → signed out, file kept, backend switch warned", async () => {
    const warns: string[] = [];
    const a = setup({ packaged: true, platform: "linux" });
    writeIdentity(a.dir, { exp: SEC + 60, encrypted: true, proof: "notenc", backend: "kwallet5" });
    const core = new AuthCore(
      { ...a.ctx, logger: () => ({ debug() {}, info() {}, warn: (m: string) => warns.push(m), error() {} }) } as never,
      { now: () => NOW, fetch: a.ff.fetch, randomBytes: (n) => Buffer.alloc(n), safeStorage: a.safe, openExternal: () => {} },
    );
    expect(await core.status()).toEqual({ status: "signed-out" });
    expect(existsSync(a.idFile)).toBe(true);
    expect(warns.some((w) => w.includes('"kwallet5"') && w.includes('"gnome_libsecret"'))).toBe(true);
  });

  it("serializes concurrent writes (last write wins, no tmp left)", async () => {
    const a = setup();
    const base = { gatewayUrl: GATEWAY_PROD, sub: "u1", login: "a", proof: "p" } as const;
    await Promise.all([1, 2, 3, 4, 5].map((i) => a.core.persist({ ...base, exp: i })));
    expect(JSON.parse(readFileSync(a.idFile, "utf-8")).exp).toBe(5);
  });

  it("activeGateway: session gateway, else settings.staging", async () => {
    expect(await setup({ staging: true }).core.activeGateway()).toBe(GATEWAY_STAGING);
    expect(await setup().core.activeGateway()).toBe(GATEWAY_PROD);
    const b = setup({ staging: false });
    writeIdentity(b.dir, { exp: SEC + 60, proof: proof(), gatewayUrl: GATEWAY_STAGING });
    expect(await b.core.activeGateway()).toBe(GATEWAY_STAGING);
  });
});

describe("browser sign-in", () => {
  const probeOk: Route = (url) => (url.endsWith("/.well-known/jwks.json") ? json(200, {}) : json(404, {}));

  it("probes the alias first, opens the login URL, installs the session and resumes waiters", async () => {
    const p = proof({ developer: true });
    const a = setup({ route: probeOk, onOpen: browser(`proof=${p}`) });
    const identities: unknown[] = [];
    const signedIn: unknown[] = [];
    const devs: boolean[] = [];
    a.core.onIdentityChanged((i) => identities.push(i));
    a.core.onSignedIn((i) => signedIn.push(i));
    a.core.onDeveloperChanged((d) => devs.push(d));
    const state = await a.core.signIn(false, false);
    expect(state).toEqual({ status: "signed-in", login: "alice", sub: "u1", gatewayUrl: GATEWAY_PROD, expiresAt: (SEC + 3600) * 1000, developer: true });
    expect(a.ff.calls[0]?.url).toBe("https://silico.goodfire.com/.well-known/jwks.json");
    const login = new URL(a.opened[0] as string);
    expect(login.origin).toBe("https://silico.goodfire.com");
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("mode")).toBe("desktop");
    expect(login.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback\?s=[0-9a-f]{32}$/);
    expect(a.rec.broadcasts).toEqual([{ channel: "auth:changed", payload: state, trustedOnly: true }]);
    expect(signedIn).toEqual([{ sub: "u1", login: "alice", gatewayUrl: GATEWAY_PROD }]);
    expect(identities).toEqual([{ sub: "u1", login: "alice", gatewayUrl: GATEWAY_PROD }]);
    expect(devs).toEqual([true]);
    expect(JSON.parse(readFileSync(a.idFile, "utf-8"))).toMatchObject({ sub: "u1", encrypted: false, proof: p, developer: true });
  });

  it("falls back to the canonical origin when every probe fails (and reports sign-in-probe failures)", async () => {
    const p = proof();
    const a = setup({ route: () => { throw netError("ENOTFOUND"); }, onOpen: browser(`proof=${p}`) });
    await a.core.signIn(true, false);
    expect(new URL(a.opened[0] as string).origin).toBe(GATEWAY_STAGING);
    expect(a.ff.calls.map((c) => c.url)).toEqual([
      "https://silico-staging.goodfire.com/.well-known/jwks.json",
      "https://my-staging.silico.run/.well-known/jwks.json",
    ]);
    const failures = a.rec.events.filter((e) => e.kind === "gateway-transport-failure");
    expect(failures).toHaveLength(2);
    expect(failures[0]?.details).toMatchObject({ operation: "sign-in-probe", failureKind: "dns", aliasOutcome: "failed" });
  });

  it("activation: registers only the SHA-256 of a client-minted sdr_ token", async () => {
    const p = proof();
    const route: Route = (url) => (url.endsWith("/labs/activate") ? json(200, { ok: true }) : json(200, {}));
    const a = setup({ route, onOpen: browser(`proof=${p}&activation_code=sda_dev1.secret`) });
    const state = await a.core.signIn(false, false);
    expect(state).toMatchObject({ status: "signed-in", expiresAt: 8.64e15 });
    const call = a.ff.calls.find((c) => c.url.endsWith("/labs/activate"));
    expect(call?.url).toBe("https://my.silico.run/labs/activate");
    expect((call?.init.headers as Record<string, string>).authorization).toBe("Bearer sda_dev1.secret");
    const expectedToken = `sdr_dev1.${Buffer.alloc(32, 7).toString("base64url")}`;
    expect(JSON.parse(call?.init.body as string)).toEqual({ token_hash: hashToken(expectedToken) });
    expect(JSON.parse(readFileSync(a.idFile, "utf-8")).refreshToken).toBe(expectedToken);
  });

  it.each([408, 425, 429, 500, 503])("activation status %i → continue without refresh token", async (status) => {
    const p = proof();
    const a = setup({ route: (u) => (u.endsWith("/labs/activate") ? json(status, {}) : json(200, {})), onOpen: browser(`proof=${p}&activation_code=sda_x.y`) });
    expect(await a.core.signIn(false, false)).toMatchObject({ expiresAt: (SEC + 3600) * 1000 });
  });

  it("activation network error → continue without refresh token", async () => {
    const p = proof();
    const a = setup({
      route: (u) => {
        if (u.includes("/labs/activate")) throw netError("ECONNRESET");
        return json(200, {});
      },
      onOpen: browser(`proof=${p}&activation_code=sda_x.y`),
    });
    expect(await a.core.signIn(false, false)).toMatchObject({ expiresAt: (SEC + 3600) * 1000 });
  });

  it.each([
    ["sda_x.y", 400, {}, "Could not activate the desktop sign-in."],
    ["sda_x.y", 200, { ok: false }, "Gateway returned an invalid desktop session."],
    ["bogus", 200, { ok: true }, "Gateway returned an invalid activation code."],
  ])("activation %s/%i → error", async (code, status, body, message) => {
    const p = proof();
    const a = setup({ route: (u) => (u.endsWith("/labs/activate") ? json(status, body) : json(200, {})), onOpen: browser(`proof=${p}&activation_code=${code}`) });
    await expect(a.core.signIn(false, false)).rejects.toThrow(message);
    expect(await a.core.status()).toEqual({ status: "signed-out" });
  });

  it("proof without sub/exp → invalid proof; garbage → Malformed proof", async () => {
    const a = setup({ route: probeOk, onOpen: browser(`proof=${makeProof({ login: "x", exp: SEC + 10 })}`) });
    await expect(a.core.signIn(false, false)).rejects.toThrow("Gateway returned an invalid proof.");
    const b = setup({ route: probeOk, onOpen: browser("proof=nodots") });
    await expect(b.core.signIn(false, false)).rejects.toThrow("Malformed proof");
  });

  it("single flight: joins, refuses an environment switch, restart rejects the old attempt", async () => {
    const a = setup({ route: probeOk });
    const first = a.core.signIn(false, false);
    first.catch(() => {});
    expect(a.core.signIn(false, false)).toBe(first);
    await expect(a.core.signIn(true, false)).rejects.toThrow(
      "Finish the sign-in already open in your browser before changing environments.",
    );
    await expect(a.core.signIn(true, true)).rejects.toThrow(
      "Finish the sign-in already open in your browser before changing environments.",
    );
    const second = a.core.signIn(false, true);
    second.catch(() => {});
    expect(second).not.toBe(first);
    await expect(first).rejects.toThrow("Sign-in restarted.");
    await a.core.signOutAll(); // cancels the loopback of `second`
    await expect(second).rejects.toThrow("Sign-in restarted.");
  });

  it("openExternal throwing is logged; the attempt stays pending, is cancellable, and times out with the exact message (T30)", async () => {
    const error = vi.fn();
    const logger = () => ({ debug: () => {}, info: () => {}, warn: () => {}, error });
    const a = setup({
      route: probeOk,
      logger,
      onOpen: () => {
        throw new Error("no default browser");
      },
    });
    let settled = false;
    const first = a.core.signIn(false, false);
    first.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("could not open the browser for sign-in", expect.any(Error)));
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    expect(a.core.signIn(false, false)).toBe(first); // still the in-flight attempt
    await a.core.signOutAll();
    await expect(first).rejects.toThrow("Sign-in restarted.");

    const b = setup({ route: probeOk, logger, timeoutMs: 50, onOpen: () => Promise.reject(new Error("xdg-open failed")) });
    await expect(b.core.signIn(false, false)).rejects.toThrow("Sign-in timed out. Please try again.");
  });

  it("times out", async () => {
    const a = setup({ route: probeOk, timeoutMs: 30 });
    await expect(a.core.signIn(false, false)).rejects.toThrow("Sign-in timed out. Please try again.");
    // a fresh attempt is possible afterwards
    const again = a.core.signIn(true, false);
    again.catch(() => {});
    await a.core.signOutAll();
  });

  it("state mismatch from the browser is ignored (X18); the attempt still times out", async () => {
    const statuses: number[] = [];
    const a = setup({
      route: probeOk,
      timeoutMs: 150,
      onOpen: (url) => {
        const redirect = new URL(new URL(url).searchParams.get("redirect_uri") as string);
        redirect.searchParams.set("s", "nope");
        httpGet(`${redirect.href}&proof=x`, (r) => {
          statuses.push(r.statusCode ?? 0);
          r.resume();
        });
      },
    });
    await expect(a.core.signIn(false, false)).rejects.toThrow("Sign-in timed out. Please try again.");
    expect(statuses).toEqual([400]);
  });

  it("missing proof with the right state fails the attempt", async () => {
    const a = setup({
      route: probeOk,
      onOpen: (url) => {
        const redirect = new URL(new URL(url).searchParams.get("redirect_uri") as string);
        httpGet(redirect.href, (r) => r.resume());
      },
    });
    await expect(a.core.signIn(false, false)).rejects.toThrow("Sign-in failed (state mismatch or missing proof).");
  });
});

describe("usable session + refresh", () => {
  function signedIn(o: SetupOpts & { exp: number; refresh?: boolean; dev?: boolean }) {
    const a = setup(o);
    writeIdentity(a.dir, {
      exp: o.exp,
      proof: proof({ exp: o.exp }),
      ...(o.refresh ? { refreshToken: "sdr_r.t" } : {}),
      ...(o.dev ? { developer: true } : {}),
    });
    return a;
  }

  it("valid proof outside the refresh window: no network", async () => {
    const a = signedIn({ exp: SEC + 3600, refresh: true });
    const r = await a.core.getSession();
    expect(r).toEqual({ ok: true, session: { sub: "u1", login: "alice", gatewayUrl: GATEWAY_PROD, proof: proof({ exp: SEC + 3600 }), developer: false } });
    expect(a.ff.calls).toHaveLength(0);
  });

  it("refreshes within 5 minutes of expiry, deduplicated, persisted without removing on failure", async () => {
    const fresh = proof({ exp: SEC + 7200, login: "", developer: true });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const a = signedIn({
      exp: SEC + 299,
      refresh: true,
      route: async (url) => {
        await gate;
        return url.endsWith("/labs/refresh") ? json(200, { proof: fresh }) : json(404, {});
      },
    });
    const [r1, r2] = [a.core.getSession(), a.core.getSession()];
    await flush();
    release();
    const res = await r1;
    expect(await r2).toEqual(res);
    expect(res).toMatchObject({ ok: true, session: { proof: fresh, login: "alice", developer: true } });
    const refreshCalls = a.ff.calls.filter((c) => c.url.endsWith("/labs/refresh"));
    expect(refreshCalls).toHaveLength(1);
    expect((refreshCalls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer sdr_r.t");
    expect(JSON.parse(readFileSync(a.idFile, "utf-8"))).toMatchObject({ proof: fresh, refreshToken: "sdr_r.t", exp: SEC + 7200 });
  });

  it("refresh persist failure (no encryption when packaged): fresh proof kept in memory, old identity.json untouched (T25)", async () => {
    const fresh = proof({ exp: SEC + 7200 });
    const a = setup({ packaged: true, keyring: false, route: (url) => (url.endsWith("/labs/refresh") ? json(200, { proof: fresh }) : json(404, {})) });
    writeIdentity(a.dir, { exp: SEC + 100, proof: proof({ exp: SEC + 100 }), refreshToken: "sdr_r.t" });
    const before = readFileSync(a.idFile, "utf-8");
    expect(await a.core.getSession()).toMatchObject({ ok: true, session: { proof: fresh } });
    expect(readFileSync(a.idFile, "utf-8")).toBe(before); // removeExistingOnFailure:false
    expect(a.core.cachedIdentity()).toEqual({ login: "alice", sub: "u1", gatewayUrl: GATEWAY_PROD });
    expect(await a.core.getSession()).toMatchObject({ ok: true, session: { proof: fresh } }); // no second refresh needed
    expect(a.ff.calls.filter((c) => c.url.endsWith("/labs/refresh"))).toHaveLength(1);
  });

  it("refresh persist failure (write error): logged, fresh proof kept in memory, old identity.json untouched (T25)", async () => {
    const warn = vi.fn();
    const fresh = proof({ exp: SEC + 7200 });
    const a = setup({
      logger: () => ({ debug: () => {}, info: () => {}, warn, error: () => {} }),
      route: (url) => (url.endsWith("/labs/refresh") ? json(200, { proof: fresh }) : json(404, {})),
    });
    writeIdentity(a.dir, { exp: SEC + 100, proof: proof({ exp: SEC + 100 }), refreshToken: "sdr_r.t" });
    const before = readFileSync(a.idFile, "utf-8");
    await a.core.status(); // load while the dir is still readable
    chmodSync(a.dir, 0o500); // the .tmp write fails
    try {
      expect(await a.core.getSession()).toMatchObject({ ok: true, session: { proof: fresh } });
    } finally {
      chmodSync(a.dir, 0o700);
    }
    expect(warn).toHaveBeenCalledWith("could not persist the refreshed device session", expect.anything());
    expect(readFileSync(a.idFile, "utf-8")).toBe(before);
    expect(a.core.cachedIdentity()).toEqual({ login: "alice", sub: "u1", gatewayUrl: GATEWAY_PROD });
  });

  it.each([401, 404])("refresh %i drops the device session", async (status) => {
    const a = signedIn({ exp: SEC + 10, refresh: true, route: () => json(status, {}) });
    expect(await a.core.getSession()).toEqual({ ok: false, error: "Your session has expired. Sign in again.", needsAuth: true });
    expect(existsSync(a.idFile)).toBe(false);
    expect(a.rec.events).toContainEqual({ kind: "session-death", details: { reason: "device-session-rejected" } });
    expect(await a.core.status()).toEqual({ status: "signed-out" });
  });

  it("refresh 5xx: keeps a still-valid proof; expired proof → temporarily unavailable", async () => {
    const a = signedIn({ exp: SEC + 10, refresh: true, route: () => json(503, {}) });
    expect(await a.core.getSession()).toMatchObject({ ok: true });
    const b = signedIn({ exp: SEC - 10, refresh: true, route: () => json(503, {}) });
    expect(await b.core.getSession()).toEqual({ ok: false, error: "Session refresh is temporarily unavailable." });
    const c = signedIn({ exp: SEC - 10, refresh: true, route: () => { throw netError("ECONNREFUSED"); } });
    expect(await c.core.getSession()).toEqual({ ok: false, error: "Session refresh is temporarily unavailable." });
    expect(existsSync(c.idFile)).toBe(true);
  });

  it.each([
    ["no proof", {}],
    ["other sub", { proof: proof({ sub: "u2" }) }],
    ["wrong purpose", { proof: proof({ purpose: "x" }) }],
    ["wrong issuer", { proof: proof({ iss: "x" }) }],
    ["zero exp", { proof: proof({ exp: 0 }) }],
  ])("refresh response with %s → device-session-invalid-response", async (_n, body) => {
    const a = signedIn({ exp: SEC + 10, refresh: true, route: () => json(200, body) });
    expect(await a.core.getSession()).toMatchObject({ ok: false, needsAuth: true });
    expect(a.rec.events).toContainEqual({ kind: "session-death", details: { reason: "device-session-invalid-response" } });
  });

  it("session swapped during refresh → account changed", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const a = signedIn({
      exp: SEC + 10,
      refresh: true,
      route: async () => {
        await gate;
        return json(200, { proof: proof() });
      },
    });
    const pending = a.core.getSession();
    await flush();
    await a.core.signOutAll();
    release();
    expect(await pending).toEqual({ ok: false, error: "The signed-in account changed. Please try again." });
  });

  it("expired proof without refresh token → proof-expired death (recorded once)", async () => {
    const a = signedIn({ exp: SEC - 1 });
    expect(await a.core.getSession()).toEqual({ ok: false, error: "Your session has expired. Sign in again.", needsAuth: true });
    await a.core.getSession();
    expect(a.rec.events.filter((e) => e.kind === "session-death")).toEqual([{ kind: "session-death", details: { reason: "proof-expired" } }]);
    expect(a.core.takeSessionDeath()).toBe(true);
    expect(a.core.takeSessionDeath()).toBe(false);
  });

  it("no session → expired error", async () => {
    expect(await setup().core.getSession()).toEqual({ ok: false, error: "Your session has expired. Sign in again.", needsAuth: true });
  });
});

describe("gatewayRequest", () => {
  function signedIn(route: Route) {
    const a = setup({ route });
    writeIdentity(a.dir, { exp: SEC + 3600, proof: proof() });
    return a;
  }

  it("http: bearer proof, JSON body, parsed response", async () => {
    const a = signedIn(() => json(409, { claim: true }));
    const r = await a.core.gatewayRequest({ path: "/labs/session", method: "POST", body: { deployment_id: "d" } });
    expect(r).toEqual({ kind: "http", status: 409, body: { claim: true }, gatewayUrl: GATEWAY_PROD });
    const call = a.ff.calls[0];
    expect(call?.url).toBe("https://my.silico.run/labs/session");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers).toEqual({ authorization: `Bearer ${proof()}`, "content-type": "application/json" });
    expect(call?.init.body).toBe('{"deployment_id":"d"}');
  });

  it("non-JSON body → null", async () => {
    const a = signedIn(() => new Response("oops", { status: 502 }));
    expect(await a.core.gatewayRequest({ path: "/labs" })).toMatchObject({ kind: "http", status: 502, body: null });
  });

  it("401 drops the session (gateway-401) and returns auth/needsAuth", async () => {
    const a = signedIn(() => json(401, {}));
    expect(await a.core.gatewayRequest({ path: "/labs" })).toEqual({ kind: "auth", error: "Your session has expired. Sign in again.", needsAuth: true });
    expect(a.rec.events).toContainEqual({ kind: "session-death", details: { reason: "gateway-401" } });
    expect(existsSync(a.idFile)).toBe(false);
  });

  it("session drop keeps the published identity (lastIdentity); only sign-out clears it (C1, auth §3.1)", async () => {
    const a = signedIn(() => json(401, {}));
    await a.core.status();
    expect(a.core.lastIdentity()).toEqual({ sub: "u1", gatewayUrl: GATEWAY_PROD });
    await a.core.gatewayRequest({ path: "/labs" });
    expect(a.core.cachedIdentity()).toBeNull();
    expect(a.core.lastIdentity()).toEqual({ sub: "u1", gatewayUrl: GATEWAY_PROD });
    await a.core.signOutAll();
    expect(a.core.lastIdentity()).toBeNull();
  });

  it("alias fallback: primary fails, alias answers; telemetry reports it", async () => {
    const a = signedIn((url) => {
      if (url.startsWith(GATEWAY_PROD)) throw netError("ENOTFOUND");
      return json(200, { labs: [] });
    });
    expect(await a.core.gatewayRequest({ path: "/labs" })).toMatchObject({ kind: "http", status: 200 });
    expect(a.ff.calls.map((c) => c.url)).toEqual(["https://my.silico.run/labs", "https://silico.goodfire.com/labs"]);
    expect(a.rec.events).toContainEqual({
      kind: "gateway-transport-failure",
      details: { operation: "api", hostname: "my.silico.run", failureKind: "dns", aliasHostname: "silico.goodfire.com", aliasOutcome: "responded", responseHostname: "silico.goodfire.com" },
    });
  });

  it("aliasFallback:false and network failure → kind network with code", async () => {
    const a = signedIn(() => { throw netError("ECONNREFUSED"); });
    expect(await a.core.gatewayRequest({ path: "/labs", aliasFallback: false })).toEqual({ kind: "network", error: "fetch failed (ECONNREFUSED)", code: "ECONNREFUSED" });
    expect(a.ff.calls).toHaveLength(1);
  });

  it("times out each attempt", async () => {
    const a = signedIn((_u, init) => new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted")))));
    const r = await a.core.gatewayRequest({ path: "/labs", timeoutMs: 10 });
    expect(r).toEqual({ kind: "network", error: "aborted" });
    expect(a.rec.events.filter((e) => e.kind === "gateway-transport-failure").map((e) => e.details?.failureKind)).toEqual(["timeout", "timeout"]);
  });

  it("signed out → auth", async () => {
    expect(await setup().core.gatewayRequest({ path: "/labs" })).toEqual({ kind: "auth", error: "Your session has expired. Sign in again.", needsAuth: true });
  });
});

describe("developer flag from lab token", () => {
  it("flips, persists, notifies and broadcasts to all windows", async () => {
    const a = setup();
    writeIdentity(a.dir, { exp: SEC + 3600, proof: proof() });
    await a.core.status();
    const devs: boolean[] = [];
    a.core.onDeveloperChanged((d) => devs.push(d));
    await a.core.noteLabToken(makeProof({ developer: true }));
    expect(a.core.isDeveloper()).toBe(true);
    expect(devs).toEqual([true]);
    expect(JSON.parse(readFileSync(a.idFile, "utf-8")).developer).toBe(true);
    expect(a.rec.broadcasts).toEqual([{ channel: "auth:changed", payload: expect.objectContaining({ developer: true }), trustedOnly: false }]);
    await a.core.noteLabToken(makeProof({ developer: true })); // unchanged → no-op
    expect(devs).toEqual([true]);
    await a.core.noteLabToken("garbage");
    expect(devs).toEqual([true, false]);
    expect(JSON.parse(readFileSync(a.idFile, "utf-8")).developer).toBeUndefined();
  });
});

describe("sign out + revocation queue", () => {
  it("without refresh token: deletes identity.json, publishes null identity", async () => {
    const a = setup();
    writeIdentity(a.dir, { exp: SEC + 3600, proof: proof(), developer: true });
    await a.core.status();
    const ids: unknown[] = [];
    const devs: boolean[] = [];
    a.core.onIdentityChanged((i) => ids.push(i));
    a.core.onDeveloperChanged((d) => devs.push(d));
    await a.core.signOutAll();
    expect(existsSync(a.idFile)).toBe(false);
    expect(ids).toEqual([null]);
    expect(devs).toEqual([false]);
    expect(await a.core.status()).toEqual({ status: "signed-out" });
    expect(a.ff.calls.filter((c) => c.url.includes("/labs/logout"))).toHaveLength(0);
  });

  it("with refresh token: queues the file (dir 0700), revokes with Bearer refresh token, deletes on {ok:true}", async () => {
    const a = setup({ route: (u) => (u.endsWith("/labs/logout") ? json(200, { ok: true }) : json(404, {})) });
    writeIdentity(a.dir, { exp: SEC + 3600, proof: proof(), refreshToken: "sdr_r.t" });
    await a.core.status();
    await a.core.signOutAll();
    const qdir = join(a.dir, "pending-revocations");
    expect(statSync(qdir).mode & 0o777).toBe(0o700);
    expect(existsSync(a.idFile)).toBe(false);
    await vi.waitFor(() => expect(readdirSync(qdir)).toEqual([]));
    const call = a.ff.calls.find((c) => c.url.endsWith("/labs/logout"));
    expect(call?.url).toBe("https://my.silico.run/labs/logout");
    expect((call?.init.headers as Record<string, string>).authorization).toBe("Bearer sdr_r.t");
  });

  it("failed revocation stays queued and is retried 30 s later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let ok = false;
    const a = setup({ route: (u) => (u.endsWith("/labs/logout") ? json(ok ? 404 : 500, {}) : json(404, {})) });
    writeIdentity(a.dir, { exp: SEC + 3600, proof: proof(), refreshToken: "sdr_r.t" });
    await a.core.status();
    await a.core.signOutAll();
    const qdir = join(a.dir, "pending-revocations");
    await vi.waitFor(() => expect(a.ff.calls.filter((c) => c.url.endsWith("/labs/logout")).length).toBeGreaterThanOrEqual(1));
    await flush();
    const files = readdirSync(qdir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^1700000000000-[0-9a-f]{24}\.json$/);
    ok = true;
    a.clock.now += 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(readdirSync(qdir)).toEqual([]));
  });

  it("retry sweep: throttled to once per 30 s, deletes unreadable entries", async () => {
    const a = setup({ route: () => json(200, { ok: true }) });
    const qdir = join(a.dir, "pending-revocations");
    mkdirSync(qdir, { recursive: true });
    writeFileSync(join(qdir, "1-bad.json"), "{not json");
    writeFileSync(join(qdir, "2-norefresh.json"), JSON.stringify({ version: 1, gatewayUrl: GATEWAY_PROD, sub: "s", exp: 1, encrypted: false, proof: "p" }));
    writeFileSync(join(qdir, "ignore.txt"), "x");
    await a.core.retryRevocations();
    expect(readdirSync(qdir)).toEqual(["ignore.txt"]);
    writeFileSync(join(qdir, "3-ok.json"), JSON.stringify({ version: 1, gatewayUrl: GATEWAY_PROD, sub: "s", exp: 1, encrypted: false, proof: "p", refreshToken: "sdr_q.w" }));
    await a.core.retryRevocations(); // throttled
    expect(readdirSync(qdir)).toContain("3-ok.json");
    a.clock.now += 30_000;
    await a.core.retryRevocations();
    expect(readdirSync(qdir)).toEqual(["ignore.txt"]);
  });

  it("status() kicks the queue", async () => {
    const a = setup({ route: () => json(401, {}) });
    const qdir = join(a.dir, "pending-revocations");
    mkdirSync(qdir, { recursive: true });
    writeFileSync(join(qdir, "3-ok.json"), JSON.stringify({ version: 1, gatewayUrl: GATEWAY_PROD, sub: "s", exp: 1, encrypted: false, proof: "p", refreshToken: "sdr_q.w" }));
    await a.core.status();
    await vi.waitFor(() => expect(readdirSync(qdir)).toEqual([]));
  });

  it("rename failure keeps the session in memory for retry", async () => {
    let status = 500;
    const a = setup({ route: () => json(status, {}) });
    writeIdentity(a.dir, { exp: SEC + 3600, proof: proof(), refreshToken: "sdr_r.t" });
    await a.core.status();
    const qdir = join(a.dir, "pending-revocations");
    mkdirSync(qdir, { mode: 0o500 }); // rename into it fails with EACCES
    try {
      await a.core.signOutAll();
      expect(existsSync(a.idFile)).toBe(false);
      expect(a.core.pendingMemoryRevocations()).toBe(1);
      await vi.waitFor(() => expect(a.ff.calls.length).toBeGreaterThanOrEqual(1));
      status = 404;
      a.clock.now += 30_000;
      await a.core.retryRevocations({ force: true });
      expect(a.core.pendingMemoryRevocations()).toBe(0);
    } finally {
      chmodSync(qdir, 0o700);
    }
  });

  it("mkdir failure rejects sign-out (state is already cleared)", async () => {
    const a = setup();
    writeIdentity(a.dir, { exp: SEC + 3600, proof: proof(), refreshToken: "sdr_r.t" });
    await a.core.status();
    writeFileSync(join(a.dir, "pending-revocations"), "a file, not a dir");
    await expect(a.core.signOutAll()).rejects.toThrow();
    expect(await a.core.status()).toEqual({ status: "signed-out" });
  });
});

describe("signup adoption + desktop-continue", () => {
  it("adopts a valid signup proof without refresh token and fires onSignedIn", async () => {
    const a = setup();
    const signed: unknown[] = [];
    a.core.onSignedIn((i) => signed.push(i));
    const p = proof({ login: "bob" });
    const state = await a.core.adoptSignupProof(p, true);
    expect(state).toEqual({ status: "signed-in", login: "bob", sub: "u1", gatewayUrl: GATEWAY_STAGING, expiresAt: (SEC + 3600) * 1000, developer: false });
    expect(signed).toEqual([{ sub: "u1", login: "bob", gatewayUrl: GATEWAY_STAGING }]);
    expect(JSON.parse(readFileSync(a.idFile, "utf-8")).refreshToken).toBeUndefined();
  });

  it.each([
    ["missing login", { login: "" }],
    ["expired", { exp: SEC - 1 }],
    ["wrong purpose", { purpose: "other" }],
    ["wrong issuer", { iss: "other" }],
  ])("rejects a signup proof with %s", async (_n, extra) => {
    await expect(setup().core.adoptSignupProof(proof(extra), false)).rejects.toThrow("Gateway returned an invalid signup identity proof.");
  });

  it("completes sign-in in memory when identity.json cannot be written", async () => {
    const a = setup();
    mkdirSync(a.idFile); // rename onto a directory fails
    const signed: unknown[] = [];
    a.core.onSignedIn((i) => signed.push(i));
    const state = await a.core.adoptSignupProof(proof(), false);
    expect(state.status).toBe("signed-in");
    expect(signed).toHaveLength(1);
    expect((await a.core.status()).status).toBe("signed-in");
    expect(statSync(a.idFile).isDirectory()).toBe(true);
  });

  it("cancels an in-flight browser sign-in", async () => {
    const a = setup({ route: () => json(200, {}) });
    const pending = a.core.signIn(false, false);
    pending.catch(() => {});
    await vi.waitFor(() => expect(a.opened).toHaveLength(1));
    await a.core.adoptSignupProof(proof(), false);
    await expect(pending).rejects.toThrow("Sign-in restarted.");
  });

  it("desktop-continue returns a valid resume token on the matching gateway only", async () => {
    const rt = "R".repeat(90);
    const a = setup({ route: (u) => (u.endsWith("/beta-signup/desktop-continue") ? json(200, { resume_token: rt }) : json(404, {})) });
    writeIdentity(a.dir, { exp: SEC + 3600, proof: proof() });
    expect(await a.core.desktopContinue("t".repeat(43), false)).toBe(rt);
    const call = a.ff.calls[0];
    expect(call?.url).toBe("https://my.silico.run/beta-signup/desktop-continue");
    expect(JSON.parse(call?.init.body as string)).toEqual({ token: "t".repeat(43) });
    expect(await a.core.desktopContinue("t".repeat(43), true)).toBeNull();
    const b = setup({ route: () => json(200, { resume_token: "short" }) });
    writeIdentity(b.dir, { exp: SEC + 3600, proof: proof() });
    expect(await b.core.desktopContinue("t", false)).toBeNull();
    const c = setup({ route: () => { throw netError("ENOTFOUND"); } });
    writeIdentity(c.dir, { exp: SEC + 3600, proof: proof() });
    expect(await c.core.desktopContinue("t", false)).toBeNull();
    expect(c.ff.calls).toHaveLength(1); // no alias fallback
    expect(await setup().core.desktopContinue("t", false)).toBeNull();
  });
});
