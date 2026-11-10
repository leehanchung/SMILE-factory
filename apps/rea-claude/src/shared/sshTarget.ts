/**
 * SSH target validation (security deviation, architecture §7 D5.6).
 *
 * A Connection's ssh host / user / jump comes from IPC or from the
 * unvalidated connections.json. Anything that begins with "-" would be parsed
 * by ssh / ssh-keyscan as an option (e.g. `-oProxyCommand=…` runs a local
 * command), and whitespace / control characters have no legitimate use in
 * these fields. Main rejects such targets before spawning anything; argv
 * builders additionally put `--` before the destination. Pure.
 */
import type { SshTarget } from "./ipc";

export const SSH_INVALID_HOST = "Invalid host name.";
export const SSH_INVALID_USER = "Invalid user name.";
export const SSH_INVALID_JUMP = "Invalid jump host.";

// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\s\x00-\x1f\x7f]/;

/** True when `v` is safe to hand to ssh as a host / user token (non-option, no whitespace/control chars). */
export function isSafeSshToken(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && !v.startsWith("-") && !BAD_CHARS.test(v);
}

/**
 * User-facing error for an unsafe target, or null when it is safe to pass to
 * ssh. An empty/missing host is left to the callers' existing "No SSH host"
 * handling. `jump` is a ProxyJump list (`[user@]host[:port][,…]`): no hop
 * (nor its host part after `@`) may begin with "-".
 */
export function sshTargetError(t: Pick<SshTarget, "host" | "user" | "jump"> | null | undefined): string | null {
  if (!t) return null;
  if (t.host !== undefined && t.host !== "" && !isSafeSshToken(t.host)) return SSH_INVALID_HOST;
  if (t.user !== undefined && t.user !== "" && !isSafeSshToken(t.user)) return SSH_INVALID_USER;
  if (t.jump !== undefined && t.jump !== "") {
    if (typeof t.jump !== "string" || BAD_CHARS.test(t.jump) || /(^|[,@])-/.test(t.jump)) return SSH_INVALID_JUMP;
  }
  return null;
}
