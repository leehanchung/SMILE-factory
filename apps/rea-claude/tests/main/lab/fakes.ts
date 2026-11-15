/**
 * Shared fakes for the lab tests: windows, clock, ssh, auth, gateway.
 * No real processes, sockets or network.
 */
import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type { BrowserWindow } from "electron";
import { DEFAULT_SETTINGS, GATEWAY_PROD } from "@shared/config";
import type { AuthState, Connection, GatewayUrl, Settings, SshTarget } from "@shared/ipc";
import type { GatewayRequest, GatewayResponse, MainContext, RemoteResult, RunRemoteOptions } from "../../../src/main/services";
import { makeTestContext } from "../helpers/context";
import type { RuntimeDeps } from "../../../src/main/lab/runtime";
import type { FetchLike } from "../../../src/main/lab/probes";

export interface FakeWin {
  id: number;
  destroyed: boolean;
  isDestroyed(): boolean;
  webContents: { send: ReturnType<typeof vi.fn>; isDestroyed(): boolean };
}

export function fakeWin(id = 1): FakeWin & BrowserWindow {
  const w: FakeWin = {
    id,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    webContents: { send: vi.fn(), isDestroyed: () => false },
  };
  return w as FakeWin & BrowserWindow;
}

/** Virtual clock: sleep advances time instantly. */
export function fakeClock(start = 1_000_000) {
  const c = {
    t: start,
    now: () => c.t,
    sleep: vi.fn(async (ms: number) => {
      c.t += ms;
    }),
  };
  return c;
}

export class FakeChild extends EventEmitter {
  killed: string[] = [];
  kill(sig?: string): boolean {
    this.killed.push(sig ?? "SIGTERM");
    return true;
  }
}

export type RemoteScript = (cmd: string, opts?: RunRemoteOptions) => Partial<RemoteResult> | Promise<Partial<RemoteResult>>;

export function ok(stdout = ""): Partial<RemoteResult> {
  return { code: 0, stdout, stderr: "" };
}

export function fakeSsh(script: RemoteScript) {
  const runRemote = vi.fn(async (_t: SshTarget, cmd: string, opts?: RunRemoteOptions): Promise<RemoteResult> => {
    const r = await script(cmd, opts);
    return { code: r.code === undefined ? 0 : r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(r.toolMissing ? { toolMissing: true as const } : {}) };
  });
  return {
    runRemote,
    spawnTool: vi.fn(async () => ({ ok: true as const, child: new FakeChild() as never })),
    sshArgs: (t: SshTarget) => {
      const a = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
      if (t.port) a.push("-p", String(t.port));
      return a;
    },
    sshDest: (t: SshTarget) => (t.user ? `${t.user}@${t.host}` : t.host),
    classifyHostKey: (s: string) =>
      /remote host identification has changed/i.test(s) ? ("changed" as const) : /host key verification failed/i.test(s) ? ("unknown" as const) : null,
    classifySshError: (r: RemoteResult) => (/permission denied/i.test(r.stderr) ? "SSH was refused" : `ssh exited ${r.code}`),
  };
}

export type GatewayScript = (req: GatewayRequest) => GatewayResponse | Promise<GatewayResponse>;

export function http(status: number, body: unknown = null, gatewayUrl: GatewayUrl = GATEWAY_PROD): GatewayResponse {
  return { kind: "http", status, body, gatewayUrl };
}

export function fakeAuth(opts: { gateway?: GatewayUrl; script?: GatewayScript; signedIn?: boolean; login?: string } = {}) {
  const state = {
    signedIn: opts.signedIn ?? true,
    gateway: opts.gateway ?? GATEWAY_PROD,
    login: opts.login ?? "octo",
    /** Published identity (auth §3.1): survives a session drop; `undefined` = derive from gateway. */
    identity: undefined as { sub: string; gatewayUrl: GatewayUrl } | null | undefined,
  };
  const auth = {
    state,
    activeGateway: vi.fn(async () => state.gateway),
    gatewayRequest: vi.fn(async (req: GatewayRequest) => (opts.script ? opts.script(req) : http(500))),
    noteLabToken: vi.fn(),
    status: vi.fn(
      async (): Promise<AuthState> =>
        state.signedIn
          ? { status: "signed-in", login: state.login, sub: "sub-1", gatewayUrl: state.gateway, expiresAt: 0, developer: false }
          : { status: "signed-out" },
    ),
    // Like AuthCore: the session's identity is gone once the session is dropped…
    cachedIdentity: vi.fn(() => (state.signedIn ? { login: state.login, sub: "sub-1", gatewayUrl: state.gateway } : null)),
    // …but the published identity survives until sign-out.
    lastIdentity: vi.fn(() => (state.identity === undefined ? { sub: "sub-1", gatewayUrl: state.gateway } : state.identity)),
    recordSessionDeath: vi.fn(),
    onIdentityChanged: vi.fn(() => () => {}),
    onSignedIn: vi.fn(() => () => {}),
  };
  return auth;
}

export function fakeWindows() {
  return {
    openLabInWindow: vi.fn(),
    hideLabView: vi.fn(),
    setReauthing: vi.fn(),
    waitForShellRenderer: vi.fn(async () => ({ reloaded: false })),
    resendLabOpened: vi.fn(),
    currentLabReturnTo: vi.fn((): string | null => null),
  };
}

/** A FetchLike that answers by URL path. */
export function routeFetch(handler: (url: URL) => number | Error | Promise<number | Error>): FetchLike & ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    const r = await handler(new URL(url));
    if (r instanceof Error) throw r;
    return { status: r, ok: r >= 200 && r < 300 };
  }) as never;
}

export interface Harness {
  ctx: MainContext;
  deps: RuntimeDeps;
  clock: ReturnType<typeof fakeClock>;
  auth: ReturnType<typeof fakeAuth>;
  ssh: ReturnType<typeof fakeSsh>;
  windows: ReturnType<typeof fakeWindows>;
  settings: Settings;
  telemetry: { recordShellEvent: ReturnType<typeof vi.fn>; markRecent: ReturnType<typeof vi.fn> };
  bridge: { clearBadgeCounts: ReturnType<typeof vi.fn> };
  connections: Connection[];
  winsById: Map<number, BrowserWindow>;
}

export function harness(
  opts: {
    gateway?: GatewayUrl;
    gatewayScript?: GatewayScript;
    remote?: RemoteScript;
    netFetch?: FetchLike;
    fetch?: FetchLike;
    settings?: Partial<Settings>;
    tcpProbe?: (port: number) => Promise<boolean>;
    allocatePort?: () => Promise<number>;
  } = {},
): Harness {
  const clock = fakeClock();
  const auth = fakeAuth({ gateway: opts.gateway, script: opts.gatewayScript });
  const ssh = fakeSsh(opts.remote ?? (() => ok()));
  const windows = fakeWindows();
  const settings: Settings = { ...DEFAULT_SETTINGS, ...opts.settings };
  const telemetry = { recordShellEvent: vi.fn(), markRecent: vi.fn() };
  const bridge = { clearBadgeCounts: vi.fn() };
  const connections: Connection[] = [];
  const winsById = new Map<number, BrowserWindow>();
  const ctx = makeTestContext({
    auth,
    ssh,
    windows,
    telemetry,
    bridge,
    settings: { get: async () => settings },
    connections: { list: async () => connections },
  });
  const deps: RuntimeDeps = {
    now: clock.now,
    sleep: clock.sleep,
    fetch: opts.fetch ?? routeFetch(() => 200),
    netFetch: opts.netFetch ?? routeFetch(() => 200),
    openExternal: vi.fn(async () => {}),
    windowFromId: (id) => winsById.get(id) ?? null,
    setTimer: () => ({ clear() {} }),
    allocatePort: opts.allocatePort ?? (async () => 45678),
    tcpProbe: opts.tcpProbe ?? (async () => true),
    execFile: async () => ({ stdout: "" }),
  };
  return { ctx, deps, clock, auth, ssh, windows, settings, telemetry, bridge, connections, winsById };
}

export function clusterConn(over: Partial<Connection> = {}): Connection {
  return { id: "c1", name: "My Lab", icon: "flask", deploymentId: "acme", labUrl: "https://acme.silico.run", ssh: { host: "hpc" }, ...over };
}

/** A gateway that serves /labs/session with a Lab at `labUrl`. */
export function sessionGateway(labUrl = "https://acme.silico.run", extra?: (req: GatewayRequest) => GatewayResponse | undefined): GatewayScript {
  return async (req) => {
    const r = extra ? await extra(req) : undefined;
    if (r) return r;
    if (req.path === "/labs/session") return http(200, { token: "TOK", lab_url: labUrl });
    if (req.path === "/labs") return http(200, { labs: [] });
    if (req.path === "/labs/setup-bearer") return http(200, { setup_bearer: "BEAR" });
    return http(404);
  };
}
