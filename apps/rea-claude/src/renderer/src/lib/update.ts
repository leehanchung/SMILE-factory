/** Lab version / update flags and the row menu's version lines [renderer §4.5, §4.7]. */
import type { DiscoveredLab } from "@shared/ipc";

export const isFullSha = (s: string | undefined | null): boolean => /^[0-9a-f]{40}$/i.test(s ?? "");

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export interface UpdateFlags {
  required: boolean;
  soft: boolean;
  any: boolean;
}

type FlagFields = Partial<
  Pick<
    DiscoveredLab,
    "stale" | "currentSha" | "targetSha" | "updateRequired" | "updateAvailable" | "reportsVersion"
  >
>;

/**
 * Whether a discovered Lab needs an update. Stale (non-heartbeating) Labs
 * ignore server flags; only an exact pinned-sha mismatch (both full 40-hex
 * shas, case-insensitive compare) still counts as a soft update.
 */
export function labUpdateFlags(
  d: FlagFields | undefined,
  opts?: { pinnedExactCheck?: boolean },
): UpdateFlags {
  if (!d) return { required: false, soft: false, any: false };
  const cur = d.currentSha;
  const tgt = d.targetSha;
  const offPin =
    opts?.pinnedExactCheck === true &&
    isFullSha(cur) &&
    isFullSha(tgt) &&
    (cur ?? "").toLowerCase() !== (tgt ?? "").toLowerCase();
  if (d.stale) return { required: false, soft: offPin, any: offPin };
  const required = d.updateRequired === true;
  const soft = !required && (d.updateAvailable === true || d.reportsVersion === false || offPin);
  return { required, soft, any: required || soft };
}

/** Is this connection out of date (and should be updated on open)? */
export function isOutOfDate(opts: {
  skipVersionCheck: boolean;
  managed: boolean;
  disc: FlagFields | undefined;
  previewPinned: boolean;
  staging: boolean;
}): boolean {
  if (opts.skipVersionCheck || opts.managed) return false;
  return labUpdateFlags(opts.disc, { pinnedExactCheck: !opts.previewPinned && !opts.staging }).any;
}

/** Non-interactive version header lines in a row's overflow menu. */
export function versionLines(opts: {
  managed: boolean;
  /** skipVersionCheck || staging */
  versionless: boolean;
  live: boolean;
  sha?: string;
  outOfDate: boolean;
  targetSha?: string;
}): string[] | undefined {
  const { managed, versionless, live, sha, outOfDate, targetSha } = opts;
  if (managed) return undefined;
  if (versionless) return live && sha ? [`Version · ${shortSha(sha)}`] : undefined;
  if (outOfDate) {
    const lines = sha ? [`Current version · ${shortSha(sha)}`] : [];
    lines.push(targetSha ? `Update available · ${shortSha(targetSha)}` : "Update available");
    return lines;
  }
  return live && sha ? [`Up to date · ${shortSha(sha)}`] : undefined;
}
