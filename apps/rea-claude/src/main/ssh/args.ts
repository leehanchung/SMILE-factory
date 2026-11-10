/** ssh option builder and destination [conn-ssh §5]. Pure. */
import { SSH_CONNECT_TIMEOUT_S } from "@shared/config";
import type { SshTarget } from "@shared/ipc";

/** `-o BatchMode=yes -o ConnectTimeout=10 [-i f -o IdentitiesOnly=yes] [-p port] [-J jump]` (truthiness checks). */
export function sshArgs(t: SshTarget): string[] {
  const args = ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`];
  if (t.identityFile) args.push("-i", t.identityFile, "-o", "IdentitiesOnly=yes");
  if (t.port) args.push("-p", String(t.port));
  if (t.jump) args.push("-J", t.jump);
  return args;
}

/** `user@host` or `host`. */
export function sshDest(t: SshTarget): string {
  return t.user ? `${t.user}@${t.host}` : t.host;
}

/**
 * Full argv for a remote command: `<sshArgs> -- <dest> <cmd>`. The `--` keeps
 * a destination from ever being parsed as an option (D5.6; callers also
 * validate with `sshTargetError`).
 */
export function remoteArgv(t: SshTarget, cmd: string): string[] {
  return [...sshArgs(t), "--", sshDest(t), cmd];
}
