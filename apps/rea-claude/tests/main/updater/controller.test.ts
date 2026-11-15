import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateState } from "@shared/ipc";
import { createUpdaterController } from "../../../src/main/updater/controller";
import type { DialogOptions, UpdaterControllerDeps } from "../../../src/main/updater/controller";
import type { DirAccess, ExitMarker } from "../../../src/main/updater/decisions";

type Cb<A extends unknown[] = []> = (...a: A) => void;

function harness(over: Partial<UpdaterControllerDeps> = {}, opts: { failed?: ExitMarker | null; access?: DirAccess } = {}) {
  const h = {
    on: {} as {
      checking?: Cb;
      notAvailable?: Cb;
      available?: Cb<[string]>;
      progress?: Cb<[number]>;
      downloaded?: Cb<[string]>;
      error?: Cb<[unknown]>;
    },
    nativeDownloaded: [] as Cb[],
    nativeOnceDownloaded: [] as Cb[],
    nativeOnceError: [] as Cb[],
    beforeQuit: [] as Cb[],
    focusWaiters: [] as Cb[],
    focused: true,
    access: opts.access ?? ("writable" as DirAccess),
    dialogs: [] as DialogOptions[],
    responses: [] as number[],
    states: [] as UpdateState[],
    logs: [] as string[],
    /** What checkForUpdates does (default: emits checking + not-available). */
    onCheck: undefined as (() => void) | undefined,
    calls: [] as string[],
    marker: {
      write: vi.fn(),
      clear: vi.fn(),
      takeFailed: vi.fn(() => opts.failed ?? null),
    },
    relaunchIfDiskBundleNewer: vi.fn(() => false),
    feedVersion: null as string | null,
  };
  const deps: UpdaterControllerDeps = {
    platform: "darwin",
    isPackaged: true,
    supported: true,
    feedUrl: "https://feed.example/stable",
    currentVersion: "1.0.0",
    now: () => Date.now(),
    log: (...a) => void h.logs.push(a.map(String).join(" ")),
    broadcast: (s) => void h.states.push({ ...s }),
    showMessageBox: async (o) => {
      h.dialogs.push(o);
      return { response: h.responses.shift() ?? 0 };
    },
    hasFocusedWindow: () => h.focused,
    onceWindowFocus: (cb) => void h.focusWaiters.push(cb),
    openExternal: (u) => void h.calls.push(`open ${u}`),
    locationAccess: () => h.access,
    locationPath: () => "/Applications",
    relaunchIfDiskBundleNewer: h.relaunchIfDiskBundleNewer,
    relaunch: () => void h.calls.push("relaunch"),
    exit: (c) => void h.calls.push(`exit ${c}`),
    fetchFeedVersion: async () => h.feedVersion,
    shipItLogTail: () => "tail",
    marker: h.marker,
    onBeforeQuit: (cb) => void h.beforeQuit.push(cb),
    killAllTunnels: () => void h.calls.push("killAllTunnels"),
    destroyAllLabViews: () => void h.calls.push("destroyAllLabViews"),
    destroyAllWindows: () => void h.calls.push("destroyAllWindows"),
    backend: () => ({
      onChecking: (cb) => void (h.on.checking = cb),
      onNotAvailable: (cb) => void (h.on.notAvailable = cb),
      onAvailable: (cb) => void (h.on.available = cb),
      onProgress: (cb) => void (h.on.progress = cb),
      onDownloaded: (cb) => void (h.on.downloaded = cb),
      onError: (cb) => void (h.on.error = cb),
      checkForUpdates: async () => {
        h.calls.push("checkForUpdates");
        if (h.onCheck) h.onCheck();
        else {
          h.on.checking?.();
          h.on.notAvailable?.();
        }
      },
      quitAndInstall: () => void h.calls.push("quitAndInstall"),
    }),
    native: () => ({
      onDownloaded: (cb) => void h.nativeDownloaded.push(cb),
      onceDownloaded: (cb) => void h.nativeOnceDownloaded.push(cb),
      onceError: (cb) => void h.nativeOnceError.push(cb),
      checkForUpdates: () => void h.calls.push("native.checkForUpdates"),
    }),
    ...over,
  };
  const ctl = createUpdaterController(deps);
  return { h, ctl };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe("enablement (D4)", () => {
  it("disabled without a feed URL, when unpackaged, or unsupported", async () => {
    for (const over of [{ feedUrl: null }, { isPackaged: false }, { supported: false }]) {
      const { h, ctl } = harness(over);
      expect(ctl.isEnabled()).toBe(false);
      ctl.start();
      expect(h.on.checking).toBeUndefined();
      expect(h.marker.takeFailed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(h.calls).toEqual([]);
      await ctl.check();
      await ctl.install();
      expect(h.calls).toEqual([]);
      expect(h.dialogs).toEqual([]);
      expect(ctl.getState()).toEqual({ phase: "idle", currentVersion: "1.0.0" });
    }
  });

  it("userCheck explains why updates are unavailable", async () => {
    const cases: [Partial<UpdaterControllerDeps>, string][] = [
      [{ isPackaged: false }, "Updates are unavailable in this build"],
      [{ supported: false }, "This install updates through your package manager"],
      [{ feedUrl: null }, "Updates are turned off"],
    ];
    for (const [over, msg] of cases) {
      const { h, ctl } = harness(over);
      await ctl.userCheck();
      expect(h.dialogs.map((d) => d.message)).toEqual([msg]);
    }
  });
});

describe("timers", () => {
  it("first check after 3 s, then every 30 min", async () => {
    const { h, ctl } = harness();
    ctl.start();
    ctl.start(); // idempotent
    await vi.advanceTimersByTimeAsync(2_999);
    expect(h.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toEqual(["checkForUpdates"]);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.calls).toEqual(["checkForUpdates", "checkForUpdates"]);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.calls.filter((c) => c === "checkForUpdates")).toHaveLength(3);
  });
});

describe("state machine", () => {
  it("merges patches, broadcasts every change, and keeps fields sticky", () => {
    const { h, ctl } = harness({ platform: "win32" });
    ctl.start();
    h.on.checking?.();
    h.on.available?.("1.1.0");
    h.on.progress?.(41.6);
    expect(ctl.getState()).toEqual({ phase: "downloading", currentVersion: "1.0.0", newVersion: "1.1.0", percent: 42 });
    h.on.error?.(new Error("net down"));
    expect(ctl.getState()).toMatchObject({ phase: "error", message: "net down", newVersion: "1.1.0" });
    h.on.checking?.();
    expect(ctl.getState()).toMatchObject({ phase: "checking", message: "net down", blocked: undefined });
    expect(h.states.map((s) => s.phase)).toEqual(["checking", "available", "downloading", "error", "checking"]);
  });

  it("read-only volume errors set blocked=needs-move", () => {
    const { h, ctl } = harness();
    ctl.start();
    h.on.error?.(new Error("Cannot update while running on a read-only volume"));
    expect(ctl.getState().blocked).toBe("needs-move");
    h.on.error?.("plain string");
    expect(ctl.getState()).toMatchObject({ message: "plain string", blocked: undefined });
  });

  it("non-darwin: downloaded → background prompt once per version, Later does not re-prompt", async () => {
    const { h, ctl } = harness({ platform: "win32" });
    ctl.start();
    h.on.available?.("1.1.0");
    h.on.downloaded?.("1.1.0");
    await flush();
    expect(ctl.getState()).toMatchObject({ phase: "downloaded", newVersion: "1.1.0", percent: 100 });
    expect(h.dialogs).toHaveLength(1);
    expect(h.dialogs[0]?.buttons).toEqual(["Later", "Restart now"]);
    h.on.downloaded?.("1.1.0");
    await flush();
    expect(h.dialogs).toHaveLength(1);
  });

  it("background prompt waits for a focused window", async () => {
    const { h, ctl } = harness({ platform: "linux" });
    h.focused = false;
    ctl.start();
    h.on.downloaded?.("2.0.0");
    h.on.downloaded?.("2.0.0");
    expect(h.focusWaiters).toHaveLength(1); // single pending waiter
    expect(h.dialogs).toHaveLength(0);
    h.focused = true;
    h.focusWaiters[0]?.();
    await flush();
    expect(h.dialogs.map((d) => d.message)).toEqual(["A Rea Claude update is ready"]);
  });

  it("darwin: update-downloaded enters staging until native Squirrel confirms", async () => {
    const { h, ctl } = harness();
    ctl.start();
    h.on.available?.("1.1.0");
    h.on.downloaded?.("1.1.0");
    expect(ctl.getState()).toMatchObject({ phase: "staging", percent: 100, newVersion: "1.1.0" });
    expect(h.dialogs).toHaveLength(0);
    for (const cb of h.nativeDownloaded) cb();
    await flush();
    expect(ctl.getState().phase).toBe("downloaded");
    expect(h.dialogs).toHaveLength(1);
  });

  it("darwin: native confirmation before update-downloaded skips staging for that cycle", async () => {
    const { h, ctl } = harness();
    ctl.start();
    h.on.available?.("1.1.0");
    for (const cb of h.nativeDownloaded) cb(); // outside staging: only logged
    expect(ctl.getState().phase).toBe("available");
    expect(h.logs.some((l) => l.includes("outside a staging phase"))).toBe(true);
    h.on.downloaded?.("1.1.0");
    await flush();
    expect(ctl.getState().phase).toBe("downloaded");
    // A new cycle needs a fresh confirmation.
    const { h: h2, ctl: c2 } = harness();
    c2.start();
    h2.on.available?.("1.1.0");
    for (const cb of h2.nativeDownloaded) cb();
    h2.on.available?.("1.2.0");
    h2.on.downloaded?.("1.2.0");
    expect(c2.getState().phase).toBe("staging");
  });

  it("staging: waits for patience, then re-kicks native Squirrel", async () => {
    const { h, ctl } = harness();
    ctl.start();
    h.on.available?.("1.1.0");
    h.on.downloaded?.("1.1.0");
    h.calls.length = 0;
    await ctl.check();
    expect(h.calls).toEqual([]);
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await ctl.check();
    expect(h.calls).toEqual(["native.checkForUpdates"]);
    await ctl.check(); // patience restarted
    expect(h.calls).toEqual(["native.checkForUpdates"]);
  });

  it("check is a no-op once downloaded", async () => {
    const { h, ctl } = harness({ platform: "win32" });
    ctl.start();
    h.on.downloaded?.("1.1.0");
    h.calls.length = 0;
    await ctl.check();
    expect(h.calls).toEqual([]);
  });

  it("checkForUpdates rejection enters the error state", async () => {
    const { h, ctl } = harness();
    h.onCheck = () => {
      throw new Error("feed 500");
    };
    ctl.start();
    await ctl.check();
    expect(ctl.getState()).toMatchObject({ phase: "error", message: "feed 500" });
  });
});

describe("location blocks (macOS)", () => {
  it("needs-move: error state once, surfaces a newer feed version once", async () => {
    const { h, ctl } = harness({}, { access: "read-only-volume" });
    h.feedVersion = "1.1.0";
    ctl.start();
    await ctl.check();
    await flush();
    expect(ctl.getState()).toMatchObject({ phase: "error", blocked: "needs-move" });
    expect(h.calls).not.toContain("checkForUpdates");
    expect(h.dialogs.map((d) => d.message)).toEqual(["Rea Claude 1.1.0 is available"]);
    const broadcasts = h.states.length;
    await ctl.check();
    await flush();
    expect(h.states.length).toBe(broadcasts); // logged/set once per state
    expect(h.dialogs).toHaveLength(1); // surfaced once per version
  });

  it("needs-admin offers a Download button that opens the installer URL", async () => {
    const { h, ctl } = harness({}, { access: "denied" });
    h.feedVersion = "1.1.0";
    h.responses.push(1);
    ctl.start();
    await ctl.check();
    await flush();
    expect(ctl.getState().blocked).toBe("needs-admin");
    expect(h.dialogs[0]?.buttons).toEqual(["OK", "Download Rea Claude…"]);
    expect(h.calls).toContain("open https://feed.example/stable/Rea-Claude-universal.dmg");
  });

  it("does not surface when the feed has the running version", async () => {
    const { h, ctl } = harness({}, { access: "denied" });
    h.feedVersion = "1.0.0";
    ctl.start();
    await ctl.check();
    await flush();
    expect(h.dialogs).toHaveLength(0);
  });
});

describe("userCheck", () => {
  it("up to date", async () => {
    const { h, ctl } = harness();
    ctl.start();
    await ctl.userCheck();
    expect(h.dialogs.map((d) => d.message)).toEqual(["You’re up to date"]);
  });

  it("error", async () => {
    const { h, ctl } = harness();
    h.onCheck = () => h.on.error?.(new Error("offline"));
    ctl.start();
    await ctl.userCheck();
    await flush();
    // Faithful to the original: the error event shows the download dialog for a
    // user-initiated check, and the post-check branch then reports the failed check.
    expect(h.dialogs.map((d) => d.message)).toEqual(["Couldn’t download the update", "Couldn’t check for updates"]);
  });

  it("checkForUpdates throwing shows Couldn’t check for updates", async () => {
    const { h, ctl } = harness();
    h.onCheck = () => {
      throw new Error("bad feed");
    };
    ctl.start();
    await ctl.userCheck();
    expect(h.dialogs.map((d) => d.message)).toEqual(["Couldn’t check for updates"]);
    expect(h.dialogs[0]?.detail).toContain("bad feed");
  });

  it("user-initiated download prompts with Restart to update", async () => {
    const { h, ctl } = harness({ platform: "win32" });
    h.onCheck = () => {
      h.on.checking?.();
      h.on.available?.("1.1.0");
      h.on.downloaded?.("1.1.0");
    };
    ctl.start();
    await ctl.userCheck();
    await flush();
    expect(h.dialogs.map((d) => d.buttons)).toEqual([["Later", "Restart to update"]]);
  });

  it("downloaded: shows the restart dialog and installs on Restart", async () => {
    const { h, ctl } = harness({ platform: "win32" });
    ctl.start();
    h.focused = false;
    h.on.downloaded?.("1.1.0");
    h.responses.push(1);
    await ctl.userCheck();
    await flush();
    expect(h.dialogs[0]?.buttons).toEqual(["Later", "Restart to update"]);
    expect(h.marker.write).toHaveBeenCalledWith("1.0.0", "1.1.0");
    expect(h.calls).toEqual(["killAllTunnels", "destroyAllLabViews", "destroyAllWindows", "quitAndInstall"]);
  });

  it("staging: still staging → 'An update is on the way'", async () => {
    const { h, ctl } = harness();
    ctl.start();
    h.on.downloaded?.("1.1.0");
    await ctl.userCheck();
    expect(h.dialogs.map((d) => d.message)).toEqual(["An update is on the way"]);
  });

  it("location blocked: dedicated dialogs", async () => {
    const a = harness({}, { access: "read-only-volume" });
    a.ctl.start();
    await a.ctl.userCheck();
    expect(a.h.dialogs.map((d) => d.message)).toEqual(["Rea Claude can’t update from this location"]);
    const b = harness({}, { access: "denied" });
    b.ctl.start();
    await b.ctl.userCheck();
    expect(b.h.dialogs.map((d) => d.message)).toEqual(["Rea Claude can’t update itself on this Mac"]);
  });
});

describe("install", () => {
  it("not downloaded: warning dialog and the prompted version is cleared", async () => {
    const { h, ctl } = harness({ platform: "win32" });
    ctl.start();
    await ctl.install();
    expect(h.dialogs.map((d) => d.message)).toEqual(["The update couldn’t be applied"]);
    expect(h.calls).toEqual([]);
  });

  it("forced exit: exits after 5 s when native staging is done", async () => {
    const { h, ctl } = harness();
    ctl.start();
    h.on.downloaded?.("1.1.0");
    for (const cb of h.nativeDownloaded) cb();
    await flush();
    h.calls.length = 0;
    await ctl.install();
    expect(h.calls).toContain("quitAndInstall");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.calls).toContain("exit 0");
    expect(h.calls).not.toContain("relaunch");
  });

  it("forced exit: native error → relaunch + exit", async () => {
    const { h, ctl } = harness({ platform: "win32" });
    ctl.start();
    h.on.downloaded?.("1.1.0");
    await flush();
    h.calls.length = 0;
    await ctl.install();
    h.nativeOnceError[0]?.();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.calls.slice(-2)).toEqual(["relaunch", "exit 0"]);
  });

  it("forced exit: waits for native update-downloaded, then exits 3 s later", async () => {
    const { h: w, ctl: wc } = harness({ platform: "win32" });
    wc.start();
    w.on.downloaded?.("1.1.0");
    await flush();
    w.calls.length = 0;
    await wc.install();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(w.calls).not.toContain("exit 0");
    w.nativeOnceDownloaded[0]?.();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(w.calls).not.toContain("exit 0");
    await vi.advanceTimersByTimeAsync(1);
    expect(w.calls).toContain("exit 0");
  });

  it("forced exit: 60 s native timeout just exits off darwin", async () => {
    const { h, ctl } = harness({ platform: "win32" });
    ctl.start();
    h.on.downloaded?.("1.1.0");
    await flush();
    h.calls.length = 0;
    await ctl.install();
    await vi.advanceTimersByTimeAsync(65_000);
    expect(h.calls).toContain("exit 0");
    expect(h.calls).not.toContain("relaunch");
  });

  it("forced exit: darwin install after native confirmation exits at 5 s", async () => {
    const { h, ctl } = harness();
    ctl.start();
    h.on.available?.("1.1.0");
    for (const cb of h.nativeDownloaded) cb(); // confirmed for this cycle → downloaded directly
    h.on.downloaded?.("1.1.0");
    await flush();
    expect(ctl.getState().phase).toBe("downloaded");
    h.calls.length = 0;
    await ctl.install();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.calls).toContain("exit 0");
    expect(h.calls).not.toContain("relaunch");
  });

  it("install side effects are guarded", async () => {
    const { h, ctl } = harness({
      platform: "win32",
      killAllTunnels: () => {
        throw new Error("x");
      },
    });
    ctl.start();
    h.on.downloaded?.("1.1.0");
    await flush();
    h.calls.length = 0;
    await ctl.install();
    expect(h.calls).toContain("quitAndInstall");
  });

  it("before-quit writes the marker only when an install-on-quit will happen", () => {
    const win = harness({ platform: "win32" });
    win.ctl.start();
    win.h.beforeQuit[0]?.();
    expect(win.h.marker.write).not.toHaveBeenCalled();
    win.h.on.downloaded?.("1.1.0");
    win.h.beforeQuit[0]?.();
    expect(win.h.marker.write).toHaveBeenCalledWith("1.0.0", "1.1.0");

    const mac = harness();
    mac.ctl.start();
    mac.h.on.downloaded?.("1.1.0"); // staging, not natively staged
    mac.h.beforeQuit[0]?.();
    expect(mac.h.marker.write).not.toHaveBeenCalled();
    for (const cb of mac.h.nativeDownloaded) cb();
    mac.h.beforeQuit[0]?.();
    expect(mac.h.marker.write).toHaveBeenCalledWith("1.0.0", "1.1.0");
  });
});

describe("failed-install detection", () => {
  const marker: ExitMarker = { fromVersion: "1.0.0", toVersion: "1.1.0", at: 1_000_000 };

  it("relaunches immediately when the disk bundle already moved on", () => {
    const { h, ctl } = harness({}, { failed: marker });
    h.relaunchIfDiskBundleNewer.mockReturnValueOnce(true);
    ctl.start();
    expect(h.marker.clear).toHaveBeenCalled();
    expect(h.on.checking).toBeUndefined(); // wiring stops
  });

  it("verifies for the grace window, then shows the failure dialog on focus and checks", async () => {
    const { h, ctl } = harness({}, { failed: marker });
    h.focused = false;
    ctl.start();
    await ctl.userCheck();
    expect(h.dialogs.map((d) => d.message)).toEqual(["Finishing up the last update"]);
    h.calls.length = 0;
    await ctl.check();
    expect(h.calls).toEqual([]); // verifying blocks checks
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.relaunchIfDiskBundleNewer.mock.calls.length).toBeGreaterThanOrEqual(30);
    expect(h.logs.some((l) => l.startsWith("ShipIt log tail after failed install:"))).toBe(true);
    expect(h.calls).toContain("checkForUpdates"); // check() after verifying
    expect(h.focusWaiters).toHaveLength(1);
    h.focusWaiters[0]?.();
    await flush();
    expect(h.dialogs.map((d) => d.message)).toContain("The last update didn’t install");
    expect(h.marker.clear).toHaveBeenCalled();
  });

  it("stops verifying when the disk bundle moves on during the grace window", async () => {
    const { h, ctl } = harness({}, { failed: marker });
    h.relaunchIfDiskBundleNewer.mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValueOnce(true);
    ctl.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.relaunchIfDiskBundleNewer).toHaveBeenCalledTimes(3);
    expect(h.marker.clear).toHaveBeenCalled();
    expect(h.dialogs).toHaveLength(0);
  });

  it("past the grace window it reports immediately", async () => {
    vi.setSystemTime(10_000_000);
    const { h, ctl } = harness({}, { failed: marker });
    ctl.start();
    await flush();
    expect(h.dialogs.map((d) => d.message)).toEqual(["The last update didn’t install"]);
    expect(h.dialogs[0]?.detail).toContain("this is still Rea Claude 1.0.0");
  });
});

describe("dialogs", () => {
  it("are serialized and logged", async () => {
    let release: (() => void) | undefined;
    const shown: string[] = [];
    const { h, ctl } = harness({
      platform: "win32",
      showMessageBox: (o) => {
        shown.push(o.message);
        if (shown.length === 1) return new Promise((r) => (release = () => r({ response: 0 })));
        return Promise.resolve({ response: 0 });
      },
    });
    ctl.start();
    const a = ctl.install();
    const b = ctl.install();
    await flush();
    expect(shown).toHaveLength(1);
    release?.();
    await Promise.all([a, b]);
    expect(shown).toHaveLength(2);
    expect(h.logs.filter((l) => l.startsWith("dialog queued:"))).toHaveLength(2);
  });
});

describe("userCheck while darwin staging is stalled (platform §5.4)", () => {
  /** Harness whose native Squirrel checkForUpdates is replaced by `kick`. */
  function stalledStaging(kick: (h: ReturnType<typeof harness>["h"]) => void) {
    let hh: ReturnType<typeof harness>["h"] | undefined;
    const r = harness({
      native: () => ({
        onDownloaded: (cb) => void hh?.nativeDownloaded.push(cb),
        onceDownloaded: (cb) => void hh?.nativeOnceDownloaded.push(cb),
        onceError: (cb) => void hh?.nativeOnceError.push(cb),
        checkForUpdates: () => {
          hh?.calls.push("native.checkForUpdates");
          if (hh) kick(hh);
        },
      }),
    });
    hh = r.h;
    r.ctl.start();
    r.h.on.available?.("1.1.0");
    r.h.on.downloaded?.("1.1.0");
    expect(r.ctl.getState().phase).toBe("staging");
    vi.setSystemTime(Date.now() + 10 * 60_000);
    return r;
  }

  it("native checkForUpdates throws → 'Couldn’t prepare the update' with the error message", async () => {
    const { h, ctl } = stalledStaging(() => {
      throw new Error("Squirrel exploded");
    });
    await ctl.userCheck();
    await flush();
    expect(h.calls).toEqual(["native.checkForUpdates"]);
    expect(ctl.getState()).toMatchObject({ phase: "error", message: "Squirrel exploded" });
    expect(h.dialogs.map((d) => d.message)).toEqual(["Couldn’t prepare the update"]);
    expect(h.dialogs[0]?.type).toBe("warning");
    expect(h.dialogs[0]?.detail).toContain("Squirrel exploded");
    expect(h.dialogs[0]?.detail).toContain("keeps trying in the background");
  });

  it("native confirms synchronously during the re-kick → restart prompt, no 'on the way' dialog", async () => {
    const { h, ctl } = stalledStaging((hh) => {
      for (const cb of hh.nativeDownloaded) cb();
    });
    await ctl.userCheck();
    await flush();
    expect(ctl.getState()).toMatchObject({ phase: "downloaded", newVersion: "1.1.0" });
    expect(h.dialogs.map((d) => d.message)).toEqual(["A Rea Claude update is ready"]);
    expect(h.dialogs.map((d) => d.message)).not.toContain("An update is on the way");
    expect(h.dialogs[0]?.buttons).toEqual(["Later", "Restart to update"]);
  });
});

describe("failed install on a blocked location (platform §5.3)", () => {
  const marker: ExitMarker = { fromVersion: "1.0.0", toVersion: "1.1.0", at: 1_000_000 };

  it.each([
    ["denied" as DirAccess, "ask your administrator"],
    ["read-only-volume" as DirAccess, "Move Rea Claude to Applications and relaunch"],
  ])("%s: hint + Download button, and the same toVersion is not surfaced again", async (access, hint) => {
    vi.setSystemTime(10_000_000); // past the 30 s grace window
    const { h, ctl } = harness({}, { failed: marker, access });
    h.feedVersion = "1.1.0";
    ctl.start();
    await flush();
    expect(h.dialogs.map((d) => d.message)).toEqual(["The last update didn’t install"]);
    expect(h.dialogs[0]?.detail).toContain(hint);
    expect(h.dialogs[0]?.detail).toContain("Rea Claude 1.1.0 was downloaded");
    expect(h.dialogs[0]?.buttons).toEqual(["OK", "Download Rea Claude…"]);
    expect(ctl.getState()).toMatchObject({
      phase: "error",
      blocked: access === "denied" ? "needs-admin" : "needs-move",
    });
    // The post-verify check and a later one both see the feed offering 1.1.0.
    await ctl.check();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await flush();
    expect(h.dialogs).toHaveLength(1);
    expect(h.dialogs.some((d) => d.message.endsWith("is available"))).toBe(false);
    expect(h.calls).not.toContain("checkForUpdates");
    // A newer version is still surfaced.
    h.feedVersion = "1.2.0";
    await ctl.check();
    await flush();
    expect(h.dialogs.map((d) => d.message)).toEqual(["The last update didn’t install", "Rea Claude 1.2.0 is available"]);
  });
});

describe("install failure resets the once-per-version prompt", () => {
  it("prompt 1.1.0 → Later → install() not downloaded → downloaded(1.1.0) prompts again", async () => {
    const { h, ctl } = harness({ platform: "win32" });
    ctl.start();
    h.on.available?.("1.1.0");
    h.on.downloaded?.("1.1.0");
    await flush();
    expect(h.dialogs.map((d) => d.buttons)).toEqual([["Later", "Restart now"]]); // response 0 = Later
    // Same version again is suppressed while promptedVersion is set.
    h.on.downloaded?.("1.1.0");
    await flush();
    expect(h.dialogs).toHaveLength(1);
    // The update leaves `downloaded` (e.g. a later error), then install() fails.
    h.on.error?.(new Error("staged file vanished"));
    await ctl.install();
    expect(h.dialogs.map((d) => d.message)).toEqual(["A Rea Claude update is ready", "The update couldn’t be applied"]);
    expect(h.dialogs[1]?.detail).toContain("staged file vanished");
    expect(h.calls).not.toContain("quitAndInstall");
    h.on.downloaded?.("1.1.0");
    await flush();
    expect(h.dialogs.map((d) => d.message)).toEqual([
      "A Rea Claude update is ready",
      "The update couldn’t be applied",
      "A Rea Claude update is ready",
    ]);
    expect(h.dialogs[2]?.buttons).toEqual(["Later", "Restart now"]);
  });
});
