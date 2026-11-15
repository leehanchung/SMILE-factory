/**
 * Login-shell environment import [conn-ssh §4.1]: run
 * `<shell> -ilc 'printf %s M; env; printf %s M'` (csh/tcsh: `-c`), SIGKILL
 * after 5 s, then import SSH_AUTH_SOCK and prepend PATH (deduplicated).
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { SHELL_ENV_MARKER, SHELL_ENV_TIMEOUT_MS } from "@shared/config";

export type SpawnFn = (command: string, args: readonly string[], options?: SpawnOptions) => ChildProcess;

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** KEY=VALUE lines between the first and last marker; `{}` when either is missing. */
export function parseEnvBlock(text: string, marker: string = SHELL_ENV_MARKER): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  const start = text.indexOf(marker);
  const end = text.lastIndexOf(marker);
  if (start === -1 || end <= start) return out;
  for (const line of text.slice(start + marker.length, end).split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (KEY_RE.test(key)) out[key] = line.slice(eq + 1);
  }
  return out;
}

/** `$SHELL`, else the account's shell, else /bin/bash. */
export function pickShell(envShell: string | undefined, userInfoShell: () => string | null | undefined): string {
  if (envShell) return envShell;
  try {
    const s = userInfoShell();
    if (s) return s;
  } catch {
    // ignore
  }
  return "/bin/bash";
}

export function shellEnvScript(marker: string = SHELL_ENV_MARKER): string {
  return `printf %s ${marker}; env; printf %s ${marker}`;
}

export function shellArgv(shell: string, script: string): string[] {
  const base = shell.slice(shell.lastIndexOf("/") + 1);
  return base === "csh" || base === "tcsh" ? ["-c", script] : ["-ilc", script];
}

/** `shellPATH:oldPATH`, dropping empty and repeated entries (first occurrence wins). */
export function mergePath(shellPath: string, oldPath: string | undefined): string {
  const seen = new Set<string>();
  return `${shellPath}:${oldPath ?? ""}`
    .split(":")
    .filter((p) => {
      if (!p || seen.has(p)) return false;
      seen.add(p);
      return true;
    })
    .join(":");
}

export interface CaptureOptions {
  spawn: SpawnFn;
  shell: string;
  timeoutMs?: number;
}

/** Never rejects: errors, timeouts and garbage all yield whatever was parsed (usually `{}`). */
export function captureLoginShellEnv(opts: CaptureOptions): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let child: ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try {
        child?.stdout?.destroy();
        child?.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve(parseEnvBlock(out));
    };
    try {
      child = opts.spawn(opts.shell, shellArgv(opts.shell, shellEnvScript()), { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      finish();
      return;
    }
    timer = setTimeout(finish, opts.timeoutMs ?? SHELL_ENV_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer | string) => {
      out += chunk.toString();
    });
    child.stdout?.on("error", () => {});
    child.on("error", finish);
    child.on("close", finish);
  });
}

/** Apply a captured environment to `env` (SSH_AUTH_SOCK overwrite, PATH prepend). */
export function applyShellEnv(env: NodeJS.ProcessEnv, captured: Record<string, string>): void {
  if (captured.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = captured.SSH_AUTH_SOCK;
  if (captured.PATH) env.PATH = mergePath(captured.PATH, env.PATH);
}
