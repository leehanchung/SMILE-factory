import test from "node:test";
import assert from "node:assert/strict";
import { createBridge, STORAGE_PREFIX } from "../web/bridge.js";

const memoryStorage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
};
const setup = (options = {}) => {
  const navigations = [];
  const storage = options.storage ?? memoryStorage();
  const bridge = createBridge({ storage, navigate: (url) => navigations.push(url), sleep: async () => {}, ...options });
  return { bridge, storage, navigations };
};

test("auth, settings, and saved connections persist without mutable references", async () => {
  const { bridge, storage } = setup();
  const original = await bridge.settings.get(); original.notifications.enabled = false;
  assert.equal((await bridge.settings.get()).notifications.enabled, true);
  await bridge.settings.set({ verbose: true, notifications: { sound: false } });
  const row = await bridge.connections.upsert({ name: "My demo", deploymentId: "test" });
  row.name = "mutated";
  const reloaded = setup({ storage }).bridge;
  assert.equal((await reloaded.settings.get()).verbose, true);
  assert.equal((await reloaded.settings.get()).notifications.enabled, true);
  assert.equal((await reloaded.settings.get()).notifications.sound, false);
  assert.equal((await reloaded.connections.list()).find((c) => c.id === row.id).name, "My demo");
  await bridge.auth.signOutEverywhere();
  assert.equal((await setup({ storage }).bridge.auth.status()).status, "signed-out");
  assert.equal((await bridge.labs.list()).needsAuth, true);
});

test("successful opening emits ordered phases and routes only to local workspace", async () => {
  const { bridge, navigations } = setup();
  const phases = [];
  const unsubscribe = bridge.lab.onPhase((e) => phases.push(e.phase));
  const row = (await bridge.connections.list())[0];
  assert.equal((await bridge.lab.connect(row)).status, "opened");
  assert.deepEqual(phases, ["checking", "waking", "opening"]);
  assert.deepEqual(navigations, ["/workspace/?lab=demo-managed"]);
  unsubscribe(); await bridge.lab.connect(row);
  assert.equal(phases.length, 3);
});

test("host-key fixture requires explicit demo trust and never writes an SSH key", async () => {
  const { bridge, navigations } = setup({ search: "?scenario=host-key" });
  const row = (await bridge.connections.list()).find((c) => c.ssh);
  assert.equal((await bridge.lab.connect(row)).status, "host-key");
  assert.equal((await bridge.lab.test(row.ssh)).hostKey, "unknown");
  assert.equal(navigations.length, 0);
  assert.match((await bridge.lab.hostKey.scan(row.ssh)).fingerprint, /DEMO_ONLY/);
  await bridge.lab.hostKey.accept(row.ssh);
  assert.equal((await bridge.lab.test(row.ssh)).ok, true);
  assert.equal((await bridge.lab.connect(row)).status, "opened");
});

test("failure fixtures cannot accidentally open a workspace", async () => {
  for (const [scenario, expected] of [["waking", "still-waking"], ["forbidden", "forbidden"], ["error", "error"]]) {
    const { bridge, navigations } = setup({ search: `?scenario=${scenario}` });
    assert.equal((await bridge.lab.connect((await bridge.connections.list())[0])).status, expected);
    assert.equal(navigations.length, 0);
  }
});

test("cancellation during a pending phase prevents later opened events and navigation", async () => {
  let release;
  const { bridge, navigations } = setup({ sleep: () => new Promise((resolve) => { release = resolve; }) });
  const row = (await bridge.connections.list())[0];
  let opened = false; bridge.labView.onOpened(() => { opened = true; });
  const result = bridge.lab.connect(row);
  await bridge.lab.cancel(row.id); release();
  assert.equal((await result).status, "canceled");
  assert.equal(opened, false); assert.deepEqual(navigations, []);
});

test("reset is confined to our namespace and malformed storage falls back safely", async () => {
  const storage = memoryStorage();
  storage.setItem("unrelated", "keep");
  storage.setItem(STORAGE_PREFIX + "settings", "invalid json");
  storage.setItem(STORAGE_PREFIX + "connections", "null");
  const { bridge } = setup({ storage });
  assert.equal((await bridge.settings.get()).verbose, false);
  assert.equal((await bridge.connections.list()).length, 3);
  await bridge.settings.set({ verbose: true });
  const reset = setup({ storage, search: "?reset=1&scenario=signed-out" }).bridge;
  assert.equal((await reset.settings.get()).verbose, false);
  assert.equal((await reset.auth.status()).status, "signed-out");
  assert.equal(storage.getItem("unrelated"), "keep");
});

test("new SSH aliases validate ports and preserve unrelated hosts", async () => {
  const { bridge } = setup();
  await assert.rejects(bridge.ssh.addHost({ alias: "example", hostName: "demo.invalid", port: 65536 }), /Port/);
  await bridge.ssh.addHost({ alias: "example", hostName: "demo.invalid", port: 2222 });
  assert.equal((await bridge.ssh.listHosts()).length, 2);
  await assert.rejects(bridge.ssh.addHost({ alias: "example", hostName: "other.invalid" }), /already/);
});

test("removing a saved cluster keeps it discoverable without duplicate deployments", async () => {
  const { bridge } = setup();
  await bridge.connections.remove("demo-cluster");
  assert.equal((await bridge.connections.list()).some((c) => c.id === "demo-cluster"), false);
  assert.equal((await bridge.labs.list()).labs.some((lab) => lab.deploymentId === "gpu-demo"), true);
  await bridge.connections.upsert({ name: "Added cluster", deploymentId: "another-demo-cluster" });
  const labs = (await bridge.labs.list()).labs;
  assert.equal(new Set(labs.map((lab) => lab.deploymentId)).size, labs.length);
});

test("viewer recovery supplies string deployments as consumed by recovered JSX", async () => {
  const { bridge, navigations } = setup();
  let recovery;
  const unsubscribe = bridge.viewer.onRecovery((value) => { recovery = value; });
  await Promise.resolve();
  assert.equal(recovery.kind, "choose");
  assert.deepEqual(recovery.deployments, ["research-demo"]);
  unsubscribe();
  await bridge.viewer.retry(recovery.deployments[0]);
  assert.deepEqual(navigations, ["/workspace/"]);
});
