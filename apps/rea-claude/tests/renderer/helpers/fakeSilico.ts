/**
 * Typed fake `window.silico` for renderer tests. Every invoke is a vi.fn with
 * a benign default; every `on*` subscription is recorded so tests can emit.
 */
import { vi } from "vitest";
import { DEFAULT_SETTINGS } from "@shared/config";
import type {
  AuthState,
  LabOpenedEvent,
  LabOutputEvent,
  LabPhaseEvent,
  LabStateEvent,
  NavState,
  NavigateDest,
  RecoveryState,
  Settings,
  SilicoApi,
  UpdateState,
  ViewVis,
} from "@shared/ipc";

type Listener<T> = (payload: T) => void;

export class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  on = (cb: Listener<T>): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
  emit(payload: T): void {
    for (const l of [...this.listeners]) l(payload);
  }
  get size(): number {
    return this.listeners.size;
  }
}

export const SIGNED_IN: Extract<AuthState, { status: "signed-in" }> = {
  status: "signed-in",
  login: "alice",
  sub: "github:1",
  gatewayUrl: "https://my.silico.run",
  expiresAt: 8.64e15,
  developer: false,
};

export interface FakeSilico {
  api: SilicoApi;
  events: {
    navigate: Emitter<NavigateDest>;
    authExpired: Emitter<undefined>;
    authChanged: Emitter<AuthState>;
    signupOpened: Emitter<undefined>;
    signupClosed: Emitter<undefined>;
    settingsChanged: Emitter<Settings>;
    connectionsChanged: Emitter<undefined>;
    labOutput: Emitter<LabOutputEvent>;
    labPhase: Emitter<LabPhaseEvent>;
    updateState: Emitter<UpdateState>;
    navState: Emitter<NavState>;
    labOpened: Emitter<LabOpenedEvent>;
    labState: Emitter<LabStateEvent>;
    viewVis: Emitter<ViewVis>;
    recovery: Emitter<RecoveryState>;
    viewerTitle: Emitter<string>;
    contentReady: Emitter<boolean>;
  };
}

export function makeFakeSilico(opts: { auth?: AuthState; settings?: Settings; initial?: boolean } = {}): FakeSilico {
  const ev: FakeSilico["events"] = {
    navigate: new Emitter(),
    authExpired: new Emitter(),
    authChanged: new Emitter(),
    signupOpened: new Emitter(),
    signupClosed: new Emitter(),
    settingsChanged: new Emitter(),
    connectionsChanged: new Emitter(),
    labOutput: new Emitter(),
    labPhase: new Emitter(),
    updateState: new Emitter(),
    navState: new Emitter(),
    labOpened: new Emitter(),
    labState: new Emitter(),
    viewVis: new Emitter(),
    recovery: new Emitter(),
    viewerTitle: new Emitter(),
    contentReady: new Emitter(),
  };
  const settings: Settings = opts.settings ?? { ...DEFAULT_SETTINGS };
  const auth: AuthState = opts.auth ?? { status: "signed-out" };
  const signal = (e: Emitter<undefined>) => (cb: () => void) => e.on(() => cb());

  const api: SilicoApi = {
    ping: vi.fn(async () => "pong" as const),
    platform: "darwin",
    isDevBuild: vi.fn(async () => false),
    isInitialWindow: vi.fn(async () => opts.initial ?? false),
    setCompact: vi.fn(async () => {}),
    openSettingsSheet: vi.fn(async () => {}),
    detectLocalStacks: vi.fn(async () => []),
    pickSshKey: vi.fn(async () => null),
    confirm: vi.fn(async () => true),
    onNavigate: ev.navigate.on,
    auth: {
      status: vi.fn(async () => auth),
      persistence: vi.fn(async () => "keychain" as const),
      signIn: vi.fn(async () => SIGNED_IN as AuthState),
      signOutEverywhere: vi.fn(async () => {}),
      onExpired: signal(ev.authExpired),
      onChanged: ev.authChanged.on,
    },
    signup: {
      open: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      status: vi.fn(async () => false),
      onOpened: signal(ev.signupOpened),
      onClosed: signal(ev.signupClosed),
    },
    labs: {
      list: vi.fn(async () =>
        auth.status === "signed-in"
          ? { ok: true as const, labs: [], gatewayUrl: auth.gatewayUrl, login: auth.login }
          : { ok: false as const, error: "signed out", needsAuth: true as const },
      ),
      heldElsewhere: vi.fn(async () => []),
      focusHeld: vi.fn(async () => false),
    },
    settings: {
      get: vi.fn(async () => settings),
      set: vi.fn(async (patch) => ({ ...settings, ...patch }) as Settings),
      onChanged: ev.settingsChanged.on,
    },
    lastOpened: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
    },
    ssh: {
      listHosts: vi.fn(async () => []),
      addHost: vi.fn(async () => {}),
    },
    connections: {
      list: vi.fn(async () => []),
      upsert: vi.fn(async (c) => ({ ...c, id: c.id ?? "new-id" })),
      remove: vi.fn(async () => {}),
      onChanged: signal(ev.connectionsChanged),
    },
    lab: {
      status: vi.fn(async () => "up" as const),
      test: vi.fn(async () => ({ ok: true as const, detail: "ok" })),
      hostKey: {
        scan: vi.fn(async (t) => ({ ok: true as const, host: t.host, keyType: "ssh-ed25519", fingerprint: "SHA256:abc" })),
        accept: vi.fn(async () => ({ ok: true as const })),
      },
      open: vi.fn(async () => ({ status: "opened" as const })),
      connect: vi.fn(async () => ({ status: "opened" as const })),
      update: vi.fn(async () => ({ status: "opened" as const })),
      cancel: vi.fn(async () => {}),
      down: vi.fn(async () => {}),
      onOutput: ev.labOutput.on,
      onPhase: ev.labPhase.on,
    },
    update: {
      getState: vi.fn(async () => ({ phase: "idle" as const, currentVersion: "1.2.3" })),
      install: vi.fn(async () => {}),
      onState: ev.updateState.on,
    },
    labView: {
      hide: vi.fn(async () => {}),
      goBack: vi.fn(async () => {}),
      goForward: vi.fn(async () => {}),
      onNavState: ev.navState.on,
      onOpened: ev.labOpened.on,
      onState: ev.labState.on,
      onViewVis: ev.viewVis.on,
    },
    viewer: {
      retry: vi.fn(async () => {}),
      onRecovery: ev.recovery.on,
      onTitle: ev.viewerTitle.on,
      onContentReady: ev.contentReady.on,
    },
  };
  return { api, events: ev };
}

/** Install a fake as window.silico and return it. */
export function installFakeSilico(opts?: Parameters<typeof makeFakeSilico>[0]): FakeSilico {
  const fake = makeFakeSilico(opts);
  Object.defineProperty(window, "silico", { value: fake.api, configurable: true, writable: true });
  return fake;
}
