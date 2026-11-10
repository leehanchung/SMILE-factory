import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { CompactController } from "../../../src/main/windows/compact";
import type { CompactWindow } from "../../../src/main/windows/compact";
import {
  buildContextMenuTemplate,
  buildDockMenuTemplate,
  buildMenuTemplate,
  isDevFromSettings,
} from "../../../src/main/windows/menuTemplate";
import type { MenuActions } from "../../../src/main/windows/menuTemplate";
import {
  createLastOpenedStore,
  createWindowStateSaver,
  parseLastOpened,
  readWindowState,
} from "../../../src/main/windows/persistence";
import { createWatchdog } from "../../../src/main/windows/watchdog";
import type { WatchdogDeps } from "../../../src/main/windows/watchdog";
import { DEFAULT_SETTINGS } from "@shared/config";

// --------------------------------------------------------------------------- menu

function actions(): MenuActions & Record<string, ReturnType<typeof vi.fn>> {
  return {
    navigate: vi.fn(),
    checkForUpdates: vi.fn(),
    newWindow: vi.fn(),
    reload: vi.fn(),
    toggleDevTools: vi.fn(),
    zoom: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    openHelp: vi.fn(),
    sendFeedback: vi.fn(),
  };
}

function flat(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? flat(i.submenu) : [])]);
}
function byLabel(items: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions | undefined {
  return flat(items).find((i) => i.label === label);
}
function top(items: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions[] {
  const m = items.find((i) => i.label === label);
  return (m?.submenu as MenuItemConstructorOptions[]) ?? [];
}

describe("menu template", () => {
  it("darwin, not dev, packaged: no developer items", () => {
    const t = buildMenuTemplate({ platform: "darwin", dev: false, isPackaged: true, appName: "Rea Claude" }, actions());
    expect(byLabel(t, "Developer settings")).toBeUndefined();
    expect(byLabel(t, "Toggle Developer Tools")).toBeUndefined();
    expect(t[0]?.label).toBe("Rea Claude");
    const appMenu = top(t, "Rea Claude");
    expect(appMenu.map((i) => i.role ?? i.label ?? i.type)).toEqual([
      "about",
      "Check for Updates…",
      "separator",
      "Notifications",
      "Profile",
      "separator",
      "services",
      "separator",
      "hide",
      "hideOthers",
      "unhide",
      "separator",
      "quit",
    ]);
    expect(top(t, "File").map((i) => i.role ?? i.label ?? i.type)).toEqual(["New Window", "separator", "close"]);
  });

  it("win32 dev: File holds settings items, quit role, Ctrl+Shift+I", () => {
    const t = buildMenuTemplate({ platform: "win32", dev: true, isPackaged: true, appName: "x" }, actions());
    expect(t[0]?.label).toBe("File");
    const file = top(t, "File").map((i) => i.role ?? i.label ?? i.type);
    expect(file).toEqual(["New Window", "separator", "Notifications", "Developer settings", "Profile", "separator", "quit"]);
    expect(byLabel(t, "Toggle Developer Tools")?.accelerator).toBe("Ctrl+Shift+I");
  });

  it("unpackaged always shows devtools (mac accelerator)", () => {
    const t = buildMenuTemplate({ platform: "darwin", dev: false, isPackaged: false, appName: "x" }, actions());
    expect(byLabel(t, "Toggle Developer Tools")?.accelerator).toBe("Alt+Command+I");
  });

  it("accelerators and actions", () => {
    const a = actions();
    const t = buildMenuTemplate({ platform: "darwin", dev: true, isPackaged: true, appName: "x" }, a);
    const accel = (l: string) => byLabel(t, l)?.accelerator;
    expect(accel("Notifications")).toBe("CmdOrCtrl+,");
    expect(accel("New Window")).toBe("CmdOrCtrl+N");
    expect(accel("Reload")).toBe("CmdOrCtrl+R");
    expect(accel("Force Reload")).toBe("Shift+CmdOrCtrl+R");
    expect(accel("Actual Size")).toBe("CmdOrCtrl+0");
    expect(accel("Zoom In")).toBe("CmdOrCtrl+Plus");
    expect(accel("Zoom Out")).toBe("CmdOrCtrl+-");
    expect(accel("Back")).toBe("CmdOrCtrl+[");
    expect(accel("Forward")).toBe("CmdOrCtrl+]");
    expect(accel("Send feedback")).toBe("CmdOrCtrl+Shift+/");
    const click = (l: string) => (byLabel(t, l)?.click as unknown as () => void)();
    click("Developer settings");
    expect(a.navigate).toHaveBeenCalledWith("settings:developer");
    click("Profile");
    expect(a.navigate).toHaveBeenCalledWith("settings:profile");
    click("Force Reload");
    expect(a.reload).toHaveBeenCalledWith(true);
    click("Zoom Out");
    expect(a.zoom).toHaveBeenCalledWith(-0.5);
    click("Actual Size");
    expect(a.zoom).toHaveBeenCalledWith("reset");
    click("Send feedback");
    expect(a.sendFeedback).toHaveBeenCalled();
    click("Check for Updates…");
    expect(a.checkForUpdates).toHaveBeenCalled();
    click("Help center");
    expect(a.openHelp).toHaveBeenCalled();
    expect(t.map((i) => i.role ?? i.label)).toEqual(["x", "File", "editMenu", "View", "History", "windowMenu", "help"]);
  });

  it("dock menu", () => {
    const nw = vi.fn();
    const d = buildDockMenuTemplate(nw);
    expect(d).toHaveLength(1);
    (d[0]?.click as unknown as () => void)();
    expect(nw).toHaveBeenCalled();
  });

  it("isDevFromSettings", () => {
    expect(isDevFromSettings(DEFAULT_SETTINGS)).toBe(false);
    expect(isDevFromSettings({ ...DEFAULT_SETTINGS, verbose: true })).toBe(true);
    expect(isDevFromSettings({ ...DEFAULT_SETTINGS, skipVersionCheck: true })).toBe(true);
    expect(isDevFromSettings(null)).toBe(false);
  });

  it("context menu", () => {
    const flags = { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: false, canSelectAll: true };
    const a = { replaceMisspelling: vi.fn(), addToDictionary: vi.fn() };
    expect(buildContextMenuTemplate({ isEditable: false, misspelledWord: "", dictionarySuggestions: [], editFlags: flags }, a)).toBeNull();
    const plain = buildContextMenuTemplate({ isEditable: true, misspelledWord: "", dictionarySuggestions: [], editFlags: flags }, a);
    expect(plain?.map((i) => i.role ?? i.type)).toEqual(["undo", "redo", "separator", "cut", "copy", "paste", "selectAll"]);
    expect(plain?.[1]?.enabled).toBe(false);
    const sp = buildContextMenuTemplate(
      { isEditable: true, misspelledWord: "teh", dictionarySuggestions: ["the", "ten"], editFlags: flags },
      a,
    );
    expect(sp?.slice(0, 4).map((i) => i.label ?? i.type)).toEqual(["the", "ten", "Add to Dictionary", "separator"]);
    (sp?.[0]?.click as unknown as () => void)();
    expect(a.replaceMisspelling).toHaveBeenCalledWith("the");
    (sp?.[2]?.click as unknown as () => void)();
    expect(a.addToDictionary).toHaveBeenCalledWith("teh");
    const none = buildContextMenuTemplate(
      { isEditable: true, misspelledWord: "zzq", dictionarySuggestions: [], editFlags: flags },
      a,
    );
    expect(none?.[0]).toEqual({ label: "No spelling suggestions", enabled: false });
  });
});

// --------------------------------------------------------------------------- watchdog

describe("watchdog", () => {
  function deps(over: Partial<WatchdogDeps> = {}): WatchdogDeps & { t: number; rewake: ReturnType<typeof vi.fn> } {
    const d = {
      t: 100_000,
      revealed: () => [{ winId: 1, connId: "c" }],
      presence: () => true,
      isManaged: async () => false,
      labOrigin: () => "https://lab.x",
      probe: async () => "up" as const,
      probePage: async () => "alive" as const,
      ...over,
      rewake: vi.fn(),
    };
    return Object.assign(d, { now: () => d.t });
  }

  it("managed: two consecutive health downs rewake", async () => {
    const d = deps({ isManaged: async () => true, probe: async () => "down" });
    const w = createWatchdog(d);
    await w.tick();
    expect(d.rewake).not.toHaveBeenCalled();
    await w.tick();
    expect(d.rewake).toHaveBeenCalledWith(1, "c");
  });

  it("health up resets pod strikes", async () => {
    let h: "up" | "down" = "down";
    const d = deps({ isManaged: async () => true, probe: async () => h });
    const w = createWatchdog(d);
    await w.tick();
    h = "up";
    await w.tick();
    h = "down";
    await w.tick();
    expect(d.rewake).not.toHaveBeenCalled();
  });

  it("page dead strikes need 10 s spacing and cap at 2 rewakes", async () => {
    const d = deps({ probePage: async () => "dead" });
    const w = createWatchdog(d);
    await w.tick(); // strike 1
    d.t += 5_000;
    await w.tick(); // too soon
    expect(d.rewake).not.toHaveBeenCalled();
    d.t += 5_000;
    await w.tick(); // strike 2 → rewake #1
    expect(d.rewake).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 2; i++) {
      d.t += 10_000;
      await w.tick();
    }
    expect(d.rewake).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 4; i++) {
      d.t += 10_000;
      await w.tick();
    }
    expect(d.rewake).toHaveBeenCalledTimes(2);
  });

  it("alive resets the page rewake budget; unknown and absence skip", async () => {
    let page: "alive" | "dead" | "unknown" = "unknown";
    let present = false;
    const d = deps({ probePage: async () => page, presence: () => present });
    const w = createWatchdog(d);
    page = "dead";
    await w.tick();
    expect(d.rewake).not.toHaveBeenCalled();
    present = true;
    page = "unknown";
    await w.tick();
    page = "alive";
    await w.tick();
    expect(d.rewake).not.toHaveBeenCalled();
  });

  it("skips rewake when the Lab is no longer revealed", async () => {
    let calls = 0;
    const d = deps({
      probePage: async () => "dead",
      revealed: () => (calls++ < 2 ? [{ winId: 1, connId: "c" }] : []),
    });
    const w = createWatchdog(d);
    await w.tick();
    d.t += 10_000;
    await w.tick();
    expect(d.rewake).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------- persistence

describe("persistence", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rea-win-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("parseLastOpened drops non-strings", () => {
    expect(parseLastOpened('{"version":1,"byAccount":{"a":"x","b":3}}')).toEqual({ a: "x" });
    expect(parseLastOpened("[]")).toEqual({});
    expect(parseLastOpened("nope")).toEqual({});
  });

  it("lastOpened set/get serialized, merges accounts", async () => {
    const s = createLastOpenedStore(() => dir);
    expect(await s.get("a")).toBeNull();
    await Promise.all([s.set("a", "1"), s.set("b", "2"), s.set("a", "3")]);
    expect(await s.get("a")).toBe("3");
    expect(await s.get("b")).toBe("2");
    const raw = JSON.parse(readFileSync(join(dir, "last-opened.json"), "utf-8"));
    expect(raw).toEqual({ version: 1, byAccount: { a: "3", b: "2" } });
  });

  it("window state: debounced write and validated read", () => {
    vi.useFakeTimers();
    const saver = createWindowStateSaver(() => dir);
    saver.save({ x: 1, y: 1, width: 10, height: 10 });
    saver.save({ x: 2, y: 3, width: 900, height: 700 });
    expect(readWindowState(dir, [{ x: 0, y: 0, width: 1440, height: 900 }])).toBeUndefined();
    vi.advanceTimersByTime(250);
    expect(readWindowState(dir, [{ x: 0, y: 0, width: 1440, height: 900 }])).toEqual({ x: 2, y: 3, width: 900, height: 700 });
    expect(readWindowState(dir, [{ x: 5000, y: 0, width: 100, height: 100 }])).toBeUndefined();
    writeFileSync(join(dir, "window-state.json"), "{bad");
    expect(readWindowState(dir, [{ x: 0, y: 0, width: 1440, height: 900 }])).toBeUndefined();
  });
});

// --------------------------------------------------------------------------- compact

class Win implements CompactWindow {
  bounds = { x: 0, y: 0, width: 1280, height: 840 };
  frame = 28;
  fs = false;
  max = false;
  min: [number, number] = [0, 0];
  private listeners: (() => void)[] = [];
  constructor(readonly id = 1) {}
  isDestroyed() {
    return false;
  }
  getBounds() {
    return { ...this.bounds };
  }
  getContentBounds() {
    return { ...this.bounds, height: this.bounds.height - this.frame };
  }
  getNormalBounds() {
    return { ...this.bounds };
  }
  setBounds(b: { x: number; y: number; width: number; height: number }) {
    this.bounds = { ...b };
    for (const l of this.listeners) l();
  }
  setMinimumSize(w: number, h: number) {
    this.min = [w, h];
  }
  isFullScreen() {
    return this.fs;
  }
  isMaximized() {
    return this.max;
  }
  on(_e: "resize", l: () => void) {
    this.listeners.push(l);
    return this;
  }
  userResize(h: number) {
    this.setBounds({ ...this.bounds, height: h });
  }
}

describe("CompactController", () => {
  const wa = { x: 0, y: 0, width: 1440, height: 900 };
  it("enter, resize, leave", () => {
    const c = new CompactController(() => wa);
    const w = new Win();
    const first = vi.fn();
    c.onNextApply(w.id, first);
    c.apply(w, true, 500);
    expect(first).toHaveBeenCalledTimes(1);
    expect(c.isCompact(1)).toBe(true);
    expect(w.min).toEqual([520, 500]);
    expect(w.bounds).toEqual({ x: 330, y: 156, width: 620, height: 528 });
    // new content height
    c.apply(w, true, 700);
    expect(w.bounds.height).toBe(728);
    // ≤1 px change ignored
    c.apply(w, true, 700.5);
    expect(w.bounds.height).toBe(728);
    c.apply(w, true, 702);
    expect(w.bounds.height).toBe(730);
    // user resized → no more automatic heights
    w.userResize(800);
    c.apply(w, true, 600);
    expect(w.bounds.height).toBe(800);
    // leave: restore normal bounds centered
    c.apply(w, false);
    expect(c.isCompact(1)).toBe(false);
    expect(w.min).toEqual([823, 540]);
    expect(w.bounds.width).toBe(1280);
    expect(w.bounds.height).toBe(840);
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("entering while fullscreen does not resize; leaving without stored normal falls back", () => {
    const c = new CompactController(() => wa);
    const w = new Win(2);
    w.fs = true;
    c.apply(w, true, 600);
    expect(w.bounds.width).toBe(1280);
    w.fs = false;
    c.apply(w, false);
    expect(w.bounds).toMatchObject({ width: 1280, height: 840 });
  });

  it("default height when none given; leaving with a small stored size uses defaults", () => {
    const c = new CompactController(() => wa);
    const w = new Win(3);
    w.bounds = { x: 0, y: 0, width: 700, height: 500 };
    c.apply(w, true);
    expect(w.bounds.height).toBe(708);
    c.apply(w, false);
    expect(w.bounds).toMatchObject({ width: 1280, height: 840 });
    c.apply(w, false);
    c.clear(3);
    expect(c.isCompact(3)).toBe(false);
  });
});
