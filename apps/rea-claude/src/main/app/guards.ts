/**
 * Pure launch/platform decisions (platform §6.1, §6.2). Electron-free.
 */
import {
  ENV_E2E_USER_DATA,
  ENV_REGISTER_PROTOCOL,
  FORBIDDEN_SWITCHES,
  PRODUCT_NAME,
  USER_DATA_DIR_NAME,
} from "@shared/config";

type Env = Readonly<Record<string, string | undefined>>;

/** `_o`: test mode = the E2E userData override is set (non-empty). */
export function isTestMode(env: Env): boolean {
  return !!env[ENV_E2E_USER_DATA];
}

/**
 * `Xa`: first forbidden Chromium switch present (packaged builds only).
 * `remote-debugging-port` is allowed in test mode.
 */
export function forbiddenSwitch(i: { isPackaged: boolean; testMode: boolean; hasSwitch: (s: string) => boolean }): string | null {
  if (!i.isPackaged) return null;
  for (const s of FORBIDDEN_SWITCHES) {
    if (i.hasSwitch(s) && !(i.testMode && s === "remote-debugging-port")) return s;
  }
  return null;
}

export function forbiddenSwitchMessage(sw: string): string {
  return `[launch] refusing to start with --${sw}: it would expose your ${PRODUCT_NAME} sign-in`;
}

/** userData path (D1): E2E override, else `<appData>/rea-claude`. */
export function userDataPathFor(appData: string, env: Env, join: (...p: string[]) => string): string {
  const e2e = env[ENV_E2E_USER_DATA];
  return e2e ? e2e : join(appData, USER_DATA_DIR_NAME);
}

/** D3: register `silico://` with the OS only in packaged builds with REA_CLAUDE_REGISTER_PROTOCOL=1. */
export function shouldRegisterProtocol(isPackaged: boolean, env: Env): boolean {
  return isPackaged && env[ENV_REGISTER_PROTOCOL] === "1";
}

/** `Xd`: asynchronous network-stack errors are logged and ignored. */
export function isIgnorableMainError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return msg.startsWith("net::ERR_");
}

/** `df`: offer to move to /Applications. */
export function shouldOfferMove(i: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  testMode: boolean;
  isInApplicationsFolder: boolean;
}): boolean {
  return i.platform === "darwin" && i.isPackaged && !i.testMode && !i.isInApplicationsFolder;
}

/** GPU process gone abnormally → invalidate shown views. */
export function isAbnormalGpuExit(details: { type: string; reason: string }): boolean {
  return details.type === "GPU" && details.reason !== "clean-exit";
}
