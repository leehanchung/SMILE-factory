/**
 * identity.json record encode/decode and persistence-mode selection (pure).
 * [auth §3.2; platform §4.2]
 */
import type { GatewayUrl, PersistenceMode } from "@shared/ipc";
import { isCanonicalGateway } from "./gateways";

/** In-memory session. [auth §3.1] */
export interface Session {
  gatewayUrl: GatewayUrl;
  sub: string;
  login: string;
  /** Seconds epoch (proof claim). */
  exp: number;
  proof: string;
  refreshToken?: string;
  developer?: true;
}

export interface IdentityFileV1 {
  version: 1;
  gatewayUrl: GatewayUrl;
  sub: string;
  login: string;
  exp: number;
  developer?: true;
  encrypted: boolean;
  proof: string;
  refreshToken?: string;
  backend?: string;
}

export type Encryptor = (plain: string) => string;
export type Decryptor = (cipher: string) => string;

/**
 * Build the on-disk record. `encrypt === null` means encryption is not usable:
 * then a plaintext record is produced only when `plaintextFallback`, else null
 * (= keep the session in memory only). Encryption failures also yield null.
 */
export function serializeIdentity(
  session: Session,
  encrypt: Encryptor | null,
  opts: { plaintextFallback: boolean; backend?: string },
): IdentityFileV1 | null {
  const base = {
    version: 1 as const,
    gatewayUrl: session.gatewayUrl,
    sub: session.sub,
    login: session.login,
    exp: session.exp,
    ...(session.developer === true ? { developer: true as const } : {}),
  };
  if (!encrypt) {
    if (!opts.plaintextFallback) return null;
    return {
      ...base,
      encrypted: false,
      proof: session.proof,
      ...(session.refreshToken ? { refreshToken: session.refreshToken } : {}),
    };
  }
  let proof: string;
  let refreshToken: string | undefined;
  try {
    proof = encrypt(session.proof);
    refreshToken = session.refreshToken ? encrypt(session.refreshToken) : undefined;
  } catch {
    return null;
  }
  if (!proof || (session.refreshToken && !refreshToken)) return null;
  return {
    ...base,
    encrypted: true,
    proof,
    ...(refreshToken ? { refreshToken } : {}),
    ...(opts.backend ? { backend: opts.backend } : {}),
  };
}

export function backendMismatchWarning(stored: string, current: string): string {
  return (
    `identity.json was encrypted by safeStorage backend "${stored}" but this run selected "${current}" ` +
    `(the OS keyring changed), so the saved sign-in can't be decrypted. Treating it as signed out; ` +
    `the next sign-in re-encrypts with the current backend.`
  );
}

/**
 * Parse an identity.json text. Returns null (signed out) on bad JSON, a
 * non-object, an encrypted record that cannot be decrypted, an empty proof,
 * a non-finite exp, or a gatewayUrl that is not exactly one of the gateways.
 */
export function parseIdentity(
  text: string,
  decrypt: Decryptor | null,
  opts: { currentBackend?: string; warn?: (msg: string) => void } = {},
): Session | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const mismatch = (): void => {
    const stored = typeof o.backend === "string" ? o.backend : undefined;
    if (stored && opts.currentBackend && stored !== opts.currentBackend) {
      opts.warn?.(backendMismatchWarning(stored, opts.currentBackend));
    }
  };
  let proof: string;
  let refreshToken: string | undefined;
  if (o.encrypted) {
    if (!decrypt) {
      mismatch();
      return null;
    }
    try {
      proof = decrypt(String(o.proof));
      refreshToken = o.refreshToken ? decrypt(String(o.refreshToken)) : undefined;
    } catch {
      mismatch();
      return null;
    }
  } else {
    proof = String(o.proof ?? "");
    refreshToken = o.refreshToken ? String(o.refreshToken) : undefined;
  }
  const exp = Number(o.exp);
  const gatewayUrl = String(o.gatewayUrl ?? "");
  if (!proof || !Number.isFinite(exp) || !isCanonicalGateway(gatewayUrl)) return null;
  return {
    gatewayUrl,
    sub: String(o.sub ?? ""),
    login: String(o.login ?? ""),
    exp,
    proof,
    ...(refreshToken ? { refreshToken } : {}),
    ...(o.developer === true ? { developer: true as const } : {}),
  };
}

/** Encryption is only ever used when packaged and not in E2E test mode. */
export function encryptionAllowed(opts: { isPackaged: boolean; testMode: boolean }): boolean {
  return opts.isPackaged && !opts.testMode;
}

/** auth:persistence. [auth §2] */
export function persistenceMode(opts: {
  isPackaged: boolean;
  testMode: boolean;
  encryptionAvailable: boolean;
}): PersistenceMode {
  if (!opts.isPackaged) return "plaintext-dev";
  if (opts.testMode) return "none-test-mode";
  return opts.encryptionAvailable ? "keychain" : "none-no-keyring";
}

/** safeStorage backend label stored in identity.json and logged at startup. */
export function backendName(opts: { platform: NodeJS.Platform; linuxBackend?: string }): string {
  if (opts.platform === "darwin") return "keychain";
  if (opts.platform === "win32") return "dpapi";
  return opts.linuxBackend || "unknown";
}

/** `expiresAt` for AuthState: effectively never with a refresh token, else proof exp in ms. */
export function expiresAtOf(session: Session, neverExpiresAt: number): number {
  return session.refreshToken ? neverExpiresAt : session.exp * 1000;
}
