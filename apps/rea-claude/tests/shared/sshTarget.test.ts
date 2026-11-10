import { describe, expect, it } from "vitest";
import { SSH_INVALID_HOST, SSH_INVALID_JUMP, SSH_INVALID_USER, isSafeSshToken, sshTargetError } from "@shared/sshTarget";

describe("sshTargetError (D5.6)", () => {
  it("accepts ordinary targets and leaves empty host to callers", () => {
    expect(sshTargetError({ host: "hpc.example.org", user: "me", jump: "bastion,me@jump2:2222" })).toBeNull();
    expect(sshTargetError({ host: "alias" })).toBeNull();
    expect(sshTargetError({ host: "" })).toBeNull();
    expect(sshTargetError(null)).toBeNull();
  });
  it("rejects option-looking or whitespace/control-char hosts", () => {
    for (const host of ["-oProxyCommand=touch /tmp/pwned", "-G", "a b", "a\tb", "a\nb", "a\u0000", "a\u007f"]) {
      expect(sshTargetError({ host })).toBe(SSH_INVALID_HOST);
    }
    expect(sshTargetError({ host: 42 as unknown as string })).toBe(SSH_INVALID_HOST);
  });
  it("rejects bad users and jump hosts", () => {
    expect(sshTargetError({ host: "h", user: "-oProxyCommand=x" })).toBe(SSH_INVALID_USER);
    expect(sshTargetError({ host: "h", user: "a b" })).toBe(SSH_INVALID_USER);
    for (const jump of ["-oProxyCommand=x", "ok,-oProxyCommand=x", "me@-oProxyCommand=x", "a b"]) {
      expect(sshTargetError({ host: "h", jump })).toBe(SSH_INVALID_JUMP);
    }
  });
  it("isSafeSshToken", () => {
    expect(isSafeSshToken("h")).toBe(true);
    expect(isSafeSshToken("-h")).toBe(false);
    expect(isSafeSshToken("")).toBe(false);
  });
});
