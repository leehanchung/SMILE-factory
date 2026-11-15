import { describe, expect, it } from "vitest";
import { GATEWAY_PROD, GATEWAY_STAGING, NEVER_EXPIRES_AT } from "@shared/config";
import {
  expandAliases,
  gatewayFor,
  gatewayOfUrl,
  isCanonicalGateway,
  signupConfirmUrl,
  signupResumeUrl,
  signupUrl,
} from "../../../src/main/auth/gateways";
import { decodeProofClaims, hasDeveloperClaim, isRefreshedProofValid, isSignupProofValid } from "../../../src/main/auth/proof";
import {
  backendName,
  encryptionAllowed,
  expiresAtOf,
  parseIdentity,
  persistenceMode,
  serializeIdentity,
  type Session,
} from "../../../src/main/auth/identityFile";
import {
  hashToken,
  isRevocationDone,
  isTransientActivationStatus,
  mintRefreshToken,
  parseActivationCode,
} from "../../../src/main/auth/activation";
import { classifySignupUrl, isGatewayPage, scaleByZoom, signupBounds, systemBrowserUrl } from "../../../src/main/auth/signupPolicy";
import { buildLoginUrl, isValidHost, parseCallback, successPage, failurePage } from "../../../src/main/auth/loopback";
import { classifyFailure, formatNetworkError, transportFailureDetails } from "../../../src/main/auth/transport";
import { makeProof } from "./helpers";
import { createHash } from "node:crypto";

describe("gateways", () => {
  it("maps staging flag and recognises canonical origins only", () => {
    expect(gatewayFor(false)).toBe(GATEWAY_PROD);
    expect(gatewayFor(true)).toBe(GATEWAY_STAGING);
    expect(isCanonicalGateway("https://my.silico.run")).toBe(true);
    expect(isCanonicalGateway("https://silico.goodfire.com")).toBe(false);
    expect(isCanonicalGateway("https://my.silico.run/")).toBe(false);
  });
  it("expands aliases keeping path and query", () => {
    expect(expandAliases("https://my.silico.run/labs/refresh?x=1")).toEqual([
      "https://my.silico.run/labs/refresh?x=1",
      "https://silico.goodfire.com/labs/refresh?x=1",
    ]);
    expect(expandAliases("https://my-staging.silico.run/labs")).toEqual([
      "https://my-staging.silico.run/labs",
      "https://silico-staging.goodfire.com/labs",
    ]);
    expect(expandAliases("https://example.com/x")).toEqual(["https://example.com/x"]);
    expect(expandAliases("not a url")).toEqual(["not a url"]);
  });
  it("maps alias URLs back to the canonical gateway", () => {
    expect(gatewayOfUrl("https://silico-staging.goodfire.com/login")).toBe(GATEWAY_STAGING);
    expect(gatewayOfUrl("https://my.silico.run/")).toBe(GATEWAY_PROD);
    expect(gatewayOfUrl("https://evil.example")).toBeNull();
    expect(gatewayOfUrl("::")).toBeNull();
  });
  it("builds signup URLs", () => {
    expect(signupUrl(false)).toBe("https://my.silico.run/beta-signup");
    expect(signupConfirmUrl(true, "a+b")).toBe("https://my-staging.silico.run/beta-signup/confirm?token=a%2Bb");
    expect(signupResumeUrl(false, "r=")).toBe("https://my.silico.run/beta-signup/resume?token=r%3D");
  });
});

describe("proof", () => {
  it("decodes claims with defaults", () => {
    const c = decodeProofClaims(makeProof({ sub: "u1", login: "al", exp: 10, purpose: "labs", iss: "silico-lab-auth", developer: true }));
    expect(c).toEqual({ sub: "u1", login: "al", exp: 10, purpose: "labs", issuer: "silico-lab-auth", developer: true });
    expect(decodeProofClaims(makeProof({}))).toEqual({ sub: "", login: "", exp: 0, purpose: "", issuer: "", developer: false });
    expect(decodeProofClaims(makeProof({ developer: "true" })).developer).toBe(false);
  });
  it("throws Malformed proof without a middle segment and on bad JSON", () => {
    expect(() => decodeProofClaims("abc")).toThrow("Malformed proof");
    expect(() => decodeProofClaims("a.!!!.c")).toThrow();
  });
  it("hasDeveloperClaim never throws", () => {
    expect(hasDeveloperClaim(makeProof({ developer: true }))).toBe(true);
    expect(hasDeveloperClaim(makeProof({ developer: 1 }))).toBe(false);
    expect(hasDeveloperClaim("garbage")).toBe(false);
  });
  it("validates refreshed and signup proofs", () => {
    const good = { sub: "u", login: "l", exp: 100, purpose: "labs", issuer: "silico-lab-auth", developer: false };
    expect(isRefreshedProofValid(good, "u")).toBe(true);
    expect(isRefreshedProofValid(good, "other")).toBe(false);
    expect(isRefreshedProofValid({ ...good, exp: 0 }, "u")).toBe(false);
    expect(isRefreshedProofValid({ ...good, purpose: "x" }, "u")).toBe(false);
    expect(isRefreshedProofValid({ ...good, issuer: "x" }, "u")).toBe(false);
    expect(isSignupProofValid(good, 99_000)).toBe(true);
    expect(isSignupProofValid(good, 100_000)).toBe(false);
    expect(isSignupProofValid({ ...good, login: "" }, 0)).toBe(false);
    expect(isSignupProofValid({ ...good, sub: "" }, 0)).toBe(false);
  });
});

describe("identity file", () => {
  const session: Session = { gatewayUrl: GATEWAY_PROD, sub: "s", login: "l", exp: 5, proof: "P", refreshToken: "R", developer: true };
  const enc = (s: string): string => `E(${s})`;
  const dec = (s: string): string => {
    const m = /^E\((.*)\)$/.exec(s);
    if (!m) throw new Error("bad");
    return m[1] as string;
  };

  it("round-trips encrypted records with backend", () => {
    const rec = serializeIdentity(session, enc, { plaintextFallback: false, backend: "keychain" });
    expect(rec).toEqual({ version: 1, gatewayUrl: GATEWAY_PROD, sub: "s", login: "l", exp: 5, developer: true, encrypted: true, proof: "E(P)", refreshToken: "E(R)", backend: "keychain" });
    expect(parseIdentity(JSON.stringify(rec), dec)).toEqual(session);
  });
  it("writes plaintext only with fallback, else null", () => {
    expect(serializeIdentity(session, null, { plaintextFallback: false })).toBeNull();
    const rec = serializeIdentity({ ...session, developer: undefined, refreshToken: undefined }, null, { plaintextFallback: true, backend: "x" });
    expect(rec).toEqual({ version: 1, gatewayUrl: GATEWAY_PROD, sub: "s", login: "l", exp: 5, encrypted: false, proof: "P" });
    expect(parseIdentity(JSON.stringify(rec), null)).toEqual({ gatewayUrl: GATEWAY_PROD, sub: "s", login: "l", exp: 5, proof: "P" });
  });
  it("returns null when encryption throws or yields empty", () => {
    expect(serializeIdentity(session, () => { throw new Error("x"); }, { plaintextFallback: true })).toBeNull();
    expect(serializeIdentity(session, () => "", { plaintextFallback: true })).toBeNull();
  });
  it("rejects bad records", () => {
    expect(parseIdentity("{", null)).toBeNull();
    expect(parseIdentity("null", null)).toBeNull();
    expect(parseIdentity(JSON.stringify({ gatewayUrl: GATEWAY_PROD, exp: 1, proof: "" }), null)).toBeNull();
    expect(parseIdentity(JSON.stringify({ gatewayUrl: GATEWAY_PROD, exp: "x", proof: "p" }), null)).toBeNull();
    expect(parseIdentity(JSON.stringify({ gatewayUrl: "https://silico.goodfire.com", exp: 1, proof: "p" }), null)).toBeNull();
    expect(parseIdentity(JSON.stringify({ gatewayUrl: GATEWAY_STAGING, exp: 1, proof: "p" }), null)?.gatewayUrl).toBe(GATEWAY_STAGING);
  });
  it("encrypted without decryptor or failing decrypt: signed out + backend mismatch warning", () => {
    const rec = JSON.stringify({ version: 1, gatewayUrl: GATEWAY_PROD, sub: "s", exp: 1, encrypted: true, proof: "zz", backend: "kwallet5" });
    const warnings: string[] = [];
    expect(parseIdentity(rec, null, { currentBackend: "gnome_libsecret", warn: (m) => warnings.push(m) })).toBeNull();
    expect(parseIdentity(rec, dec, { currentBackend: "gnome_libsecret", warn: (m) => warnings.push(m) })).toBeNull();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('"kwallet5"');
    expect(parseIdentity(rec, dec, { currentBackend: "kwallet5", warn: (m) => warnings.push(m) })).toBeNull();
    expect(warnings).toHaveLength(2);
  });
  it("persistence mode / backend / encryption gate / expiresAt", () => {
    expect(persistenceMode({ isPackaged: false, testMode: true, encryptionAvailable: true })).toBe("plaintext-dev");
    expect(persistenceMode({ isPackaged: true, testMode: true, encryptionAvailable: true })).toBe("none-test-mode");
    expect(persistenceMode({ isPackaged: true, testMode: false, encryptionAvailable: true })).toBe("keychain");
    expect(persistenceMode({ isPackaged: true, testMode: false, encryptionAvailable: false })).toBe("none-no-keyring");
    expect(backendName({ platform: "darwin" })).toBe("keychain");
    expect(backendName({ platform: "win32" })).toBe("dpapi");
    expect(backendName({ platform: "linux", linuxBackend: "kwallet" })).toBe("kwallet");
    expect(backendName({ platform: "linux" })).toBe("unknown");
    expect(encryptionAllowed({ isPackaged: true, testMode: false })).toBe(true);
    expect(encryptionAllowed({ isPackaged: true, testMode: true })).toBe(false);
    expect(encryptionAllowed({ isPackaged: false, testMode: false })).toBe(false);
    expect(expiresAtOf(session, NEVER_EXPIRES_AT)).toBe(8.64e15);
    expect(expiresAtOf({ ...session, refreshToken: undefined }, NEVER_EXPIRES_AT)).toBe(5000);
  });
});

describe("activation", () => {
  it("parses activation codes", () => {
    expect(parseActivationCode("sda_abc-_1.xyz")).toBe("abc-_1");
    expect(parseActivationCode("sda_abc")).toBeNull();
    expect(parseActivationCode("sdb_a.b")).toBeNull();
    expect(parseActivationCode("sda_a.b.c")).toBeNull();
    expect(parseActivationCode("sda_a b.c")).toBeNull();
  });
  it("mints sdr_ tokens and hashes with sha256 hex", () => {
    const t = mintRefreshToken("id1", Buffer.alloc(32, 0xff));
    expect(t).toBe(`sdr_id1.${Buffer.alloc(32, 0xff).toString("base64url")}`);
    expect(hashToken(t)).toBe(createHash("sha256").update(t).digest("hex"));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("maps statuses", () => {
    for (const s of [408, 425, 429, 500, 503]) expect(isTransientActivationStatus(s)).toBe(true);
    for (const s of [400, 401, 403, 404, 200]) expect(isTransientActivationStatus(s)).toBe(false);
    expect(isRevocationDone(401, null)).toBe(true);
    expect(isRevocationDone(404, null)).toBe(true);
    expect(isRevocationDone(200, { ok: true })).toBe(true);
    expect(isRevocationDone(200, { ok: "true" })).toBe(false);
    expect(isRevocationDone(500, { ok: true })).toBe(false);
  });
});

describe("signup policy", () => {
  it("classifies URLs", () => {
    expect(classifySignupUrl("javascript:alert(1)")).toBe("blocked");
    expect(classifySignupUrl("silico://signup-ready")).toBe("blocked");
    expect(classifySignupUrl("nope")).toBe("blocked");
    expect(classifySignupUrl("https://my.silico.run/beta-signup/github")).toBe("system-auth");
    expect(classifySignupUrl("https://my-staging.silico.run/beta-signup/github?x=1")).toBe("system-auth");
    expect(classifySignupUrl("https://silico.goodfire.com/beta-signup/github")).toBe("external");
    expect(classifySignupUrl("https://my.silico.run/beta-signup")).toBe("embedded");
    expect(classifySignupUrl("https://github.com/login")).toBe("embedded");
    expect(classifySignupUrl("http://my.silico.run/x")).toBe("external");
    expect(classifySignupUrl("https://example.com")).toBe("external");
  });
  it("system browser URLs", () => {
    expect(systemBrowserUrl("https://my.silico.run/beta-signup/github?a=1")).toBe("https://my.silico.run/beta-signup/github?a=1&desktop=1");
    expect(systemBrowserUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(systemBrowserUrl("https://my.silico.run/beta-signup")).toBeNull();
    expect(systemBrowserUrl("file:///etc/passwd")).toBeNull();
    expect(isGatewayPage("https://my-staging.silico.run/a")).toBe(true);
    expect(isGatewayPage("https://silico.goodfire.com/a")).toBe(false);
  });
  it("geometry", () => {
    expect(scaleByZoom(78, 1.5)).toBe(117);
    expect(scaleByZoom(78, 0)).toBe(78);
    expect(scaleByZoom(78, Number.NaN)).toBe(78);
    expect(signupBounds([800, 600], 78, 1.1)).toEqual({ x: 0, y: 86, width: 800, height: 514 });
    expect(signupBounds([800, 50], 78, 1)).toEqual({ x: 0, y: 78, width: 800, height: 0 });
  });
});

describe("loopback pure", () => {
  it("builds the login URL", () => {
    expect(buildLoginUrl("https://my.silico.run", 5555, "ab")).toBe(
      "https://my.silico.run/login?mode=desktop&redirect_uri=http%3A%2F%2F127.0.0.1%3A5555%2Fcallback%3Fs%3Dab",
    );
  });
  it("checks the Host header exactly", () => {
    expect(isValidHost("127.0.0.1:80", 80)).toBe(true);
    expect(isValidHost("localhost:80", 80)).toBe(false);
    expect(isValidHost("127.0.0.1:81", 80)).toBe(false);
    expect(isValidHost(undefined, 80)).toBe(false);
    expect(isValidHost("127.0.0.1:0", 0)).toBe(false);
  });
  it("parses callbacks", () => {
    expect(parseCallback("/callback?proof=p&s=st", "st")).toEqual({ ok: true, stateOk: true, proof: "p" });
    expect(parseCallback("/callback?proof=p&s=st&activation_code=sda_a.b", "st")).toEqual({ ok: true, stateOk: true, proof: "p", activationCode: "sda_a.b" });
    expect(parseCallback("/callback?proof=p&s=other", "st")).toMatchObject({ ok: false, stateOk: false });
    expect(parseCallback("/callback?s=st", "st")).toMatchObject({ ok: false, stateOk: true });
    expect(parseCallback("/callback?proof=p&activation_code=", "st")).toEqual({ ok: false, stateOk: false, proof: "p" });
  });
  it("result pages carry the exact copy", () => {
    expect(successPage()).toContain("Signed in");
    expect(successPage()).toContain("You can close this tab and return to the app.");
    expect(failurePage()).toContain("Sign-in didn’t complete");
    expect(failurePage()).toContain("Return to the app and try again.");
    expect(successPage("data:image/png;base64,AA")).toContain('src="data:image/png;base64,AA"');
  });
});

describe("transport pure", () => {
  it("classifies failures", () => {
    expect(classifyFailure(new Error("x"), true)).toBe("timeout");
    expect(classifyFailure({ cause: { code: "ENOTFOUND" } }, false)).toBe("dns");
    expect(classifyFailure({ code: "ECONNRESET" }, false)).toBe("reset");
    expect(classifyFailure(new Error("net::ERR_CONNECTION_TIMED_OUT"), false)).toBe("timeout");
    expect(classifyFailure(new Error("net::ERR_CERT_AUTHORITY_INVALID"), false)).toBe("tls");
    expect(classifyFailure({ code: "CERT_HAS_EXPIRED" }, false)).toBe("tls");
    expect(classifyFailure(new Error("net::ERR_INTERNET_DISCONNECTED"), false)).toBe("connection");
    expect(classifyFailure(new Error("boom"), false)).toBe("other");
    expect(classifyFailure(null, false)).toBe("other");
  });
  it("formats network errors with safe codes", () => {
    expect(formatNetworkError({ message: "fetch failed", cause: { code: "ECONNREFUSED" } }, "f")).toEqual({ error: "fetch failed (ECONNREFUSED)", code: "ECONNREFUSED" });
    expect(formatNetworkError({ message: "net::ERR_X", code: "ERR_X" }, "f")).toEqual({ error: "net::ERR_X", code: "ERR_X" });
    expect(formatNetworkError({ code: "bad code!" }, "fallback")).toEqual({ error: "fallback" });
    expect(formatNetworkError("str", "fallback")).toEqual({ error: "fallback" });
  });
  it("builds transport-failure details", () => {
    const url = "https://my.silico.run/labs";
    expect(transportFailureDetails("api", url, [])).toEqual([]);
    expect(transportFailureDetails("api", url, [{ hostname: "my.silico.run", failureKind: "dns" }], "https://silico.goodfire.com/labs")).toEqual([
      { operation: "api", hostname: "my.silico.run", failureKind: "dns", aliasHostname: "silico.goodfire.com", aliasOutcome: "responded", responseHostname: "silico.goodfire.com" },
    ]);
    const both = transportFailureDetails("api", url, [
      { hostname: "my.silico.run", failureKind: "dns" },
      { hostname: "silico.goodfire.com", failureKind: "timeout" },
    ]);
    expect(both).toHaveLength(2);
    expect(both[0]).toMatchObject({ aliasOutcome: "failed", responseHostname: null });
    expect(transportFailureDetails("api", url, [{ hostname: "my.silico.run", failureKind: "dns" }])[0]).toMatchObject({ aliasOutcome: "not-attempted" });
  });
});
