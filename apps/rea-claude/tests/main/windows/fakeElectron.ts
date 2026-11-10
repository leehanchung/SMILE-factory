/**
 * Minimal in-memory Electron fake for windows-area glue tests.
 * Usage: `vi.mock("electron", async () => (await import("./fakeElectron")).electron);`
 */
import { EventEmitter } from "node:events";
import { vi } from "vitest";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

let nextWcId = 1;
let nextWinId = 1;

export const labSession = { name: "persist:silico", addWordToSpellCheckerDictionary: vi.fn() };
export const defaultSession = { name: "default", addWordToSpellCheckerDictionary: vi.fn() };

export class FakeWebContents extends EventEmitter {
  readonly id = nextWcId++;
  url = "";
  destroyed = false;
  crashed = false;
  loading = false;
  focused = false;
  devTools = false;
  zoomFactor = 1;
  zoomLevel = 0;
  readonly sent: unknown[][] = [];
  readonly mainFrame = { isDestroyed: () => false, url: "" };
  session: unknown;
  canBack = false;
  canFwd = false;
  openHandler: ((d: { url: string }) => unknown) | null = null;
  /** Script → result (or function). Unknown scripts resolve undefined. */
  scriptResult: (script: string) => unknown = () => undefined;
  readonly loaded: string[] = [];
  readonly navigationHistory = {
    canGoBack: () => this.canBack,
    canGoForward: () => this.canFwd,
    goBack: vi.fn(),
    goForward: vi.fn(),
  };
  reload = vi.fn();
  reloadIgnoringCache = vi.fn();
  invalidate = vi.fn();
  replaceMisspelling = vi.fn();

  constructor(session: unknown = defaultSession) {
    super();
    this.session = session;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isCrashed(): boolean {
    return this.crashed;
  }
  isLoading(): boolean {
    return this.loading;
  }
  isFocused(): boolean {
    return this.focused;
  }
  focus(): void {
    this.focused = true;
  }
  getURL(): string {
    return this.url;
  }
  getZoomFactor(): number {
    return this.zoomFactor;
  }
  send(...args: unknown[]): void {
    this.sent.push(args);
  }
  sentOn(channel: string): unknown[] {
    return this.sent.filter((s) => s[0] === channel).map((s) => s[1]);
  }
  loadURL(url: string): Promise<void> {
    this.url = url;
    this.loaded.push(url);
    return Promise.resolve();
  }
  loadFile(file: string, opts?: { hash?: string }): Promise<void> {
    const url = `file://${file}${opts?.hash ? `#${opts.hash}` : ""}`;
    this.url = url;
    this.loaded.push(url);
    return Promise.resolve();
  }
  executeJavaScript(script: string): Promise<unknown> {
    try {
      const r = this.scriptResult(script);
      return r instanceof Promise ? r : Promise.resolve(r);
    } catch (e) {
      return Promise.reject(e);
    }
  }
  setWindowOpenHandler(fn: (d: { url: string }) => unknown): void {
    this.openHandler = fn;
  }
  close(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("destroyed");
  }
  isDevToolsOpened(): boolean {
    return this.devTools;
  }
  openDevTools(): void {
    this.devTools = true;
  }
  closeDevTools(): void {
    this.devTools = false;
  }
}

export class FakeView {
  readonly webContents: FakeWebContents;
  visible = true;
  bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  readonly opts: { webPreferences?: Record<string, unknown> };
  constructor(opts: { webPreferences?: Record<string, unknown> } = {}) {
    this.opts = opts;
    const partition = opts.webPreferences?.partition;
    this.webContents = new FakeWebContents(partition === "persist:silico" ? labSession : defaultSession);
    views.push(this);
  }
  setVisible(v: boolean): void {
    this.visible = v;
  }
  setBounds(b: Rect): void {
    this.bounds = b;
  }
}

export const views: FakeView[] = [];

export class FakeWindow extends EventEmitter {
  static all: FakeWindow[] = [];
  static focused: FakeWindow | null = null;
  readonly id = nextWinId++;
  readonly opts: Record<string, unknown>;
  readonly webContents = new FakeWebContents();
  bounds: Rect;
  frame = 28;
  destroyed = false;
  visible = false;
  minimized = false;
  fullScreen = false;
  maximized = false;
  title = "";
  minSize: [number, number] = [0, 0];
  readonly children: FakeView[] = [];
  readonly contentView = {
    addChildView: (v: FakeView) => this.children.push(v),
    removeChildView: (v: FakeView) => {
      const i = this.children.indexOf(v);
      if (i >= 0) this.children.splice(i, 1);
    },
  };
  show = vi.fn(() => {
    this.visible = true;
  });
  showInactive = vi.fn(() => {
    this.visible = true;
  });
  focus = vi.fn(() => {
    FakeWindow.focused = this;
  });
  restore = vi.fn(() => {
    this.minimized = false;
  });
  setMenuBarVisibility = vi.fn();
  setIgnoreMouseEvents = vi.fn();
  setOpacity = vi.fn();

  constructor(opts: Record<string, unknown> = {}) {
    super();
    this.opts = opts;
    this.bounds = {
      x: (opts.x as number) ?? 100,
      y: (opts.y as number) ?? 100,
      width: (opts.width as number) ?? 800,
      height: (opts.height as number) ?? 600,
    };
    FakeWindow.all.push(this);
  }
  static getAllWindows(): FakeWindow[] {
    return FakeWindow.all.filter((w) => !w.destroyed);
  }
  static getFocusedWindow(): FakeWindow | null {
    return FakeWindow.focused && !FakeWindow.focused.destroyed ? FakeWindow.focused : null;
  }
  static fromId(id: number): FakeWindow | null {
    return FakeWindow.all.find((w) => w.id === id && !w.destroyed) ?? null;
  }
  static fromWebContents(wc: FakeWebContents): FakeWindow | null {
    return FakeWindow.all.find((w) => w.webContents === wc) ?? null;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  getBounds(): Rect {
    return { ...this.bounds };
  }
  getNormalBounds(): Rect {
    return { ...this.bounds };
  }
  getContentBounds(): Rect {
    return { ...this.bounds, height: this.bounds.height - this.frame };
  }
  getContentSize(): number[] {
    return [this.bounds.width, this.bounds.height - this.frame];
  }
  getPosition(): number[] {
    return [this.bounds.x, this.bounds.y];
  }
  setBounds(b: Rect): void {
    this.bounds = { ...b };
    this.emit("resize");
  }
  setMinimumSize(w: number, h: number): void {
    this.minSize = [w, h];
  }
  isFullScreen(): boolean {
    return this.fullScreen;
  }
  isMaximized(): boolean {
    return this.maximized;
  }
  isFocused(): boolean {
    return FakeWindow.focused === this;
  }
  isVisible(): boolean {
    return this.visible;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  setTitle(t: string): void {
    this.title = t;
  }
  getParentWindow(): FakeWindow | null {
    return (this.opts.parent as FakeWindow | undefined) ?? null;
  }
  loadURL(url: string): Promise<void> {
    return this.webContents.loadURL(url);
  }
  loadFile(file: string, opts?: { hash?: string }): Promise<void> {
    return this.webContents.loadFile(file, opts);
  }
  close(): void {
    this.destroy();
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.webContents.destroyed = true;
    if (FakeWindow.focused === this) FakeWindow.focused = null;
    this.emit("closed");
  }
}

class FakeApp extends EventEmitter {
  name = "Rea Claude";
  focus = vi.fn();
  dock = { bounce: vi.fn(), setMenu: vi.fn() };
}

export const app = new FakeApp();
export const powerMonitor = Object.assign(new EventEmitter(), { getSystemIdleTime: vi.fn(() => 0) });
export const menus: { template: unknown[]; popup: ReturnType<typeof vi.fn> }[] = [];
export const Menu = {
  setApplicationMenu: vi.fn(),
  buildFromTemplate: vi.fn((template: unknown[]) => {
    const m = { template, popup: vi.fn() };
    menus.push(m);
    return m;
  }),
};
export const shell = { openExternal: vi.fn(() => Promise.resolve()) };
export const dialog = { showMessageBox: vi.fn(async () => ({ response: 1 })) };
export const nativeImage = { createFromPath: vi.fn(() => ({ isEmpty: () => true })) };
export const net = { fetch: vi.fn() };
export const screen = {
  getDisplayMatching: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })),
  getAllDisplays: vi.fn(() => [{ workArea: { x: 0, y: 0, width: 1440, height: 900 } }]),
};
export const webContents = {
  focused: null as FakeWebContents | null,
  getFocusedWebContents(): FakeWebContents | null {
    return this.focused;
  },
  getAllWebContents(): FakeWebContents[] {
    return [];
  },
};
export const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
export const ipcMain = {
  handle: (ch: string, fn: (event: unknown, ...args: unknown[]) => unknown) => ipcHandlers.set(ch, fn),
  on: vi.fn(),
};
export const session = { fromPartition: (p: string) => (p === "persist:silico" ? labSession : { name: p }) };

export function resetFakes(): void {
  FakeWindow.all = [];
  FakeWindow.focused = null;
  views.length = 0;
  menus.length = 0;
  ipcHandlers.clear();
  app.removeAllListeners();
  powerMonitor.removeAllListeners();
  webContents.focused = null;
  vi.clearAllMocks();
}

export const electron = {
  app,
  BrowserWindow: FakeWindow,
  WebContentsView: FakeView,
  Menu,
  shell,
  dialog,
  nativeImage,
  net,
  screen,
  powerMonitor,
  webContents,
  ipcMain,
  session,
};
