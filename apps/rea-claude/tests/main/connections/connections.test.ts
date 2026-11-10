import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: unknown, ...args: unknown[]) => unknown;
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Listener>() }));
vi.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: Listener) => mocks.handlers.set(ch, fn), on: () => {} },
  session: { fromPartition: () => ({}) },
}));

import type { Connection, ConnectionUpsert } from "@shared/ipc";
import { createConnectionsService, registerConnectionsIpc } from "../../../src/main/connections";
import { createSerializer } from "../../../src/main/connections/store";
import type { Logger, LoggerFactory } from "../../../src/main/services";
import { makeTestContext } from "../helpers/context";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rea-conn-test-"));
  mocks.handlers.clear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(opts: { nested?: boolean } = {}) {
  const warnings: unknown[][] = [];
  const logger: Logger = { debug() {}, info() {}, warn: (...a) => warnings.push(a), error() {} };
  const tags: string[] = [];
  const factory: LoggerFactory = (tag) => {
    tags.push(tag);
    return logger;
  };
  const userData = opts.nested ? join(dir, "a", "b") : dir;
  const ctx = makeTestContext({ env: { userDataPath: () => userData }, logger: factory as never });
  let n = 0;
  const svc = createConnectionsService(ctx, { now: () => 1234, uuid: () => `uuid-${++n}` });
  return { svc, ctx, file: join(userData, "connections.json"), warnings, tags };
}

const base: ConnectionUpsert = { name: "Lab", icon: "flask", deploymentId: "d1", labUrl: "", ssh: { host: "alias" } };

describe("connections store", () => {
  it("missing file => []", async () => {
    expect(await setup().svc.list()).toEqual([]);
  });
  it("file without a connections array => []", async () => {
    const { svc, file } = setup();
    await writeFile(file, JSON.stringify({ version: 1 }));
    expect(await svc.list()).toEqual([]);
    await writeFile(file, "null");
    expect(await svc.list()).toEqual([]);
    await writeFile(file, JSON.stringify({ connections: { a: 1 } }));
    expect(await svc.list()).toEqual([]);
  });
  it("upsert assigns a uuid, writes {version:1} pretty JSON, and mkdirs userData", async () => {
    const { svc, file } = setup({ nested: true });
    const c = await svc.upsert(base);
    expect(c).toEqual({ ...base, id: "uuid-1" });
    const text = await readFile(file, "utf-8");
    expect(text).toBe(JSON.stringify({ version: 1, connections: [{ ...base, id: "uuid-1" }] }, null, 2));
    expect(await svc.list()).toEqual([c]);
    expect(await svc.get("uuid-1")).toEqual(c);
    expect(await svc.get("nope")).toBeUndefined();
  });
  it("upsert with an existing id replaces wholesale (no merge) in place", async () => {
    const { svc } = setup();
    const a = await svc.upsert({ ...base, owner: "me", gatewayUrl: "https://my.silico.run" });
    const b = await svc.upsert({ ...base, name: "Second" });
    const replaced = await svc.upsert({ id: a.id, name: "Renamed", icon: "flask", deploymentId: "", labUrl: "" });
    expect(replaced).toEqual({ id: a.id, name: "Renamed", icon: "flask", deploymentId: "", labUrl: "" });
    const all = await svc.list();
    expect(all.map((c) => c.id)).toEqual([a.id, b.id]);
    expect(all[0]).not.toHaveProperty("owner");
  });
  it("upsert with an unknown explicit id appends with that id (managed rows)", async () => {
    const { svc } = setup();
    const id = "managed:me:dep:https://my.silico.run";
    expect((await svc.upsert({ ...base, id, routeMode: "managed" })).id).toBe(id);
    expect((await svc.list())[0]?.id).toBe(id);
  });
  it("soft-delete via dismissed:true is just an upsert", async () => {
    const { svc } = setup();
    const a = await svc.upsert(base);
    await svc.upsert({ ...a, dismissed: true });
    expect((await svc.list())[0]).toEqual({ ...a, dismissed: true });
  });
  it("remove filters every record with that id; missing id still rewrites", async () => {
    const { svc, file } = setup();
    await writeFile(
      file,
      JSON.stringify({ version: 1, connections: [{ id: "x", name: "1" }, { id: "y" }, { id: "x", name: "2" }] }),
    );
    await svc.remove("x");
    expect(await svc.list()).toEqual([{ id: "y" }]);
    await svc.remove("nope");
    expect(await readFile(file, "utf-8")).toBe(JSON.stringify({ version: 1, connections: [{ id: "y" }] }, null, 2));
  });
  it("remove on a missing file creates an empty store", async () => {
    const { svc, file } = setup();
    await svc.remove("x");
    expect(JSON.parse(await readFile(file, "utf-8"))).toEqual({ version: 1, connections: [] });
  });
  it("stores unvalidated extra fields as given", async () => {
    const { svc } = setup();
    const weird = { ...base, extra: { deep: [1, 2] } } as unknown as ConnectionUpsert;
    expect(await svc.upsert(weird)).toMatchObject({ extra: { deep: [1, 2] } });
  });
  it("rejects a non-object upsert payload", async () => {
    const { svc } = setup();
    await expect(svc.upsert(null as unknown as ConnectionUpsert)).rejects.toThrow("A connection must be an object.");
    // the chain keeps working
    expect((await svc.upsert(base)).id).toBe("uuid-1");
  });
  it("concurrent upserts are serialized (none lost)", async () => {
    const { svc } = setup();
    await Promise.all(Array.from({ length: 20 }, (_, i) => svc.upsert({ ...base, name: `n${i}` })));
    const all = await svc.list();
    expect(all).toHaveLength(20);
    expect(new Set(all.map((c) => c.id)).size).toBe(20);
  });
  it("interleaved upsert/remove keep call order", async () => {
    const { svc } = setup();
    const p1 = svc.upsert({ ...base, id: "a" });
    const p2 = svc.remove("a");
    const p3 = svc.upsert({ ...base, id: "b" });
    await Promise.all([p1, p2, p3]);
    expect((await svc.list()).map((c: Connection) => c.id)).toEqual(["b"]);
  });
  it("leaves no .tmp file behind (atomic tmp+rename)", async () => {
    const { svc } = setup();
    await svc.upsert(base);
    expect((await readdir(dir)).sort()).toEqual(["connections.json"]);
  });
  it("D5: corrupt JSON is backed up, logged, and treated as empty", async () => {
    const { svc, file, warnings, tags } = setup();
    await writeFile(file, "{not json");
    expect(await svc.list()).toEqual([]);
    expect(await readFile(`${file}.corrupt-1234`, "utf-8")).toBe("{not json");
    expect(warnings).toHaveLength(1);
    expect(tags).toContain("connections");
    const c = await svc.upsert(base);
    expect(await svc.list()).toEqual([c]);
  });
  it("D5: corrupt file during upsert does not throw", async () => {
    const { svc, file } = setup();
    await writeFile(file, "\u0000garbage");
    const c = await svc.upsert(base);
    expect(await svc.list()).toEqual([c]);
    expect((await readdir(dir)).sort()).toEqual(["connections.json", "connections.json.corrupt-1234"]);
  });
  it("other read errors still reject", async () => {
    const ctx = makeTestContext();
    const svc = createConnectionsService(ctx, { filePath: dir /* a directory => EISDIR */ });
    await expect(svc.list()).rejects.toThrow();
  });
  it("create* does not touch services eagerly", () => {
    const ctx = makeTestContext({ env: { userDataPath: () => { throw new Error("too early"); } } });
    expect(() => createConnectionsService(ctx)).not.toThrow();
  });
});

describe("createSerializer", () => {
  it("a failed task does not break the chain", async () => {
    const s = createSerializer();
    const order: number[] = [];
    const a = s(async () => {
      order.push(1);
      throw new Error("boom");
    });
    const b = s(async () => {
      order.push(2);
      return 2;
    });
    await expect(a).rejects.toThrow("boom");
    await expect(b).resolves.toBe(2);
    expect(order).toEqual([1, 2]);
  });
});

describe("registerConnectionsIpc", () => {
  it("wires list/upsert/remove via the shell gate", async () => {
    const calls: unknown[] = [];
    const ctx = makeTestContext({
      connections: {
        list: async () => [],
        upsert: async (c) => {
          calls.push(["upsert", c]);
          return { ...c, id: "i" } as Connection;
        },
        remove: async (id) => {
          calls.push(["remove", id]);
        },
      },
    });
    registerConnectionsIpc(ctx);
    const ev = { sender: { getURL: () => "file:///x" }, senderFrame: { url: "file:///x" } };
    expect(await mocks.handlers.get("connections:list")?.(ev)).toEqual([]);
    await mocks.handlers.get("connections:upsert")?.(ev, base);
    await mocks.handlers.get("connections:remove")?.(ev, "i");
    expect(calls).toEqual([["upsert", base], ["remove", "i"]]);
    expect(() => mocks.handlers.get("connections:list")?.({ sender: { getURL: () => "https://x" }, senderFrame: null })).toThrow(
      "Blocked 'connections:list': untrusted sender.",
    );
  });
});
