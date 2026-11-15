/** ConfigureForm validation and value shaping [renderer §4.12, §6]. */
import type { AddHostInput, ConnectionUpsert, SshHostEntry, SshTarget, TestResult } from "@shared/ipc";
import { sshAliasFor } from "./sshAlias";

export type HostMode = "pick" | "new";

export interface NewHostFields {
  hostName: string;
  user: string;
  port: string;
  identityFile: string;
}

export const EMPTY_NEW_HOST: NewHostFields = { hostName: "", user: "", port: "", identityFile: "" };

const orUndef = (s: string): string | undefined => s.trim() || undefined;

/** Port text -> number only when non-empty (no range/NaN validation, as observed). */
export function portValue(port: string): number | undefined {
  return port ? Number(port) : undefined;
}

export function canSave(opts: {
  noSsh: boolean;
  mode: HostMode;
  pickedHost: string | undefined;
  newHostName: string;
}): boolean {
  if (opts.noSsh) return true;
  return opts.mode === "pick" ? !!(opts.pickedHost ?? "").trim() : !!opts.newHostName.trim();
}

/** Target passed to lab.test / hostKey.scan / hostKey.accept. */
export function sshTestTarget(mode: HostMode, pickedHost: string | undefined, nh: NewHostFields): SshTarget {
  if (mode === "pick") return { host: (pickedHost ?? "").trim() };
  return {
    host: nh.hostName.trim(),
    user: orUndef(nh.user),
    port: portValue(nh.port),
    identityFile: orUndef(nh.identityFile),
  };
}

/** ssh.addHost input for "new host" mode. */
export function newHostInput(deploymentId: string, nh: NewHostFields): AddHostInput {
  return {
    alias: sshAliasFor(deploymentId, nh.hostName),
    hostName: nh.hostName.trim(),
    user: orUndef(nh.user),
    port: portValue(nh.port),
    identityFile: orUndef(nh.identityFile),
  };
}

/** Name saved for the row. */
export function savedName(form: Pick<ConnectionUpsert, "name" | "deploymentId">, noSsh: boolean, sshHost?: string): string {
  const name = form.name.trim();
  if (noSsh) return name || form.deploymentId;
  return name || form.deploymentId || sshHost || "";
}

/** Host options: listHosts plus the current host if missing, sorted by alias. */
export function hostOptions(hosts: readonly SshHostEntry[], current: string | undefined): SshHostEntry[] {
  const list = current && !hosts.some((h) => h.alias === current) ? [{ alias: current }, ...hosts] : [...hosts];
  return list.sort((a, b) => a.alias.localeCompare(b.alias, undefined, { sensitivity: "base" }));
}

export const HOST_SEARCH_THRESHOLD = 5;

/** Search filter, only active when there are more than 5 options. */
export function filterHosts(options: readonly SshHostEntry[], query: string): SshHostEntry[] {
  const q = query.trim().toLowerCase();
  if (options.length <= HOST_SEARCH_THRESHOLD || !q) return [...options];
  return options.filter(
    (h) => h.alias.toLowerCase().includes(q) || (h.hostName ?? "").toLowerCase().includes(q),
  );
}

export type PrimaryAction = "save" | "test-and-save" | "accept-and-save";

/** Which flow the primary button runs (managed, not noSsh, as observed). */
export function primaryAction(opts: { isEdit: boolean; managed: boolean; test: TestResult | null }): PrimaryAction {
  if (opts.isEdit || opts.managed) return "save";
  if (opts.test && !opts.test.ok && opts.test.hostKey === "unknown") return "accept-and-save";
  return "test-and-save";
}

export function primaryLabel(opts: {
  testing: boolean;
  isEdit: boolean;
  managed: boolean;
  test: TestResult | null;
}): string {
  if (opts.testing) return "Verifying SSH…";
  if (opts.isEdit) return "Save";
  if (opts.managed) return "Add";
  if (opts.test && !opts.test.ok && opts.test.hostKey === "unknown") return "Accept host key & add";
  return "Add";
}
