/**
 * Pure application/dock/context menu templates (windows spec §5). Only
 * Electron *types* are imported, so templates are testable without Electron.
 */
import type { MenuItemConstructorOptions } from "electron";
import type { NavigateDest, Settings } from "@shared/ipc";

export type ZoomStep = "reset" | number;

export interface MenuActions {
  navigate(dest: NavigateDest): void;
  checkForUpdates(): void;
  newWindow(): void;
  reload(ignoreCache: boolean): void;
  toggleDevTools(): void;
  zoom(step: ZoomStep): void;
  back(): void;
  forward(): void;
  openHelp(): void;
  sendFeedback(): void;
}

export interface MenuOptions {
  platform: string;
  /** settings-dev || signed-in developer. */
  dev: boolean;
  isPackaged: boolean;
  /** `app.name` (label of the macOS app menu). */
  appName: string;
}

const ZOOM_DELTA = 0.5;

/** `settingsDev` = any of the developer-ish settings (platform §4.1). */
export function isDevFromSettings(s: Partial<Settings> | null | undefined): boolean {
  return !!(s && (s.developerMode || s.staging || s.previewBuilds || s.verbose || s.skipVersionCheck));
}

export function buildMenuTemplate(opts: MenuOptions, a: MenuActions): MenuItemConstructorOptions[] {
  const mac = opts.platform === "darwin";
  const settingsItems: MenuItemConstructorOptions[] = [
    { label: "Notifications", accelerator: "CmdOrCtrl+,", click: () => a.navigate("settings:notifications") },
    ...(opts.dev ? [{ label: "Developer settings", click: () => a.navigate("settings:developer") }] : []),
    { label: "Profile", click: () => a.navigate("settings:profile") },
  ];
  const sep: MenuItemConstructorOptions = { type: "separator" };
  const showDevTools = opts.dev || !opts.isPackaged;

  return [
    ...(mac
      ? [
          {
            label: opts.appName,
            submenu: [
              { role: "about" },
              { label: "Check for Updates…", click: () => a.checkForUpdates() },
              sep,
              ...settingsItems,
              sep,
              { role: "services" },
              sep,
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              sep,
              { role: "quit" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        { label: "New Window", accelerator: "CmdOrCtrl+N", click: () => a.newWindow() },
        ...(mac ? [] : [sep, ...settingsItems]),
        sep,
        mac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => a.reload(false) },
        { label: "Force Reload", accelerator: "Shift+CmdOrCtrl+R", click: () => a.reload(true) },
        sep,
        ...(showDevTools
          ? [
              {
                label: "Toggle Developer Tools",
                accelerator: mac ? "Alt+Command+I" : "Ctrl+Shift+I",
                click: () => a.toggleDevTools(),
              },
              sep,
            ]
          : []),
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => a.zoom("reset") },
        { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", click: () => a.zoom(ZOOM_DELTA) },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => a.zoom(-ZOOM_DELTA) },
        sep,
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "History",
      submenu: [
        { label: "Back", accelerator: "CmdOrCtrl+[", click: () => a.back() },
        { label: "Forward", accelerator: "CmdOrCtrl+]", click: () => a.forward() },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Help center", click: () => a.openHelp() },
        { label: "Send feedback", accelerator: "CmdOrCtrl+Shift+/", click: () => a.sendFeedback() },
      ],
    },
  ];
}

export function buildDockMenuTemplate(newWindow: () => void): MenuItemConstructorOptions[] {
  return [{ label: "New Window", click: () => newWindow() }];
}

/** Subset of Electron's ContextMenuParams used by the template. */
export interface ContextParams {
  isEditable: boolean;
  misspelledWord: string;
  dictionarySuggestions: readonly string[];
  editFlags: {
    canUndo: boolean;
    canRedo: boolean;
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
}

export interface ContextActions {
  replaceMisspelling(word: string): void;
  addToDictionary(word: string): void;
}

/** Editable-only context menu (§5 "Context menu"); null => no menu. */
export function buildContextMenuTemplate(p: ContextParams, a: ContextActions): MenuItemConstructorOptions[] | null {
  if (!p.isEditable) return null;
  const items: MenuItemConstructorOptions[] = [];
  if (p.misspelledWord) {
    if (p.dictionarySuggestions.length > 0) {
      for (const s of p.dictionarySuggestions) items.push({ label: s, click: () => a.replaceMisspelling(s) });
    } else {
      items.push({ label: "No spelling suggestions", enabled: false });
    }
    const word = p.misspelledWord;
    items.push({ label: "Add to Dictionary", click: () => a.addToDictionary(word) });
    items.push({ type: "separator" });
  }
  items.push(
    { role: "undo", enabled: p.editFlags.canUndo },
    { role: "redo", enabled: p.editFlags.canRedo },
    { type: "separator" },
    { role: "cut", enabled: p.editFlags.canCut },
    { role: "copy", enabled: p.editFlags.canCopy },
    { role: "paste", enabled: p.editFlags.canPaste },
    { role: "selectAll", enabled: p.editFlags.canSelectAll },
  );
  return items;
}
