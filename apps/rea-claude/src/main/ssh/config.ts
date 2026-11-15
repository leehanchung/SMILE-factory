/**
 * ~/.ssh/config parsing and Host-block rendering [conn-ssh §4.4, §4.5]. Pure.
 *
 * The parser is deliberately tiny and faithful to the original quirks: no
 * Include, `Match` is not a block boundary, `key=value` is unsupported, quotes
 * and inline comments are kept, later repeats overwrite, duplicates are kept.
 */
import type { AddHostInput, SshHostEntry } from "@shared/ipc";

export function parseSshConfig(text: string): SshHostEntry[] {
  const out: SshHostEntry[] = [];
  let cur: SshHostEntry | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const ws = line.search(/\s/);
    const keyword = (ws === -1 ? line : line.slice(0, ws)).toLowerCase();
    const value = ws === -1 ? "" : line.slice(ws + 1).trim();
    if (keyword === "host") {
      const alias = value.split(/\s+/).find((tok) => tok && !tok.includes("*") && !tok.includes("?") && !tok.includes("!"));
      cur = alias ? { alias } : null;
      if (cur) out.push(cur);
      continue;
    }
    if (!cur) continue;
    switch (keyword) {
      case "hostname":
        cur.hostName = value;
        break;
      case "user":
        cur.user = value;
        break;
      case "identityfile":
        cur.identityFile = value;
        break;
      case "port":
        cur.port = Number(value) || undefined;
        break;
      default:
        break;
    }
  }
  return out;
}

const CONTROL_RE = /[\x00-\x1f\x7f]/;

export interface ValidHostInput {
  alias: string;
  hostName: string;
  user: string;
  port: number | undefined;
  identityFile: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function checkToken(label: string, v: string): string {
  const t = v.trim();
  if (CONTROL_RE.test(t) || /\s/.test(t)) throw new Error(`The ${label} must not contain spaces or control characters.`);
  return t;
}

/** Validation in spec order with the exact messages (+ D5.3 double-quote rejection). */
export function validateAddHost(input: AddHostInput): ValidHostInput {
  const alias = checkToken("alias", str(input.alias));
  if (!alias) throw new Error("An alias is required.");
  const hostName = checkToken("hostname / IP", str(input.hostName));
  if (!hostName) throw new Error("A hostname / IP is required.");
  const user = checkToken("user", str(input.user));
  const identityFile = str(input.identityFile).trim();
  if (CONTROL_RE.test(identityFile)) throw new Error("The identity file path must not contain control characters.");
  if (identityFile.includes('"')) throw new Error("The identity file path must not contain double quotes.");
  const port = input.port === undefined ? undefined : Number(input.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("The port must be a whole number between 1 and 65535.");
  }
  return { alias, hostName, user, port, identityFile };
}

/** D5.3: quote IdentityFile paths that contain whitespace. */
export function formatIdentityFile(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

/** The exact text appended to ~/.ssh/config: leading `\n`, 4-space indent, trailing `\n`. */
export function renderHostBlock(v: ValidHostInput): string {
  const lines = [`Host ${v.alias}`, `    HostName ${v.hostName}`];
  if (v.user) lines.push(`    User ${v.user}`);
  if (v.port) lines.push(`    Port ${v.port}`);
  if (v.identityFile) lines.push(`    IdentityFile ${formatIdentityFile(v.identityFile)}`);
  return `\n${lines.join("\n")}\n`;
}
