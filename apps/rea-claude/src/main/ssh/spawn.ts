/**
 * OpenSSH binary resolution and process runners [conn-ssh §4.2, §4.3, §5].
 * Binaries are spawned directly (no shell, no options => inherit process.env).
 */
import type { ChildProcess } from "node:child_process";
import { win32 } from "node:path";
import type { SshTarget } from "@shared/ipc";
import { sshTargetError } from "@shared/sshTarget";
import type { RemoteResult, RunRemoteOptions } from "../services";
import { remoteArgv } from "./args";
import type { SpawnFn } from "./env";

export type SshTool = "ssh" | "ssh-keyscan" | "ssh-keygen";

export class ToolMissingError extends Error {
  override readonly name = "ToolMissingError";
}

export function toolMissingMessage(tool: string, platform: NodeJS.Platform): string {
  const base = `The OpenSSH client isn't installed on this machine (couldn't find \`${tool}\`). Silico uses it to connect to clusters.`;
  return platform === "win32"
    ? `${base} To install it, open Windows Settings → System → Optional features and add "OpenSSH Client", then try again.`
    : `${base} Install OpenSSH with your system's package manager, then try again.`;
}

export type FallbackDecision = { kind: "spawn"; cmd: string } | { kind: "missing"; message: string };

/** Next candidate after ENOENT failures: the bare tool, then (win32 + SystemRoot) the built-in OpenSSH path. */
export function resolveFallback(o: {
  tool: string;
  failed: readonly string[];
  platform: NodeJS.Platform;
  systemRoot?: string | undefined;
}): FallbackDecision {
  const candidates = [o.tool];
  if (o.platform === "win32" && o.systemRoot) candidates.push(win32.join(o.systemRoot, "System32", "OpenSSH", `${o.tool}.exe`));
  const next = candidates.find((c) => !o.failed.includes(c));
  return next !== undefined ? { kind: "spawn", cmd: next } : { kind: "missing", message: toolMissingMessage(o.tool, o.platform) };
}

export function toolMissingResult(err: ToolMissingError): RemoteResult {
  return { code: 255, stdout: "", stderr: err.message, toolMissing: true };
}

export interface ToolRunnerOptions {
  spawn: SpawnFn;
  platform: NodeJS.Platform;
  systemRoot: () => string | undefined;
  /** Awaited before every spawn (memoized login-shell env import). */
  ensureEnv: () => Promise<void>;
}

export interface ToolRunner {
  /** Resolve + spawn; rejects with ToolMissingError, or the raw error for non-ENOENT failures. */
  spawnResolved(tool: SshTool, args: readonly string[]): Promise<ChildProcess>;
  /** Local tool run (`zt`): collect output, optional stdin, no timeout. */
  runLocal(tool: SshTool, args: readonly string[], stdin?: string): Promise<RemoteResult>;
  /** Remote command (`q`) [conn-ssh §4.3]. */
  runRemote(target: SshTarget, cmd: string, opts?: RunRemoteOptions): Promise<RemoteResult>;
}

function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

export function createToolRunner(o: ToolRunnerOptions): ToolRunner {
  const cache = new Map<string, string>();

  function spawnResolved(tool: SshTool, args: readonly string[]): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
      const failed: string[] = [];
      const attempt = (cmd: string): void => {
        let child: ChildProcess;
        try {
          child = o.spawn(cmd, args);
        } catch (err) {
          onError(cmd, err);
          return;
        }
        const onSpawn = (): void => {
          child.off("error", onErr);
          cache.set(tool, cmd);
          resolve(child);
        };
        const onErr = (err: unknown): void => {
          child.off("spawn", onSpawn);
          onError(cmd, err);
        };
        child.once("spawn", onSpawn);
        child.once("error", onErr);
      };
      const onError = (cmd: string, err: unknown): void => {
        if (errCode(err) !== "ENOENT") {
          cache.delete(tool);
          reject(err);
          return;
        }
        failed.push(cmd);
        const next = resolveFallback({ tool, failed, platform: o.platform, systemRoot: o.systemRoot() });
        if (next.kind === "spawn") attempt(next.cmd);
        else reject(new ToolMissingError(next.message));
      };
      attempt(cache.get(tool) ?? tool);
    });
  }

  async function runLocal(tool: SshTool, args: readonly string[], stdin?: string): Promise<RemoteResult> {
    await o.ensureEnv();
    let child: ChildProcess;
    try {
      child = await spawnResolved(tool, args);
    } catch (err) {
      if (err instanceof ToolMissingError) return toolMissingResult(err);
      throw err;
    }
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (c: Buffer | string) => {
        stdout += c.toString();
      });
      child.stderr?.on("data", (c: Buffer | string) => {
        stderr += c.toString();
      });
      child.on("error", reject);
      child.on("close", (code: number | null) => resolve({ code, stdout, stderr }));
      if (stdin !== undefined) {
        child.stdin?.on("error", () => {});
        child.stdin?.write(stdin);
        child.stdin?.end();
      }
    });
  }

  async function runRemote(target: SshTarget, cmd: string, opts: RunRemoteOptions = {}): Promise<RemoteResult> {
    // D5.6: never hand an option-looking host/user/jump to ssh. Reported like an ssh failure (code 255).
    const invalid = sshTargetError(target);
    if (invalid) return { code: 255, stdout: "", stderr: invalid };
    await o.ensureEnv();
    if (opts.signal?.aborted) return { code: null, stdout: "", stderr: "" };
    let child: ChildProcess;
    try {
      child = await spawnResolved("ssh", remoteArgv(target, cmd));
    } catch (err) {
      if (err instanceof ToolMissingError) return toolMissingResult(err);
      throw err;
    }
    if (opts.signal?.aborted) {
      child.on("error", () => {});
      child.kill("SIGTERM");
      return { code: null, stdout: "", stderr: "" };
    }
    opts.onSpawn?.(child);
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (c: Buffer | string) => {
        const text = c.toString();
        stdout += text;
        opts.onChunk?.(text, "stdout");
      });
      child.stderr?.on("data", (c: Buffer | string) => {
        const text = c.toString();
        stderr += text;
        opts.onChunk?.(text, "stderr");
      });
      child.on("error", reject);
      child.on("close", (code: number | null) => resolve({ code, stdout, stderr }));
    });
  }

  return { spawnResolved, runLocal, runRemote };
}
