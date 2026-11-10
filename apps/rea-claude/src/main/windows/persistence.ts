/**
 * userData persistence owned by the windows area (windows spec §3.6):
 * `last-opened.json` and `window-state.json`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { FILE_LAST_OPENED, FILE_WINDOW_STATE, WINDOW_STATE_SAVE_DEBOUNCE_MS } from "@shared/config";
import { parseSavedBounds } from "./geometry";
import type { Rect } from "./geometry";

const LAST_OPENED_VERSION = 1;

/** Sanitize the `byAccount` map: non-string values are dropped. */
export function parseLastOpened(text: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return {};
    const by = (parsed as { byAccount?: unknown }).byAccount;
    if (!by || typeof by !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(by)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export interface LastOpenedStore {
  get(account: string): Promise<string | null>;
  /** Serialized read-merge-write via `.tmp` + rename. */
  set(account: string, connId: string): Promise<void>;
}

export function createLastOpenedStore(dir: () => string): LastOpenedStore {
  let queue: Promise<unknown> = Promise.resolve();
  const file = (): string => path.join(dir(), FILE_LAST_OPENED);

  const readAll = async (): Promise<Record<string, string>> => {
    try {
      return parseLastOpened(await fs.promises.readFile(file(), "utf-8"));
    } catch {
      return {};
    }
  };

  const write = async (account: string, connId: string): Promise<void> => {
    const byAccount = { ...(await readAll()), [account]: connId };
    const target = file();
    const tmp = `${target}.tmp`;
    await fs.promises.mkdir(dir(), { recursive: true });
    await fs.promises.writeFile(tmp, JSON.stringify({ version: LAST_OPENED_VERSION, byAccount }, null, 2), "utf-8");
    await fs.promises.rename(tmp, target);
  };

  return {
    async get(account) {
      if (typeof account !== "string") return null;
      return (await readAll())[account] ?? null;
    },
    set(account, connId) {
      const run = queue.then(
        () => write(account, connId),
        () => write(account, connId),
      );
      queue = run.catch(() => undefined);
      return run;
    },
  };
}

/** Read `window-state.json`; undefined unless it intersects a work area. */
export function readWindowState(dir: string, workAreas: readonly Rect[]): Rect | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, FILE_WINDOW_STATE), "utf-8");
  } catch {
    return undefined;
  }
  return parseSavedBounds(text, workAreas);
}

export interface WindowStateSaver {
  /** Debounced (250 ms, single global timer) write; errors swallowed. */
  save(bounds: Rect): void;
}

export function createWindowStateSaver(dir: () => string): WindowStateSaver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    save(bounds) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        try {
          const d = dir();
          fs.mkdirSync(d, { recursive: true });
          fs.writeFileSync(path.join(d, FILE_WINDOW_STATE), JSON.stringify(bounds));
        } catch {
          /* swallowed (§3.6) */
        }
      }, WINDOW_STATE_SAVE_DEBOUNCE_MS);
    },
  };
}
