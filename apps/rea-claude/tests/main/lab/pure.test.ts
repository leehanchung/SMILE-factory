import { describe, expect, it } from "vitest";
import {
  backoffMs,
  callbackUrl,
  claimTokenCmd,
  clampReachBudget,
  cliName,
  depIdFor,
  downCmd,
  exitedMessage,
  gatewayFallbackUrl,
  installCmd,
  isLoopbackUrl,
  labTitle,
  manualTunnelCmd,
  mapDiscoveredLab,
  needsExactUpdate,
  networkErrorKey,
  normalizeConnection,
  parseDockerPs,
  parseTunnelTarget,
  probeStatusToReach,
  readTunnelTargetCmd,
  routeModeOf,
  shq,
  stateDir,
  STAGING_CLI_PROBE_CMD,
  stripDev,
  tunnelArgs,
  updateCmd,
  updateFlags,
  updateLabel,
  upCmd,
  withLocalBin,
} from "../../../src/main/lab/pure";

const A40 = "a".repeat(40);
const B40 = "b".repeat(40);
const T40 = "0123456789abcdef0123456789abcdef01234567";

describe("shell quoting and commands", () => {
  it("shq", () => {
    expect(shq("it's")).toBe(`'it'\\''s'`);
    expect(shq("a b")).toBe("'a b'");
    expect(shq("")).toBe("''");
    expect(shq("$(rm -rf /)")).toBe("'$(rm -rf /)'");
  });
  it("withLocalBin", () => {
    expect(withLocalBin("silico up")).toBe('PATH="$PATH:$HOME/.local/bin" silico up');
    expect(STAGING_CLI_PROBE_CMD).toBe('PATH="$PATH:$HOME/.local/bin" command -v silico-dev >/dev/null 2>&1');
  });
  it("cli and state dir", () => {
    expect(cliName(false)).toBe("silico");
    expect(cliName(true)).toBe("silico-dev");
    expect(stateDir(false)).toBe("state");
    expect(stateDir(true)).toBe("state/_dev");
  });
  it("depIdFor / stripDev", () => {
    expect(depIdFor("acme", true)).toBe("acme-dev");
    expect(depIdFor("acme-dev", true)).toBe("acme-dev");
    expect(depIdFor("acme", false)).toBe("acme");
    expect(depIdFor("", true)).toBe("");
    expect(stripDev("acme-dev")).toBe("acme");
    expect(stripDev("acme")).toBe("acme");
  });
  it("installCmd quotes every value and has no PATH prefix", () => {
    expect(installCmd("https://my.silico.run", "ac'me", "b$r")).toBe(
      "curl -fsSL 'https://my.silico.run/install' | SILICO_LAB_AUTH_URL='https://my.silico.run' " +
        "SILICO_CLUSTER_ID='ac'\\''me' SILICO_SETUP_BEARER='b$r' bash -s -- --tenant 'ac'\\''me'",
    );
  });
  it("up / update / down", () => {
    expect(upCmd(false, false)).toBe("silico up");
    expect(upCmd(true, true)).toBe("silico-dev up --verbose");
    expect(updateLabel(false, true)).toBe("silico update --preview");
    expect(updateLabel(true, false)).toBe("silico-dev update");
    expect(updateCmd("acme-dev", "BEAR", "silico-dev update")).toBe(
      `PATH="$PATH:$HOME/.local/bin" SILICO_CLUSTER_ID='acme-dev' SILICO_SETUP_BEARER='BEAR' silico-dev update`,
    );
    expect(downCmd(false)).toBe('PATH="$PATH:$HOME/.local/bin" silico down --yes');
    expect(downCmd(true)).toBe('PATH="$PATH:$HOME/.local/bin" silico-dev down --yes');
  });
  it("state-file reads", () => {
    expect(readTunnelTargetCmd(false)).toBe(
      'echo "$(cat "$HOME/.silico/state/lab-host.txt" 2>/dev/null)|$(cat "$HOME/.silico/state/lab-port.txt" 2>/dev/null)"',
    );
    expect(readTunnelTargetCmd(true)).toContain("state/_dev/lab-port.txt");
    expect(claimTokenCmd(true)).toBe('cat "$HOME/.silico/state/_dev/claim.token" 2>/dev/null');
  });
  it("manual tunnel command and tunnel args", () => {
    expect(manualTunnelCmd({ host: "h", identityFile: "/k", port: 2222, jump: "j" }, "u@h", 5000, "10.0.0.5", 8123)).toBe(
      "ssh -N -i /k -p 2222 -J j -L 5000:10.0.0.5:8123 u@h",
    );
    expect(manualTunnelCmd({ host: "h" }, "h", 1, "x", 2)).toBe("ssh -N -L 1:x:2 h");
    expect(tunnelArgs(["-o", "BatchMode=yes"], "h", 5000, "n1", 80)).toEqual([
      "-o",
      "BatchMode=yes",
      "-N",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-o",
      "ExitOnForwardFailure=yes",
      "-L",
      "5000:n1:80",
      "--",
      "h",
    ]);
  });
});

describe("parsers", () => {
  it("parseTunnelTarget", () => {
    expect(parseTunnelTarget("10.0.0.5|8123\n")).toEqual({ host: "10.0.0.5", port: 8123 });
    expect(parseTunnelTarget("|")).toBeNull();
    expect(parseTunnelTarget("h|0")).toBeNull();
    expect(parseTunnelTarget("h|abc")).toBeNull();
    expect(parseTunnelTarget("h|1.5")).toBeNull();
    expect(parseTunnelTarget("")).toBeNull();
  });
  it("parseDockerPs", () => {
    expect(parseDockerPs("silico-local-foo-web-1\t0.0.0.0:5174->5173/tcp, :::5174->5173/tcp\twt\tfeat/x\n")).toEqual([
      { project: "silico-local-foo", port: 5174, worktree: "wt", branch: "feat/x" },
    ]);
    expect(parseDockerPs("x\t0.0.0.0:8080->80/tcp\t\t")).toEqual([]);
    expect(parseDockerPs("x\t[::1]:3000->5173/tcp\t \t")).toEqual([{ project: "x", port: 3000, worktree: undefined, branch: undefined }]);
    expect(parseDockerPs("x\t\twt\tb")).toEqual([]);
    expect(parseDockerPs("x\t127.0.0.1:70000->5173/tcp")).toEqual([]);
    expect(parseDockerPs("a\t127.0.0.1:1->5173/tcp, 127.0.0.1:2->5173/tcp")[0]?.port).toBe(1);
  });
});

describe("discovery mapping", () => {
  it("routeModeOf", () => {
    expect(routeModeOf("managed")).toBe("managed");
    expect(routeModeOf("local")).toBe("local");
    expect(routeModeOf("slurm")).toBe("cluster");
    expect(routeModeOf(undefined)).toBe("cluster");
  });
  it("mapDiscoveredLab", () => {
    expect(
      mapDiscoveredLab({
        kind: "cluster",
        deployment_id: "acme-dev",
        lab_public_host: "acme.silico.run",
        host: "n1",
        port: 8000,
        stale: false,
        current_sha: A40,
        target_sha: B40,
        update_available: "yes",
        update_required: true,
        reports_version: false,
      }),
    ).toEqual({
      deploymentId: "acme",
      labPublicHost: "acme.silico.run",
      routeMode: "cluster",
      host: "n1",
      port: 8000,
      stale: false,
      currentSha: A40,
      targetSha: B40,
      minSha: undefined,
      updateAvailable: false,
      updateRequired: true,
      reportsVersion: false,
    });
    const m = mapDiscoveredLab({ kind: "managed", deployment_id: "x-dev" });
    expect(m.deploymentId).toBe("x-dev");
    expect(m.stale).toBe(true);
    expect(m.labPublicHost).toBe("");
    expect(mapDiscoveredLab(null).deploymentId).toBe("");
    expect(mapDiscoveredLab({ stale: null }).stale).toBe(true);
  });
  it("updateFlags", () => {
    expect(updateFlags(undefined)).toEqual({ required: false, soft: false, any: false });
    expect(updateFlags({ stale: false, updateRequired: true })).toEqual({ required: true, soft: false, any: true });
    expect(updateFlags({ stale: false, reportsVersion: false })).toEqual({ required: false, soft: true, any: true });
    expect(updateFlags({ stale: false, updateAvailable: true })).toEqual({ required: false, soft: true, any: true });
    expect(updateFlags({ stale: true, currentSha: A40, targetSha: B40 }, { pinnedExactCheck: true })).toEqual({
      required: false,
      soft: true,
      any: true,
    });
    expect(updateFlags({ stale: true, currentSha: A40, targetSha: B40 }, { pinnedExactCheck: false }).any).toBe(false);
    expect(updateFlags({ stale: true, updateRequired: true }).any).toBe(false);
    expect(updateFlags({ stale: false, currentSha: A40, targetSha: A40.toUpperCase() }, { pinnedExactCheck: true }).any).toBe(false);
  });
  it("needsExactUpdate", () => {
    expect(needsExactUpdate({ targetSha: "abc" })).toBe(false);
    expect(needsExactUpdate({ targetSha: T40 })).toBe(true);
    expect(needsExactUpdate({ currentSha: T40.toUpperCase(), targetSha: T40 })).toBe(false);
    expect(needsExactUpdate({ currentSha: A40, targetSha: T40 })).toBe(true);
    expect(needsExactUpdate(undefined)).toBe(false);
  });
});

describe("misc", () => {
  it("clampReachBudget", () => {
    expect(clampReachBudget(undefined)).toBe(3000);
    expect(clampReachBudget(10)).toBe(1000);
    expect(clampReachBudget(1e9)).toBe(120000);
    expect(clampReachBudget(NaN)).toBe(3000);
    expect(clampReachBudget("5000")).toBe(3000);
    expect(clampReachBudget(5000)).toBe(5000);
  });
  it("backoffMs", () => {
    expect([0, 1, 2, 3, 4, 5].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });
  it("probeStatusToReach", () => {
    expect(probeStatusToReach(425)).toBe("warming");
    expect(probeStatusToReach(503)).toBe("warming");
    expect(probeStatusToReach(500)).toBe("warming");
    expect(probeStatusToReach(401)).toBe("ready");
    expect(probeStatusToReach(404)).toBe("ready");
    expect(probeStatusToReach(200)).toBe("ready");
  });
  it("isLoopbackUrl (D5.4 accepts [::1])", () => {
    expect(isLoopbackUrl("http://127.0.0.1:9/")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:9")).toBe(true);
    expect(isLoopbackUrl("http://localhost:3000")).toBe(true);
    expect(isLoopbackUrl("https://acme.silico.run")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
  it("callbackUrl", () => {
    expect(callbackUrl("http://localhost:5", "T", undefined)).toBe("http://localhost:5/auth/callback?return_to=%2F#token=T");
    expect(callbackUrl("https://x", "T", "/a?b=c#d")).toBe("https://x/auth/callback?return_to=%2Fa%3Fb%3Dc%23d#token=T");
    expect(callbackUrl("https://x", "T", null)).toBe("https://x/auth/callback?return_to=%2F#token=T");
  });
  it("gatewayFallbackUrl", () => {
    expect(gatewayFallbackUrl("https://my.silico.run/", "acme", false)).toBe("https://my.silico.run/?return_to=%2F&deployment=acme");
    expect(gatewayFallbackUrl("https://my-staging.silico.run", "acme", true)).toBe(
      "https://my-staging.silico.run/?return_to=%2F&deployment=acme-dev",
    );
    expect(gatewayFallbackUrl("https://my.silico.run", undefined, false)).toBe("https://my.silico.run/?return_to=%2F");
  });
  it("exitedMessage", () => {
    expect(exitedMessage("`silico up`", 3, "  err\n")).toBe("`silico up` exited 3.\nerr");
    expect(exitedMessage("x", null, "")).toBe("x exited (stopped).\n");
    const long = "e".repeat(700) + "TAIL";
    expect(exitedMessage("x", 1, long).split("\n")[1]).toHaveLength(600);
    expect(exitedMessage("x", 1, long).endsWith("TAIL")).toBe(true);
  });
  it("labTitle", () => {
    expect(labTitle({ name: "N", deploymentId: "d" })).toBe("N");
    expect(labTitle({ name: "", deploymentId: "d" })).toBe("d");
    expect(labTitle({ name: "", deploymentId: "" })).toBe("Lab");
  });
  it("networkErrorKey", () => {
    expect(networkErrorKey({ cause: { code: "ECONNREFUSED" }, code: "X" })).toBe("ECONNREFUSED");
    expect(networkErrorKey({ code: "ENOTFOUND" })).toBe("ENOTFOUND");
    expect(networkErrorKey(new Error("boom"))).toBe("boom");
    expect(networkErrorKey(null)).toBe("unknown network error");
  });
  it("normalizeConnection", () => {
    expect(() => normalizeConnection(null)).toThrow("Invalid connection.");
    expect(() => normalizeConnection("x")).toThrow();
    expect(normalizeConnection({ id: "a", routeMode: "weird", ssh: { host: "h", port: 22, user: 5 } })).toEqual({
      id: "a",
      name: "",
      icon: "",
      deploymentId: "",
      labUrl: "",
      ssh: { host: "h", port: 22 },
    });
    expect(normalizeConnection({ id: "a", routeMode: "managed" }).routeMode).toBe("managed");
  });
});
