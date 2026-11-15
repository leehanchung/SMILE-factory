/**
 * Desktop activation helpers (pure): activation-code parsing, client-minted
 * refresh token and its SHA-256 hash, status mapping. [auth §4.1 step 6]
 */
import { createHash } from "node:crypto";

const ACTIVATION_CODE_RE = /^sda_([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/;

/** Returns the captured `<id>` of `sda_<id>.<x>`, or null. */
export function parseActivationCode(code: string): string | null {
  return ACTIVATION_CODE_RE.exec(code)?.[1] ?? null;
}

/** `sdr_<id>.<base64url(random32)>`. */
export function mintRefreshToken(id: string, random32: Buffer): string {
  return `sdr_${id}.${random32.toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 408/425/429/>=500: transient; continue the sign-in without a refresh token. */
export function isTransientActivationStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Logout succeeded iff 401/404, or 2xx with `{ok:true}`. [auth §4.4 step 5] */
export function isRevocationDone(status: number, body: unknown): boolean {
  if (status === 401 || status === 404) return true;
  if (status < 200 || status >= 300) return false;
  return !!body && typeof body === "object" && (body as Record<string, unknown>).ok === true;
}
