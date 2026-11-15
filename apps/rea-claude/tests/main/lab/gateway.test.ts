import { describe, expect, it } from "vitest";
import { GATEWAY_STAGING } from "@shared/config";
import { claimRoute, createLabSession, listLabs, setupBearer } from "../../../src/main/lab/gateway";
import type { AuthService } from "../../../src/main/services";
import { fakeAuth, http } from "./fakes";

const asAuth = (a: ReturnType<typeof fakeAuth>) => a as unknown as AuthService;

describe("listLabs", () => {
  it("maps labs and stamps gateway + login", async () => {
    const auth = fakeAuth({ script: () => http(200, { labs: [{ kind: "cluster", deployment_id: "a-dev", stale: false }] }, GATEWAY_STAGING) });
    const r = await listLabs(asAuth(auth));
    expect(r).toMatchObject({ ok: true, gatewayUrl: GATEWAY_STAGING, login: "octo" });
    expect(r.ok && r.labs[0]?.deploymentId).toBe("a");
    expect(auth.gatewayRequest).toHaveBeenCalledWith(expect.objectContaining({ path: "/labs", method: "GET" }));
  });
  it("errors", async () => {
    expect(await listLabs(asAuth(fakeAuth({ script: () => http(502) })))).toEqual({ ok: false, error: "Discovery failed (HTTP 502)." });
    expect(await listLabs(asAuth(fakeAuth({ script: () => ({ kind: "auth", error: "Your session has expired. Sign in again.", needsAuth: true }) })))).toEqual({
      ok: false,
      error: "Your session has expired. Sign in again.",
      needsAuth: true,
    });
    expect(await listLabs(asAuth(fakeAuth({ script: () => ({ kind: "network", error: "fetch failed (ENOTFOUND)" }) })))).toEqual({
      ok: false,
      error: "fetch failed (ENOTFOUND)",
    });
    const r = await listLabs(asAuth(fakeAuth({ script: () => http(200, { labs: "nope" }) })));
    expect(r.ok && r.labs).toEqual([]);
  });
});

describe("createLabSession", () => {
  it("cluster on staging gets -dev; managed and local keep the raw id", async () => {
    const auth = fakeAuth({ script: () => http(200, { token: "T", lab_url: "https://l" }) });
    expect(await createLabSession(asAuth(auth), true, { deploymentId: "acme", managed: false })).toEqual({ ok: true, token: "T", labUrl: "https://l" });
    expect(auth.gatewayRequest.mock.calls[0]?.[0]).toMatchObject({ path: "/labs/session", method: "POST", body: { deployment_id: "acme-dev" } });
    await createLabSession(asAuth(auth), true, { deploymentId: "acme", managed: true });
    expect(auth.gatewayRequest.mock.calls[1]?.[0].body).toEqual({ deployment_id: "acme" });
    await createLabSession(asAuth(auth), true, { deploymentId: "goodfire-local", managed: false, labUrl: "http://localhost:5174" });
    expect(auth.gatewayRequest.mock.calls[2]?.[0].body).toEqual({ deployment_id: "goodfire-local", lab_url: "http://localhost:5174" });
    expect(auth.noteLabToken).toHaveBeenCalledWith("T");
  });
  it("http errors carry status; incomplete body; auth kind", async () => {
    expect(await createLabSession(asAuth(fakeAuth({ script: () => http(409) })), false, { deploymentId: "a", managed: false })).toEqual({
      ok: false,
      error: "Could not get a Lab session (HTTP 409).",
      status: 409,
    });
    const auth = fakeAuth({ script: () => http(200, { token: "T" }) });
    expect(await createLabSession(asAuth(auth), false, { deploymentId: "a", managed: false })).toEqual({
      ok: false,
      error: "Gateway returned an incomplete Lab session.",
    });
    expect(auth.noteLabToken).not.toHaveBeenCalled();
    expect(
      await createLabSession(asAuth(fakeAuth({ script: () => ({ kind: "auth", error: "E", needsAuth: true }) })), false, { deploymentId: "a", managed: false }),
    ).toEqual({ ok: false, error: "E", needsAuth: true });
  });
});

describe("claimRoute / setupBearer", () => {
  it("claim posts the hash with -dev on staging", async () => {
    const auth = fakeAuth({ script: () => http(200, { token: "T", lab_url: "https://l" }) });
    expect(await claimRoute(asAuth(auth), true, "acme", "HASH")).toEqual({ ok: true, token: "T", labUrl: "https://l" });
    expect(auth.gatewayRequest.mock.calls[0]?.[0]).toMatchObject({ path: "/labs/claim", body: { deployment_id: "acme-dev", claim_token_hash: "HASH" } });
    expect(await claimRoute(asAuth(fakeAuth({ script: () => http(409) })), false, "a", "h")).toEqual({
      ok: false,
      error: "Could not bind your Lab route (HTTP 409).",
      status: 409,
    });
  });
  it("setup bearer", async () => {
    const auth = fakeAuth({ script: () => http(200, { setup_bearer: "B" }) });
    expect(await setupBearer(asAuth(auth), false, "acme")).toEqual({ ok: true, setupBearer: "B" });
    expect(auth.gatewayRequest.mock.calls[0]?.[0]).toMatchObject({ path: "/labs/setup-bearer", body: { deployment_id: "acme" } });
    expect(await setupBearer(asAuth(fakeAuth({ script: () => http(200, {}) })), false, "a")).toEqual({ ok: false, error: "Gateway returned no setup bearer." });
    expect(await setupBearer(asAuth(fakeAuth({ script: () => http(403) })), false, "a")).toEqual({
      ok: false,
      error: "Could not authorize setup (HTTP 403).",
      status: 403,
    });
  });
});
