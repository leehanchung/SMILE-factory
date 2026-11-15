/**
 * Electron fakes for bridge tests. Use with:
 *   vi.mock("electron", async () => (await import("./fakes")).electronMock);
 */
import { vi } from "vitest";

type Fn = (...args: unknown[]) => unknown;

export class FakeSession {
  verifyProc: Fn | null = null;
  requestHandler: Fn | null = null;
  checkHandler: Fn | null = null;
  constructor(readonly name: string) {}
  setCertificateVerifyProc(fn: Fn) {
    this.verifyProc = fn;
  }
  setPermissionRequestHandler(fn: Fn) {
    this.requestHandler = fn;
  }
  setPermissionCheckHandler(fn: Fn) {
    this.checkHandler = fn;
  }
}

export class FakeNotification {
  static supported = true;
  static instances: FakeNotification[] = [];
  static isSupported() {
    return FakeNotification.supported;
  }
  shown = false;
  private readonly handlers = new Map<string, Fn[]>();
  constructor(readonly opts: { title: string; body: string; silent: boolean }) {
    FakeNotification.instances.push(this);
  }
  on(ev: string, fn: Fn) {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]);
    return this;
  }
  show() {
    this.shown = true;
  }
  emit(ev: string) {
    for (const fn of this.handlers.get(ev) ?? []) fn();
  }
}

export const state = {
  appListeners: new Map<string, Fn[]>(),
  sessions: new Map<string, FakeSession>(),
  defaultSession: new FakeSession("default"),
  focusedWindow: null as FakeWin | null,
  allWindows: [] as FakeWin[],
  handlers: new Map<string, Fn>(),
  listeners: new Map<string, Fn>(),
  dock: { setBadge: vi.fn() },
  setBadgeCount: vi.fn(),
  appFocus: vi.fn(),
  idle: 7 as number | (() => number),
  showMessageBox: vi.fn(async () => ({ response: 0 })),
};

export function labSession(): FakeSession {
  return electronMock.session.fromPartition("persist:silico");
}

export function resetElectron(): void {
  state.appListeners.clear();
  state.sessions.clear();
  state.defaultSession = new FakeSession("default");
  state.focusedWindow = null;
  state.allWindows = [];
  state.handlers.clear();
  state.listeners.clear();
  state.dock.setBadge.mockReset();
  state.setBadgeCount.mockReset();
  state.appFocus.mockReset();
  state.idle = 7;
  state.showMessageBox.mockReset();
  state.showMessageBox.mockImplementation(async () => ({ response: 0 }));
  FakeNotification.supported = true;
  FakeNotification.instances = [];
}

export function emitApp(ev: string, ...args: unknown[]): void {
  for (const fn of state.appListeners.get(ev) ?? []) fn(...args);
}

export const electronMock = {
  app: {
    on(ev: string, fn: Fn) {
      state.appListeners.set(ev, [...(state.appListeners.get(ev) ?? []), fn]);
    },
    focus: (...a: unknown[]) => state.appFocus(...a),
    get dock() {
      return state.dock;
    },
    setBadgeCount: (n: number) => state.setBadgeCount(n),
  },
  BrowserWindow: {
    getFocusedWindow: () => state.focusedWindow,
    getAllWindows: () => state.allWindows,
  },
  Notification: FakeNotification,
  dialog: { showMessageBox: (...a: unknown[]) => (state.showMessageBox as unknown as Fn)(...a) },
  powerMonitor: {
    getSystemIdleTime: () => {
      const v = state.idle;
      return typeof v === "function" ? v() : v;
    },
  },
  session: {
    get defaultSession() {
      return state.defaultSession;
    },
    fromPartition(p: string) {
      let s = state.sessions.get(p);
      if (!s) {
        s = new FakeSession(p);
        state.sessions.set(p, s);
      }
      return s;
    },
  },
  ipcMain: {
    handle: (ch: string, fn: Fn) => state.handlers.set(ch, fn),
    on: (ch: string, fn: Fn) => state.listeners.set(ch, fn),
  },
};

export class FakeWc {
  destroyed = false;
  sent: unknown[][] = [];
  private readonly onceHandlers = new Map<string, Fn[]>();
  constructor(
    public url = "https://lab.silico.run/home",
    public session: unknown = labSession(),
  ) {}
  isDestroyed() {
    return this.destroyed;
  }
  getURL() {
    return this.url;
  }
  send(...a: unknown[]) {
    this.sent.push(a);
  }
  once(ev: string, fn: Fn) {
    this.onceHandlers.set(ev, [...(this.onceHandlers.get(ev) ?? []), fn]);
  }
  destroy() {
    this.destroyed = true;
    const hs = this.onceHandlers.get("destroyed") ?? [];
    this.onceHandlers.delete("destroyed");
    for (const fn of hs) fn();
  }
}

let nextWinId = 1;
export class FakeWin {
  readonly id = nextWinId++;
  destroyed = false;
  focused = false;
  minimized = false;
  calls: string[] = [];
  private readonly handlers = new Map<string, Fn[]>();
  isDestroyed() {
    return this.destroyed;
  }
  isFocused() {
    return this.focused;
  }
  isMinimized() {
    return this.minimized;
  }
  restore() {
    this.calls.push("restore");
    this.minimized = false;
  }
  show() {
    this.calls.push("show");
  }
  focus() {
    this.calls.push("focus");
  }
  on(ev: string, fn: Fn) {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]);
  }
  emit(ev: string) {
    for (const fn of this.handlers.get(ev) ?? []) fn();
  }
}
