/** Minimal fake Electron windows / webContents / views for auth tests. */
type Fn = (...args: unknown[]) => unknown;

export class FakeWc {
  url = "";
  destroyed = false;
  sent: unknown[][] = [];
  js: string[] = [];
  jsResult: unknown = 0;
  zoom = 1;
  loads: string[] = [];
  loadError: Error | null = null;
  openHandler: ((d: { url: string }) => { action: string }) | null = null;
  private readonly handlers = new Map<string, Fn[]>();
  session: unknown = {};
  isDestroyed(): boolean {
    return this.destroyed;
  }
  getURL(): string {
    return this.url;
  }
  send(...a: unknown[]): void {
    this.sent.push(a);
  }
  on(ev: string, fn: Fn): this {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]);
    return this;
  }
  emit(ev: string, ...args: unknown[]): void {
    for (const fn of this.handlers.get(ev) ?? []) fn(...args);
  }
  setWindowOpenHandler(fn: (d: { url: string }) => { action: string }): void {
    this.openHandler = fn;
  }
  async loadURL(u: string): Promise<void> {
    this.loads.push(u);
    if (this.loadError) throw this.loadError;
    this.url = u;
  }
  executeJavaScript(code: string): Promise<unknown> {
    this.js.push(code);
    return Promise.resolve(this.jsResult);
  }
  close(): void {
    this.destroyed = true;
  }
  getZoomFactor(): number {
    return this.zoom;
  }
}

export class FakeView {
  webContents = new FakeWc();
  bounds: unknown = null;
  visible = false;
  setBounds(b: unknown): void {
    this.bounds = b;
  }
  setVisible(v: boolean): void {
    this.visible = v;
  }
}

let nextId = 1;

export class FakeWin {
  id = nextId++;
  destroyed = false;
  minimized = false;
  visible = true;
  parent: FakeWin | null = null;
  calls: string[] = [];
  webContents = new FakeWc();
  children: unknown[] = [];
  contentView = {
    addChildView: (v: unknown) => void this.children.push(v),
    removeChildView: (v: unknown) => {
      this.children = this.children.filter((c) => c !== v);
    },
  };
  constructor() {
    this.webContents.url = "file:///index.html";
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  getContentSize(): number[] {
    return [1000, 800];
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  isVisible(): boolean {
    return this.visible;
  }
  restore(): void {
    this.calls.push("restore");
    this.minimized = false;
  }
  show(): void {
    this.calls.push("show");
  }
  showInactive(): void {
    this.calls.push("showInactive");
  }
  focus(): void {
    this.calls.push("focus");
  }
  flashFrame(v: boolean): void {
    this.calls.push(`flash:${v}`);
  }
  once(ev: string, fn: Fn): void {
    this.calls.push(`once:${ev}`);
    void fn;
  }
  getParentWindow(): FakeWin | null {
    return this.parent;
  }
}

/** Shared electron mock factory body (use inside vi.mock). */
export function electronMock(handlers: Map<string, Fn>): Record<string, unknown> {
  return {
    ipcMain: { handle: (ch: string, fn: Fn) => handlers.set(ch, fn), on: () => {} },
    session: { fromPartition: (p: string) => ({ partition: p }) },
    BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
    WebContentsView: class {},
    app: { focus: () => {}, dock: { bounce: () => 0 } },
    net: { fetch: () => Promise.reject(new Error("network disabled in tests")) },
    safeStorage: { isEncryptionAvailable: () => false },
    shell: { openExternal: () => Promise.resolve() },
  };
}
