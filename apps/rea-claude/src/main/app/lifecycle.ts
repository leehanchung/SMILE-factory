/**
 * whenReady steps 6, 7, 16 and the quit hooks (platform §6.1), against an
 * injected Electron surface.
 */
import { PRODUCT_NAME } from "@shared/config";
import type { MainContext } from "../services";
import { shouldOfferMove } from "./guards";

export interface MoveHost {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  testMode: boolean;
  isInApplicationsFolder(): boolean;
  showMessageBoxSync(opts: {
    type: "question" | "info" | "warning";
    buttons?: string[];
    defaultId?: number;
    cancelId?: number;
    message: string;
    detail?: string;
  }): number;
  /** `app.moveToApplicationsFolder` with a conflict handler. */
  moveToApplicationsFolder(opts: { conflictHandler: (type: string) => boolean }): boolean;
}

/** whenReady step 6: macOS offer to move into /Applications (never in test mode). */
export function offerMove(ctx: MainContext, host: MoveHost): void {
  if (host.platform !== "darwin" || !host.isPackaged || host.testMode) return;
  try {
    if (
      !shouldOfferMove({
        platform: host.platform,
        isPackaged: host.isPackaged,
        testMode: host.testMode,
        isInApplicationsFolder: host.isInApplicationsFolder(),
      })
    ) {
      return;
    }
    const choice = host.showMessageBoxSync({
      type: "question",
      buttons: ["Move to Applications", "Not Now"],
      defaultId: 0,
      cancelId: 1,
      message: `Move ${PRODUCT_NAME} to your Applications folder?`,
      detail: `${PRODUCT_NAME} is running from outside your Applications folder (for example a disk image or Downloads), where it can’t install its own updates. Moving it fixes that; ${PRODUCT_NAME} will quit and reopen from Applications.`,
    });
    if (choice !== 0) return;
    let conflict = false;
    const moved = host.moveToApplicationsFolder({
      conflictHandler: () => {
        conflict = true;
        return false;
      },
    });
    if (moved) return;
    if (conflict) {
      host.showMessageBoxSync({
        type: "info",
        message: `${PRODUCT_NAME} is already in your Applications folder.`,
        detail: `Quit this copy and open ${PRODUCT_NAME} from your Applications folder instead.`,
      });
    }
  } catch (err) {
    ctx.logger("app").error("move-to-Applications offer failed:", err);
    try {
      host.showMessageBoxSync({
        type: "warning",
        message: `Couldn’t move ${PRODUCT_NAME} automatically.`,
        detail: `Quit ${PRODUCT_NAME}, drag it into your Applications folder, then reopen it.\n\n${err instanceof Error ? err.message : String(err)}`,
      });
    } catch {
      /* ignore */
    }
  }
}

export interface LifecycleHost {
  platform: NodeJS.Platform;
  on(event: "activate" | "window-all-closed" | "before-quit", listener: () => void): void;
  quit(): void;
}

/** whenReady step 16 + quit: activate, window-all-closed, before-quit (kill tunnels). */
export function installLifecycle(ctx: MainContext, host: LifecycleHost): void {
  const log = ctx.logger("app");
  host.on("activate", () => {
    try {
      ctx.windows.ensureShellWindow();
    } catch (err) {
      log.error("activate: ensureShellWindow failed", err);
    }
  });
  host.on("window-all-closed", () => {
    // macOS keeps the app alive with no windows.
    if (host.platform !== "darwin") host.quit();
  });
  host.on("before-quit", () => {
    try {
      ctx.lab.killAllTunnels();
    } catch (err) {
      log.error("before-quit: killAllTunnels failed", err);
    }
  });
}
