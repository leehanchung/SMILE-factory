/**
 * Proof (JWT-shaped) payload decoding (pure). The client never verifies the
 * signature; it only reads claims. [auth §4.1 step 7, §4.2 step 3, §4.3]
 */
import { PROOF_ISSUER, PROOF_PURPOSE } from "@shared/config";

export interface ProofClaims {
  sub: string;
  login: string;
  /** Seconds epoch; 0 when absent. */
  exp: number;
  purpose: string;
  issuer: string;
  developer: boolean;
}

function decodeSegment(token: string): unknown {
  const seg = token.split(".")[1];
  if (!seg) throw new Error("Malformed proof");
  const json = Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
  return JSON.parse(json) as unknown;
}

function field(obj: unknown, key: string): unknown {
  return obj !== null && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
}

/**
 * Decode the middle segment's claims. Throws `Error("Malformed proof")` when
 * there is no middle segment, and a JSON SyntaxError when it is not JSON.
 */
export function decodeProofClaims(token: string): ProofClaims {
  const payload = decodeSegment(token);
  return {
    sub: String(field(payload, "sub") ?? ""),
    login: String(field(payload, "login") ?? ""),
    exp: Number(field(payload, "exp") ?? 0),
    purpose: String(field(payload, "purpose") ?? ""),
    issuer: String(field(payload, "iss") ?? ""),
    developer: field(payload, "developer") === true,
  };
}

/** `developer === true` claim of a lab token; false on any decode error. */
export function hasDeveloperClaim(token: string): boolean {
  try {
    return field(decodeSegment(token), "developer") === true;
  } catch {
    return false;
  }
}

/** A refreshed proof is acceptable iff same sub, nonzero exp, purpose "labs", issuer "silico-lab-auth". [auth §4.2] */
export function isRefreshedProofValid(claims: ProofClaims, expectSub: string): boolean {
  return claims.sub === expectSub && !!claims.exp && claims.purpose === PROOF_PURPOSE && claims.issuer === PROOF_ISSUER;
}

/** Signup identity proof check: sub, login, exp in the future, purpose and issuer. [auth §4.5 step 5] */
export function isSignupProofValid(claims: ProofClaims, nowMs: number): boolean {
  return (
    !!claims.sub &&
    !!claims.login &&
    !!claims.exp &&
    claims.exp * 1000 > nowMs &&
    claims.purpose === PROOF_PURPOSE &&
    claims.issuer === PROOF_ISSUER
  );
}
