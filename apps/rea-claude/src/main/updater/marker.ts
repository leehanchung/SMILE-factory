/**
 * update-exit-marker.json (platform §5.4): written right before exiting to
 * install, inspected on the next launch to detect installs that failed.
 */
import * as fs from "node:fs";
import { classifyExitMarker } from "./decisions";
import type { ExitMarker } from "./decisions";

export interface MarkerFs {
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string): void;
  rmSync(path: string, opts: { force: true }): void;
}

export interface ExitMarkerStore {
  write(fromVersion: string, toVersion: string): void;
  clear(): void;
  /** `Ru`: returns the marker only when it shows a failed install; deletes invalid/applied markers. */
  takeFailed(currentVersion: string): ExitMarker | null;
}

export function createExitMarkerStore(opts: {
  path: () => string;
  log: (...args: unknown[]) => void;
  now?: () => number;
  fs?: MarkerFs;
}): ExitMarkerStore {
  const f = opts.fs ?? fs;
  const now = opts.now ?? Date.now;

  function clear(): void {
    try {
      f.rmSync(opts.path(), { force: true });
    } catch {
      /* ignore */
    }
  }

  return {
    write(fromVersion, toVersion) {
      const marker: ExitMarker = { fromVersion, toVersion, at: now() };
      try {
        f.writeFileSync(opts.path(), JSON.stringify(marker));
        opts.log(`exiting for update ${fromVersion} → ${toVersion}`);
      } catch (err) {
        opts.log("WARN could not write exit marker", err);
      }
    },
    clear,
    takeFailed(currentVersion) {
      let text: string;
      try {
        text = f.readFileSync(opts.path(), "utf8");
      } catch {
        return null;
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      const kind = classifyExitMarker(parsed, currentVersion);
      if (kind !== "invalid") {
        const m = parsed as ExitMarker;
        opts.log(`previous exit expected ${m.fromVersion} → ${m.toVersion}; now running ${currentVersion} (${kind})`);
      }
      if (kind !== "failed") {
        clear();
        return null;
      }
      return parsed as ExitMarker;
    },
  };
}
