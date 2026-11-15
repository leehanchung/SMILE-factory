/**
 * Update state machine, dialogs, install and failed-install detection
 * (platform §5.2-§5.4). Electron-free: electron-updater, Squirrel's native
 * autoUpdater, dialogs, windows, fs and process control are injected so the
 * whole flow is unit-testable with fakes and fake timers.
 *
 * Enablement (decision D4): packaged build AND self-update supported on this
 * platform AND a valid REA_CLAUDE_UPDATE_URL feed. While disabled the state
 * stays `{phase:"idle", currentVersion}`, `install` is a no-op, `start` wires
 * nothing and `userCheck` only explains why updates are unavailable.
 */
import {
  PRODUCT_NAME,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_FIRST_CHECK_DELAY_MS,
  UPDATE_FORCED_EXIT_DELAY_MS,
  UPDATE_GRACE_POLL_MS,
  UPDATE_INSTALL_GRACE_MS,
  UPDATE_NATIVE_EXIT_DELAY_MS,
  UPDATE_NATIVE_WAIT_TIMEOUT_MS,
  UPDATE_STAGING_PATIENCE_MS,
} from "@shared/config";
import type { UpdateState } from "@shared/ipc";
import {
  graceRemaining,
  installerDownloadUrl,
  isReadOnlyVolumeError,
  locationBlock,
  stagedPhase,
  stagingVerdict,
  willInstallOnQuit,
} from "./decisions";
import type { BlockReason, DirAccess, ExitMarker, LocationBlock } from "./decisions";
import type { ExitMarkerStore } from "./marker";

/** electron-updater (`autoUpdater` from the package), narrowed to what we use. */
export interface UpdaterBackend {
  onChecking(cb: () => void): void;
  onNotAvailable(cb: () => void): void;
  onAvailable(cb: (version: string) => void): void;
  onProgress(cb: (percent: number) => void): void;
  onDownloaded(cb: (version: string) => void): void;
  onError(cb: (err: unknown) => void): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

/** Electron's native `autoUpdater` (Squirrel.Mac), narrowed. */
export interface NativeUpdater {
  onDownloaded(cb: () => void): void;
  onceDownloaded(cb: () => void): void;
  onceError(cb: () => void): void;
  checkForUpdates(): void;
}

export interface DialogOptions {
  type: "info" | "warning" | "question";
  buttons: string[];
  message: string;
  detail?: string;
  defaultId?: number;
  cancelId?: number;
}

export interface UpdaterControllerDeps {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** Self-update supported on this platform (`Ho`). */
  supported: boolean;
  /** Normalized feed URL, or null when REA_CLAUDE_UPDATE_URL is unset/invalid. */
  feedUrl: string | null;
  currentVersion: string;
  now(): number;
  log(...args: unknown[]): void;
  /** Called with the full state after every merge (`update:state` to all windows). */
  broadcast(state: UpdateState): void;
  /** Shows a message box (parented to the focused window when there is one). */
  showMessageBox(opts: DialogOptions): Promise<{ response: number }>;
  hasFocusedWindow(): boolean;
  onceWindowFocus(cb: () => void): void;
  openExternal(url: string): void;
  /** Writability of the directory that holds the .app. */
  locationAccess(): DirAccess;
  /** Human-readable path of that directory (dialog text). */
  locationPath(): string;
  /** `En`: relaunch onto a newer bundle on disk; true when it did (the process is exiting). */
  relaunchIfDiskBundleNewer(reason: string): boolean;
  relaunch(): void;
  exit(code: number): void;
  /** `version:` of `<feed>/latest-mac.yml` (10 s timeout), or null. */
  fetchFeedVersion(): Promise<string | null>;
  shipItLogTail(): string | null;
  marker: ExitMarkerStore;
  onBeforeQuit(cb: () => void): void;
  /** Install side effects (`Xi`, `wl`, destroy windows). Each is guarded. */
  killAllTunnels(): void;
  destroyAllLabViews(): void;
  destroyAllWindows(): void;
  /** Lazily created backends (only touched once enabled). */
  backend(): UpdaterBackend;
  native(): NativeUpdater;
}

export interface UpdaterController {
  isEnabled(): boolean;
  getState(): UpdateState;
  /** `ud`: wire events, exit-marker check, timers. Idempotent; no-op while disabled. */
  start(): void;
  /** `ze`: background check. */
  check(): Promise<void>;
  /** `nd`: menu "Check for Updates…". */
  userCheck(): Promise<void>;
  /** `Yo`: update:install. */
  install(): Promise<void>;
}

const MOVE_HINT = `Move ${PRODUCT_NAME} to Applications and relaunch — updates work from there.`;
const ADMIN_HINT = `this is usually an IT-managed install. Update by downloading the latest ${PRODUCT_NAME} and replacing the app, or ask your administrator.`;

export function createUpdaterController(d: UpdaterControllerDeps): UpdaterController {
  const enabled = d.isPackaged && d.supported && d.feedUrl !== null;

  let state: UpdateState = { phase: "idle", currentVersion: d.currentVersion };
  let started = false;
  // Download-cycle bookkeeping for macOS staging (`An`, `Ar`, `Ft`, `ro`).
  let downloadCycle = 0;
  let nativeConfirmedCycle: number | null = null;
  let nativeStaged = false;
  let stagingStartedAt = 0;
  // `K`: the current check was started from the menu.
  let userInitiated = false;
  // `In`: still verifying a previous (failed-looking) install.
  let verifying = false;
  // `yt`, `xe`, `$n`, `so`.
  let promptedVersion: string | null = null;
  let restartDialogOpen = false;
  let waitingForFocusPrompt = false;
  let surfacedVersion: string | null = null;

  // ---- state ---------------------------------------------------------------
  function setState(patch: Partial<UpdateState>): void {
    state = { ...state, ...patch };
    try {
      d.broadcast(state);
    } catch (err) {
      d.log("WARN broadcast failed", err);
    }
  }

  function toError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    setState({ phase: "error", message, blocked: isReadOnlyVolumeError(message) ? "needs-move" : undefined });
  }

  // ---- dialogs (serialized) ------------------------------------------------
  let dialogTail: Promise<unknown> = Promise.resolve();
  function showDialog(opts: DialogOptions): Promise<{ response: number }> {
    d.log(`dialog queued: ${opts.message}`);
    const run = dialogTail.then(
      () => d.showMessageBox(opts),
      () => d.showMessageBox(opts),
    );
    dialogTail = run.catch(() => undefined);
    return run;
  }

  function whenWindowFocused(cb: () => void): void {
    if (d.hasFocusedWindow()) cb();
    else d.onceWindowFocus(cb);
  }

  /** `Jo`: warning with an optional "Download …" button for the full installer. */
  async function showBlockedDialog(message: string, detail: string): Promise<void> {
    const url = installerDownloadUrl(d.feedUrl, d.platform);
    const r = await showDialog({
      type: "warning",
      buttons: url ? ["OK", `Download ${PRODUCT_NAME}…`] : ["OK"],
      defaultId: 0,
      cancelId: 0,
      message,
      detail,
    });
    if (url && r.response === 1) d.openExternal(url);
  }

  // ---- location check ------------------------------------------------------
  function currentBlock(): LocationBlock {
    return locationBlock(d.platform, d.locationAccess());
  }

  /** `bs`: location check; enters the blocked error state once per block kind. */
  function checkLocation(): LocationBlock {
    const block = currentBlock();
    if (block === "none") return block;
    if (state.phase === "error" && state.blocked === block) return block;
    d.log(`self-update blocked (${block}): ${d.locationPath()} is not writable`);
    setState({
      phase: "error",
      blocked: block,
      message:
        block === "needs-admin"
          ? `${PRODUCT_NAME} can’t update itself because your user account can’t modify ${d.locationPath()}.`
          : `${PRODUCT_NAME} can’t update itself while it runs from a read-only location. Move ${PRODUCT_NAME} to Applications and relaunch.`,
    });
    return block;
  }

  /** `od`: tell the user (once per version) that the feed has a version they can't install here. */
  async function surfaceBlocked(block: BlockReason): Promise<void> {
    let version: string | null = null;
    try {
      version = await d.fetchFeedVersion();
    } catch {
      version = null;
    }
    if (!version || version === d.currentVersion || surfacedVersion === version) return;
    surfacedVersion = version;
    d.log(`feed offers ${version} but this install is blocked (${block}) — surfacing it`);
    whenWindowFocused(() => {
      if (block === "needs-move") {
        void showDialog({
          type: "info",
          buttons: ["OK"],
          message: `${PRODUCT_NAME} ${version} is available`,
          detail: `${PRODUCT_NAME} can’t install it while running from a read-only location (like a disk image). ${MOVE_HINT}`,
        });
        return;
      }
      void showBlockedDialog(
        `${PRODUCT_NAME} ${version} is available`,
        `${PRODUCT_NAME} can’t install it because your user account can’t modify ${d.locationPath()} — ${ADMIN_HINT}`,
      );
    });
  }

  // ---- check ---------------------------------------------------------------
  async function check(): Promise<void> {
    if (!enabled || verifying || state.phase === "downloaded") return;
    const verdict = stagingVerdict({
      phase: state.phase,
      now: d.now(),
      stagingStartedAt,
      patienceMs: UPDATE_STAGING_PATIENCE_MS,
    });
    if (verdict === "wait") return;
    if (verdict === "stalled") {
      d.log("native staging silent past patience — re-kicking Squirrel");
      stagingStartedAt = d.now();
      try {
        d.native().checkForUpdates();
      } catch (err) {
        toError(err);
      }
      return;
    }
    const block = checkLocation();
    if (block !== "none") {
      void surfaceBlocked(block);
      return;
    }
    try {
      await d.backend().checkForUpdates();
    } catch (err) {
      toError(err);
    }
  }

  // ---- restart prompts -----------------------------------------------------
  async function restartDialog(laterLabel: string, restartLabel: string): Promise<void> {
    promptedVersion = state.newVersion ?? null;
    restartDialogOpen = true;
    try {
      const r = await showDialog({
        type: "info",
        buttons: [laterLabel, restartLabel],
        defaultId: 1,
        cancelId: 0,
        message: `A ${PRODUCT_NAME} update is ready`,
        detail: `${PRODUCT_NAME} ${state.newVersion ?? ""} has been downloaded. Restart to switch to it. Nothing is lost, and your Labs pick up where you left off.`,
      });
      if (r.response === 1) await install();
    } finally {
      restartDialogOpen = false;
    }
  }

  /** `vs`: user-initiated restart prompt. */
  async function promptRestartForUser(): Promise<void> {
    if (restartDialogOpen) return;
    await restartDialog("Later", "Restart to update");
  }

  /** `Mr`: background restart prompt (once per version). */
  async function promptRestartInBackground(): Promise<void> {
    if (restartDialogOpen || state.phase !== "downloaded" || promptedVersion === state.newVersion) return;
    await restartDialog("Later", "Restart now");
  }

  /** `ld`: prompt now if a window is focused, else on the next focus. */
  function promptWhenFocused(): void {
    const v = state.newVersion;
    if (!v || promptedVersion === v) return;
    if (d.hasFocusedWindow()) {
      void promptRestartInBackground();
      return;
    }
    if (waitingForFocusPrompt) return;
    waitingForFocusPrompt = true;
    d.onceWindowFocus(() => {
      waitingForFocusPrompt = false;
      void promptRestartInBackground();
    });
  }

  /** `Mn`. */
  function offerRestart(): void {
    if (userInitiated) {
      userInitiated = false;
      void promptRestartForUser();
    } else {
      promptWhenFocused();
    }
  }

  // ---- install -------------------------------------------------------------
  function guarded(label: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      d.log(`WARN ${label} failed`, err);
    }
  }

  /** `sd`: make sure the process exits even if Squirrel never finishes. */
  function armForcedExit(): void {
    const exitNow = (): void => d.exit(0);
    const relaunchAndExit = (): void => {
      try {
        d.relaunch();
      } catch {
        /* ignore */
      }
      d.exit(0);
    };
    let nativeErrored = false;
    d.native().onceError(() => {
      nativeErrored = true;
    });
    setTimeout(() => {
      if (nativeErrored) return relaunchAndExit();
      if (nativeStaged) return exitNow();
      d.native().onceDownloaded(() => {
        setTimeout(exitNow, UPDATE_NATIVE_EXIT_DELAY_MS);
      });
      d.native().onceError(relaunchAndExit);
      setTimeout(d.platform === "darwin" ? relaunchAndExit : exitNow, UPDATE_NATIVE_WAIT_TIMEOUT_MS);
    }, UPDATE_FORCED_EXIT_DELAY_MS);
  }

  /** `ad`: quit and install; false unless the phase is `downloaded`. */
  function installNow(): boolean {
    if (state.phase !== "downloaded") return false;
    d.marker.write(d.currentVersion, state.newVersion ?? "unknown");
    armForcedExit();
    guarded("killAllTunnels", d.killAllTunnels);
    guarded("destroyAllLabViews", d.destroyAllLabViews);
    guarded("destroyAllWindows", d.destroyAllWindows);
    try {
      d.backend().quitAndInstall();
    } catch (err) {
      d.log("ERROR quitAndInstall failed; forced exit is armed", err);
    }
    return true;
  }

  async function install(): Promise<void> {
    if (!enabled) return; // D4: no-op while disabled
    if (installNow()) return;
    await showDialog({
      type: "warning",
      buttons: ["OK"],
      message: "The update couldn’t be applied",
      detail: `${state.message ?? "Something went wrong preparing the update."} ${PRODUCT_NAME} keeps checking in the background and will offer it again.`,
    });
    promptedVersion = null;
  }

  // ---- failed-install detection ----------------------------------------------
  /** `id`. */
  async function showInstallFailed(marker: ExitMarker): Promise<void> {
    if (d.relaunchIfDiskBundleNewer("disk bundle moved on before the install-failed dialog — the update landed; relaunching into it")) {
      d.marker.clear();
      return;
    }
    d.log(`showing install-failed dialog for ${marker.toVersion}`);
    d.marker.clear();
    const block = currentBlock();
    if (block !== "none") surfacedVersion = marker.toVersion;
    const detail =
      block === "needs-admin"
        ? `${PRODUCT_NAME} ${marker.toVersion} was downloaded, but your user account can’t modify ${d.locationPath()}, so the update couldn’t be installed — ${ADMIN_HINT}`
        : block === "needs-move"
          ? `${PRODUCT_NAME} ${marker.toVersion} was downloaded, but ${PRODUCT_NAME} runs from a read-only location (like a disk image), so the update couldn’t be installed. ${MOVE_HINT}`
          : `${PRODUCT_NAME} ${marker.toVersion} was downloaded, but this is still ${PRODUCT_NAME} ${d.currentVersion} — the installer didn’t finish. ${PRODUCT_NAME} will try again in the background; if this keeps happening, reinstall from the download link.`;
    await showBlockedDialog("The last update didn’t install", detail);
  }

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /** `rd`: give a just-finished install up to 30 s to land, then report the failure. */
  async function verifyFailedInstall(marker: ExitMarker): Promise<void> {
    try {
      let remaining = graceRemaining({ markerAt: marker.at, now: d.now(), graceMs: UPDATE_INSTALL_GRACE_MS });
      while (remaining > 0) {
        await sleep(Math.min(remaining, UPDATE_GRACE_POLL_MS));
        if (d.relaunchIfDiskBundleNewer("disk bundle moved on during the install grace window — the update landed; relaunching into it")) {
          d.marker.clear();
          return;
        }
        remaining = graceRemaining({ markerAt: marker.at, now: d.now(), graceMs: UPDATE_INSTALL_GRACE_MS });
      }
      const tail = d.shipItLogTail();
      if (tail) d.log(`ShipIt log tail after failed install:\n${tail}`);
      whenWindowFocused(() => void showInstallFailed(marker));
    } finally {
      verifying = false;
    }
    void check();
  }

  // ---- wiring ----------------------------------------------------------------
  function start(): void {
    if (!enabled || started) return;
    started = true;
    const backend = d.backend();
    const native = d.native();

    native.onDownloaded(() => {
      nativeStaged = true;
      nativeConfirmedCycle = downloadCycle;
      if (state.phase !== "staging") {
        d.log("native staging confirmed outside a staging phase — not offering a restart");
        return;
      }
      d.log(`native staging complete for ${state.newVersion ?? "unknown"}`);
      setState({ phase: "downloaded", percent: 100 });
      offerRestart();
    });

    const failed = d.marker.takeFailed(d.currentVersion);
    if (failed) {
      if (d.relaunchIfDiskBundleNewer("disk bundle moved on after launch — the update installed; relaunching into it")) {
        d.marker.clear();
        return;
      }
      verifying = true;
      void verifyFailedInstall(failed);
    }

    d.onBeforeQuit(() => {
      if (willInstallOnQuit({ platform: d.platform, nativeStaged, phase: state.phase })) {
        d.marker.write(d.currentVersion, state.newVersion ?? "unknown");
      }
    });

    backend.onChecking(() => setState({ phase: "checking", blocked: undefined }));
    backend.onNotAvailable(() => {
      userInitiated = false;
      setState({ phase: "not-available" });
    });
    backend.onAvailable((version) => {
      downloadCycle += 1;
      setState({ phase: "available", newVersion: version });
    });
    backend.onProgress((percent) => setState({ phase: "downloading", percent: Math.round(percent) }));
    backend.onDownloaded((version) => {
      if (d.platform === "darwin") {
        if (stagedPhase({ downloadCycle, nativeConfirmedCycle }) === "downloaded") {
          d.log(`native staging already confirmed for ${version} — offering restart now`);
          setState({ phase: "downloaded", newVersion: version, percent: 100 });
          offerRestart();
          return;
        }
        nativeStaged = false;
        stagingStartedAt = d.now();
        setState({ phase: "staging", newVersion: version, percent: 100 });
        return;
      }
      setState({ phase: "downloaded", newVersion: version, percent: 100 });
      offerRestart();
    });
    backend.onError((err) => {
      const wasUser = userInitiated;
      userInitiated = false;
      toError(err);
      if (wasUser) {
        void showDialog({
          type: "warning",
          buttons: ["OK"],
          message: "Couldn’t download the update",
          detail: `${state.message ?? "The download didn’t finish."} ${PRODUCT_NAME} keeps checking in the background.`,
        });
      }
    });

    setTimeout(() => void check(), UPDATE_FIRST_CHECK_DELAY_MS);
    const interval = setInterval(() => void check(), UPDATE_CHECK_INTERVAL_MS);
    (interval as { unref?: () => void }).unref?.();
  }

  // ---- user check ------------------------------------------------------------
  async function info(message: string, detail: string): Promise<void> {
    await showDialog({ type: "info", buttons: ["OK"], message, detail });
  }

  async function userCheck(): Promise<void> {
    if (state.phase === "downloaded") {
      await promptRestartForUser();
      return;
    }
    if (!d.isPackaged) {
      await info(
        "Updates are unavailable in this build",
        "This is an unpackaged development build, so self-update is switched off.",
      );
      return;
    }
    if (!d.supported) {
      await info(
        "This install updates through your package manager",
        `${PRODUCT_NAME} was installed as a system package, so updates come from your package manager. In-app self-update applies only to the AppImage.`,
      );
      return;
    }
    if (!d.feedUrl) {
      await info(
        "Updates are turned off",
        `${PRODUCT_NAME} has no update feed configured, so it never checks for updates. Set REA_CLAUDE_UPDATE_URL to a generic update feed to enable them.`,
      );
      return;
    }
    if (verifying) {
      await info(
        "Finishing up the last update",
        `${PRODUCT_NAME} is confirming whether the update it downloaded earlier finished installing. Try again in a moment.`,
      );
      return;
    }
    if (state.phase === "staging") {
      userInitiated = true;
      await check();
      // `check` may have changed the phase; re-read through a widening alias.
      const after: UpdateState = state;
      if (after.phase === "staging") {
        await info(
          "An update is on the way",
          `${PRODUCT_NAME} ${after.newVersion ?? ""} has been downloaded and is being prepared. You’ll be offered a restart in a moment.`,
        );
        return;
      }
      if (after.phase !== "error") return;
      userInitiated = false;
      await showDialog({
        type: "warning",
        buttons: ["OK"],
        message: "Couldn’t prepare the update",
        detail: `${after.message ?? "The update stalled while being prepared."} ${PRODUCT_NAME} keeps trying in the background.`,
      });
      return;
    }
    const block = checkLocation();
    if (block !== "none") {
      if (block === "needs-move") {
        await showDialog({
          type: "warning",
          buttons: ["OK"],
          message: `${PRODUCT_NAME} can’t update from this location`,
          detail: `${PRODUCT_NAME} is running from a read-only location (like a disk image). ${MOVE_HINT}`,
        });
        return;
      }
      await showBlockedDialog(
        `${PRODUCT_NAME} can’t update itself on this Mac`,
        `Your user account can’t modify ${d.locationPath()}, so updates can’t be installed in place — ${ADMIN_HINT}`,
      );
      return;
    }
    userInitiated = true;
    await check();
    const after: UpdateState = state;
    if (after.phase === "not-available") {
      userInitiated = false;
      await info("You’re up to date", `${PRODUCT_NAME} ${d.currentVersion} is the latest version.`);
    } else if (after.phase === "error") {
      userInitiated = false;
      await showDialog({
        type: "warning",
        buttons: ["OK"],
        message: "Couldn’t check for updates",
        detail: `${after.message ?? "The update feed couldn’t be reached."} ${PRODUCT_NAME} keeps checking in the background.`,
      });
    }
  }

  return {
    isEnabled: () => enabled,
    getState: () => state,
    start,
    check,
    userCheck,
    install,
  };
}
