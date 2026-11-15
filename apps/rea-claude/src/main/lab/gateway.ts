/**
 * Gateway calls for Labs, through `ctx.auth.gatewayRequest` (lab code never
 * handles proofs). [lab §4.6, §4.7, §4.8; auth §4.9]
 */
import { GatewayPath } from "@shared/config";
import type { LabsListResult } from "@shared/ipc";
import type { AuthService, GatewayResponse, LabSessionResult } from "../services";
import { depIdFor, mapDiscoveredLab } from "./pure";

type Fail = { ok: false; error: string; status?: number; needsAuth?: true };

function nonHttp(res: Exclude<GatewayResponse, { kind: "http" }>): Fail {
  return res.kind === "auth"
    ? { ok: false, error: res.error, ...(res.needsAuth ? { needsAuth: true as const } : {}) }
    : { ok: false, error: res.error };
}

function okStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function field(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const v = (body as Record<string, unknown>)[key];
  return typeof v === "string" && v ? v : undefined;
}

/** `GET /labs` (`It`). */
export async function listLabs(auth: AuthService): Promise<LabsListResult> {
  let res: GatewayResponse;
  try {
    res = await auth.gatewayRequest({ path: GatewayPath.labs, method: "GET", operation: "labs" });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Discovery failed." };
  }
  if (res.kind !== "http") {
    const f = nonHttp(res);
    return f.needsAuth ? { ok: false, error: f.error, needsAuth: true } : { ok: false, error: f.error };
  }
  if (!okStatus(res.status)) return { ok: false, error: `Discovery failed (HTTP ${res.status}).` };
  const body = res.body && typeof res.body === "object" ? (res.body as Record<string, unknown>) : {};
  const labs = Array.isArray(body.labs) ? body.labs.map(mapDiscoveredLab) : [];
  return { ok: true, labs, gatewayUrl: res.gatewayUrl, login: auth.cachedIdentity()?.login ?? "" };
}

/** Shared tail of /labs/session and /labs/claim: `{token, lab_url}` + developer-flag update. */
function tokenResult(auth: AuthService, body: unknown): LabSessionResult {
  const token = field(body, "token");
  const labUrl = field(body, "lab_url");
  if (!token || !labUrl) return { ok: false, error: "Gateway returned an incomplete Lab session." };
  auth.noteLabToken(token);
  return { ok: true, token, labUrl };
}

/**
 * `POST /labs/session`. Managed and local use the raw id; cluster ids get `-dev` on staging.
 */
export async function createLabSession(
  auth: AuthService,
  staging: boolean,
  req: { deploymentId: string; managed: boolean; labUrl?: string },
): Promise<LabSessionResult> {
  const body: Record<string, string> = {
    deployment_id: req.managed || req.labUrl ? req.deploymentId : depIdFor(req.deploymentId, staging),
  };
  if (req.labUrl) body.lab_url = req.labUrl;
  const res = await auth.gatewayRequest({ path: GatewayPath.labSession, method: "POST", body, operation: "lab-session" });
  if (res.kind !== "http") return nonHttp(res);
  if (!okStatus(res.status)) {
    return { ok: false, error: `Could not get a Lab session (HTTP ${res.status}).`, status: res.status };
  }
  return tokenResult(auth, res.body);
}

/** `POST /labs/claim {deployment_id, claim_token_hash}`. */
export async function claimRoute(
  auth: AuthService,
  staging: boolean,
  deploymentId: string,
  claimTokenHash: string,
): Promise<LabSessionResult> {
  const res = await auth.gatewayRequest({
    path: GatewayPath.labClaim,
    method: "POST",
    body: { deployment_id: depIdFor(deploymentId, staging), claim_token_hash: claimTokenHash },
    operation: "lab-claim",
  });
  if (res.kind !== "http") return nonHttp(res);
  if (!okStatus(res.status)) {
    return { ok: false, error: `Could not bind your Lab route (HTTP ${res.status}).`, status: res.status };
  }
  return tokenResult(auth, res.body);
}

export type SetupBearerResult = { ok: true; setupBearer: string } | Fail;

/** `POST /labs/setup-bearer {deployment_id}`. */
export async function setupBearer(auth: AuthService, staging: boolean, deploymentId: string): Promise<SetupBearerResult> {
  const res = await auth.gatewayRequest({
    path: GatewayPath.setupBearer,
    method: "POST",
    body: { deployment_id: depIdFor(deploymentId, staging) },
    operation: "setup-bearer",
  });
  if (res.kind !== "http") return nonHttp(res);
  if (!okStatus(res.status)) {
    return { ok: false, error: `Could not authorize setup (HTTP ${res.status}).`, status: res.status };
  }
  const bearer = field(res.body, "setup_bearer");
  return bearer ? { ok: true, setupBearer: bearer } : { ok: false, error: "Gateway returned no setup bearer." };
}
