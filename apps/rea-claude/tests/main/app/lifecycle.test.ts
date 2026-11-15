import { describe, expect, it, vi } from "vitest";
import { installLifecycle, offerMove } from "../../../src/main/app/lifecycle";
import type { MoveHost } from "../../../src/main/app/lifecycle";
import { makeTestContext, silentLogger } from "../helpers/context";

function lifecycleHost(platform: NodeJS.Platform) {
  const handlers = new Map<string, () => void>();
  const quit = vi.fn();
  return { handlers, quit, host: { platform, on: (e: string, l: () => void) => void handlers.set(e, l), quit } };
}

describe("installLifecycle", () => {
  it("activate ensures a shell window; before-quit kills tunnels", () => {
    const ensure = vi.fn();
    const kill = vi.fn();
    const ctx = makeTestContext({ windows: { ensureShellWindow: ensure }, lab: { killAllTunnels: kill } });
    const { handlers, host } = lifecycleHost("darwin");
    installLifecycle(ctx, host);
    handlers.get("activate")?.();
    handlers.get("before-quit")?.();
    expect(ensure).toHaveBeenCalled();
    expect(kill).toHaveBeenCalled();
  });

  it("window-all-closed quits except on macOS", () => {
    const mac = lifecycleHost("darwin");
    installLifecycle(makeTestContext(), mac.host);
    mac.handlers.get("window-all-closed")?.();
    expect(mac.quit).not.toHaveBeenCalled();
    const win = lifecycleHost("win32");
    installLifecycle(makeTestContext(), win.host);
    win.handlers.get("window-all-closed")?.();
    expect(win.quit).toHaveBeenCalled();
  });

  it("before-quit tolerates a failing tunnel teardown", () => {
    const error = vi.fn();
    const ctx = makeTestContext({
      lab: {
        killAllTunnels: () => {
          throw new Error("x");
        },
      },
      logger: () => ({ ...silentLogger, error }),
    });
    const { handlers, host } = lifecycleHost("linux");
    installLifecycle(ctx, host);
    expect(() => handlers.get("before-quit")?.()).not.toThrow();
    expect(error).toHaveBeenCalled();
  });
});

describe("offerMove", () => {
  const host = (over: Partial<MoveHost> = {}): MoveHost & { boxes: string[] } => {
    const boxes: string[] = [];
    return {
      boxes,
      platform: "darwin",
      isPackaged: true,
      testMode: false,
      isInApplicationsFolder: () => false,
      showMessageBoxSync: (o) => {
        boxes.push(o.message);
        return 0;
      },
      moveToApplicationsFolder: () => true,
      ...over,
    };
  };

  it("skips in test mode, dev builds, other platforms, and inside /Applications", () => {
    for (const over of [{ testMode: true }, { isPackaged: false }, { platform: "win32" as const }, { isInApplicationsFolder: () => true }]) {
      const h = host(over);
      offerMove(makeTestContext(), h);
      expect(h.boxes).toEqual([]);
    }
  });

  it("moves when accepted; Not Now does nothing", () => {
    const move = vi.fn(() => true);
    const h = host({ moveToApplicationsFolder: move });
    offerMove(makeTestContext(), h);
    expect(h.boxes).toEqual(["Move Rea Claude to your Applications folder?"]);
    expect(move).toHaveBeenCalled();
    const move2 = vi.fn(() => true);
    offerMove(makeTestContext(), host({ showMessageBoxSync: () => 1, moveToApplicationsFolder: move2 }));
    expect(move2).not.toHaveBeenCalled();
  });

  it("explains a conflict and reports failures", () => {
    const conflict = host({
      moveToApplicationsFolder: (o) => {
        o.conflictHandler("exists");
        return false;
      },
    });
    offerMove(makeTestContext(), conflict);
    expect(conflict.boxes[1]).toBe("Rea Claude is already in your Applications folder.");
    const failing = host({
      moveToApplicationsFolder: () => {
        throw new Error("EPERM");
      },
    });
    offerMove(makeTestContext(), failing);
    expect(failing.boxes[1]).toBe("Couldn’t move Rea Claude automatically.");
  });
});
