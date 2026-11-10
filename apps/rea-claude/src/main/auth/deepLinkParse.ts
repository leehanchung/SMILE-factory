/**
 * `silico://` deep-link parsers (pure). [auth §4.5 step 5, §4.6, §4.8; bridge §4.5-4.7]
 */
import { DEEP_LINK_ARG_RE } from "@shared/config";
import type { CheckoutOutcome, GithubConnectReturn, McpOauthReturn } from "@shared/ipc";

const SIGNUP_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const RESUME_TOKEN_RE = /^[A-Za-z0-9_-]{80,4096}={0,2}$/;
const DEPLOYMENT_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const PROOF_SHAPE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const NONCE_RE = /^[A-Za-z0-9-]{1,64}$/;
const MCP_CODE_RE = /^[\x20-\x7E]{1,2048}$/;
const MCP_STATE_RE = /^[\x20-\x7E]{1,4096}$/;
const ERROR_CODE_RE = /^[a-z_]{1,64}$/;
export const SIGNUP_READY_RETURN_TO = "/onboarding/compute";

export function isValidResumeToken(token: string): boolean {
  return RESUME_TOKEN_RE.test(token);
}

/** First argv entry matching /^silico:/i. */
export function findDeepLinkInArgv(argv: readonly string[]): string | null {
  return argv.find((a) => DEEP_LINK_ARG_RE.test(a)) ?? null;
}

/** Parse a `silico:` URL and return it with its lower-cased target (host, else path sans leading slashes). */
function parseSilico(url: string): { u: URL; target: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "silico:") return null;
  return { u, target: (u.hostname || u.pathname.replace(/^\/+/, "")).toLowerCase() };
}

/** Lower-cased dispatch target of any URL, or null if it is not a `silico:` URL. */
export function deepLinkTarget(url: string): string | null {
  return parseSilico(url)?.target ?? null;
}

/** Breadcrumb label for the `deep-link:delivered` cause (host, else first path segment, else "silico"). */
export function deepLinkLabel(url: string): string {
  try {
    const u = new URL(url);
    return u.host || u.pathname.replace(/^\/+/, "").split("/")[0] || "silico";
  } catch {
    return "silico";
  }
}

/** `silico://signup?token=<43 url-safe chars>` → token. */
export function parseSignupLink(url: string): string | null {
  const p = parseSilico(url);
  if (!p || p.target !== "signup") return null;
  const token = p.u.searchParams.get("token") ?? "";
  return SIGNUP_TOKEN_RE.test(token) ? token : null;
}

/** `silico://signup-resume?token=<80..4096 url-safe chars, ={0,2}>` → token. */
export function parseSignupResumeLink(url: string): string | null {
  const p = parseSilico(url);
  if (!p || p.target !== "signup-resume") return null;
  const token = p.u.searchParams.get("token") ?? "";
  return isValidResumeToken(token) ? token : null;
}

export interface SignupReady {
  deploymentId: string;
  proof: string;
  returnTo?: string;
}

/** `silico://signup-ready?deployment_id=&proof=[&return_to=/onboarding/compute]`. */
export function parseSignupReady(url: string): SignupReady | null {
  const p = parseSilico(url);
  if (!p || p.target !== "signup-ready") return null;
  const deploymentId = p.u.searchParams.get("deployment_id") ?? "";
  const proof = p.u.searchParams.get("proof") ?? "";
  if (!DEPLOYMENT_ID_RE.test(deploymentId) || proof.length < 100 || proof.length > 4096 || !PROOF_SHAPE_RE.test(proof)) {
    return null;
  }
  const returnTo = p.u.searchParams.get("return_to") === SIGNUP_READY_RETURN_TO ? SIGNUP_READY_RETURN_TO : undefined;
  return { deploymentId, proof, ...(returnTo ? { returnTo } : {}) };
}

export function isWelcomeLink(url: string): boolean {
  return parseSilico(url)?.target === "welcome";
}

function isSilicoRunHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "silico.run" || h.endsWith(".silico.run");
}

/** `silico://open?url=<https *.silico.run | http localhost/127.0.0.1>` → normalized href. */
export function parseOpenLink(url: string): string | null {
  const p = parseSilico(url);
  if (!p || p.target !== "open") return null;
  const raw = p.u.searchParams.get("url");
  if (!raw) return null;
  let t: URL;
  try {
    t = new URL(raw);
  } catch {
    return null;
  }
  const https = t.protocol === "https:" && isSilicoRunHost(t.hostname);
  const local = t.protocol === "http:" && (t.hostname === "localhost" || t.hostname === "127.0.0.1");
  return https || local ? t.href : null;
}

export function parseCheckoutReturn(url: string): { outcome: CheckoutOutcome; nonce: string } | null {
  const p = parseSilico(url);
  if (!p || p.target !== "checkout-return") return null;
  const outcome = p.u.searchParams.get("outcome");
  const nonce = p.u.searchParams.get("s") ?? "";
  if ((outcome !== "success" && outcome !== "cancel" && outcome !== "manage") || !nonce) return null;
  return { outcome, nonce };
}

export function parseMcpOauthReturn(url: string): { payload: McpOauthReturn; nonce: string } | null {
  const p = parseSilico(url);
  if (!p || p.target !== "mcp-oauth-return") return null;
  const nonce = p.u.searchParams.get("s") ?? "";
  if (!NONCE_RE.test(nonce)) return null;
  const outcome = p.u.searchParams.get("outcome");
  if (outcome === "code") {
    const code = p.u.searchParams.get("code") ?? "";
    const state = p.u.searchParams.get("state") ?? "";
    if (!MCP_CODE_RE.test(code) || !MCP_STATE_RE.test(state)) return null;
    return { payload: { outcome: "code", code, state }, nonce };
  }
  if (outcome === "error") {
    const error = p.u.searchParams.get("error") ?? "";
    return ERROR_CODE_RE.test(error) ? { payload: { outcome: "error", error }, nonce } : null;
  }
  return null;
}

export function parseGithubConnectReturn(url: string): { payload: GithubConnectReturn; nonce: string } | null {
  const p = parseSilico(url);
  if (!p || p.target !== "github-connect-return") return null;
  const nonce = p.u.searchParams.get("s") ?? "";
  if (!NONCE_RE.test(nonce)) return null;
  const outcome = p.u.searchParams.get("outcome");
  if (outcome === "success") return { payload: { outcome: "success" }, nonce };
  if (outcome === "error") {
    const error = p.u.searchParams.get("error") ?? "";
    return ERROR_CODE_RE.test(error) ? { payload: { outcome: "error", error }, nonce } : null;
  }
  return null;
}
