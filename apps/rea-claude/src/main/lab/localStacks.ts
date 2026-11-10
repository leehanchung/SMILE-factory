/**
 * `local:detectStacks`: `docker ps` scan for local dev stacks. [lab §4.9]
 */
import { DOCKER_PS_NAME_FILTER, DOCKER_PS_TIMEOUT_MS } from "@shared/config";
import type { LocalStack } from "@shared/ipc";
import { parseDockerPs } from "./pure";

export type ExecFileLike = (file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string }>;

export const DOCKER_PS_ARGS: readonly string[] = [
  "ps",
  "--filter",
  DOCKER_PS_NAME_FILTER,
  "--format",
  '{{.Names}}\t{{.Ports}}\t{{.Label "com.silico.local.worktree"}}\t{{.Label "com.silico.local.branch"}}',
];

/** Any failure (docker missing, timeout, non-zero exit) → []. */
export async function detectLocalStacks(execFile: ExecFileLike): Promise<LocalStack[]> {
  try {
    const { stdout } = await execFile("docker", [...DOCKER_PS_ARGS], { timeout: DOCKER_PS_TIMEOUT_MS });
    return parseDockerPs(String(stdout));
  } catch {
    return [];
  }
}
