/**
 * SSH module entry (owner: I2) [conn-ssh spec].
 *
 * Owns: login-shell env import, OpenSSH binary resolver, ssh argv builder,
 * remote exec, error classifiers, ~/.ssh/config parse + append (D5: quote
 * IdentityFile paths with spaces), host-key scan/accept (D5: only append keys
 * whose fingerprint matches the approved one). IPC: ssh:listHosts,
 * ssh:addHost, dialog:pickFile, lab:test, lab:hostKey:scan, lab:hostKey:accept.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, promises as fsp } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { dialog } from "electron";
import type { OpenDialogOptions, OpenDialogReturnValue } from "electron";
import { GATEWAY_STAGING, SSH_CONFIG_MODE, SSH_DIR_MODE } from "@shared/config";
import { ShellInvokeChannel } from "@shared/ipc";
import type { AddHostInput, HostKeyAcceptResult, HostKeyScanResult, SshHostEntry, SshTarget, TestResult } from "@shared/ipc";
import { handleShell } from "../ipc/trust";
import type { MainContext, SshService } from "../services";
import { sshArgs, sshDest } from "./args";
import { classifyHostKey, classifySshError } from "./classify";
import { parseSshConfig, renderHostBlock, validateAddHost } from "./config";
import { applyShellEnv, captureLoginShellEnv, pickShell } from "./env";
import type { SpawnFn } from "./env";
import { acceptHostKey, scanHostKey } from "./hostkey";
import { runLabTest } from "./labtest";
import { createToolRunner, ToolMissingError } from "./spawn";

export interface SshDeps {
  /** Override $HOME (tests). */
  homeDir?: string;
  /** Process spawner (tests inject a fake; default child_process.spawn). */
  spawn?: SpawnFn;
  /** Default process.platform. */
  platform?: NodeJS.Platform;
  /** Environment that receives the login-shell import (default process.env, which children inherit). */
  env?: NodeJS.ProcessEnv;
  /** Account shell fallback (default os.userInfo().shell). */
  userShell?: () => string | null | undefined;
  /** Login-shell capture timeout (default SHELL_ENV_TIMEOUT_MS). */
  shellEnvTimeoutMs?: number;
  /** Staging check for lab:test (default: ctx.auth.activeGateway() === GATEWAY_STAGING). */
  isStaging?: () => Promise<boolean>;
  /** Native open dialog (tests). */
  showOpenDialog?: (opts: OpenDialogOptions) => Promise<OpenDialogReturnValue>;
}

/** Handlers behind the ssh-area IPC channels (exported for tests). */
export interface SshIpcOps {
  listHosts(): Promise<SshHostEntry[]>;
  addHost(input: AddHostInput): Promise<void>;
  pickFile(): Promise<string | null>;
  test(target: SshTarget): Promise<TestResult>;
  scanHostKey(target: SshTarget): Promise<HostKeyScanResult>;
  acceptHostKey(target: SshTarget, expectedFingerprint: string): Promise<HostKeyAcceptResult>;
}

const opsByService = new WeakMap<SshService, SshIpcOps>();

const defaultSpawn: SpawnFn = (cmd, args, opts) => (opts ? nodeSpawn(cmd, [...args], opts) : nodeSpawn(cmd, [...args]));

export function createSshService(ctx: MainContext, deps?: SshDeps): SshService {
  const spawn = deps?.spawn ?? defaultSpawn;
  const platform = deps?.platform ?? process.platform;
  const env = deps?.env ?? process.env;
  const home = (): string => deps?.homeDir ?? homedir();

  let envPromise: Promise<void> | null = null;
  const ensureShellEnv = (): Promise<void> => {
    envPromise ??= (async () => {
      if (platform === "win32") return;
      const shell = pickShell(env.SHELL, deps?.userShell ?? (() => userInfo().shell));
      const captured = await captureLoginShellEnv({
        spawn,
        shell,
        ...(deps?.shellEnvTimeoutMs !== undefined ? { timeoutMs: deps.shellEnvTimeoutMs } : {}),
      });
      applyShellEnv(env, captured);
    })();
    return envPromise;
  };

  const runner = createToolRunner({ spawn, platform, systemRoot: () => env.SystemRoot, ensureEnv: ensureShellEnv });

  const service: SshService = {
    ensureShellEnv,
    runRemote: (target, cmd, opts) => runner.runRemote(target, cmd, opts),
    spawnTool: async (tool, args) => {
      await ensureShellEnv();
      try {
        return { ok: true, child: await runner.spawnResolved(tool, args) };
      } catch (err) {
        if (err instanceof ToolMissingError) return { ok: false, toolMissing: true, message: err.message };
        throw err;
      }
    },
    sshArgs,
    sshDest,
    classifyHostKey,
    classifySshError,
  };

  const configPath = (): string => join(home(), ".ssh", "config");
  const listHosts = async (): Promise<SshHostEntry[]> => {
    try {
      return parseSshConfig(await fsp.readFile(configPath(), "utf-8"));
    } catch {
      return [];
    }
  };
  const isStaging =
    deps?.isStaging ?? (async (): Promise<boolean> => (await ctx.auth.activeGateway()) === GATEWAY_STAGING);
  const showOpenDialog = deps?.showOpenDialog ?? ((o: OpenDialogOptions) => dialog.showOpenDialog(o));

  opsByService.set(service, {
    listHosts,
    addHost: async (input) => {
      const v = validateAddHost((input ?? {}) as AddHostInput);
      if ((await listHosts()).some((h) => h.alias === v.alias)) {
        throw new Error(`An SSH host "${v.alias}" already exists in ~/.ssh/config.`);
      }
      await fsp.mkdir(join(home(), ".ssh"), { recursive: true, mode: SSH_DIR_MODE });
      await fsp.appendFile(configPath(), renderHostBlock(v), { mode: SSH_CONFIG_MODE });
    },
    pickFile: async () => {
      const sshDir = join(home(), ".ssh");
      const res = await showOpenDialog({
        title: "Select SSH private key",
        defaultPath: existsSync(sshDir) ? sshDir : home(),
        properties: ["openFile", "showHiddenFiles"],
      });
      return res.canceled || res.filePaths.length === 0 ? null : (res.filePaths[0] ?? null);
    },
    test: (target) => runLabTest(target, isStaging, (t, cmd) => runner.runRemote(t, cmd)),
    scanHostKey: (target) => scanHostKey(runner.runLocal, target),
    acceptHostKey: (target, fp) => acceptHostKey(runner.runLocal, target, fp, { homeDir: home() }),
  });

  return service;
}

/** The IPC handlers bound to a service created by `createSshService`. */
export function sshIpcOps(service: SshService): SshIpcOps {
  const ops = opsByService.get(service);
  if (!ops) throw new Error("ssh IPC handlers are only available for a service created by createSshService");
  return ops;
}

/** ssh:listHosts, ssh:addHost, dialog:pickFile, lab:test, lab:hostKey:scan, lab:hostKey:accept. */
export function registerSshIpc(ctx: MainContext): void {
  const ops = (): SshIpcOps => sshIpcOps(ctx.ssh);
  handleShell(ShellInvokeChannel.sshListHosts, () => ops().listHosts());
  handleShell(ShellInvokeChannel.sshAddHost, (_e, input) => ops().addHost(input));
  handleShell(ShellInvokeChannel.dialogPickFile, () => ops().pickFile());
  handleShell(ShellInvokeChannel.labTest, (_e, target) => ops().test(target));
  handleShell(ShellInvokeChannel.labHostKeyScan, (_e, target) => ops().scanHostKey(target));
  handleShell(ShellInvokeChannel.labHostKeyAccept, (_e, target, fp) => ops().acceptHostKey(target, fp));
}
