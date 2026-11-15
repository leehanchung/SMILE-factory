/** Shared fixtures for auth tests (no Electron imports). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "@shared/config";
import type { ShellEventKind } from "@shared/ipc";
import type { MainContext, SettingsService, TelemetryService, WindowService } from "../../../src/main/services";
import { makeTestContext, testEnv } from "../helpers/context";
import type { AuthDeps } from "../../../src/main/auth/platform";
import type { SafeStorageLike } from "../../../src/main/auth/core";

export function b64url(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64url");
}

/** JWT-shaped token with the given claims. */
export function makeProof(claims: Record<string, unknown>, pad = 0): string {
  return `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(claims))}.${"s".repeat(10 + pad)}`;
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rea-auth-"));
}

export interface Recorded {
  events: { kind: ShellEventKind; details?: Record<string, unknown> }[];
  causes: { cause: string; details?: unknown }[];
  broadcasts: { channel: string; payload: unknown; trustedOnly: boolean }[];
}

export function makeCtx(opts: {
  dir: string;
  isPackaged?: boolean;
  isTestMode?: boolean;
  platform?: NodeJS.Platform;
  staging?: boolean;
  windows?: Partial<WindowService>;
  extra?: Parameters<typeof makeTestContext>[0];
}): { ctx: MainContext; rec: Recorded } {
  const rec: Recorded = { events: [], causes: [], broadcasts: [] };
  const telemetry: Partial<TelemetryService> = {
    recordShellEvent: (kind, o) => void rec.events.push({ kind, ...(o?.details ? { details: o.details } : {}) }),
    markCause: (cause, details) => void rec.causes.push({ cause, details }),
  };
  const settings: Partial<SettingsService> = {
    get: async () => ({ ...DEFAULT_SETTINGS, staging: opts.staging ?? false }),
  };
  const windows: Partial<WindowService> = {
    broadcast: (channel, payload) => void rec.broadcasts.push({ channel, payload, trustedOnly: false }),
    broadcastToTrustedShells: (channel, payload) => void rec.broadcasts.push({ channel, payload, trustedOnly: true }),
    ...opts.windows,
  };
  const ctx = makeTestContext({
    env: testEnv({
      userDataPath: () => opts.dir,
      isPackaged: opts.isPackaged ?? false,
      isTestMode: opts.isTestMode ?? false,
      platform: opts.platform ?? "darwin",
      iconPath: () => join(opts.dir, "no-icon.png"),
    }),
    telemetry,
    settings,
    windows,
    ...opts.extra,
  });
  return { ctx, rec };
}

/** Reversible fake keyring: "enc:" + base64. */
export function fakeSafeStorage(available = true, backend = "gnome_libsecret"): SafeStorageLike & { available: boolean } {
  const s = {
    available,
    isEncryptionAvailable: () => s.available,
    encryptString: (p: string) => Buffer.from(`enc:${p}`, "utf-8"),
    decryptString: (b: Buffer) => {
      const t = b.toString("utf-8");
      if (!t.startsWith("enc:")) throw new Error("cannot decrypt");
      return t.slice(4);
    },
    getSelectedStorageBackend: () => backend,
  };
  return s;
}

export type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Fake gateway transport: records calls, answers via `route`. */
export function fakeFetch(route: Route): { fetch: NonNullable<AuthDeps["fetch"]>; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return route(url, init);
    },
  };
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function netError(code: string): Error {
  const e = new Error("fetch failed") as Error & { cause?: unknown };
  e.cause = { code };
  return e;
}

export const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
