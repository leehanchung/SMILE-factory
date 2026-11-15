/**
 * Offline implementation of Silico 0.137.0's window.silico preload contract.
 * This file never performs authentication, SSH, requests, or target app execution.
 * /shell/?scenario=signed-out|host-key|waking|forbidden|error|empty|default
 * selects a fixture. host-key applies to SSH connections; accepting trusts only
 * this in-memory demo host. ?reset=1 resets only rea-astra:shell:* storage.
 */
export const STORAGE_PREFIX = "rea-astra:shell:";
const GATEWAY = "https://demo.invalid";
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const DEFAULT_SETTINGS = {
  developerMode: false, previewBuilds: false, skipVersionCheck: false,
  staging: false, verbose: false,
  notifications: { enabled: true, needsInput: true, experimentFinished: true,
    sound: true, notifyWhenActive: false, badge: true },
};
const DEFAULT_CONNECTIONS = [
  { id: "demo-managed", name: "Research lab", icon: "flask", deploymentId: "research-demo",
    labUrl: "https://demo.invalid/research", routeMode: "managed", owner: "demo", gatewayUrl: GATEWAY },
  { id: "demo-cluster", name: "GPU cluster", icon: "server", deploymentId: "gpu-demo",
    labUrl: "https://demo.invalid/gpu", ssh: { host: "demo-gpu" }, owner: "demo", gatewayUrl: GATEWAY },
  { id: "demo-local", name: "Local sandbox", icon: "cpu", deploymentId: "goodfire-local",
    labUrl: "http://localhost:8000", routeMode: "local", owner: "demo", gatewayUrl: GATEWAY },
];
const DEFAULT_HOSTS = [{ alias: "demo-gpu", hostName: "gpu.demo.invalid", user: "researcher" }];
const signedIn = (staging = false) => ({ status: "signed-in", login: "demo", sub: "github:demo",
  gatewayUrl: staging ? "https://my-staging.silico.run" : GATEWAY, developer: true });

export function createBridge({ storage, search = "", navigate = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  delayMs = 250, confirm = () => true, now = () => Date.now() } = {}) {
  const query = new URLSearchParams(search);
  const scenario = query.get("scenario") || "default";
  const knownKeys = ["settings", "connections", "hosts", "auth", "lastOpened"];
  if (query.get("reset") === "1") {
    for (const key of knownKeys) { try { storage?.removeItem(STORAGE_PREFIX + key); } catch {} }
  }
  const read = (key, fallback) => {
    try {
      const raw = storage?.getItem(STORAGE_PREFIX + key);
      return raw === null || raw === undefined ? clone(fallback) : JSON.parse(raw);
    } catch { return clone(fallback); }
  };
  const save = (key, value) => { try { storage?.setItem(STORAGE_PREFIX + key, JSON.stringify(value)); } catch {} };
  let settings = read("settings", DEFAULT_SETTINGS);
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) settings = clone(DEFAULT_SETTINGS);
  settings = { ...clone(DEFAULT_SETTINGS), ...settings,
    notifications: { ...DEFAULT_SETTINGS.notifications, ...settings.notifications } };
  let connections = read("connections", DEFAULT_CONNECTIONS);
  if (!Array.isArray(connections)) connections = clone(DEFAULT_CONNECTIONS);
  connections = connections.filter((c) => c && typeof c.id === "string");
  let hosts = read("hosts", DEFAULT_HOSTS);
  if (!Array.isArray(hosts)) hosts = clone(DEFAULT_HOSTS);
  let auth = read("auth", signedIn(settings.staging));
  if (!auth || !["signed-in", "signed-out"].includes(auth.status)) auth = signedIn(settings.staging);
  if (scenario === "signed-out") auth = { status: "signed-out" };
  if (scenario === "empty") connections = [];
  const listeners = new Map();
  const on = (event, callback) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(callback);
    return () => listeners.get(event)?.delete(callback);
  };
  const emit = (event, value) => { for (const callback of [...(listeners.get(event) ?? [])]) callback(clone(value)); };
  const accepted = new Set();
  const operations = new Map();
  let operationId = 0;
  let connectionId = 0;
  let signupOpen = false;
  const requireAuth = () => auth.status === "signed-in";
  const getDiscovery = () => {
    if (scenario === "empty") return [];
    // Discovery belongs to the simulated gateway, independently of saved rows.
    // Removing a saved cluster must leave it available in "Connect an existing lab".
    const discovered = new Map(DEFAULT_CONNECTIONS.map((c) => [c.deploymentId, c]));
    for (const connection of connections) {
      if (connection.deploymentId) discovered.set(connection.deploymentId, connection);
    }
    return [
      ...[...discovered.values()].map((c) => ({ deploymentId: c.deploymentId,
        routeMode: c.routeMode, labPublicHost: "demo.invalid", host: "demo.invalid", port: 443,
        stale: true, reportsVersion: true, updateRequired: false, updateAvailable: false,
        currentSha: "a".repeat(40), targetSha: "a".repeat(40) })),
      ...discovered.has("another-demo-cluster") ? [] : [{ deploymentId: "another-demo-cluster", stale: true, reportsVersion: true,
        labPublicHost: "demo.invalid", updateRequired: false, updateAvailable: false }],
    ];
  };
  async function connect(connection, options = {}) {
    if (!requireAuth()) return { status: "forbidden", login: "signed-out" };
    if (!connection || typeof connection.id !== "string") throw new Error("Choose a demo lab first.");
    const id = connection.id;
    const token = ++operationId;
    operations.set(id, token);
    const canceled = () => operations.get(id) !== token;
    try {
      if (scenario === "forbidden") return { status: "forbidden", login: auth.login };
      if (scenario === "host-key" && connection.ssh && !accepted.has(connection.ssh.host)) {
        return { status: "host-key", kind: "unknown", host: connection.ssh.host };
      }
      const phases = options.update ? ["updating", "opening"] : connection.ssh ?
        ["checking", "ssh", options.tunnel ? "tunneling" : "starting", "opening"] :
        ["checking", "waking", "opening"];
      for (const phase of phases) {
        if (canceled()) return { status: "canceled" };
        emit("lab:phase", { id, phase });
        emit("lab:output", { id, chunk: `[demo] ${phase}: simulated locally; no commands or requests\n` });
        await sleep(delayMs);
      }
      if (canceled()) return { status: "canceled" };
      if (scenario === "waking") return { status: "still-waking" };
      if (scenario === "error") return { status: "error", message: "Simulated offline connection failure. Use the scenario menu to reset." };
      emit("lab:opened", { id, title: connection.name || connection.deploymentId });
      emit("lab:state", { id, state: "ready" });
      navigate(`/workspace/?lab=${encodeURIComponent(id)}`);
      return { status: "opened", labUrl: connection.labUrl };
    } finally { if (operations.get(id) === token) operations.delete(id); }
  }
  const bridge = {
    platform: "darwin",
    ping: async () => "pong",
    isDevBuild: async () => false,
    isInitialWindow: async () => false,
    setCompact: async () => undefined,
    openSettingsSheet: async () => emit("app:navigate", "settings:notifications"),
    detectLocalStacks: async () => [],
    pickSshKey: async () => "/demo/keys/placeholder_ed25519",
    confirm: async ({ message, detail } = {}) => !!confirm([message, detail].filter(Boolean).join("\n")),
    onNavigate: (fn) => on("app:navigate", fn),
    auth: {
      status: async () => clone(auth), persistence: async () => "demo-local-storage",
      signIn: async (staging = false) => {
        auth = signedIn(staging); save("auth", auth); emit("auth:changed", auth); return clone(auth);
      },
      signOutEverywhere: async () => {
        operations.clear(); auth = { status: "signed-out" }; save("auth", auth);
        emit("auth:changed", auth); emit("auth:expired");
      },
      onChanged: (fn) => on("auth:changed", fn), onExpired: (fn) => on("auth:expired", fn),
    },
    signup: {
      open: async () => { signupOpen = true; emit("signup:opened"); navigate("/workspace/?new=1"); },
      close: async () => { signupOpen = false; emit("signup:closed"); },
      status: async () => signupOpen,
      onOpened: (fn) => on("signup:opened", fn), onClosed: (fn) => on("signup:closed", fn),
    },
    labs: {
      list: async () => requireAuth() ? { ok: true, labs: clone(getDiscovery()), gatewayUrl: auth.gatewayUrl, login: auth.login } : { ok: false, needsAuth: true },
      heldElsewhere: async () => [], focusHeld: async () => false,
    },
    settings: {
      get: async () => clone(settings),
      set: async (patch) => {
        settings = { ...settings, ...clone(patch), notifications: { ...settings.notifications, ...clone(patch?.notifications) } };
        save("settings", settings); emit("settings:changed", settings); return clone(settings);
      },
      onChanged: (fn) => on("settings:changed", fn),
    },
    lastOpened: {
      get: async (login) => read("lastOpened", {})?.[login] ?? null,
      set: async (login, id) => save("lastOpened", { ...read("lastOpened", {}), [login]: id }),
    },
    ssh: {
      listHosts: async () => clone(hosts),
      addHost: async (host) => {
        if (!host || !/^[a-zA-Z0-9._-]+$/.test(host.alias ?? "") || !host.hostName?.trim()) throw new Error("Provide a demo host name and valid alias.");
        if (host.port !== undefined && (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535)) throw new Error("Port must be between 1 and 65535.");
        const existing = hosts.find((h) => h.alias === host.alias);
        if (existing && existing.hostName !== host.hostName) throw new Error("That demo alias is already in use.");
        hosts = [...hosts.filter((h) => h.alias !== host.alias), clone(host)]; save("hosts", hosts); return clone(host);
      },
    },
    connections: {
      list: async () => clone(connections),
      upsert: async (draft) => {
        if (!draft || typeof draft !== "object") throw new Error("Invalid demo connection.");
        const record = { ...clone(draft), id: draft.id || `demo-added-${now()}-${++connectionId}` };
        const index = connections.findIndex((c) => c.id === record.id);
        if (index < 0) connections.push(record); else connections[index] = record;
        save("connections", connections); emit("connections:changed"); return clone(record);
      },
      remove: async (id) => { connections = connections.filter((c) => c.id !== id); save("connections", connections); emit("connections:changed"); },
      onChanged: (fn) => on("connections:changed", fn),
    },
    lab: {
      status: async () => "up",
      test: async (target) => {
        if (!target?.host?.trim()) return { ok: false, detail: "A demo host is required." };
        if (scenario === "host-key" && !accepted.has(target.host)) return { ok: false, hostKey: "unknown", detail: "Demo host key has not been accepted." };
        return { ok: true, detail: "Simulated SSH test passed. No SSH connection was made." };
      },
      hostKey: {
        scan: async () => ({ ok: true, keyType: "ssh-ed25519", fingerprint: "SHA256:DEMO_ONLY_NOT_A_REAL_HOST_KEY" }),
        accept: async (target) => { if (!target?.host) return { ok: false, error: "Missing demo host." }; accepted.add(target.host); return { ok: true }; },
      },
      open: (connection) => connect(connection),
      connect: (connection, _verbose, options) => connect(connection, options),
      update: (connection) => connect(connection, { update: true }),
      cancel: async (id) => { operations.delete(id); },
      down: async (connection) => { operations.delete(connection.id); emit("lab:state", { id: connection.id, state: "down" }); },
      onOutput: (fn) => on("lab:output", fn), onPhase: (fn) => on("lab:phase", fn),
    },
    update: {
      getState: async () => ({ phase: "idle", currentVersion: "0.137.0 · offline demo" }),
      install: async () => undefined, onState: (fn) => on("update:state", fn),
    },
    labView: {
      hide: async () => emit("lab:viewvis", { shown: false }),
      goBack: async () => undefined, goForward: async () => undefined,
      onNavState: (fn) => on("lab:navstate", fn), onOpened: (fn) => on("lab:opened", fn),
      onState: (fn) => on("lab:state", fn), onViewVis: (fn) => on("lab:viewvis", fn),
    },
    viewer: {
      retry: async () => { navigate("/workspace/"); },
      onRecovery: (fn) => { const off = on("viewer:recovery", fn); queueMicrotask(() => listeners.get("viewer:recovery")?.has(fn) && fn({ kind: "choose", message: "Choose a local demo workspace.", deployments: ["research-demo"] })); return off; },
      onTitle: (fn) => { const off = on("viewer:title", fn); queueMicrotask(() => listeners.get("viewer:title")?.has(fn) && fn("Offline demo")); return off; },
      onContentReady: (fn) => on("viewer:content-ready", fn),
    },
  };
  return bridge;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  let storage;
  try { storage = window.localStorage; } catch {}
  window.silico = createBridge({ storage, search: window.location.search,
    navigate: (url) => window.location.assign(url), confirm: (message) => window.confirm(message) });
  // Preserve the recovered screen while making the fixture boundary visible.
  const mountControls = () => {
    const box = document.createElement("aside");
    box.setAttribute("aria-label", "Offline preview controls");
    box.style.cssText = "position:fixed;right:8px;top:2px;z-index:99999;display:flex;align-items:center;gap:9px;padding:5px 8px;border:1px solid #d6d6d6;border-radius:6px;background:white;font:12px system-ui;color:#555";
    const label = document.createElement("span"); label.textContent = "Offline demo"; box.append(label);
    const link = document.createElement("a"); link.href = "/workspace/"; link.textContent = "Workspace"; box.append(link);
    const select = document.createElement("select"); select.setAttribute("aria-label", "Demo scenario");
    for (const name of ["default", "signed-out", "host-key", "waking", "forbidden", "error", "empty"]) {
      const option = document.createElement("option"); option.value = name; option.textContent = name; select.append(option);
    }
    select.value = new URLSearchParams(window.location.search).get("scenario") || "default";
    select.addEventListener("change", () => window.location.assign(`/shell/?reset=1&scenario=${encodeURIComponent(select.value)}`));
    box.append(select); document.body.append(box);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountControls, { once: true }); else mountControls();
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[href]");
    if (link && new URL(link.href, window.location.href).origin !== window.location.origin) {
      event.preventDefault(); window.alert("External links are disabled in this offline preview.");
    }
  }, true);
}
