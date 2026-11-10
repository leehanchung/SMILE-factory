/**
 * Host-key trust on first use [conn-ssh §4.8, §4.9; D5.2].
 *
 * scan:   ssh -G <host> → ssh-keyscan -H -p <port> <host> → ssh-keygen -lf -
 *         → preferred fingerprint (ED25519 > ECDSA > RSA > others).
 * accept: rescan, fingerprint EVERY scanned line separately and append to
 *         ~/.ssh/known_hosts only the lines whose SHA256 fingerprint equals the
 *         fingerprint the user approved (fixes the original TOCTOU, D5.2).
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { KNOWN_HOSTS_MODE, SSH_DIR_MODE, SSH_KEY_TYPE_PREFERENCE } from "@shared/config";
import type { HostKeyAcceptResult, HostKeyScanResult, SshTarget } from "@shared/ipc";
import { SSH_INVALID_HOST, isSafeSshToken, sshTargetError } from "@shared/sshTarget";
import type { RemoteResult } from "../services";
import type { SshTool } from "./spawn";

export type LocalRun = (tool: SshTool, args: readonly string[], stdin?: string) => Promise<RemoteResult>;

export interface ResolvedHost {
  host: string;
  port: number;
  proxyJump: boolean;
}

/** Apply `ssh -G` output on top of defaults (`hostname`, `port`, `proxyjump` ≠ none). */
export function parseSshG(stdout: string, defaults: ResolvedHost): ResolvedHost {
  const r = { ...defaults };
  for (const line of stdout.split("\n")) {
    const [kw, ...rest] = line.trim().split(/\s+/);
    const v = rest.join(" ");
    if (kw === "hostname" && v) r.host = v;
    else if (kw === "port" && v) r.port = Number(v) || r.port;
    else if (kw === "proxyjump" && v && v.toLowerCase() !== "none") r.proxyJump = true;
  }
  return r;
}

export async function resolveViaSshG(run: LocalRun, target: SshTarget): Promise<ResolvedHost> {
  const defaults: ResolvedHost = { host: target.host, port: target.port ?? 22, proxyJump: !!target.jump };
  const res = await run("ssh", ["-G", "--", target.host]).catch(() => null);
  return res && res.code === 0 ? parseSshG(res.stdout, defaults) : defaults;
}

const FP_RE = /\b(SHA256:[A-Za-z0-9+/=]+)\b.*\(([A-Za-z0-9]+)\)\s*$/;

export interface Fingerprint {
  fingerprint: string;
  keyType: string;
}

export function parseFingerprintLine(line: string): Fingerprint | null {
  const m = FP_RE.exec(line);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return { fingerprint: m[1], keyType: m[2].toUpperCase() };
}

function keyRank(keyType: string): number {
  const i = SSH_KEY_TYPE_PREFERENCE.indexOf(keyType.toUpperCase());
  return i < 0 ? 99 : i;
}

/** Preferred fingerprint among `ssh-keygen -lf` output lines, or undefined. */
export function pickFingerprint(stdout: string): Fingerprint | undefined {
  return stdout
    .split("\n")
    .map(parseFingerprintLine)
    .filter((f): f is Fingerprint => f !== null)
    .sort((a, b) => keyRank(a.keyType) - keyRank(b.keyType))[0];
}

export function displayHost(host: string, port: number): string {
  return port === 22 ? host : `${host}:${port}`;
}

const FINGERPRINT_INPUT_RE = /^SHA256:[A-Za-z0-9+/=]+$/;

async function keyscan(run: LocalRun, r: ResolvedHost): Promise<RemoteResult | null> {
  return run("ssh-keyscan", ["-H", "-p", String(r.port), "--", r.host]).catch(() => null);
}

export async function scanHostKey(run: LocalRun, target: SshTarget): Promise<HostKeyScanResult> {
  if (!target?.host) return { ok: false, error: "No SSH host." };
  const invalid = sshTargetError(target);
  if (invalid) return { ok: false, error: invalid };
  const r = await resolveViaSshG(run, target);
  if (!isSafeSshToken(r.host)) return { ok: false, error: SSH_INVALID_HOST };
  if (r.proxyJump) {
    return {
      ok: false,
      error: `${target.host} is reached through a jump host; automatic key fetch isn't supported yet. Run \`ssh ${target.host}\` once to accept it.`,
    };
  }
  const scan = await keyscan(run, r);
  if (scan?.toolMissing) return { ok: false, error: scan.stderr };
  const lines = scan?.stdout.trim();
  if (!scan || !lines) {
    return { ok: false, error: `Couldn't reach ${r.host} to read its host key. Check the host and your network / VPN.` };
  }
  const keygen = await run("ssh-keygen", ["-lf", "-"], `${lines}\n`).catch(() => null);
  if (keygen?.toolMissing) return { ok: false, error: keygen.stderr };
  const best = pickFingerprint(keygen?.stdout ?? "");
  if (!best) return { ok: false, error: "Could not read the host key fingerprint." };
  return { ok: true, host: displayHost(r.host, r.port), keyType: best.keyType, fingerprint: best.fingerprint };
}

export interface AcceptOptions {
  homeDir: string;
}

export async function acceptHostKey(
  run: LocalRun,
  target: SshTarget,
  expectedFingerprint: unknown,
  opts: AcceptOptions,
): Promise<HostKeyAcceptResult> {
  if (!target?.host) return { ok: false, error: "No SSH host." };
  if (typeof expectedFingerprint !== "string" || !FINGERPRINT_INPUT_RE.test(expectedFingerprint)) {
    return { ok: false, error: "No approved host key fingerprint to verify against. Fetch the host key first." };
  }
  const invalid = sshTargetError(target);
  if (invalid) return { ok: false, error: invalid };
  const r = await resolveViaSshG(run, target);
  if (!isSafeSshToken(r.host)) return { ok: false, error: SSH_INVALID_HOST };
  if (r.proxyJump) return { ok: false, error: "Jump-host key fetch is not supported yet." };
  const scan = await keyscan(run, r);
  if (scan?.toolMissing) return { ok: false, error: scan.stderr };
  const scanned = scan?.stdout.trim();
  if (!scan || !scanned) return { ok: false, error: `Couldn't reach ${r.host} to read its host key.` };

  // D5.2: fingerprint each key line on its own and keep only exact matches.
  const matching: string[] = [];
  for (const raw of scanned.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const keygen = await run("ssh-keygen", ["-lf", "-"], `${line}\n`).catch(() => null);
    if (keygen?.toolMissing) return { ok: false, error: keygen.stderr };
    const fps = (keygen?.stdout ?? "").split("\n").map(parseFingerprintLine);
    if (fps.some((f) => f?.fingerprint === expectedFingerprint)) matching.push(line);
  }
  if (matching.length === 0) {
    return {
      ok: false,
      error: `The host key ${r.host} presented no longer matches the fingerprint you approved (${expectedFingerprint}). Nothing was trusted; fetch the host key again and check it.`,
    };
  }

  const dir = join(opts.homeDir, ".ssh");
  const file = join(dir, "known_hosts");
  await fsp.mkdir(dir, { recursive: true, mode: SSH_DIR_MODE });
  let prefix = "";
  try {
    const existing = await fsp.readFile(file, "utf-8");
    if (existing.length && !existing.endsWith("\n")) prefix = "\n";
  } catch {
    // missing file: nothing to separate from
  }
  await fsp.appendFile(file, `${prefix}${matching.join("\n")}\n`, { mode: KNOWN_HOSTS_MODE });
  return { ok: true };
}
