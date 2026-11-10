/** `lab:test` [conn-ssh §4.7]: is the silico CLI reachable over SSH? */
import { REMOTE_PATH_PREFIX } from "@shared/config";
import type { SshTarget, TestResult } from "@shared/ipc";
import { sshTargetError } from "@shared/sshTarget";
import type { RemoteResult } from "../services";
import { classifyHostKey, classifySshError } from "./classify";

export const MSG_DEV_CLI_MISSING =
  "The dev CLI (silico-dev) isn't installed on this cluster. On its login node, update the Silico CLI, then run `silico-dev setup`.";
export const MSG_CLI_MISSING = "Connected, but the silico CLI was not found on the cluster.";

export function labTestCommand(staging: boolean): string {
  const probe = staging
    ? "command -v silico-dev >/dev/null 2>&1"
    : "command -v silico >/dev/null 2>&1 || command -v silico-setup >/dev/null 2>&1";
  return `${REMOTE_PATH_PREFIX} ${probe}`;
}

/** Map a probe result to the TestResult shown in ConfigureForm. Pure. */
export function interpretLabTest(target: SshTarget, staging: boolean, res: RemoteResult): TestResult {
  if (res.code === 0) return { ok: true, detail: `SSH OK: ${staging ? "silico-dev" : "silico"} present on the cluster.` };
  if (res.code === 255) {
    const kind = classifyHostKey(res.stderr);
    if (kind === "changed") {
      return {
        ok: false,
        hostKey: "changed",
        detail: `The host key for ${target.host} has CHANGED since it was last trusted. Possible security issue; investigate before connecting.`,
      };
    }
    if (kind === "unknown") {
      return { ok: false, hostKey: "unknown", detail: `First time connecting to ${target.host}. Trust its host key to continue.` };
    }
    return { ok: false, detail: classifySshError(res) };
  }
  return { ok: false, detail: staging ? MSG_DEV_CLI_MISSING : MSG_CLI_MISSING };
}

export async function runLabTest(
  target: SshTarget,
  isStaging: () => Promise<boolean>,
  runRemote: (t: SshTarget, cmd: string) => Promise<RemoteResult>,
): Promise<TestResult> {
  if (!target?.host) return { ok: false, detail: "No SSH host configured." };
  const invalid = sshTargetError(target);
  if (invalid) return { ok: false, detail: invalid };
  const staging = await isStaging();
  const res = await runRemote(target, labTestCommand(staging));
  return interpretLabTest(target, staging, res);
}
