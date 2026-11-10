/**
 * Gateway transport: origin guard, per-attempt timeout, alias fallback,
 * transport-failure classification and telemetry details. [auth §5 Transport]
 */
import { GATEWAY_FETCH_TIMEOUT_MS, GatewayPath, LOGIN_ORIGIN_PROBE_TIMEOUT_MS } from "@shared/config";
import { expandAliases, isCanonicalGateway } from "./gateways";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const ERR_UNKNOWN_ORIGIN = "Refusing to send gateway credentials to an unknown origin.";
export const ERR_INVALID_GATEWAY_URL = "Refusing an invalid gateway URL.";

export type FailureKind = "dns" | "reset" | "timeout" | "tls" | "connection" | "other";

const DNS = ["ENOTFOUND", "EAI_AGAIN", "ERR_NAME_NOT_RESOLVED", "ERR_NAME_RESOLUTION_FAILED"];
const RESET = ["ECONNRESET", "ERR_CONNECTION_RESET"];
const TIMEOUT = ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "ERR_TIMED_OUT", "ERR_CONNECTION_TIMED_OUT"];
const TLS = ["CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"];
const CONNECTION = [
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ERR_CONNECTION_REFUSED",
  "ERR_ADDRESS_UNREACHABLE",
  "ERR_INTERNET_DISCONNECTED",
];

function prop(obj: unknown, key: string): unknown {
  return obj !== null && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
}

/** Classify a fetch failure (aborted by our own timer => "timeout"). */
export function classifyFailure(err: unknown, aborted: boolean): FailureKind {
  if (aborted) return "timeout";
  const message = prop(err, "message");
  const netCode = typeof message === "string" ? /\bnet::(ERR_[A-Z_]+)\b/.exec(message)?.[1] : undefined;
  for (const code of [prop(prop(err, "cause"), "code"), prop(err, "code"), netCode]) {
    if (typeof code !== "string") continue;
    if (DNS.includes(code)) return "dns";
    if (RESET.includes(code)) return "reset";
    if (TIMEOUT.includes(code)) return "timeout";
    if (code.startsWith("ERR_CERT_") || code.startsWith("ERR_SSL_") || TLS.includes(code)) return "tls";
    if (CONNECTION.includes(code)) return "connection";
  }
  return "other";
}

/** `message` (or `fallback`) with ` (<code>)` appended when a safe code exists and is not already in it. */
export function formatNetworkError(err: unknown, fallback: string): { error: string; code?: string } {
  const m = prop(err, "message");
  const message = typeof m === "string" ? m : fallback;
  const raw = prop(prop(err, "cause"), "code") ?? prop(err, "code");
  const code = typeof raw === "string" && /^[A-Za-z0-9_.:-]+$/.test(raw) ? raw : null;
  if (code && !message.includes(code)) return { error: `${message} (${code})`, code };
  return code ? { error: message, code } : { error: message };
}

export interface AttemptFailure {
  hostname: string;
  failureKind: FailureKind;
}

export type TransportFailureSink = (details: Record<string, unknown>) => void;

/**
 * Build one `gateway-transport-failure` details object per failed attempt.
 * `aliasOutcome`: "responded" if the alias answered, "failed" if it was tried
 * and failed, else "not-attempted".
 */
export function transportFailureDetails(
  operation: string,
  primaryUrl: string,
  failures: readonly AttemptFailure[],
  respondedUrl?: string,
): Record<string, unknown>[] {
  if (failures.length === 0) return [];
  const alias = expandAliases(primaryUrl)[1];
  const aliasHostname = alias ? new URL(alias).hostname : null;
  const responseHostname = respondedUrl ? new URL(respondedUrl).hostname : null;
  const aliasOutcome =
    responseHostname === aliasHostname && aliasHostname !== null
      ? "responded"
      : failures.some((f) => f.hostname === aliasHostname)
        ? "failed"
        : "not-attempted";
  return failures.map((f) => ({ operation, ...f, aliasHostname, aliasOutcome, responseHostname }));
}

export interface GatewayFetchOptions {
  timeoutMs?: number;
  aliasFallback?: boolean;
  operation?: string;
  onFailure?: TransportFailureSink;
}

/**
 * Fetch a gateway URL. Refuses non-gateway origins. With alias fallback tries
 * the canonical URL then its alias, returning the first HTTP response of any
 * status; when every attempt fails, rethrows the first error.
 */
export async function gatewayFetch(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  opts: GatewayFetchOptions = {},
): Promise<Response> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new Error(ERR_INVALID_GATEWAY_URL);
  }
  if (!isCanonicalGateway(origin)) throw new Error(ERR_UNKNOWN_ORIGIN);
  const urls = opts.aliasFallback ? expandAliases(url) : [url];
  const timeoutMs = opts.timeoutMs ?? GATEWAY_FETCH_TIMEOUT_MS;
  const operation = opts.operation ?? "api";
  const failures: AttemptFailure[] = [];
  let firstError: unknown;
  let haveError = false;
  const report = (responded?: string): void => {
    for (const d of transportFailureDetails(operation, url, failures, responded)) opts.onFailure?.(d);
  };
  for (const attempt of urls) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(attempt, { ...init, signal: ctl.signal });
      report(attempt);
      return res;
    } catch (err) {
      failures.push({ hostname: new URL(attempt).hostname, failureKind: classifyFailure(err, ctl.signal.aborted) });
      if (!haveError) {
        haveError = true;
        firstError = err;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  report();
  throw firstError;
}

/**
 * Pick the login origin: alias first, then canonical (`GET /.well-known/jwks.json`,
 * 2.5 s each); the first that answers with any status wins; default canonical.
 */
export async function probeLoginOrigin(
  fetchImpl: FetchLike,
  gateway: string,
  onFailure?: TransportFailureSink,
  timeoutMs = LOGIN_ORIGIN_PROBE_TIMEOUT_MS,
): Promise<string> {
  const all = expandAliases(gateway);
  if (all.length === 1) return gateway;
  const order = [...all.slice(1), all[0] as string];
  const failures: AttemptFailure[] = [];
  const report = (responded?: string): void => {
    for (const d of transportFailureDetails("sign-in-probe", gateway, failures, responded)) onFailure?.(d);
  };
  for (const origin of order) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      await fetchImpl(`${origin}${GatewayPath.jwks}`, { signal: ctl.signal });
      report(origin);
      return origin;
    } catch (err) {
      failures.push({ hostname: new URL(origin).hostname, failureKind: classifyFailure(err, ctl.signal.aborted) });
    } finally {
      clearTimeout(timer);
    }
  }
  report();
  return gateway;
}

/** Parse a response body as JSON; null when it is not JSON. */
export async function readJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}
