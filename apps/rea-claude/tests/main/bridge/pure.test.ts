import { describe, expect, it, vi } from "vitest";
import { BLOCKED_SPKI_SHA256, CERT_VERIFY_REJECT, CERT_VERIFY_USE_CHROMIUM, DEFAULT_NOTIFICATIONS } from "@shared/config";
import type { NotificationSettings } from "@shared/ipc";
import { aggregateBadge, badgeActionFor, parseBadge, sanitizeCount } from "../../../src/main/bridge/badge";
import { attributeForeground, ForegroundState, recentMarkers } from "../../../src/main/bridge/foreground";
import {
  Batcher,
  coalesce,
  Deduper,
  parseNotify,
  suppressedByFocus,
  suppressedBySettings,
  type NotificationRequest,
  type ParsedNotify,
} from "../../../src/main/bridge/notify";
import { ShellEventQueue, TransportFailureLimiter } from "../../../src/main/bridge/shell-events";
import { certificateVerdict, chainHasBlockedKey, spkiSha256, type CertLike } from "../../../src/main/bridge/tls";

const S = (o: Partial<NotificationSettings> = {}): NotificationSettings => ({ ...DEFAULT_NOTIFICATIONS, ...o });
const base = { kind: "finished", title: "A", route: "/w/1", dedupeKey: "k" };
const parsed = (o: Record<string, unknown> = {}): ParsedNotify => {
  const p = parseNotify({ ...base, ...o });
  if (!p) throw new Error("expected valid");
  return p;
};

describe("parseNotify", () => {
  it("accepts a minimal payload with defaults", () => {
    expect(parseNotify(base)).toEqual({
      kind: "finished",
      title: "A",
      body: "",
      route: "/w/1",
      dedupeKey: "k",
      status: undefined,
      elapsedSeconds: undefined,
      routeMatchesActiveView: false,
    });
  });
  it.each([
    ["non-object", null],
    ["string", "x"],
    ["bad kind", { ...base, kind: "other" }],
    ["empty title", { ...base, title: "" }],
    ["non-string title", { ...base, title: 5 }],
    ["empty route", { ...base, route: "" }],
    ["non-string route", { ...base, route: 1 }],
    ["missing dedupeKey", { kind: "finished", title: "A", route: "/r" }],
    ["empty dedupeKey", { ...base, dedupeKey: "" }],
  ])("drops %s", (_n, p) => {
    expect(parseNotify(p)).toBeNull();
  });
  it("truncates title and body to 200 chars; non-string body → ''", () => {
    const p = parsed({ title: "t".repeat(250), body: "b".repeat(201) });
    expect(p.title).toHaveLength(200);
    expect(p.body).toHaveLength(200);
    expect(parsed({ body: 42 }).body).toBe("");
  });
  it("keeps only known status, numeric elapsed, literal true", () => {
    expect(parsed({ status: "weird" }).status).toBeUndefined();
    expect(parsed({ status: "failed" }).status).toBe("failed");
    expect(parsed({ elapsedSeconds: "5" }).elapsedSeconds).toBeUndefined();
    expect(parsed({ elapsedSeconds: 5 }).elapsedSeconds).toBe(5);
    expect(parsed({ routeMatchesActiveView: "true" }).routeMatchesActiveView).toBe(false);
    expect(parsed({ routeMatchesActiveView: true }).routeMatchesActiveView).toBe(true);
  });
  it("accepts needsInput", () => {
    expect(parsed({ kind: "needsInput" }).kind).toBe("needsInput");
  });
});

describe("suppressedBySettings (policy matrix)", () => {
  it.each<[string, Record<string, unknown>, Partial<NotificationSettings>, boolean]>([
    ["defaults, finished", {}, {}, false],
    ["enabled:false", {}, { enabled: false }, true],
    ["enabled:false needsInput", { kind: "needsInput" }, { enabled: false }, true],
    ["needsInput off", { kind: "needsInput" }, { needsInput: false }, true],
    ["needsInput off does not affect finished", {}, { needsInput: false }, false],
    ["experimentFinished off", {}, { experimentFinished: false }, true],
    ["experimentFinished off does not affect needsInput", { kind: "needsInput" }, { experimentFinished: false }, false],
    ["completed 29s", { status: "completed", elapsedSeconds: 29 }, {}, true],
    ["completed 29.9s", { status: "completed", elapsedSeconds: 29.9 }, {}, true],
    ["completed 30s", { status: "completed", elapsedSeconds: 30 }, {}, false],
    ["failed 5s", { status: "failed", elapsedSeconds: 5 }, {}, false],
    ["stopped 5s", { status: "stopped", elapsedSeconds: 5 }, {}, false],
    ["completed, no elapsed", { status: "completed" }, {}, false],
    ["no status 5s", { elapsedSeconds: 5 }, {}, false],
    ["needsInput completed 5s (quick rule only for finished)", { kind: "needsInput", status: "completed", elapsedSeconds: 5 }, {}, false],
    ["sound/badge/notifyWhenActive irrelevant", {}, { sound: false, badge: false, notifyWhenActive: true }, false],
  ])("%s", (_n, p, s, expected) => {
    expect(suppressedBySettings(parsed(p), S(s))).toBe(expected);
  });
});

describe("suppressedByFocus", () => {
  const match = parsed({ routeMatchesActiveView: true });
  const all = { windowFocused: true, labShown: true };
  it("suppresses when focused + shown + route match + !notifyWhenActive", () => {
    expect(suppressedByFocus(match, all, S())).toBe(true);
  });
  it("shows when notifyWhenActive", () => {
    expect(suppressedByFocus(match, all, S({ notifyWhenActive: true }))).toBe(false);
  });
  it.each([
    ["not focused", match, { windowFocused: false, labShown: true }],
    ["not shown", match, { windowFocused: true, labShown: false }],
    ["route differs", parsed(), all],
  ])("shows when %s", (_n, n, f) => {
    expect(suppressedByFocus(n, f, S())).toBe(false);
  });
});

describe("Deduper", () => {
  it("5 min window, strictly-older prune", () => {
    const d = new Deduper();
    expect(d.isDuplicate("k", 0)).toBe(false);
    expect(d.isDuplicate("k", 299_999)).toBe(true);
    expect(d.isDuplicate("k", 300_000)).toBe(true);
    expect(d.isDuplicate("k", 300_001)).toBe(false);
  });
  it("duplicates do not refresh the timestamp; keys are independent; prunes others", () => {
    const d = new Deduper();
    d.isDuplicate("a", 0);
    d.isDuplicate("a", 200_000);
    expect(d.isDuplicate("b", 250_000)).toBe(false);
    expect(d.isDuplicate("a", 300_001)).toBe(false);
    d.isDuplicate("c", 900_000);
    expect(d.size).toBe(1);
  });
});

const req = (title: string, extra: Partial<NotificationRequest<string>> = {}): NotificationRequest<string> => ({
  title,
  body: `${title}-body`,
  route: `/r/${title}`,
  senderWc: `wc-${title}`,
  connId: `c-${title}`,
  sound: title !== "b",
  ...extra,
});

describe("coalesce", () => {
  it("empty → null; 1 → itself", () => {
    expect(coalesce([])).toBeNull();
    const a = req("a");
    expect(coalesce([a])).toBe(a);
  });
  it("2 items → count title, joined body, last item's routing", () => {
    expect(coalesce([req("a"), req("b")])).toEqual({
      title: "2 experiments finished",
      body: "a, b",
      route: "/r/b",
      senderWc: "wc-b",
      connId: "c-b",
      sound: false,
    });
  });
  it("3 items → no '+more'; 5 items → first three + '+2 more'", () => {
    expect(coalesce([req("a"), req("b"), req("c")])?.body).toBe("a, b, c");
    const five = coalesce(["a", "b", "c", "d", "e"].map((t) => req(t)));
    expect(five?.title).toBe("5 experiments finished");
    expect(five?.body).toBe("a, b, c +2 more");
    expect(five?.route).toBe("/r/e");
  });
});

describe("Batcher (700 ms debounce)", () => {
  it("each push restarts the timer; fires once with all items", () => {
    vi.useFakeTimers();
    try {
      const out: NotificationRequest<string>[] = [];
      const b = new Batcher<string>((r) => out.push(r), {
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      });
      b.push(req("a"));
      vi.advanceTimersByTime(699);
      b.push(req("b"));
      vi.advanceTimersByTime(699);
      expect(out).toHaveLength(0);
      expect(b.pending).toBe(2);
      vi.advanceTimersByTime(1);
      expect(out).toHaveLength(1);
      expect(out[0]?.title).toBe("2 experiments finished");
      b.push(req("c"));
      vi.advanceTimersByTime(700);
      expect(out[1]?.title).toBe("c");
      b.flush();
      expect(out).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("badge", () => {
  it("sanitizeCount", () => {
    expect(sanitizeCount(3.7)).toBe(3);
    expect(sanitizeCount(0)).toBe(0);
    expect(sanitizeCount(-1)).toBeNull();
    expect(sanitizeCount(Number.NaN)).toBeNull();
    expect(sanitizeCount(Number.POSITIVE_INFINITY)).toBeNull();
    expect(sanitizeCount("3")).toBeNull();
    expect(sanitizeCount(1e9)).toBe(9999);
    expect(sanitizeCount(9999.9)).toBe(9999);
  });
  it("parseBadge", () => {
    expect(parseBadge({ attention: 1 })).toBeNull();
    expect(parseBadge({ attention: -1, unread: 0 })).toBeNull();
    expect(parseBadge(null)).toBeNull();
    expect(parseBadge({ attention: 1.7, unread: 1e6 })).toEqual({ attention: 1, unread: 9999 });
  });
  const on = { enabled: true, badge: true };
  it("aggregateBadge", () => {
    expect(aggregateBadge([{ attention: 0, unread: 2 }, { attention: 0, unread: 1 }], on)).toEqual({ text: "•", count: 0 });
    expect(aggregateBadge([{ attention: 2, unread: 0 }, { attention: 3, unread: 9 }], on)).toEqual({ text: "5", count: 5 });
    expect(aggregateBadge([], on)).toEqual({ text: "", count: 0 });
    expect(aggregateBadge([{ attention: 2, unread: 0 }], { enabled: true, badge: false })).toEqual({ text: "", count: 0 });
    expect(aggregateBadge([{ attention: 2, unread: 0 }], { enabled: false, badge: true })).toEqual({ text: "", count: 0 });
    // sum is not re-capped
    expect(aggregateBadge([{ attention: 9999, unread: 0 }, { attention: 9999, unread: 0 }], on)).toEqual({ text: "19998", count: 19998 });
  });
  it("badgeActionFor per platform", () => {
    const att = { text: "3", count: 3 };
    const dot = { text: "•", count: 0 };
    expect(badgeActionFor("darwin", att)).toEqual({ kind: "dock", text: "3" });
    expect(badgeActionFor("darwin", dot)).toEqual({ kind: "dock", text: "•" });
    expect(badgeActionFor("linux", att)).toEqual({ kind: "count", count: 3 });
    expect(badgeActionFor("linux", dot)).toEqual({ kind: "count", count: 0 });
    expect(badgeActionFor("win32", att)).toEqual({ kind: "none" });
  });
});

describe("ShellEventQueue", () => {
  it("cap 100, drops oldest, drain takes all then empty", () => {
    const q = new ShellEventQueue<number>();
    let dropped = 0;
    for (let i = 0; i < 105; i++) dropped += q.push(i);
    expect(dropped).toBe(5);
    const out = q.drain();
    expect(out).toHaveLength(100);
    expect(out[0]).toBe(5);
    expect(out[99]).toBe(104);
    expect(q.drain()).toEqual([]);
  });
});

describe("TransportFailureLimiter", () => {
  it("same key + same details within 5 min dropped; different details kept; after window kept", () => {
    const l = new TransportFailureLimiter();
    const d = { operation: "api", hostname: "h", code: "E1" };
    expect(l.admit(d, 0)).toBe(true);
    expect(l.admit({ ...d }, 299_999)).toBe(false);
    expect(l.admit({ ...d, code: "E2" }, 1000)).toBe(true);
    expect(l.admit({ ...d, code: "E2" }, 2000)).toBe(false);
    expect(l.admit({ ...d, hostname: "other" }, 2000)).toBe(true);
    expect(l.admit({ ...d, code: "E2" }, 1000 + 300_000)).toBe(true);
  });
});

describe("foreground", () => {
  it("attributeForeground 1500 ms boundary", () => {
    const mark = { cause: "menu:settings", details: 1, stack: "s", ts: 1000 };
    expect(attributeForeground(mark, 2500)).toEqual({ cause: "menu:settings", details: 1, stack: "s" });
    expect(attributeForeground(mark, 2501)).toEqual({ cause: "external-or-user" });
    expect(attributeForeground(null, 0)).toEqual({ cause: "external-or-user" });
  });
  it("recentMarkers keeps 0..5000 ms", () => {
    const m = new Map([
      ["a", 1000],
      ["b", 6000],
      ["c", 7000],
    ]);
    expect(recentMarkers(m, 6000)).toEqual({ a: 5000, b: 0 });
    expect(recentMarkers(m, 20_000)).toBeUndefined();
  });
  it("state machine: resign/become, cause cleared, msSinceResign", () => {
    const f = new ForegroundState();
    const first = f.onBecomeActive(100);
    expect(first).toMatchObject({ cause: "external-or-user", msSinceResign: null });
    f.onResignActive(1000);
    f.markCause("notification-click", "c1", "stk", 1500);
    f.markRecent("notification-shown", 1400);
    const e = f.onBecomeActive(2000);
    expect(e).toMatchObject({ cause: "notification-click", details: "c1", msSinceResign: 1000, recent: { "notification-shown": 600 } });
    f.onResignActive(3000);
    expect(f.onBecomeActive(3100)?.cause).toBe("external-or-user");
  });
  it("resign clears a pending cause", () => {
    const f = new ForegroundState();
    f.markCause("popup", undefined, undefined, 0);
    f.onResignActive(10);
    expect(f.onBecomeActive(20)?.cause).toBe("external-or-user");
  });
  it("error while inactive suppresses the next activation; while active it does not", () => {
    const f = new ForegroundState();
    const err = f.onError("boom", "stack", 0);
    expect(err).toMatchObject({ cause: "error-dialog", details: "boom", stack: "stack" });
    expect(f.onBecomeActive(10)).toBeNull();
    expect(f.onBecomeActive(20)?.cause).toBe("external-or-user");
    f.onError("x", undefined, 30);
    expect(f.onBecomeActive(40)).not.toBeNull();
    f.onResignActive(50);
    f.onError("y", undefined, 60);
    f.onResignActive(70); // resign clears the suppress flag
    expect(f.onBecomeActive(80)).not.toBeNull();
  });
});

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBiTCCAS+gAwIBAgIUeVZkuKYrUYfAJD7vksnRhte8U6swCgYIKoZIzj0EAwIw
GjEYMBYGA1UEAwwPcmVhLWNsYXVkZS10ZXN0MB4XDTI2MTEwOTA3MjU0N1oXDTM2
MTEwNjA3MjU0N1owGjEYMBYGA1UEAwwPcmVhLWNsYXVkZS10ZXN0MFkwEwYHKoZI
zj0CAQYIKoZIzj0DAQcDQgAEtqdrNKJzfBjBMeU+QKgEh0s8dzByvYMT+ZX9mCJM
k7L1+BeW3WJvmKXD25ritcw+zgEd3jWyT0G5bcNgvORy66NTMFEwHQYDVR0OBBYE
FIBoyQjZZs7JLzHwp+yjTm3NxIyeMB8GA1UdIwQYMBaAFIBoyQjZZs7JLzHwp+yj
Tm3NxIyeMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgWQG2W1ZX
RU62P4oYQf9zbjxIFnPH46hzNQF5yLDGsZACIQCa7cqRSG3g8epSNNYXRF3zAy9b
1c3s7vHbV37j7Eltpw==
-----END CERTIFICATE-----
`;
// Computed independently with: openssl x509 -pubkey | openssl pkey -pubin -outform der | shasum -a 256
const TEST_SPKI = "90be3704dd090cf813149c3dfc651caea3de66170ea3efc073794a3bb63c7988";

describe("tls", () => {
  it("blocklist has the 8 known hashes", () => {
    expect(BLOCKED_SPKI_SHA256).toHaveLength(8);
    expect(new Set(BLOCKED_SPKI_SHA256).size).toBe(8);
    for (const h of BLOCKED_SPKI_SHA256) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
  it("spkiSha256 hashes the DER SPKI; garbage → null", () => {
    expect(spkiSha256(TEST_CERT)).toBe(TEST_SPKI);
    expect(spkiSha256("not a cert")).toBeNull();
  });
  it("certificateVerdict: blocked key anywhere in either chain → -206, else -3", () => {
    const leaf: CertLike = { data: "garbage", issuerCert: { data: TEST_CERT } };
    expect(certificateVerdict({ certificate: leaf }, new Set([TEST_SPKI]))).toBe(CERT_VERIFY_REJECT);
    expect(certificateVerdict({ certificate: { data: "x" }, validatedCertificate: leaf }, new Set([TEST_SPKI]))).toBe(
      CERT_VERIFY_REJECT,
    );
    expect(certificateVerdict({ certificate: leaf })).toBe(CERT_VERIFY_USE_CHROMIUM);
  });
  it("chain walk matches each of the 8 production hashes and is cycle-safe", () => {
    for (const h of BLOCKED_SPKI_SHA256) {
      const chain: CertLike = { data: "leaf", issuerCert: { data: "mid", issuerCert: { data: h } } };
      expect(chainHasBlockedKey(chain, undefined, (pem) => pem)).toBe(true);
    }
    const a: CertLike = { data: "a" };
    const b: CertLike = { data: "b", issuerCert: a };
    a.issuerCert = b;
    expect(chainHasBlockedKey(a, undefined, (pem) => pem)).toBe(false);
    expect(chainHasBlockedKey(null)).toBe(false);
  });
});
