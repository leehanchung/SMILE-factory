/**
 * Connections module entry (owner: I2) [conn-ssh §2, §3].
 *
 * Owns: connections.json store (serial queue, atomic tmp+rename, wholesale
 * replace on upsert; D5: corrupt file -> backup `connections.json.corrupt-<ts>`
 * + start empty + log). IPC: connections:list / upsert / remove.
 * `connections:changed` is NOT sent here (only by signup adoption, I1).
 */
import { join } from "node:path";
import { FILE_CONNECTIONS } from "@shared/config";
import { ShellInvokeChannel } from "@shared/ipc";
import { handleShell } from "../ipc/trust";
import type { ConnectionsService, MainContext } from "../services";
import { createConnectionStore } from "./store";

export interface ConnectionsDeps {
  /** Override the store path (tests). Default: <userData>/connections.json. */
  filePath?: string;
  /** Clock for the corrupt-backup suffix (tests). */
  now?: () => number;
  /** Id generator (tests). Default: crypto.randomUUID. */
  uuid?: () => string;
}

export function createConnectionsService(ctx: MainContext, deps?: ConnectionsDeps): ConnectionsService {
  const store = createConnectionStore({
    filePath: () => deps?.filePath ?? join(ctx.env.userDataPath(), FILE_CONNECTIONS),
    // Resolve the logger lazily: create* must not touch services eagerly.
    logger: {
      debug: (...a) => ctx.logger("connections").debug(...a),
      info: (...a) => ctx.logger("connections").info(...a),
      warn: (...a) => ctx.logger("connections").warn(...a),
      error: (...a) => ctx.logger("connections").error(...a),
    },
    ...(deps?.now ? { now: deps.now } : {}),
    ...(deps?.uuid ? { uuid: deps.uuid } : {}),
  });
  return {
    list: () => store.list(),
    get: async (id) => (await store.list()).find((c) => (c as { id?: unknown } | null)?.id === id),
    upsert: (conn) => store.upsert(conn),
    remove: (id) => store.remove(id),
  };
}

export function registerConnectionsIpc(ctx: MainContext): void {
  handleShell(ShellInvokeChannel.connectionsList, () => ctx.connections.list());
  handleShell(ShellInvokeChannel.connectionsUpsert, (_e, conn) => ctx.connections.upsert(conn));
  handleShell(ShellInvokeChannel.connectionsRemove, (_e, id) => ctx.connections.remove(id));
}
