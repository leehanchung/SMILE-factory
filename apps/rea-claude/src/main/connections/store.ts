/**
 * connections.json store [conn-ssh §3].
 *
 * - Format `{version: 1, connections: [...]}` pretty-printed with 2 spaces.
 * - Atomic write: mkdir -p <dir>, write `<file>.tmp`, rename over the target.
 * - upsert/remove are serialized through a promise-chain mutex; a failed task
 *   does not break the chain. `list` is not serialized.
 * - No validation: records are stored as given (upsert replaces wholesale).
 * - D5: a file that fails to parse is renamed to
 *   `connections.json.corrupt-<epoch ms>`, logged, and treated as `[]`.
 *   Other read errors (except ENOENT) still reject.
 */
import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { dirname } from "node:path";
import type { Connection, ConnectionUpsert } from "@shared/ipc";
import type { Logger } from "../services";

export const CONNECTIONS_FILE_VERSION = 1;

export interface ConnectionStoreOptions {
  /** Resolved lazily (userData is only valid after the pre-ready bootstrap). */
  filePath: () => string;
  logger: Logger;
  now?: () => number;
  uuid?: () => string;
}

export interface ConnectionStore {
  list(): Promise<Connection[]>;
  upsert(conn: ConnectionUpsert): Promise<Connection>;
  remove(id: string): Promise<void>;
}

/** Promise-chain mutex: tasks run one at a time; failures do not poison the chain. */
export function createSerializer(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

export function createConnectionStore(opts: ConnectionStoreOptions): ConnectionStore {
  const now = opts.now ?? Date.now;
  const uuid = opts.uuid ?? randomUUID;
  const serialize = createSerializer();

  async function backupCorrupt(file: string, err: unknown): Promise<void> {
    const backup = `${file}.corrupt-${now()}`;
    try {
      await fsp.rename(file, backup);
      opts.logger.warn(`connections.json could not be parsed (${String(err)}); moved it to ${backup} and starting empty`);
    } catch (renameErr) {
      // A concurrent reader may already have moved it away.
      if (errCode(renameErr) !== "ENOENT") {
        opts.logger.warn(`connections.json could not be parsed and could not be backed up: ${String(renameErr)}`);
      }
    }
  }

  async function read(): Promise<Connection[]> {
    const file = opts.filePath();
    let text: string;
    try {
      text = await fsp.readFile(file, "utf-8");
    } catch (err) {
      if (errCode(err) === "ENOENT") return [];
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      await backupCorrupt(file, err);
      return [];
    }
    const list = (parsed as { connections?: unknown } | null)?.connections;
    return Array.isArray(list) ? (list as Connection[]) : [];
  }

  async function write(connections: Connection[]): Promise<void> {
    const file = opts.filePath();
    const tmp = `${file}.tmp`;
    await fsp.mkdir(dirname(file), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify({ version: CONNECTIONS_FILE_VERSION, connections }, null, 2), "utf-8");
    await fsp.rename(tmp, file);
  }

  return {
    list: () => read(),
    upsert: (conn) =>
      serialize(async () => {
        if (typeof conn !== "object" || conn === null || Array.isArray(conn)) {
          throw new Error("A connection must be an object.");
        }
        const all = await read();
        const id = conn.id ?? uuid();
        const record = { ...conn, id } as Connection;
        const idx = all.findIndex((c) => (c as { id?: unknown } | null)?.id === id);
        if (idx >= 0) all[idx] = record;
        else all.push(record);
        await write(all);
        return record;
      }),
    remove: (id) =>
      serialize(async () => {
        const all = await read();
        await write(all.filter((c) => (c as { id?: unknown } | null)?.id !== id));
      }),
  };
}
