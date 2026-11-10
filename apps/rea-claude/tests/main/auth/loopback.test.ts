import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { startLoopback } from "../../../src/main/auth/loopback";

function get(port: number, path: string, host = `127.0.0.1:${port}`): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host }, agent: false }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString("utf-8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function start(timeoutMs = 5_000) {
  let resolvePort: (p: number) => void = () => {};
  const port = new Promise<number>((r) => (resolvePort = r));
  const handle = startLoopback({ state: "st4te", timeoutMs, onListening: (p) => resolvePort(p) });
  handle.promise.catch(() => {});
  return { handle, port };
}

describe("loopback server", () => {
  it("rejects bad Host with 403 and other paths with 404, then accepts a valid callback", async () => {
    const { handle, port } = start();
    const p = await port;
    expect(p).toBeGreaterThan(0);
    expect((await get(p, "/callback?proof=x&s=st4te", `localhost:${p}`)).status).toBe(403);
    expect((await get(p, "/other")).status).toBe(404);
    const ok = await get(p, "/callback?proof=pr00f&s=st4te&activation_code=sda_a.b");
    expect(ok.status).toBe(200);
    expect(ok.body).toContain("You can close this tab and return to the app.");
    await expect(handle.promise).resolves.toEqual({ proof: "pr00f", activationCode: "sda_a.b" });
  });

  it("state mismatch → 400 page but keeps listening; the real callback still completes (X18)", async () => {
    const { handle, port } = start();
    const p = await port;
    let settled = false;
    void handle.promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    const res = await get(p, "/callback?proof=p&s=wrong");
    expect(res.status).toBe(400);
    expect(res.body).toContain("Return to the app and try again.");
    expect((await get(p, "/callback?proof=p")).status).toBe(400); // no state at all
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    expect((await get(p, "/callback?proof=good&s=st4te")).status).toBe(200);
    await expect(handle.promise).resolves.toEqual({ proof: "good" });
  });

  it("state mismatch does not stop the timeout", async () => {
    const { handle, port } = start(80);
    expect((await get(await port, "/callback?proof=p&s=wrong")).status).toBe(400);
    await expect(handle.promise).rejects.toThrow("Sign-in timed out. Please try again.");
  });

  it("missing proof → failure", async () => {
    const { handle, port } = start();
    await get(await port, "/callback?s=st4te");
    await expect(handle.promise).rejects.toThrow("Sign-in failed (state mismatch or missing proof).");
  });

  it("times out with the exact message", async () => {
    const { handle } = start(30);
    await expect(handle.promise).rejects.toThrow("Sign-in timed out. Please try again.");
  });

  it("cancel rejects with Sign-in restarted. and closes the server", async () => {
    const { handle, port } = start();
    const p = await port;
    handle.cancel();
    await expect(handle.promise).rejects.toThrow("Sign-in restarted.");
    await expect(get(p, "/callback")).rejects.toThrow();
  });

  it("is single-use: the server stops after the first callback", async () => {
    const { handle, port } = start();
    const p = await port;
    await get(p, "/callback?proof=x&s=st4te");
    await handle.promise;
    await expect(get(p, "/callback?proof=x&s=st4te")).rejects.toThrow();
  });
});
