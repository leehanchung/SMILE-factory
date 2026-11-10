/**
 * IPC sender trust gates and typed registration helpers.
 *
 * FROZEN SHARED FILE (architect-owned). Every main-process IPC registration
 * MUST go through these helpers; raw `ipcMain.handle/on` is not allowed
 * anywhere else (see docs/architecture.md, decision D5).
 *
 *  - Shell-trusted (`Cs`, platform §3): the sender frame URL (falling back to
 *    `sender.getURL()`) is the app's own renderer `index.html` (same `file:`
 *    path; hash/query ignored) or, in dev builds only, has the origin of the
 *    dev-server URL. The original trusted any `file:` URL and read
 *    ELECTRON_RENDERER_URL per call even when packaged (deviation X17):
 *    `configureShellTrust` is called once at startup with the resolved values.
 *  - Lab-trusted (`oe`, bridge §6): `!sender.isDestroyed() &&
 *    sender.session === session.fromPartition("persist:silico")`.
 *
 * Untrusted invokes log `[ipc] blocked '<ch>' from untrusted sender` and
 * reject with `Error("Blocked '<ch>': untrusted sender.")`. Untrusted sends
 * are dropped silently (with the same warning log).
 */

import { ipcMain, session } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";
import { pathToFileURL } from "node:url";
import { LAB_PARTITION } from "@shared/config";
import type {
  InvokeArgs,
  InvokeRet,
  LabEventMap,
  LabInvokeMap,
  LabSendMap,
  ShellEventMap,
  ShellInvokeMap,
} from "@shared/ipc";

/** Minimal shape of an IPC event used by the trust checks (keeps them unit-testable). */
export interface SenderLike {
  readonly sender: WebContents;
  readonly senderFrame?: { readonly url: string } | null;
}

/** What the shell renderer is loaded from (resolved once at startup). */
export interface ShellTrustConfig {
  /** Dev-server URL; must already be `undefined` in packaged builds (S2). */
  readonly rendererUrl: string | undefined;
  /** Absolute path of the built renderer `index.html`. */
  readonly rendererHtmlPath: string;
}

function safeDecode(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/**
 * Build a matcher for "this URL is the app's own renderer": the exact
 * `file:` path of `rendererHtmlPath` (any hash/query), or the dev-server origin.
 */
export function makeShellUrlMatcher(cfg: ShellTrustConfig): (url: string) => boolean {
  let filePath: string | null = null;
  try {
    filePath = safeDecode(pathToFileURL(cfg.rendererHtmlPath).pathname);
  } catch {
    filePath = null;
  }
  let devOrigin: string | null = null;
  try {
    devOrigin = cfg.rendererUrl ? new URL(cfg.rendererUrl).origin : null;
  } catch {
    devOrigin = null;
  }
  return (url: string): boolean => {
    try {
      const u = new URL(url);
      if (u.protocol === "file:") return filePath !== null && (u.host === "" || u.host === "localhost") && safeDecode(u.pathname) === filePath;
      return devOrigin !== null && devOrigin !== "null" && u.origin === devOrigin;
    } catch {
      return false;
    }
  };
}

/**
 * Legacy "any file: URL" matcher. Only plain-Node unit tests (vitest) get it
 * as the default; inside Electron the default fails closed, so nothing is
 * shell-trusted until `configureShellTrust` installs the real renderer path.
 */
const legacyFileMatcher = (url: string): boolean => {
  try {
    return new URL(url).protocol === "file:";
  } catch {
    return false;
  }
};

const failClosed = (_url: string): boolean => false;

const runningInElectron = typeof process !== "undefined" && typeof process.versions?.electron === "string";

let shellMatcher: (url: string) => boolean = runningInElectron ? failClosed : legacyFileMatcher;

/**
 * Install the shell trust configuration. `src/main/index.ts` calls this once,
 * before any IPC is registered or any window is created.
 */
export function configureShellTrust(cfg: ShellTrustConfig): void {
  shellMatcher = makeShellUrlMatcher(cfg);
}

/** Test hook: drop the configuration (back to the pre-configure default). */
export function resetShellTrustForTests(): void {
  shellMatcher = legacyFileMatcher;
}

/**
 * Trusted shell URL. With `cfg`, checks against that configuration; without,
 * uses the configuration installed by `configureShellTrust`.
 */
export function isTrustedShellUrl(url: string, cfg?: ShellTrustConfig): boolean {
  return cfg ? makeShellUrlMatcher(cfg)(url) : shellMatcher(url);
}

function senderUrl(event: SenderLike): string {
  let frameUrl: string | undefined;
  try {
    // Accessing senderFrame can throw if the frame was disposed.
    frameUrl = event.senderFrame?.url;
  } catch {
    frameUrl = undefined;
  }
  if (frameUrl) return frameUrl;
  try {
    return event.sender.getURL();
  } catch {
    return "";
  }
}

/** Shell-trust check for an IPC event (`Cs`). */
export function isTrustedShellSender(event: SenderLike): boolean {
  return isTrustedShellUrl(senderUrl(event));
}

/** Shell-trust check for a bare webContents (e.g. before broadcasting `auth:changed`). */
export function isTrustedShellWebContents(wc: WebContents): boolean {
  try {
    return !wc.isDestroyed() && isTrustedShellUrl(wc.getURL());
  } catch {
    return false;
  }
}

/** Lab-trust check (`oe`): sender lives in the `persist:silico` partition. */
export function isLabSender(wc: WebContents): boolean {
  try {
    return !wc.isDestroyed() && wc.session === session.fromPartition(LAB_PARTITION);
  } catch {
    return false;
  }
}

/** The exact error thrown for untrusted invokes. */
export function blockedError(channel: string): Error {
  return new Error(`Blocked '${channel}': untrusted sender.`);
}

function warnBlocked(channel: string): void {
  console.warn(`[ipc] blocked '${channel}' from untrusted sender`);
}

type Handler<M, C extends keyof M, E> = (
  event: E,
  ...args: InvokeArgs<M, C>
) => InvokeRet<M, C> | Promise<InvokeRet<M, C>>;

/** Register a shell-trusted invoke handler (`y(channel, fn)`). */
export function handleShell<C extends keyof ShellInvokeMap & string>(
  channel: C,
  fn: Handler<ShellInvokeMap, C, IpcMainInvokeEvent>,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!isTrustedShellSender(event)) {
      warnBlocked(channel);
      throw blockedError(channel);
    }
    return fn(event, ...(args as InvokeArgs<ShellInvokeMap, C>));
  });
}

/** Register a lab-trusted invoke handler. */
export function handleLab<C extends keyof LabInvokeMap & string>(
  channel: C,
  fn: Handler<LabInvokeMap, C, IpcMainInvokeEvent>,
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (!isLabSender(event.sender)) {
      warnBlocked(channel);
      throw blockedError(channel);
    }
    return fn(event, ...(args as InvokeArgs<LabInvokeMap, C>));
  });
}

/**
 * Register a shell-trusted `ipcMain.on` listener. No shell send channels exist
 * today; provided for completeness. Untrusted messages are dropped.
 */
export function onShell(channel: string, fn: (event: IpcMainEvent, ...args: unknown[]) => void): void {
  ipcMain.on(channel, (event, ...args: unknown[]) => {
    if (!isTrustedShellSender(event)) {
      warnBlocked(channel);
      return;
    }
    fn(event, ...args);
  });
}

/**
 * Register a lab-trusted `ipcMain.on` listener. The payload is passed as
 * `unknown`: Lab pages are remote content, so the handler must validate it.
 * Untrusted messages are dropped silently (plus a warning log).
 */
export function onLab<C extends keyof LabSendMap & string>(
  channel: C,
  fn: (event: IpcMainEvent, payload: unknown) => void,
): void {
  ipcMain.on(channel, (event, payload: unknown) => {
    if (!isLabSender(event.sender)) {
      warnBlocked(channel);
      return;
    }
    fn(event, payload);
  });
}

type PayloadArgs<P> = [P] extends [undefined] ? [] : [payload: P];

/** Safe typed send to a shell renderer (`Le`): no-op when destroyed. */
export function sendShell<C extends keyof ShellEventMap & string>(
  wc: WebContents,
  channel: C,
  ...payload: PayloadArgs<ShellEventMap[C]>
): void {
  if (wc.isDestroyed()) return;
  wc.send(channel, ...payload);
}

/** Safe typed send to a Lab page: no-op when destroyed. */
export function sendLab<C extends keyof LabEventMap & string>(
  wc: WebContents,
  channel: C,
  ...payload: PayloadArgs<LabEventMap[C]>
): void {
  if (wc.isDestroyed()) return;
  wc.send(channel, ...payload);
}
