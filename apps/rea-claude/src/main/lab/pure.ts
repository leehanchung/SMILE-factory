/**
 * Pure helpers for the Lab lifecycle (no Electron, no I/O). [lab §4, §5, §8]
 */
import {
  CLI_PROD,
  CLI_STAGING,
  DEPLOYMENT_DEV_SUFFIX,
  REACH_BUDGET_DEFAULT_MS,
  REACH_BUDGET_MAX_MS,
  REACH_BUDGET_MIN_MS,
  REMOTE_PATH_PREFIX,
  REMOTE_STATE_DIR_PROD,
  REMOTE_STATE_DIR_STAGING,
  STDERR_TAIL_CHARS,
  TUNNEL_BACKOFF_BASE_MS,
  TUNNEL_BACKOFF_MAX_MS,
} from "@shared/config";
import type { Connection, DiscoveredLab, LocalStack, RouteMode, SshTarget } from "@shared/ipc";

// ---------------------------------------------------------------------------
// Shell quoting and remote command builders [lab §4.2, §5.1, §6]
// ---------------------------------------------------------------------------

/** POSIX single-quote a value (`'` → `'\''`). */
export function shq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Prefix a remote command with `PATH="$PATH:$HOME/.local/bin"`. */
export function withLocalBin(cmd: string): string {
  return `${REMOTE_PATH_PREFIX} ${cmd}`;
}

export function cliName(staging: boolean): string {
  return staging ? CLI_STAGING : CLI_PROD;
}

export function stateDir(staging: boolean): string {
  return staging ? REMOTE_STATE_DIR_STAGING : REMOTE_STATE_DIR_PROD;
}

/** Append `-dev` on staging unless already present; empty stays empty. */
export function depIdFor(id: string, staging: boolean): string {
  if (!staging || !id || id.endsWith(DEPLOYMENT_DEV_SUFFIX)) return id;
  return id + DEPLOYMENT_DEV_SUFFIX;
}

/** Strip one trailing `-dev`. */
export function stripDev(id: string): string {
  return id.endsWith(DEPLOYMENT_DEV_SUFFIX) ? id.slice(0, -DEPLOYMENT_DEV_SUFFIX.length) : id;
}

export function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

export const DEPLOYMENT_PROBE_CMD = 'test -f "$HOME/.silico/deployment.toml"';
export const STAGING_CLI_PROBE_CMD = withLocalBin("command -v silico-dev >/dev/null 2>&1");
export const STAGING_REPO_PROBE_CMD = 'test -d "$HOME/silico-repo-dev"';

/** First-time installer (no PATH prefix). `gateway` must already have trailing slashes stripped. */
export function installCmd(gateway: string, deploymentId: string, bearer: string): string {
  return (
    `curl -fsSL ${shq(`${gateway}/install`)} | SILICO_LAB_AUTH_URL=${shq(gateway)} ` +
    `SILICO_CLUSTER_ID=${shq(deploymentId)} SILICO_SETUP_BEARER=${shq(bearer)} ` +
    `bash -s -- --tenant ${shq(deploymentId)}`
  );
}

/** `silico[-dev] up [--verbose]` (without PATH prefix; this is also the user-facing label). */
export function upCmd(staging: boolean, verbose: boolean): string {
  return `${cliName(staging)} up${verbose ? " --verbose" : ""}`;
}

/** `silico[-dev] update [--preview]` (user-facing label). */
export function updateLabel(staging: boolean, preview: boolean): string {
  return `${cliName(staging)} update${preview ? " --preview" : ""}`;
}

/** Full remote update command line (PATH prefix + env + label). `clusterId` already has `-dev` applied. */
export function updateCmd(clusterId: string, bearer: string, label: string): string {
  return withLocalBin(`SILICO_CLUSTER_ID=${shq(clusterId)} SILICO_SETUP_BEARER=${shq(bearer)} ${label}`);
}

export function downCmd(staging: boolean): string {
  return withLocalBin(`${cliName(staging)} down --yes`);
}

export function readTunnelTargetCmd(staging: boolean): string {
  const d = stateDir(staging);
  return `echo "$(cat "$HOME/.silico/${d}/lab-host.txt" 2>/dev/null)|$(cat "$HOME/.silico/${d}/lab-port.txt" 2>/dev/null)"`;
}

export function claimTokenCmd(staging: boolean): string {
  return `cat "$HOME/.silico/${stateDir(staging)}/claim.token" 2>/dev/null`;
}

/** Manual tunnel hint: `ssh -N [-i id] [-p port] [-J jump] -L <p>:<host>:<port> <dest>`. */
export function manualTunnelCmd(target: SshTarget, dest: string, localPort: number, host: string, port: number): string {
  const parts = ["ssh", "-N"];
  if (target.identityFile) parts.push("-i", target.identityFile);
  if (target.port) parts.push("-p", String(target.port));
  if (target.jump) parts.push("-J", target.jump);
  parts.push("-L", `${localPort}:${host}:${port}`, dest);
  return parts.join(" ");
}

/** ssh options appended to the base args for a tunnel child. [lab §5.2 step 4] */
export function tunnelArgs(baseArgs: readonly string[], dest: string, localPort: number, host: string, port: number): string[] {
  return [
    ...baseArgs,
    "-N",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ExitOnForwardFailure=yes",
    "-L",
    `${localPort}:${host}:${port}`,
    "--", // D5.6: the destination is never parsed as an option
    dest,
  ];
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/** Parse `host|port` from the tunnel-target probe. Port must be an integer > 0 and host non-empty. */
export function parseTunnelTarget(stdout: string): { host: string; port: number } | null {
  const [host, portText] = stdout.trim().split("|");
  const port = Number(portText);
  if (!host || !Number.isInteger(port) || port <= 0) return null;
  return { host, port };
}

const DOCKER_PORT_RE = /(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d+)->5173\/tcp/;

/** Parse `docker ps` output (name TAB ports TAB worktree TAB branch). [lab §4.9] */
export function parseDockerPs(output: string): LocalStack[] {
  const stacks: LocalStack[] = [];
  for (const line of output.split("\n")) {
    const [name, ports, worktree, branch] = line.split("\t");
    if (!name || !ports) continue;
    const m = DOCKER_PORT_RE.exec(ports);
    if (!m) continue;
    const port = Number(m[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    stacks.push({
      project: name.replace(/-web-\d+$/, ""),
      port,
      worktree: worktree?.trim() || undefined,
      branch: branch?.trim() || undefined,
    });
  }
  return stacks;
}

// ---------------------------------------------------------------------------
// Discovery mapping and version flags [lab §4.6, §8]
// ---------------------------------------------------------------------------

/** "managed" / "local" stay; anything else is "cluster". */
export function routeModeOf(kind: unknown): RouteMode {
  return kind === "managed" ? "managed" : kind === "local" ? "local" : "cluster";
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** Map one gateway `labs[]` item (`wc`). Defensive against malformed items. */
export function mapDiscoveredLab(raw: unknown): DiscoveredLab {
  const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const routeMode = routeModeOf(e.kind);
  const depRaw = typeof e.deployment_id === "string" ? e.deployment_id : "";
  const port = typeof e.port === "number" && e.port ? e.port : undefined;
  const lab: DiscoveredLab = {
    deploymentId: routeMode === "managed" ? depRaw : stripDev(depRaw),
    labPublicHost: typeof e.lab_public_host === "string" ? e.lab_public_host : "",
    routeMode,
    host: str(e.host),
    port,
    stale: e.stale !== false,
    currentSha: str(e.current_sha),
    targetSha: str(e.target_sha),
    minSha: str(e.min_sha),
    updateAvailable: e.update_available === true,
    updateRequired: e.update_required === true,
  };
  if (typeof e.reports_version === "boolean") lab.reportsVersion = e.reports_version;
  return lab;
}

const SHA40_RE = /^[0-9a-f]{40}$/i;
export function isSha40(v: string | undefined): v is string {
  return SHA40_RE.test(v ?? "");
}

export interface UpdateFlags {
  required: boolean;
  soft: boolean;
  any: boolean;
}

type VersionInfo = Partial<Pick<DiscoveredLab, "stale" | "currentSha" | "targetSha" | "updateAvailable" | "updateRequired" | "reportsVersion">>;

/** `updateFlags(lab, {pinnedExactCheck})` (M:43-62 semantics). */
export function updateFlags(lab: VersionInfo | undefined | null, opts?: { pinnedExactCheck?: boolean }): UpdateFlags {
  if (!lab) return { required: false, soft: false, any: false };
  const cur = lab.currentSha;
  const tgt = lab.targetSha;
  const exactMismatch =
    opts?.pinnedExactCheck === true && isSha40(cur) && isSha40(tgt) && cur.toLowerCase() !== tgt.toLowerCase();
  if (lab.stale) return { required: false, soft: exactMismatch, any: exactMismatch };
  const required = lab.updateRequired === true;
  const soft = !required && (lab.updateAvailable === true || lab.reportsVersion === false || exactMismatch);
  return { required, soft, any: required || soft };
}

/** True iff target is a 40-hex sha and current is missing/not-40-hex/different. */
export function needsExactUpdate(lab: VersionInfo | undefined | null): boolean {
  if (!lab || !isSha40(lab.targetSha)) return false;
  return !isSha40(lab.currentSha) || lab.currentSha.toLowerCase() !== lab.targetSha.toLowerCase();
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** lab:open budget: non-number/non-finite → 3000, else clamp to [1000, 120000]. */
export function clampReachBudget(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return REACH_BUDGET_DEFAULT_MS;
  return Math.min(Math.max(v, REACH_BUDGET_MIN_MS), REACH_BUDGET_MAX_MS);
}

/** Tunnel reconnect backoff `min(1000·2^r, 8000)`. */
export function backoffMs(retries: number): number {
  return Math.min(TUNNEL_BACKOFF_BASE_MS * 2 ** retries, TUNNEL_BACKOFF_MAX_MS);
}

export type ProbeReach = "ready" | "warming" | "unreachable";

/** HTTP 425 or ≥500 → warming; anything else (incl. 401/404) → ready. */
export function probeStatusToReach(status: number): "ready" | "warming" {
  return status === 425 || status >= 500 ? "warming" : "ready";
}

/** D5.4: localhost, 127.0.0.1, ::1 and [::1] (the original's `::1` never matched). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  } catch {
    return false;
  }
}

/** `<base>/auth/callback?return_to=<enc(returnTo ?? "/")>#token=<token>`. */
export function callbackUrl(base: string, token: string, returnTo?: string | null): string {
  return `${base}/auth/callback?return_to=${encodeURIComponent(returnTo ?? "/")}#token=${token}`;
}

/** Browser fallback `<gw>/?return_to=%2F[&deployment=<depId>]`. */
export function gatewayFallbackUrl(gateway: string, deploymentId: string | undefined, staging: boolean): string {
  const params = new URLSearchParams({ return_to: "/" });
  if (deploymentId) params.set("deployment", depIdFor(deploymentId, staging));
  return `${stripTrailingSlashes(gateway)}/?${params.toString()}`;
}

/** "<label> exited <code|(stopped)>.\n<last 600 chars of trimmed stderr>". */
export function exitedMessage(label: string, code: number | null, stderr: string): string {
  return `${label} exited ${code ?? "(stopped)"}.\n${stderr.trim().slice(-STDERR_TAIL_CHARS)}`;
}

/** Display title for a mounted Lab. */
export function labTitle(conn: Pick<Connection, "name" | "deploymentId">): string {
  return conn.name || conn.deploymentId || "Lab";
}

export function isManaged(conn: Pick<Connection, "routeMode">): boolean {
  return conn.routeMode === "managed";
}

export function isLocal(conn: Pick<Connection, "routeMode">): boolean {
  return conn.routeMode === "local";
}

/** Error code for once-per-code managed-wake logging (`cause.code ?? code ?? message`). */
export function networkErrorKey(err: unknown): string {
  const e = err as { cause?: { code?: unknown }; code?: unknown; message?: unknown } | null | undefined;
  const v = e?.cause?.code ?? e?.code ?? e?.message;
  return v === undefined || v === null ? "unknown network error" : String(v);
}

/**
 * Normalize an untrusted IPC connection. Throws on a non-object or missing id
 * (the original threw a TypeError when touching fields of a non-object).
 */
export function normalizeConnection(raw: unknown): Connection {
  if (!raw || typeof raw !== "object") throw new Error("Invalid connection.");
  const c = raw as Record<string, unknown>;
  const s = c.ssh && typeof c.ssh === "object" ? (c.ssh as Record<string, unknown>) : undefined;
  const ssh: SshTarget | undefined = s
    ? {
        host: typeof s.host === "string" ? s.host : "",
        ...(typeof s.user === "string" && s.user ? { user: s.user } : {}),
        ...(typeof s.port === "number" && Number.isFinite(s.port) ? { port: s.port } : {}),
        ...(typeof s.identityFile === "string" && s.identityFile ? { identityFile: s.identityFile } : {}),
        ...(typeof s.jump === "string" && s.jump ? { jump: s.jump } : {}),
      }
    : undefined;
  const routeMode = c.routeMode === "managed" || c.routeMode === "local" || c.routeMode === "cluster" ? c.routeMode : undefined;
  return {
    id: typeof c.id === "string" ? c.id : String(c.id ?? ""),
    name: typeof c.name === "string" ? c.name : "",
    icon: typeof c.icon === "string" ? c.icon : "",
    deploymentId: typeof c.deploymentId === "string" ? c.deploymentId : "",
    labUrl: typeof c.labUrl === "string" ? c.labUrl : "",
    ...(routeMode ? { routeMode } : {}),
    ...(ssh ? { ssh } : {}),
  };
}
