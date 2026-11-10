import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenDialogOptions } from "electron";

type Listener = (event: unknown, ...args: unknown[]) => unknown;
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Listener>(), dialogCalls: [] as unknown[] }));

vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: Listener) => mocks.handlers.set(ch, fn), on: () => {} },
  session: { fromPartition: () => ({}) },
  dialog: {
    showOpenDialog: async (o: unknown) => {
      mocks.dialogCalls.push(o);
      return { canceled: true, filePaths: [] };
    },
  },
}));

import { GATEWAY_PROD, GATEWAY_STAGING } from "@shared/config";
import type { SshDeps } from "../../../src/main/ssh";
import { createSshService, registerSshIpc, sshIpcOps } from "../../../src/main/ssh";
import { createMainContext } from "../../../src/main/services";
import type { SshService } from "../../../src/main/services";
import { makeTestContext, silentLoggerFactory, testEnv } from "../helpers/context";
import { fakeSpawn } from "./fakes";
import type { FakeHandler } from "./fakes";

const MARK = "__SILICO_SHELL_ENV__";
const shellOk: FakeHandler = () => ({ stdout: `motd\n${MARK}PATH=/opt/bin:/usr/bin\nSSH_AUTH_SOCK=/tmp/agent\n${MARK}` });

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rea-ssh-test-"));
  mocks.handlers.clear();
  mocks.dialogCalls.length = 0;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function make(handler: FakeHandler, extra: Partial<SshDeps> = {}) {
  const f = fakeSpawn((cmd, args, stdin) => (cmd === "/bin/testsh" ? shellOk(cmd, args, stdin) : handler(cmd, args, stdin)));
  const env: NodeJS.ProcessEnv = { SHELL: "/bin/testsh", PATH: "/usr/bin:/bin" };
  const ctx = makeTestContext({ auth: { activeGateway: async () => GATEWAY_PROD } });
  const svc = createSshService(ctx, { homeDir: home, spawn: f.spawn, platform: "darwin", env, ...extra });
  return { svc, ops: sshIpcOps(svc), calls: f.calls, env, ctx };
}

const nonShell = <T extends { cmd: string }>(calls: T[]): T[] => calls.filter((c) => c.cmd !== "/bin/testsh");

describe("ensureShellEnv", () => {
  it("imports PATH (prepended, deduped) and SSH_AUTH_SOCK once", async () => {
    const { svc, calls, env } = make(() => ({}));
    await Promise.all([svc.ensureShellEnv(), svc.ensureShellEnv()]);
    await svc.ensureShellEnv();
    expect(env.PATH).toBe("/opt/bin:/usr/bin:/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/agent");
    const shellCalls = calls.filter((c) => c.cmd === "/bin/testsh");
    expect(shellCalls).toHaveLength(1);
    expect(shellCalls[0]?.args).toEqual(["-ilc", `printf %s ${MARK}; env; printf %s ${MARK}`]);
    expect(shellCalls[0]?.opts).toEqual({ stdio: ["ignore", "pipe", "ignore"] });
  });
  it("is a no-op on win32", async () => {
    const { svc, calls, env } = make(() => ({}), { platform: "win32" });
    await svc.ensureShellEnv();
    expect(calls).toHaveLength(0);
    expect(env.PATH).toBe("/usr/bin:/bin");
  });
  it("SIGKILLs after the timeout and keeps the env unchanged", async () => {
    const f = fakeSpawn(() => ({ hang: true }));
    const env: NodeJS.ProcessEnv = { SHELL: "/bin/tcsh", PATH: "/usr/bin" };
    const svc = createSshService(makeTestContext(), { spawn: f.spawn, platform: "linux", env, shellEnvTimeoutMs: 20, homeDir: home });
    await svc.ensureShellEnv();
    expect(f.calls[0]?.args[0]).toBe("-c");
    expect(f.calls[0]?.killed).toEqual(["SIGKILL"]);
    expect(env.PATH).toBe("/usr/bin");
  });
  it("shell spawn error resolves without importing", async () => {
    const f = fakeSpawn(() => ({ errorCode: "ENOENT" }));
    const env: NodeJS.ProcessEnv = { SHELL: "/nope", PATH: "/usr/bin" };
    const svc = createSshService(makeTestContext(), { spawn: f.spawn, platform: "linux", env, homeDir: home });
    await svc.ensureShellEnv();
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("runRemote", () => {
  it("spawns ssh with sshArgs + dest + cmd, streams chunks, waits for the env import", async () => {
    const { svc, calls } = make(() => ({ stdout: "out", stderr: "err", code: 0 }));
    const chunks: string[] = [];
    let spawned = false;
    const r = await svc.runRemote({ host: "h", user: "u", port: 2200 }, "echo hi", {
      onChunk: (t, s) => chunks.push(`${s}:${t}`),
      onSpawn: () => (spawned = true),
    });
    expect(r).toEqual({ code: 0, stdout: "out", stderr: "err" });
    expect(chunks.sort()).toEqual(["stderr:err", "stdout:out"]);
    expect(spawned).toBe(true);
    expect(calls[0]?.cmd).toBe("/bin/testsh");
    expect(nonShell(calls)[0]).toMatchObject({
      cmd: "ssh",
      args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", "2200", "--", "u@h", "echo hi"],
      opts: undefined,
    });
  });
  it("already-aborted signal => code null without spawning ssh", async () => {
    const { svc, calls } = make(() => ({ code: 0 }));
    const ac = new AbortController();
    ac.abort();
    expect(await svc.runRemote({ host: "h" }, "x", { signal: ac.signal })).toEqual({ code: null, stdout: "", stderr: "" });
    expect(nonShell(calls)).toHaveLength(0);
  });
  it("abort during spawn => SIGTERM and code null", async () => {
    const ac = new AbortController();
    const { svc, calls } = make((cmd) => {
      if (cmd === "ssh") ac.abort();
      return { code: 0 };
    });
    expect(await svc.runRemote({ host: "h" }, "x", { signal: ac.signal })).toEqual({ code: null, stdout: "", stderr: "" });
    expect(nonShell(calls)[0]?.killed).toEqual(["SIGTERM"]);
  });
  it("missing ssh => 255 toolMissing result", async () => {
    const { svc } = make(() => ({ errorCode: "ENOENT" }));
    const r = await svc.runRemote({ host: "h" }, "x");
    expect(r.code).toBe(255);
    expect(r.toolMissing).toBe(true);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("couldn't find `ssh`");
    expect(svc.classifySshError(r)).toBe(r.stderr);
  });
  it("non-ENOENT spawn error rejects", async () => {
    const { svc } = make(() => ({ errorCode: "EACCES" }));
    await expect(svc.runRemote({ host: "h" }, "x")).rejects.toThrow(/EACCES/);
  });
});

describe("binary resolver", () => {
  it("win32 falls back to %SystemRoot%\\System32\\OpenSSH and caches the hit", async () => {
    const f = fakeSpawn((cmd) => (cmd === "ssh" ? { errorCode: "ENOENT" } : { code: 0 }));
    const env: NodeJS.ProcessEnv = { SystemRoot: "C:\\Windows" };
    const svc = createSshService(makeTestContext(), { spawn: f.spawn, platform: "win32", env, homeDir: home });
    await svc.runRemote({ host: "h" }, "x");
    await svc.runRemote({ host: "h" }, "y");
    expect(f.calls.map((c) => c.cmd)).toEqual([
      "ssh",
      "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
      "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
    ]);
  });
  it("win32 with both missing => Windows install advice", async () => {
    const f = fakeSpawn(() => ({ errorCode: "ENOENT" }));
    const svc = createSshService(makeTestContext(), { spawn: f.spawn, platform: "win32", env: { SystemRoot: "C:\\W" }, homeDir: home });
    const r = await svc.spawnTool("ssh-keyscan", ["-H"]);
    expect(r).toEqual({
      ok: false,
      toolMissing: true,
      message: expect.stringContaining('add "OpenSSH Client"') as unknown as string,
    });
  });
  it("spawnTool returns the child", async () => {
    const { svc, calls } = make(() => ({ code: 0 }));
    const r = await svc.spawnTool("ssh", ["-N", "h"]);
    expect(r.ok).toBe(true);
    expect(nonShell(calls)[0]?.args).toEqual(["-N", "h"]);
  });
  it("spawnTool rejects on non-ENOENT errors", async () => {
    const { svc } = make(() => ({ errorCode: "EPERM" }));
    await expect(svc.spawnTool("ssh", [])).rejects.toThrow(/EPERM/);
  });
});

describe("ssh:listHosts / ssh:addHost", () => {
  it("missing config => []", async () => {
    const { ops } = make(() => ({}));
    expect(await ops.listHosts()).toEqual([]);
  });
  it("creates ~/.ssh (0700) and config (0600), appends exact text", async () => {
    const { ops } = make(() => ({}));
    await ops.addHost({ alias: "silico-x", hostName: "login.c", user: "me", port: "22", identityFile: "~/.ssh/id" });
    const dir = await stat(join(home, ".ssh"));
    const file = await stat(join(home, ".ssh", "config"));
    expect(dir.mode & 0o777).toBe(0o700);
    expect(file.mode & 0o777).toBe(0o600);
    expect(await readFile(join(home, ".ssh", "config"), "utf-8")).toBe(
      "\nHost silico-x\n    HostName login.c\n    User me\n    Port 22\n    IdentityFile ~/.ssh/id\n",
    );
    expect(await ops.listHosts()).toEqual([
      { alias: "silico-x", hostName: "login.c", user: "me", port: 22, identityFile: "~/.ssh/id" },
    ]);
  });
  it("appends to an existing config without touching its mode", async () => {
    await mkdir(join(home, ".ssh"));
    await writeFile(join(home, ".ssh", "config"), "Host old\n  HostName o", { mode: 0o644 });
    const { ops } = make(() => ({}));
    await ops.addHost({ alias: "new", hostName: "n", identityFile: "/k dir/id" });
    expect(await readFile(join(home, ".ssh", "config"), "utf-8")).toBe(
      'Host old\n  HostName o\nHost new\n    HostName n\n    IdentityFile "/k dir/id"\n',
    );
    expect((await stat(join(home, ".ssh", "config"))).mode & 0o777).toBe(0o644);
  });
  it("duplicate alias (case-sensitive) is rejected", async () => {
    await mkdir(join(home, ".ssh"));
    await writeFile(join(home, ".ssh", "config"), "Host dup\n");
    const { ops } = make(() => ({}));
    await expect(ops.addHost({ alias: "dup", hostName: "h" })).rejects.toThrow('An SSH host "dup" already exists in ~/.ssh/config.');
    await expect(ops.addHost({ alias: "DUP", hostName: "h" })).resolves.toBeUndefined();
  });
  it("validation errors write nothing", async () => {
    const { ops } = make(() => ({}));
    await expect(ops.addHost({ alias: "a b", hostName: "h" })).rejects.toThrow("The alias must not contain spaces or control characters.");
    await expect(stat(join(home, ".ssh"))).rejects.toThrow();
  });
});

describe("dialog:pickFile", () => {
  it("defaults to ~/.ssh when it exists and returns the first path", async () => {
    await mkdir(join(home, ".ssh"));
    const seen: OpenDialogOptions[] = [];
    const { ops } = make(() => ({}), {
      showOpenDialog: async (o) => {
        seen.push(o);
        return { canceled: false, filePaths: ["/a", "/b"] };
      },
    });
    expect(await ops.pickFile()).toBe("/a");
    expect(seen[0]).toEqual({
      title: "Select SSH private key",
      defaultPath: join(home, ".ssh"),
      properties: ["openFile", "showHiddenFiles"],
    });
  });
  it("falls back to home and returns null on cancel / empty", async () => {
    const seen: OpenDialogOptions[] = [];
    const { ops } = make(() => ({}), {
      showOpenDialog: async (o) => {
        seen.push(o);
        return { canceled: false, filePaths: [] };
      },
    });
    expect(await ops.pickFile()).toBeNull();
    expect(seen[0]?.defaultPath).toBe(home);
  });
  it("uses electron dialog by default", async () => {
    const { ops } = make(() => ({}));
    expect(await ops.pickFile()).toBeNull();
    expect(mocks.dialogCalls).toHaveLength(1);
  });
});

describe("SSH argument injection (D5.6)", () => {
  const EVIL = "-oProxyCommand=touch /tmp/pwned";
  it("runRemote never spawns ssh for option-looking host/user/jump", async () => {
    const { svc, calls } = make(() => ({ code: 0 }));
    expect(await svc.runRemote({ host: EVIL }, "x")).toEqual({ code: 255, stdout: "", stderr: "Invalid host name." });
    expect(await svc.runRemote({ host: "h", user: "-oProxyCommand=x" }, "x")).toMatchObject({ code: 255, stderr: "Invalid user name." });
    expect(await svc.runRemote({ host: "h", jump: "-oProxyCommand=x" }, "x")).toMatchObject({ code: 255, stderr: "Invalid jump host." });
    expect(nonShell(calls)).toHaveLength(0);
  });
  it("lab:test, hostKey scan and accept reject without spawning anything", async () => {
    const { ops, calls } = make(hostKeyHandler());
    expect(await ops.test({ host: EVIL })).toEqual({ ok: false, detail: "Invalid host name." });
    expect(await ops.scanHostKey({ host: EVIL })).toEqual({ ok: false, error: "Invalid host name." });
    expect(await ops.acceptHostKey({ host: EVIL }, "SHA256:EDFP")).toEqual({ ok: false, error: "Invalid host name." });
    expect(nonShell(calls)).toHaveLength(0);
  });
  it("an option-looking hostname from ssh -G output is never keyscanned", async () => {
    const { ops, calls } = make(hostKeyHandler({ sshG: "hostname -oProxyCommand=x\nport 22\n" }));
    expect(await ops.scanHostKey({ host: "alias" })).toEqual({ ok: false, error: "Invalid host name." });
    expect(nonShell(calls).some((c) => c.cmd === "ssh-keyscan")).toBe(false);
  });
});

describe("lab:test", () => {
  it("no host", async () => {
    const { ops } = make(() => ({}));
    expect(await ops.test({ host: "" })).toEqual({ ok: false, detail: "No SSH host configured." });
  });
  it("prod probes silico || silico-setup", async () => {
    const { ops, calls } = make(() => ({ code: 0 }));
    expect(await ops.test({ host: "h" })).toEqual({ ok: true, detail: "SSH OK: silico present on the cluster." });
    expect(nonShell(calls)[0]?.args.at(-1)).toBe(
      'PATH="$PATH:$HOME/.local/bin" command -v silico >/dev/null 2>&1 || command -v silico-setup >/dev/null 2>&1',
    );
  });
  it("staging uses ctx.auth.activeGateway and probes silico-dev", async () => {
    const f = fakeSpawn((cmd) => (cmd === "/bin/testsh" ? { stdout: "" } : { code: 1 }));
    const ctx = makeTestContext({ auth: { activeGateway: async () => GATEWAY_STAGING } });
    const svc = createSshService(ctx, { spawn: f.spawn, platform: "darwin", env: { SHELL: "/bin/testsh" }, homeDir: home });
    const r = await sshIpcOps(svc).test({ host: "h" });
    expect(r).toEqual({
      ok: false,
      detail: "The dev CLI (silico-dev) isn't installed on this cluster. On its login node, update the Silico CLI, then run `silico-dev setup`.",
    });
    expect(f.calls.at(-1)?.args.at(-1)).toBe('PATH="$PATH:$HOME/.local/bin" command -v silico-dev >/dev/null 2>&1');
  });
  it("255 + unknown host key", async () => {
    const { ops } = make(() => ({ code: 255, stderr: "Host key verification failed.\n" }));
    expect(await ops.test({ host: "h" })).toEqual({
      ok: false,
      hostKey: "unknown",
      detail: "First time connecting to h. Trust its host key to continue.",
    });
  });
});

// --- host keys -------------------------------------------------------------

const ED_LINE = "|1|aaa|bbb ssh-ed25519 AAAAED";
const RSA_LINE = "|1|ccc|ddd ssh-rsa AAAARSA";
const FP: Record<string, string> = { [ED_LINE]: "256 SHA256:EDFP |1|aaa|bbb (ED25519)", [RSA_LINE]: "3072 SHA256:RSAFP |1|ccc|ddd (RSA)" };

function hostKeyHandler(opts: { sshG?: string; sshGCode?: number; scan?: string; missing?: string } = {}): FakeHandler {
  return (cmd, args, stdin) => {
    if (opts.missing === cmd) return { errorCode: "ENOENT" };
    if (cmd === "ssh" && args[0] === "-G") return { code: opts.sshGCode ?? 0, stdout: opts.sshG ?? "hostname real.host\nport 22\nproxyjump none\n" };
    if (cmd === "ssh-keyscan") return { code: 0, stdout: opts.scan ?? `${RSA_LINE}\n${ED_LINE}\n` };
    if (cmd === "ssh-keygen") {
      const out = stdin
        .split("\n")
        .filter(Boolean)
        .map((l) => FP[l] ?? "")
        .join("\n");
      return { code: 0, stdout: `${out}\n` };
    }
    return { code: 1 };
  };
}

describe("lab:hostKey:scan", () => {
  it("resolves via ssh -G, keyscans with -H -p, fingerprints with stdin, prefers ED25519", async () => {
    const { ops, calls } = make(hostKeyHandler());
    expect(await ops.scanHostKey({ host: "alias", port: 2222 })).toEqual({
      ok: true,
      host: "real.host",
      keyType: "ED25519",
      fingerprint: "SHA256:EDFP",
    });
    const nc = nonShell(calls);
    expect(nc[0]?.args).toEqual(["-G", "--", "alias"]);
    // Faithful quirk: ssh -G's port overrides the explicit target port.
    expect(nc[1]).toMatchObject({ cmd: "ssh-keyscan", args: ["-H", "-p", "22", "--", "real.host"] });
    expect(nc[2]).toMatchObject({ cmd: "ssh-keygen", args: ["-lf", "-"], stdin: `${RSA_LINE}\n${ED_LINE}\n` });
  });
  it("non-22 port shows host:port; ssh -G failure keeps defaults", async () => {
    const { ops, calls } = make(hostKeyHandler({ sshGCode: 255 }));
    expect(await ops.scanHostKey({ host: "h", port: 2222 })).toMatchObject({ ok: true, host: "h:2222" });
    expect(nonShell(calls)[1]?.args).toEqual(["-H", "-p", "2222", "--", "h"]);
  });
  it("errors", async () => {
    expect(await make(hostKeyHandler()).ops.scanHostKey({ host: "" })).toEqual({ ok: false, error: "No SSH host." });
    expect(await make(hostKeyHandler({ sshG: "proxyjump bastion\n" })).ops.scanHostKey({ host: "a" })).toEqual({
      ok: false,
      error: "a is reached through a jump host; automatic key fetch isn't supported yet. Run `ssh a` once to accept it.",
    });
    expect(await make(hostKeyHandler({ sshGCode: 1 })).ops.scanHostKey({ host: "a", jump: "j" })).toMatchObject({ ok: false });
    expect(await make(hostKeyHandler({ scan: "  \n" })).ops.scanHostKey({ host: "a" })).toEqual({
      ok: false,
      error: "Couldn't reach real.host to read its host key. Check the host and your network / VPN.",
    });
    const missing = await make(hostKeyHandler({ missing: "ssh-keyscan" })).ops.scanHostKey({ host: "a" });
    expect(missing.ok === false && missing.error).toContain("couldn't find `ssh-keyscan`");
    const missingKg = await make(hostKeyHandler({ missing: "ssh-keygen" })).ops.scanHostKey({ host: "a" });
    expect(missingKg.ok === false && missingKg.error).toContain("couldn't find `ssh-keygen`");
    expect(await make(hostKeyHandler({ scan: "|1|x|y ssh-dss Z\n" })).ops.scanHostKey({ host: "a" })).toEqual({
      ok: false,
      error: "Could not read the host key fingerprint.",
    });
  });
});

describe("lab:hostKey:accept (D5.2)", () => {
  const kh = () => join(home, ".ssh", "known_hosts");

  it("appends only the line matching the approved fingerprint; creates 0700 dir and 0644 file", async () => {
    const { ops, calls } = make(hostKeyHandler());
    expect(await ops.acceptHostKey({ host: "alias" }, "SHA256:EDFP")).toEqual({ ok: true });
    expect(await readFile(kh(), "utf-8")).toBe(`${ED_LINE}\n`);
    expect((await stat(join(home, ".ssh"))).mode & 0o777).toBe(0o700);
    expect((await stat(kh())).mode & 0o777).toBe(0o644);
    // each scanned line is fingerprinted separately
    expect(nonShell(calls).filter((c) => c.cmd === "ssh-keygen").map((c) => c.stdin)).toEqual([`${RSA_LINE}\n`, `${ED_LINE}\n`]);
  });
  it("mismatch (key changed since scan) writes nothing", async () => {
    const { ops } = make(hostKeyHandler());
    const r = await ops.acceptHostKey({ host: "alias" }, "SHA256:OTHER");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("SHA256:OTHER");
    await expect(stat(kh())).rejects.toThrow();
  });
  it("invalid or missing expected fingerprint is refused before scanning", async () => {
    const { ops, calls } = make(hostKeyHandler());
    for (const fp of [undefined, "", "EDFP", "SHA256:x y"] as unknown[]) {
      const r = await ops.acceptHostKey({ host: "a" }, fp as string);
      expect(r.ok).toBe(false);
    }
    expect(nonShell(calls)).toHaveLength(0);
  });
  it("adds a separating newline when known_hosts lacks a trailing one", async () => {
    await mkdir(join(home, ".ssh"));
    await writeFile(kh(), "existing line");
    const { ops } = make(hostKeyHandler());
    await ops.acceptHostKey({ host: "a" }, "SHA256:RSAFP");
    expect(await readFile(kh(), "utf-8")).toBe(`existing line\n${RSA_LINE}\n`);
  });
  it("no separator when the file ends in a newline or is empty", async () => {
    await mkdir(join(home, ".ssh"));
    await writeFile(kh(), "x\n");
    const { ops } = make(hostKeyHandler());
    await ops.acceptHostKey({ host: "a" }, "SHA256:EDFP");
    expect(await readFile(kh(), "utf-8")).toBe(`x\n${ED_LINE}\n`);
  });
  it("errors: no host, jump host, unreachable, missing tool", async () => {
    expect(await make(hostKeyHandler()).ops.acceptHostKey({ host: "" }, "SHA256:EDFP")).toEqual({ ok: false, error: "No SSH host." });
    expect(await make(hostKeyHandler({ sshG: "proxyjump b\n" })).ops.acceptHostKey({ host: "a" }, "SHA256:EDFP")).toEqual({
      ok: false,
      error: "Jump-host key fetch is not supported yet.",
    });
    expect(await make(hostKeyHandler({ scan: "" })).ops.acceptHostKey({ host: "a" }, "SHA256:EDFP")).toEqual({
      ok: false,
      error: "Couldn't reach real.host to read its host key.",
    });
    const m = await make(hostKeyHandler({ missing: "ssh-keygen" })).ops.acceptHostKey({ host: "a" }, "SHA256:EDFP");
    expect(m.ok === false && m.error).toContain("couldn't find `ssh-keygen`");
    await expect(stat(kh())).rejects.toThrow();
  });
});

describe("registerSshIpc", () => {
  it("registers the six channels through the shell trust gate", async () => {
    const b = createMainContext();
    b.provide("env", testEnv());
    b.provide("logger", silentLoggerFactory);
    const f = fakeSpawn(() => ({ code: 0 }));
    const svc: SshService = createSshService(b.ctx, { spawn: f.spawn, platform: "win32", env: {}, homeDir: home, isStaging: async () => false });
    b.provide("ssh", svc);
    registerSshIpc(b.ctx);
    expect([...mocks.handlers.keys()].sort()).toEqual(
      ["dialog:pickFile", "lab:hostKey:accept", "lab:hostKey:scan", "lab:test", "ssh:addHost", "ssh:listHosts"].sort(),
    );
    const trusted = { sender: { getURL: () => "file:///x" }, senderFrame: { url: "file:///index.html" } };
    const untrusted = { sender: { getURL: () => "https://evil" }, senderFrame: { url: "https://evil" } };
    expect(await mocks.handlers.get("ssh:listHosts")?.(trusted)).toEqual([]);
    expect(await mocks.handlers.get("lab:test")?.(trusted, { host: "h" })).toEqual({
      ok: true,
      detail: "SSH OK: silico present on the cluster.",
    });
    expect(() => mocks.handlers.get("ssh:listHosts")?.(untrusted)).toThrow("Blocked 'ssh:listHosts': untrusted sender.");
  });
});
