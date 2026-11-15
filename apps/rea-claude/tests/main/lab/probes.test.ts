import { describe, expect, it, vi } from "vitest";
import { labStatus, probeLabVersion, waitClusterReady, waitManagedWake } from "../../../src/main/lab/probes";
import { fakeClock, routeFetch } from "./fakes";

describe("labStatus", () => {
  it("2xx up, non-2xx down, throw down, falsy unknown", async () => {
    expect(await labStatus(routeFetch(() => 204), "http://x:1")).toBe("up");
    expect(await labStatus(routeFetch(() => 503), "http://x:1")).toBe("down");
    expect(await labStatus(routeFetch(() => new Error("x")), "http://x:1")).toBe("down");
    expect(await labStatus(routeFetch(() => 200), "")).toBe("unknown");
    expect(await labStatus(routeFetch(() => 200), "not a url")).toBe("down");
  });
  it("hits /healthz on the origin", async () => {
    const f = routeFetch(() => 200);
    await labStatus(f, "http://x:1/some/path");
    expect(f.mock.calls[0]?.[0]).toBe("http://x:1/healthz");
  });
});

describe("probeLabVersion", () => {
  it("sends the bearer token to /api/cluster/version", async () => {
    const f = routeFetch(() => 401);
    expect(await probeLabVersion(f, "https://lab", "TOK")).toBe("ready");
    expect(f.mock.calls[0]?.[0]).toBe("https://lab/api/cluster/version");
    expect(f.mock.calls[0]?.[1]).toMatchObject({ headers: { authorization: "Bearer TOK" } });
  });
  it("425/5xx warming, network error unreachable", async () => {
    expect(await probeLabVersion(routeFetch(() => 425), "https://lab", "T")).toBe("warming");
    expect(await probeLabVersion(routeFetch(() => 502), "https://lab", "T")).toBe("warming");
    expect(await probeLabVersion(routeFetch(() => new Error("x")), "https://lab", "T")).toBe("unreachable");
  });
  it("managed front door: dataplane 200 counts as warming", async () => {
    const f = routeFetch((u) => (u.pathname === "/healthz/dataplane" ? 200 : new Error("down")));
    const onError = vi.fn();
    expect(await probeLabVersion(f, "https://lab", "T", { managedFrontDoor: true, onError })).toBe("warming");
    expect(f.mock.calls[1]?.[1]).toMatchObject({ redirect: "manual", cache: "no-store" });
    expect(onError).toHaveBeenCalledTimes(1);
    const g = routeFetch((u) => (u.pathname === "/healthz/dataplane" ? 302 : new Error("down")));
    expect(await probeLabVersion(g, "https://lab", "T", { managedFrontDoor: true })).toBe("unreachable");
  });
});

describe("waitClusterReady", () => {
  it("returns ready immediately", async () => {
    const clock = fakeClock();
    expect(await waitClusterReady(routeFetch(() => 200), clock, "https://l", "T", { budgetMs: 5000 })).toBe("ready");
    expect(clock.sleep).not.toHaveBeenCalled();
  });
  it("unreachable at deadline when never warming; logs once; sleeps 1500", async () => {
    const clock = fakeClock();
    const onLog = vi.fn();
    const r = await waitClusterReady(routeFetch(() => new Error("x")), clock, "https://l", "T", { budgetMs: 4000, onLog });
    expect(r).toBe("unreachable");
    expect(onLog).toHaveBeenCalledTimes(1);
    expect(onLog).toHaveBeenCalledWith("Lab started. Waiting for it to be ready…\n");
    expect(clock.sleep).toHaveBeenCalledWith(1500);
    expect(clock.sleep).toHaveBeenCalledTimes(3);
  });
  it("ready at deadline if any probe was warming", async () => {
    const clock = fakeClock();
    let n = 0;
    const f = routeFetch(() => (n++ === 0 ? 503 : new Error("x")));
    expect(await waitClusterReady(f, clock, "https://l", "T", { budgetMs: 3000 })).toBe("ready");
  });
  it("abort → canceled", async () => {
    const clock = fakeClock();
    const ac = new AbortController();
    const f = routeFetch(() => {
      ac.abort();
      return 503;
    });
    expect(await waitClusterReady(f, clock, "https://l", "T", { budgetMs: 3000, signal: ac.signal })).toBe("canceled");
  });
});

describe("waitManagedWake", () => {
  it("unreachable at min(unreachable, timeout) when never warming; logs each error code once", async () => {
    const clock = fakeClock();
    const onLog = vi.fn();
    const warn = vi.fn();
    const err = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    const r = await waitManagedWake(routeFetch(() => err), clock, "https://l", "T", { unreachableTimeoutMs: 3000, onLog, warn });
    expect(r).toBe("unreachable");
    expect(onLog).toHaveBeenCalledWith("Couldn't reach the Lab (ECONNREFUSED) — retrying…\n");
    expect(onLog).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(clock.t - 1_000_000).toBe(3000);
  });
  it("first warming → waking phase + log; still-waking after timeout", async () => {
    const clock = fakeClock();
    const onLog = vi.fn();
    const onPhase = vi.fn();
    const r = await waitManagedWake(routeFetch(() => 425), clock, "https://l", "T", {
      unreachableTimeoutMs: 1000,
      timeoutMs: 6000,
      onLog,
      onPhase,
    });
    expect(r).toBe("still-waking");
    expect(onPhase).toHaveBeenCalledTimes(1);
    expect(onPhase).toHaveBeenCalledWith("waking");
    expect(onLog).toHaveBeenCalledWith("Starting your Lab — this usually takes under a minute…\n");
    expect(clock.t - 1_000_000).toBe(6000);
  });
  it("ready once probe passes; canceled when aborted", async () => {
    const clock = fakeClock();
    let n = 0;
    expect(await waitManagedWake(routeFetch(() => (n++ < 2 ? 503 : 200)), clock, "https://l", "T", {})).toBe("ready");
    const ac = new AbortController();
    ac.abort();
    expect(await waitManagedWake(routeFetch(() => 200), clock, "https://l", "T", { signal: ac.signal })).toBe("canceled");
  });
});
