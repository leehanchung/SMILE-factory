/**
 * Electron-backed defaults for the auth area's injectable dependencies.
 * Everything here is resolved lazily (inside methods) so `create*Service`
 * stays side-effect free and tests can override any piece.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { BrowserWindow, WebContentsView, app, net, safeStorage, shell } from "electron";
import type { WebContents, WebPreferences } from "electron";
import { SIGN_IN_TIMEOUT_MS } from "@shared/config";
import type { SafeStorageLike } from "./core";
import type { FetchLike } from "./transport";

/** Minimal view surface the signup service needs (a WebContentsView). */
export interface SignupViewLike {
  readonly webContents: WebContents;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  setVisible(visible: boolean): void;
}

export interface AuthDeps {
  /** Injectable clock for tests. */
  now?: () => number;
  /** Gateway transport (default: Electron `net.fetch`). */
  fetch?: FetchLike;
  randomBytes?: (n: number) => Buffer;
  randomUUID?: () => string;
  safeStorage?: SafeStorageLike;
  openExternal?: (url: string) => unknown;
  /** Loopback sign-in timeout (default SIGN_IN_TIMEOUT_MS). */
  signInTimeoutMs?: number;
  /** `app.focus({steal:true})`. */
  focusApp?: () => void;
  /** macOS dock bounce. */
  dockBounce?: (type: "informational" | "critical") => void;
  /** Create the sandboxed signup view. */
  createSignupView?: (webPreferences: WebPreferences) => SignupViewLike;
  /** `BrowserWindow.fromWebContents`. */
  windowFromWebContents?: (wc: WebContents) => BrowserWindow | null;
}

export type ResolvedAuthDeps = Required<AuthDeps>;

export function resolveDeps(deps: AuthDeps = {}): ResolvedAuthDeps {
  return {
    now: deps.now ?? (() => Date.now()),
    fetch: deps.fetch ?? ((url, init) => net.fetch(url, init as Parameters<typeof net.fetch>[1])),
    randomBytes: deps.randomBytes ?? ((n) => randomBytes(n)),
    randomUUID: deps.randomUUID ?? (() => randomUUID()),
    safeStorage: deps.safeStorage ?? {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (s) => safeStorage.encryptString(s),
      decryptString: (b) => safeStorage.decryptString(b),
      getSelectedStorageBackend: () => safeStorage.getSelectedStorageBackend(),
    },
    openExternal: deps.openExternal ?? ((url) => shell.openExternal(url)),
    signInTimeoutMs: deps.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS,
    focusApp: deps.focusApp ?? (() => app.focus({ steal: true })),
    dockBounce: deps.dockBounce ?? ((type) => void app.dock?.bounce(type)),
    createSignupView: deps.createSignupView ?? ((webPreferences) => new WebContentsView({ webPreferences })),
    windowFromWebContents: deps.windowFromWebContents ?? ((wc) => BrowserWindow.fromWebContents(wc)),
  };
}
