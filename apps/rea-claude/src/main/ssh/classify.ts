/** ssh stderr classifiers [conn-ssh §8, lab §5.4]. Pure. */
import type { HostKeyKind } from "@shared/ipc";
import type { RemoteResult } from "../services";

export const MSG_PERMISSION_DENIED =
  "SSH was refused (publickey). If your key has a passphrase, add it to your ssh-agent (`ssh-add`) or use a passphrase-less key — the app cannot prompt for one. Otherwise check the key registered with us matches your SSH config.";
export const MSG_TIMED_OUT = "SSH timed out. Check the host and your network / VPN.";
export const MSG_UNRESOLVED = "Could not resolve the SSH host. Check the host name.";
export const MSG_REFUSED = "SSH connection refused. Check the host and port.";

/** "changed" is checked before "unknown". */
export function classifyHostKey(stderr: string): HostKeyKind | null {
  const s = stderr.toLowerCase();
  if (s.includes("remote host identification has changed")) return "changed";
  if (s.includes("host key verification failed")) return "unknown";
  return null;
}

export function classifySshError(r: Pick<RemoteResult, "code" | "stderr" | "toolMissing">): string {
  if (r.toolMissing) return r.stderr;
  if (/host key verification failed|no matching host key/i.test(r.stderr)) return "host-key";
  const s = r.stderr.toLowerCase();
  if (s.includes("permission denied")) return MSG_PERMISSION_DENIED;
  if (s.includes("timed out")) return MSG_TIMED_OUT;
  if (s.includes("could not resolve") || s.includes("name or service not known")) return MSG_UNRESOLVED;
  if (s.includes("connection refused")) return MSG_REFUSED;
  return r.stderr.trim().split("\n").slice(-2).join("\n") || `ssh exited ${r.code}`;
}
