import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deepLinkLabel,
  deepLinkTarget,
  findDeepLinkInArgv,
  isWelcomeLink,
  parseCheckoutReturn,
  parseGithubConnectReturn,
  parseMcpOauthReturn,
  parseOpenLink,
  parseSignupLink,
  parseSignupReady,
  parseSignupResumeLink,
} from "../../../src/main/auth/deepLinkParse";
import { BoundedLifoQueue, NonceStore, PendingByKey, StickySuccessSlot } from "../../../src/main/auth/returnStores";

const T43 = "a".repeat(43);
const R80 = "B".repeat(80);

describe("deep-link parsers", () => {
  it("target + label + argv", () => {
    expect(deepLinkTarget("silico://WELCOME")).toBe("welcome");
    expect(deepLinkTarget("silico:welcome")).toBe("welcome");
    expect(deepLinkTarget("silico:///welcome")).toBe("welcome");
    expect(deepLinkTarget("https://welcome")).toBeNull();
    expect(deepLinkLabel("silico://checkout-return?x")).toBe("checkout-return");
    expect(deepLinkLabel("silico:open/x")).toBe("open");
    expect(deepLinkLabel("bad")).toBe("silico");
    expect(findDeepLinkInArgv(["/app", "--x", "SILICO://welcome"])).toBe("SILICO://welcome");
    expect(findDeepLinkInArgv(["/app"])).toBeNull();
  });
  it("signup token: exactly 43 url-safe chars", () => {
    expect(parseSignupLink(`silico://signup?token=${T43}`)).toBe(T43);
    expect(parseSignupLink(`silico:signup?token=${T43}`)).toBe(T43);
    expect(parseSignupLink(`silico://signup?token=${"a".repeat(42)}`)).toBeNull();
    expect(parseSignupLink(`silico://signup?token=${"a".repeat(44)}`)).toBeNull();
    expect(parseSignupLink(`silico://signup?token=${"a".repeat(42)}=`)).toBeNull();
    expect(parseSignupLink(`silico://signup-resume?token=${T43}`)).toBeNull();
  });
  it("resume token: 80..4096 + up to two =", () => {
    expect(parseSignupResumeLink(`silico://signup-resume?token=${R80}`)).toBe(R80);
    expect(parseSignupResumeLink(`silico://signup-resume?token=${R80}==`)).toBe(`${R80}==`);
    expect(parseSignupResumeLink(`silico://signup-resume?token=${R80}===`)).toBeNull();
    expect(parseSignupResumeLink(`silico://signup-resume?token=${"B".repeat(79)}`)).toBeNull();
    expect(parseSignupResumeLink(`silico://signup-resume?token=${"B".repeat(4096)}`)).not.toBeNull();
    expect(parseSignupResumeLink(`silico://signup-resume?token=${"B".repeat(4097)}`)).toBeNull();
  });
  it("signup-ready", () => {
    const proof = `${"a".repeat(40)}.${"b".repeat(40)}.${"c".repeat(20)}`;
    expect(parseSignupReady(`silico://signup-ready?deployment_id=lab-1&proof=${proof}`)).toEqual({ deploymentId: "lab-1", proof });
    expect(parseSignupReady(`silico://signup-ready?deployment_id=lab-1&proof=${proof}&return_to=/onboarding/compute`)).toEqual({ deploymentId: "lab-1", proof, returnTo: "/onboarding/compute" });
    expect(parseSignupReady(`silico://signup-ready?deployment_id=lab-1&proof=${proof}&return_to=/other`)).toEqual({ deploymentId: "lab-1", proof });
    expect(parseSignupReady(`silico://signup-ready?deployment_id=ab&proof=${proof}`)).toBeNull();
    expect(parseSignupReady(`silico://signup-ready?deployment_id=abc&proof=${proof}`)).not.toBeNull();
    expect(parseSignupReady(`silico://signup-ready?deployment_id=Lab-1&proof=${proof}`)).toBeNull();
    expect(parseSignupReady(`silico://signup-ready?deployment_id=lab-&proof=${proof}`)).toBeNull();
    expect(parseSignupReady(`silico://signup-ready?deployment_id=${"a".repeat(65)}&proof=${proof}`)).toBeNull();
    expect(parseSignupReady(`silico://signup-ready?deployment_id=${"a".repeat(64)}&proof=${proof}`)).not.toBeNull();
    expect(parseSignupReady(`silico://signup-ready?deployment_id=lab-1&proof=${"a".repeat(48)}.${"b".repeat(48)}.c`)).toBeNull(); // 99 chars
    expect(parseSignupReady(`silico://signup-ready?deployment_id=lab-1&proof=${"a".repeat(2050)}.${"b".repeat(2050)}.c`)).toBeNull();
    expect(parseSignupReady(`silico://signup-ready?deployment_id=lab-1&proof=${"a".repeat(120)}`)).toBeNull();
  });
  it("welcome and open", () => {
    expect(isWelcomeLink("silico://welcome")).toBe(true);
    expect(isWelcomeLink("silico://welcomes")).toBe(false);
    expect(parseOpenLink("silico://open?url=https%3A%2F%2Flab.silico.run%2Fx")).toBe("https://lab.silico.run/x");
    expect(parseOpenLink("silico://open?url=https%3A%2F%2Fsilico.run")).toBe("https://silico.run/");
    expect(parseOpenLink("silico://open?url=http%3A%2F%2Flocalhost%3A3000%2Fa")).toBe("http://localhost:3000/a");
    expect(parseOpenLink("silico://open?url=http%3A%2F%2F127.0.0.1%2Fa")).toBe("http://127.0.0.1/a");
    expect(parseOpenLink("silico://open?url=http%3A%2F%2Flab.silico.run")).toBeNull();
    expect(parseOpenLink("silico://open?url=https%3A%2F%2Fevilsilico.run")).toBeNull();
    expect(parseOpenLink("silico://open?url=https%3A%2F%2Flocalhost")).toBeNull();
    expect(parseOpenLink("silico://open")).toBeNull();
  });
  it("checkout-return", () => {
    expect(parseCheckoutReturn("silico://checkout-return?outcome=manage&s=x")).toEqual({ outcome: "manage", nonce: "x" });
    expect(parseCheckoutReturn("silico:checkout-return?outcome=success&s=x")).toEqual({ outcome: "success", nonce: "x" });
    expect(parseCheckoutReturn("silico://CHECKOUT-RETURN?outcome=cancel&s=x")).toEqual({ outcome: "cancel", nonce: "x" });
    expect(parseCheckoutReturn("silico://checkout-return?outcome=refund&s=x")).toBeNull();
    expect(parseCheckoutReturn("silico://checkout-return?outcome=success")).toBeNull();
    expect(parseCheckoutReturn("https://checkout-return?outcome=success&s=x")).toBeNull();
  });
  it("mcp-oauth-return", () => {
    expect(parseMcpOauthReturn("silico://mcp-oauth-return?outcome=code&code=abc&state=xyz&s=ab-1")).toEqual({ payload: { outcome: "code", code: "abc", state: "xyz" }, nonce: "ab-1" });
    expect(parseMcpOauthReturn("silico://mcp-oauth-return?outcome=code&code=abc&state=xyz&s=a_b")).toBeNull();
    expect(parseMcpOauthReturn(`silico://mcp-oauth-return?outcome=code&code=${encodeURIComponent("é")}&state=x&s=a`)).toBeNull();
    expect(parseMcpOauthReturn(`silico://mcp-oauth-return?outcome=code&code=${"c".repeat(2049)}&state=x&s=a`)).toBeNull();
    expect(parseMcpOauthReturn(`silico://mcp-oauth-return?outcome=code&code=c&state=${"s".repeat(4097)}&s=a`)).toBeNull();
    expect(parseMcpOauthReturn("silico://mcp-oauth-return?outcome=code&state=x&s=a")).toBeNull();
    expect(parseMcpOauthReturn("silico://mcp-oauth-return?outcome=error&error=access_denied&s=a")).toEqual({ payload: { outcome: "error", error: "access_denied" }, nonce: "a" });
    expect(parseMcpOauthReturn("silico://mcp-oauth-return?outcome=error&error=Access&s=a")).toBeNull();
    expect(parseMcpOauthReturn("silico://mcp-oauth-return?outcome=other&s=a")).toBeNull();
    expect(parseMcpOauthReturn(`silico://mcp-oauth-return?outcome=error&error=x&s=${"a".repeat(65)}`)).toBeNull();
  });
  it("github-connect-return", () => {
    expect(parseGithubConnectReturn("silico://github-connect-return?outcome=success&s=n")).toEqual({ payload: { outcome: "success" }, nonce: "n" });
    expect(parseGithubConnectReturn("silico://github-connect-return?outcome=error&error=bad_thing&s=n")).toEqual({ payload: { outcome: "error", error: "bad_thing" }, nonce: "n" });
    expect(parseGithubConnectReturn("silico://github-connect-return?outcome=error&error=bad-thing&s=n")).toBeNull();
    expect(parseGithubConnectReturn("silico://github-connect-return?outcome=success")).toBeNull();
  });
});

describe("return stores", () => {
  afterEach(() => vi.useRealTimers());

  it("NonceStore: single use and TTL", () => {
    vi.useFakeTimers();
    let now = 0;
    const store = new NonceStore<string>(1000, () => now);
    store.add("a", "A");
    expect(store.consume("a")).toBe("A");
    expect(store.consume("a")).toBeNull();
    store.add("b", "B");
    now = 1001;
    expect(store.consume("b")).toBeNull();
    expect(store.size).toBe(0);
    store.add("c", "C");
    vi.advanceTimersByTime(1000);
    expect(store.size).toBe(0);
  });
  it("BoundedLifoQueue: cap 3 drops oldest, pops newest, entries expire", () => {
    vi.useFakeTimers();
    const q = new BoundedLifoQueue<string>(3, 10_000);
    for (const p of ["p1", "p2", "p3", "p4"]) q.push("c", p);
    expect(q.size("c")).toBe(3);
    expect(q.take("c")).toBe("p4");
    expect(q.take("c")).toBe("p3");
    q.push("c", "p5");
    vi.advanceTimersByTime(10_000);
    expect(q.take("c")).toBeNull();
    expect(q.take("other")).toBeNull();
  });
  it("PendingByKey: latest wins, taken once", () => {
    const p = new PendingByKey<string>();
    p.set("c", "a");
    p.set("c", "b");
    expect(p.take("c")).toBe("b");
    expect(p.take("c")).toBeNull();
  });
  it("StickySuccessSlot: error never overwrites success", () => {
    const s = new StickySuccessSlot<{ outcome: string; error?: string }>();
    s.set("c", { outcome: "success" });
    s.set("c", { outcome: "error", error: "x" });
    expect(s.take("c")).toEqual({ outcome: "success" });
    expect(s.take("c")).toBeNull();
    s.set("c", { outcome: "error", error: "x" });
    s.set("c", { outcome: "success" });
    expect(s.take("c")).toEqual({ outcome: "success" });
    s.set("c", { outcome: "error", error: "x" });
    s.set("c", { outcome: "error", error: "y" });
    expect(s.take("c")).toEqual({ outcome: "error", error: "y" });
  });
});
