/**
 * Shell IPC owned by the windows area (architecture §4 "IPC registration
 * ownership"; windows spec §2.1). All channels are shell-trusted (D5 adds the
 * gate to `window:open-settings-sheet`, `labs:held-elsewhere`,
 * `labs:focus-held`).
 */
import { BrowserWindow, dialog } from "electron";
import type { MessageBoxOptions, WebContents } from "electron";
import { handleShell } from "../ipc/trust";
import type { MainContext } from "../services";
import { windowInternals } from "./service";

export function registerWindowsIpc(ctx: MainContext): void {
  const svc = ctx.windows;
  const w = windowInternals(svc);
  const senderWindow = (sender: WebContents): BrowserWindow | null => {
    if (sender.isDestroyed()) return null;
    return BrowserWindow.fromWebContents(sender);
  };

  handleShell("window:is-initial", (e) => w.isInitialWindow(senderWindow(e.sender)));

  handleShell("window:set-compact", (e, compact, contentHeight) => {
    w.setCompactFromRenderer(e.sender, compact, contentHeight);
  });

  handleShell("window:open-settings-sheet", (e) => {
    const win = senderWindow(e.sender);
    if (win && !win.isDestroyed() && win.webContents === e.sender && svc.isShellWindow(win)) {
      svc.openSettingsSheet(win, "settings:notifications");
    }
  });

  handleShell("lastOpened:get", (e, account) =>
    w.consumeInitialLastOpened(senderWindow(e.sender)) ? w.lastOpenedGet(account) : null,
  );

  handleShell("lastOpened:set", (_e, account, connId) => w.lastOpenedSet(account, connId));

  handleShell("labs:held-elsewhere", (e) => w.heldElsewhere(senderWindow(e.sender)));

  handleShell("labs:focus-held", (_e, connId) => w.focusHeld(connId));

  handleShell("lab:hide", (e) => w.hideByUser(senderWindow(e.sender)));
  handleShell("lab:goBack", (e) => w.goBack(senderWindow(e.sender)));
  handleShell("lab:goForward", (e) => w.goForward(senderWindow(e.sender)));

  handleShell("viewer:retry", (e, deployment) => w.viewerRetry(senderWindow(e.sender), deployment));

  handleShell("dialog:confirm", async (e, opts) => {
    const win = senderWindow(e.sender);
    const o = (opts ?? {}) as { message?: unknown; detail?: unknown; confirmLabel?: unknown };
    const icon = w.dialogIcon();
    const box: MessageBoxOptions = {
      type: "question",
      buttons: ["Cancel", typeof o.confirmLabel === "string" ? o.confirmLabel : "OK"],
      defaultId: 1,
      cancelId: 0,
      ...(icon ? { icon } : {}),
      message: typeof o.message === "string" ? o.message : String(o.message ?? ""),
      ...(typeof o.detail === "string" ? { detail: o.detail } : {}),
    };
    const id = win?.id;
    if (id !== undefined) w.markDialogOpen(id, true);
    try {
      const res = win ? await dialog.showMessageBox(win, box) : await dialog.showMessageBox(box);
      return res.response === 1;
    } finally {
      if (id !== undefined) w.markDialogOpen(id, false);
    }
  });
}
