import { describe, expect, it } from "vitest";
import { remoteArgv, sshArgs, sshDest } from "../../../src/main/ssh/args";
import {
  classifyHostKey,
  classifySshError,
  MSG_PERMISSION_DENIED,
  MSG_REFUSED,
  MSG_TIMED_OUT,
  MSG_UNRESOLVED,
} from "../../../src/main/ssh/classify";
import { formatIdentityFile, parseSshConfig, renderHostBlock, validateAddHost } from "../../../src/main/ssh/config";
import { mergePath, parseEnvBlock, pickShell, shellArgv, shellEnvScript } from "../../../src/main/ssh/env";
import { displayHost, parseFingerprintLine, parseSshG, pickFingerprint } from "../../../src/main/ssh/hostkey";
import { interpretLabTest, labTestCommand, MSG_CLI_MISSING, MSG_DEV_CLI_MISSING } from "../../../src/main/ssh/labtest";
import { resolveFallback, toolMissingMessage } from "../../../src/main/ssh/spawn";

const BASE = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

describe("sshArgs / sshDest", () => {
  it("minimal target", () => {
    expect(sshArgs({ host: "h" })).toEqual(BASE);
    expect(sshDest({ host: "h" })).toBe("h");
  });
  it("full target in order", () => {
    const t = { host: "h", user: "u", port: 2222, identityFile: "/k", jump: "bast" };
    expect(sshArgs(t)).toEqual([...BASE, "-i", "/k", "-o", "IdentitiesOnly=yes", "-p", "2222", "-J", "bast"]);
    expect(sshDest(t)).toBe("u@h");
  });
  it("port 0 / empty strings are skipped (truthiness)", () => {
    expect(sshArgs({ host: "h", port: 0, identityFile: "", jump: "" })).toEqual(BASE);
    expect(sshDest({ host: "h", user: "" })).toBe("h");
  });
  it("remoteArgv appends dest and cmd as separate argv entries", () => {
    expect(remoteArgv({ host: "h", user: "u" }, "echo hi; rm x")).toEqual([...BASE, "--", "u@h", "echo hi; rm x"]);
  });
  it("never sets ControlMaster/StrictHostKeyChecking/UserKnownHostsFile", () => {
    const all = sshArgs({ host: "h", user: "u", port: 1, identityFile: "/k", jump: "j" }).join(" ");
    expect(all).not.toMatch(/ControlMaster|ControlPath|StrictHostKeyChecking|UserKnownHostsFile/);
  });
});

describe("classifyHostKey", () => {
  it("changed wins over failed", () => {
    expect(classifyHostKey("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.")).toBe(
      "changed",
    );
  });
  it("unknown", () => expect(classifyHostKey("Host key verification failed.\r\n")).toBe("unknown"));
  it("null otherwise", () => expect(classifyHostKey("Permission denied (publickey).")).toBeNull());
});

describe("classifySshError", () => {
  it("toolMissing returns stderr verbatim", () => {
    expect(classifySshError({ code: 255, stderr: "Permission denied whatever", toolMissing: true })).toBe(
      "Permission denied whatever",
    );
  });
  it("host-key literal (incl. no matching host key quirk)", () => {
    expect(classifySshError({ code: 255, stderr: "Host key verification failed." })).toBe("host-key");
    expect(classifySshError({ code: 255, stderr: "Unable to negotiate: no matching host key type found" })).toBe("host-key");
  });
  it("host-key is checked before permission denied", () => {
    expect(classifySshError({ code: 255, stderr: "Permission denied\nHost key verification failed." })).toBe("host-key");
  });
  it("permission denied", () => {
    expect(classifySshError({ code: 255, stderr: "u@h: Permission denied (publickey)." })).toBe(MSG_PERMISSION_DENIED);
    expect(MSG_PERMISSION_DENIED).toBe(
      "SSH was refused (publickey). If your key has a passphrase, add it to your ssh-agent (`ssh-add`) or use a passphrase-less key — the app cannot prompt for one. Otherwise check the key registered with us matches your SSH config.",
    );
  });
  it("timed out", () => {
    expect(classifySshError({ code: 255, stderr: "ssh: connect to host x port 22: Operation timed out" })).toBe(MSG_TIMED_OUT);
    expect(MSG_TIMED_OUT).toBe("SSH timed out. Check the host and your network / VPN.");
  });
  it("could not resolve / name or service not known", () => {
    expect(classifySshError({ code: 255, stderr: "ssh: Could not resolve hostname foo: nodename nor servname provided" })).toBe(
      MSG_UNRESOLVED,
    );
    expect(classifySshError({ code: 255, stderr: "ssh: foo: Name or service not known" })).toBe(MSG_UNRESOLVED);
    expect(MSG_UNRESOLVED).toBe("Could not resolve the SSH host. Check the host name.");
  });
  it("connection refused", () => {
    expect(classifySshError({ code: 255, stderr: "connect to host h port 22: Connection refused" })).toBe(MSG_REFUSED);
    expect(MSG_REFUSED).toBe("SSH connection refused. Check the host and port.");
  });
  it("fallback: last two trimmed lines, else ssh exited <code>", () => {
    expect(classifySshError({ code: 255, stderr: "a\nb\nc\n" })).toBe("b\nc");
    expect(classifySshError({ code: 255, stderr: "" })).toBe("ssh exited 255");
    expect(classifySshError({ code: 7, stderr: "  \n" })).toBe("ssh exited 7");
    expect(classifySshError({ code: null, stderr: "" })).toBe("ssh exited null");
  });
});

describe("parseSshConfig", () => {
  it("spec example: wildcards skipped, first concrete token, options", () => {
    expect(parseSshConfig("Host *\n  User x\nHost a b\n  HostName 1.2.3.4\n  Port 2222\n  IdentityFile ~/.ssh/k\n")).toEqual([
      { alias: "a", hostName: "1.2.3.4", port: 2222, identityFile: "~/.ssh/k" },
    ]);
  });
  it("skips *, ?, ! tokens", () => {
    expect(parseSshConfig("Host *.corp !x real\n User u")).toEqual([{ alias: "real", user: "u" }]);
    expect(parseSshConfig("Host a?c\n User u\nHost ok")).toEqual([{ alias: "ok" }]);
  });
  it("case-insensitive keywords; tab is whitespace; comments/blank lines skipped", () => {
    expect(parseSshConfig("# c\n\nHOST A\n\tHOSTNAME h")).toEqual([{ alias: "A", hostName: "h" }]);
  });
  it("bad port => undefined", () => {
    const r = parseSshConfig("Host a\n Port abc");
    expect(r).toEqual([{ alias: "a", port: undefined }]);
    expect(r[0]).toHaveProperty("port", undefined);
  });
  it("key=value form unsupported", () => {
    expect(parseSshConfig("Host a\n HostName=h")).toEqual([{ alias: "a" }]);
  });
  it("Include ignored", () => {
    expect(parseSshConfig("Include ~/.ssh/conf.d/*\nHost a")).toEqual([{ alias: "a" }]);
  });
  it("Match is not a boundary", () => {
    expect(parseSshConfig("Host a\nMatch host b\n User z")).toEqual([{ alias: "a", user: "z" }]);
  });
  it("later repeat overwrites; duplicates kept; quotes and inline comments kept", () => {
    expect(parseSshConfig('Host a\n User x\n User y\nHost a\n IdentityFile "~/my key" # c')).toEqual([
      { alias: "a", user: "y" },
      { alias: "a", identityFile: '"~/my key" # c' },
    ]);
  });
  it("Host with only wildcards resets the current entry", () => {
    expect(parseSshConfig("Host a\nHost *\n User x")).toEqual([{ alias: "a" }]);
  });
  it("CRLF lines are trimmed", () => {
    expect(parseSshConfig("Host a\r\n HostName h\r\n")).toEqual([{ alias: "a", hostName: "h" }]);
  });
  it("Host with no value", () => {
    expect(parseSshConfig("Host\n User x")).toEqual([]);
  });
});

describe("validateAddHost / renderHostBlock", () => {
  it("renders the exact block", () => {
    const v = validateAddHost({ alias: "silico-x", hostName: "login.c", user: "me", port: 22, identityFile: "~/.ssh/id" });
    expect(renderHostBlock(v)).toBe("\nHost silico-x\n    HostName login.c\n    User me\n    Port 22\n    IdentityFile ~/.ssh/id\n");
  });
  it("omits empty optional lines and trims", () => {
    const v = validateAddHost({ alias: "  a ", hostName: " h ", user: "", identityFile: "  " });
    expect(renderHostBlock(v)).toBe("\nHost a\n    HostName h\n");
  });
  it("alias errors", () => {
    expect(() => validateAddHost({ alias: "a b", hostName: "h" })).toThrow("The alias must not contain spaces or control characters.");
    expect(() => validateAddHost({ alias: "a\u0007", hostName: "h" })).toThrow(
      "The alias must not contain spaces or control characters.",
    );
    expect(() => validateAddHost({ alias: "  ", hostName: "h" })).toThrow("An alias is required.");
  });
  it("hostname errors", () => {
    expect(() => validateAddHost({ alias: "a" })).toThrow("A hostname / IP is required.");
    expect(() => validateAddHost({ alias: "a", hostName: "h\nProxyCommand x" })).toThrow(
      "The hostname / IP must not contain spaces or control characters.",
    );
  });
  it("user errors; empty user allowed", () => {
    expect(() => validateAddHost({ alias: "a", hostName: "h", user: "a b" })).toThrow(
      "The user must not contain spaces or control characters.",
    );
    expect(validateAddHost({ alias: "a", hostName: "h" }).user).toBe("");
  });
  it("identity file: control chars rejected", () => {
    expect(() => validateAddHost({ alias: "a", hostName: "h", identityFile: "/k\n" + "x" })).toThrow(
      "The identity file path must not contain control characters.",
    );
  });
  it("D5.3: identity file with spaces is double-quoted; double quote rejected", () => {
    const v = validateAddHost({ alias: "a", hostName: "h", identityFile: "/Users/me/My Keys/id" });
    expect(renderHostBlock(v)).toBe('\nHost a\n    HostName h\n    IdentityFile "/Users/me/My Keys/id"\n');
    expect(formatIdentityFile("/k")).toBe("/k");
    expect(() => validateAddHost({ alias: "a", hostName: "h", identityFile: '/k"x' })).toThrow(
      "The identity file path must not contain double quotes.",
    );
  });
  it("port validation", () => {
    const msg = "The port must be a whole number between 1 and 65535.";
    expect(() => validateAddHost({ alias: "a", hostName: "h", port: "70000" })).toThrow(msg);
    expect(() => validateAddHost({ alias: "a", hostName: "h", port: 0 })).toThrow(msg);
    expect(() => validateAddHost({ alias: "a", hostName: "h", port: 22.5 })).toThrow(msg);
    expect(() => validateAddHost({ alias: "a", hostName: "h", port: "" })).toThrow(msg);
    expect(validateAddHost({ alias: "a", hostName: "h", port: "22" }).port).toBe(22);
    expect(validateAddHost({ alias: "a", hostName: "h", port: 65535 }).port).toBe(65535);
  });
  it("validation order: alias before hostname before port", () => {
    expect(() => validateAddHost({ alias: "", port: "x" })).toThrow("An alias is required.");
    expect(() => validateAddHost({ alias: "a", port: "x" })).toThrow("A hostname / IP is required.");
  });
  it("non-string alias from IPC is treated as empty", () => {
    expect(() => validateAddHost({} as never)).toThrow("An alias is required.");
  });
});

describe("parseSshG", () => {
  const d = { host: "a", port: 22, proxyJump: false };
  it("hostname, port, proxyjump none", () => {
    expect(parseSshG("hostname 10.0.0.5\nport 2200\nproxyjump none\n", d)).toEqual({ host: "10.0.0.5", port: 2200, proxyJump: false });
  });
  it("proxyjump set", () => expect(parseSshG("proxyjump bastion\n", d).proxyJump).toBe(true));
  it("NONE is case-insensitive; bad port keeps default", () => {
    expect(parseSshG("proxyjump NONE\nport x\n", d)).toEqual(d);
  });
  it("does not mutate defaults", () => {
    const def = { ...d };
    parseSshG("hostname z", def);
    expect(def).toEqual(d);
  });
});

describe("fingerprints", () => {
  it("picks ED25519 > ECDSA > RSA", () => {
    expect(pickFingerprint("3072 SHA256:AAA= h (RSA)\n256 SHA256:BBB h (ED25519)\n256 SHA256:CCC h (ECDSA)")).toEqual({
      fingerprint: "SHA256:BBB",
      keyType: "ED25519",
    });
  });
  it("unknown types rank last; type upper-cased", () => {
    expect(pickFingerprint("1 SHA256:X h (dsa)\n2 SHA256:Y h (rsa)")).toEqual({ fingerprint: "SHA256:Y", keyType: "RSA" });
    expect(pickFingerprint("1 SHA256:X h (dsa)")).toEqual({ fingerprint: "SHA256:X", keyType: "DSA" });
  });
  it("no matches => undefined", () => expect(pickFingerprint("garbage\n")).toBeUndefined());
  it("parses hashed-host lines", () => {
    expect(parseFingerprintLine("256 SHA256:abc+/9 |1|salt|hash (ED25519)  ")).toEqual({
      fingerprint: "SHA256:abc+/9",
      keyType: "ED25519",
    });
  });
  it("faithful quirk: trailing \\b drops a final non-word run (consistent for scan and accept)", () => {
    expect(parseFingerprintLine("256 SHA256:abc+/= h (ED25519)")).toEqual({
      fingerprint: "SHA256:abc",
      keyType: "ED25519",
    });
  });
  it("displayHost", () => {
    expect(displayHost("h", 22)).toBe("h");
    expect(displayHost("h", 2222)).toBe("h:2222");
  });
});

describe("env import helpers", () => {
  it("parseEnvBlock", () => {
    expect(parseEnvBlock("junk__M__A=1\nB=x=y\n1BAD=2\nnoeq\n=v\n__M__tail", "__M__")).toEqual({ A: "1", B: "x=y" });
    expect(parseEnvBlock("__M__A=1\n", "__M__")).toEqual({});
    expect(parseEnvBlock("A=1", "__M__")).toEqual({});
  });
  it("parseEnvBlock uses the first and last marker", () => {
    expect(parseEnvBlock("__M__A=1\n__M__\nB=2\n__M__", "__M__")).toEqual({ A: "1", B: "2" });
  });
  it("parseEnvBlock does not pollute prototypes", () => {
    const r = parseEnvBlock("__M__\n__proto__=x\nA=1\n__M__", "__M__");
    expect(r.A).toBe("1");
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
  it("pickShell order", () => {
    expect(pickShell("/bin/zsh", () => "/bin/fish")).toBe("/bin/zsh");
    expect(pickShell(undefined, () => "/bin/fish")).toBe("/bin/fish");
    expect(pickShell("", () => null)).toBe("/bin/bash");
    expect(
      pickShell(undefined, () => {
        throw new Error("x");
      }),
    ).toBe("/bin/bash");
  });
  it("shellArgv: csh/tcsh use -c, others -ilc", () => {
    const s = shellEnvScript();
    expect(s).toBe("printf %s __SILICO_SHELL_ENV__; env; printf %s __SILICO_SHELL_ENV__");
    expect(shellArgv("/bin/tcsh", s)).toEqual(["-c", s]);
    expect(shellArgv("csh", s)).toEqual(["-c", s]);
    expect(shellArgv("/usr/bin/zsh", s)).toEqual(["-ilc", s]);
  });
  it("mergePath prepends and dedupes keeping first", () => {
    expect(mergePath("/a:/b::/c", "/b:/d::/a")).toBe("/a:/b:/c:/d");
    expect(mergePath("/a", undefined)).toBe("/a");
  });
});

describe("resolveFallback / toolMissingMessage", () => {
  it("win32 with SystemRoot tries the built-in OpenSSH path", () => {
    expect(resolveFallback({ tool: "ssh", failed: ["ssh"], platform: "win32", systemRoot: "C:\\Windows" })).toEqual({
      kind: "spawn",
      cmd: "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
    });
  });
  it("win32 after both fail => missing with Windows advice", () => {
    const r = resolveFallback({
      tool: "ssh-keygen",
      failed: ["ssh-keygen", "C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe"],
      platform: "win32",
      systemRoot: "C:\\Windows",
    });
    expect(r).toEqual({ kind: "missing", message: toolMissingMessage("ssh-keygen", "win32") });
    expect(toolMissingMessage("ssh-keygen", "win32")).toBe(
      "The OpenSSH client isn't installed on this machine (couldn't find `ssh-keygen`). Silico uses it to connect to clusters. To install it, open Windows Settings → System → Optional features and add \"OpenSSH Client\", then try again.",
    );
  });
  it("darwin => missing with package-manager advice", () => {
    expect(resolveFallback({ tool: "ssh", failed: ["ssh"], platform: "darwin" })).toEqual({
      kind: "missing",
      message:
        "The OpenSSH client isn't installed on this machine (couldn't find `ssh`). Silico uses it to connect to clusters. Install OpenSSH with your system's package manager, then try again.",
    });
  });
  it("first attempt is the bare tool", () => {
    expect(resolveFallback({ tool: "ssh", failed: [], platform: "linux" })).toEqual({ kind: "spawn", cmd: "ssh" });
  });
});

describe("lab:test interpretation", () => {
  const t = { host: "login" };
  it("commands", () => {
    expect(labTestCommand(false)).toBe(
      'PATH="$PATH:$HOME/.local/bin" command -v silico >/dev/null 2>&1 || command -v silico-setup >/dev/null 2>&1',
    );
    expect(labTestCommand(true)).toBe('PATH="$PATH:$HOME/.local/bin" command -v silico-dev >/dev/null 2>&1');
  });
  it("exit 0", () => {
    expect(interpretLabTest(t, false, { code: 0, stdout: "", stderr: "" })).toEqual({
      ok: true,
      detail: "SSH OK: silico present on the cluster.",
    });
    expect(interpretLabTest(t, true, { code: 0, stdout: "", stderr: "" })).toEqual({
      ok: true,
      detail: "SSH OK: silico-dev present on the cluster.",
    });
  });
  it("exit 255 host key changed / unknown / other", () => {
    expect(interpretLabTest(t, false, { code: 255, stdout: "", stderr: "REMOTE HOST IDENTIFICATION HAS CHANGED" })).toEqual({
      ok: false,
      hostKey: "changed",
      detail: "The host key for login has CHANGED since it was last trusted. Possible security issue; investigate before connecting.",
    });
    expect(interpretLabTest(t, false, { code: 255, stdout: "", stderr: "Host key verification failed." })).toEqual({
      ok: false,
      hostKey: "unknown",
      detail: "First time connecting to login. Trust its host key to continue.",
    });
    expect(interpretLabTest(t, false, { code: 255, stdout: "", stderr: "Permission denied (publickey)." })).toEqual({
      ok: false,
      detail: MSG_PERMISSION_DENIED,
    });
    expect(interpretLabTest(t, false, { code: 255, stdout: "", stderr: "no matching host key type found" })).toEqual({
      ok: false,
      detail: "host-key",
    });
  });
  it("other codes (incl. null)", () => {
    expect(interpretLabTest(t, false, { code: 1, stdout: "", stderr: "" })).toEqual({ ok: false, detail: MSG_CLI_MISSING });
    expect(interpretLabTest(t, true, { code: null, stdout: "", stderr: "" })).toEqual({ ok: false, detail: MSG_DEV_CLI_MISSING });
    expect(MSG_CLI_MISSING).toBe("Connected, but the silico CLI was not found on the cluster.");
    expect(MSG_DEV_CLI_MISSING).toBe(
      "The dev CLI (silico-dev) isn't installed on this cluster. On its login node, update the Silico CLI, then run `silico-dev setup`.",
    );
  });
});
