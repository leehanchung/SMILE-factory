/**
 * Certificate verify proc [bridge §5 "Not present", auth §6]: reject (-206)
 * when any certificate in the presented or validated chain has an SPKI
 * SHA-256 in BLOCKED_SPKI_SHA256; otherwise defer to Chromium (-3).
 */
import { createHash, X509Certificate } from "node:crypto";
import { BLOCKED_SPKI_SHA256, CERT_VERIFY_REJECT, CERT_VERIFY_USE_CHROMIUM } from "@shared/config";

/** Minimal shape of Electron's `Certificate` used here. */
export interface CertLike {
  /** PEM-encoded certificate. */
  data: string;
  issuerCert?: CertLike | null;
}

const BLOCKED = new Set(BLOCKED_SPKI_SHA256);

/** Hex SHA-256 of the DER SubjectPublicKeyInfo, or null when unparsable. */
export function spkiSha256(pem: string): string | null {
  try {
    const spki = new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" });
    return createHash("sha256").update(spki).digest("hex");
  } catch {
    return null;
  }
}

/** Walk leaf → issuers (cycle-safe); true if any key is blocked. */
export function chainHasBlockedKey(
  cert: CertLike | null | undefined,
  blocked: ReadonlySet<string> = BLOCKED,
  hash: (pem: string) => string | null = spkiSha256,
): boolean {
  const seen = new Set<CertLike>();
  for (let c = cert; c && !seen.has(c); c = c.issuerCert) {
    seen.add(c);
    const h = hash(c.data);
    if (h && blocked.has(h)) return true;
  }
  return false;
}

export interface VerifyRequestLike {
  certificate: CertLike;
  validatedCertificate?: CertLike | null;
}

/** Verdict for one request. */
export function certificateVerdict(req: VerifyRequestLike, blocked: ReadonlySet<string> = BLOCKED): number {
  return chainHasBlockedKey(req.certificate, blocked) || chainHasBlockedKey(req.validatedCertificate, blocked)
    ? CERT_VERIFY_REJECT
    : CERT_VERIFY_USE_CHROMIUM;
}
