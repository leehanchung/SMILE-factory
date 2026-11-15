/**
 * Shell preload: exposes `window.silico` to the app's own renderer (shell,
 * settings sheet, viewer strip). FROZEN SHARED FILE.
 *
 * Runs sandboxed: imports only `electron` (renderer-side modules) and bundled
 * `@shared/*` constants. Shape: `SilicoApi` in src/shared/ipc.ts.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import { ShellEventChannel as E, ShellInvokeChannel as C } from "@shared/ipc";
import type {
  AuthState,
  LabOpenedEvent,
  LabOutputEvent,
  LabPhaseEvent,
  LabStateEvent,
  NavState,
  NavigateDest,
  RecoveryState,
  Settings,
  SilicoApi,
  Unsubscribe,
  UpdateState,
  ViewVis,
} from "@shared/ipc";

/** Subscribe forwarding the first payload argument (never the IpcRendererEvent). */
function onPayload<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

/** Subscribe with no arguments forwarded. */
function onSignal(channel: string, cb: () => void): Unsubscribe {
  const listener = (): void => cb();
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: SilicoApi = {
  ping: () => ipcRenderer.invoke(C.ping),
  platform: process.platform,
  isDevBuild: () => ipcRenderer.invoke(C.appIsDevBuild),
  isInitialWindow: () => ipcRenderer.invoke(C.windowIsInitial),
  setCompact: (compact, contentHeight) => ipcRenderer.invoke(C.windowSetCompact, compact, contentHeight),
  openSettingsSheet: () => ipcRenderer.invoke(C.windowOpenSettingsSheet),
  detectLocalStacks: () => ipcRenderer.invoke(C.localDetectStacks),
  pickSshKey: () => ipcRenderer.invoke(C.dialogPickFile),
  confirm: (opts) => ipcRenderer.invoke(C.dialogConfirm, opts),
  onNavigate: (cb) => onPayload<NavigateDest>(E.appNavigate, cb),
  auth: {
    status: () => ipcRenderer.invoke(C.authStatus),
    persistence: () => ipcRenderer.invoke(C.authPersistence),
    signIn: (staging, restart = false) => ipcRenderer.invoke(C.authSignIn, staging, restart),
    signOutEverywhere: () => ipcRenderer.invoke(C.authSignOutAll),
    onExpired: (cb) => onSignal(E.authExpired, cb),
    onChanged: (cb) => onPayload<AuthState>(E.authChanged, cb),
  },
  signup: {
    open: () => ipcRenderer.invoke(C.signupOpen),
    close: () => ipcRenderer.invoke(C.signupClose),
    status: () => ipcRenderer.invoke(C.signupStatus),
    onOpened: (cb) => onSignal(E.signupOpened, cb),
    onClosed: (cb) => onSignal(E.signupClosed, cb),
  },
  labs: {
    list: () => ipcRenderer.invoke(C.labsList),
    heldElsewhere: () => ipcRenderer.invoke(C.labsHeldElsewhere),
    focusHeld: (connId) => ipcRenderer.invoke(C.labsFocusHeld, connId),
  },
  settings: {
    get: () => ipcRenderer.invoke(C.settingsGet),
    set: (patch) => ipcRenderer.invoke(C.settingsSet, patch),
    onChanged: (cb) => onPayload<Settings>(E.settingsChanged, cb),
  },
  lastOpened: {
    get: (account) => ipcRenderer.invoke(C.lastOpenedGet, account),
    set: (account, connId) => ipcRenderer.invoke(C.lastOpenedSet, account, connId),
  },
  ssh: {
    listHosts: () => ipcRenderer.invoke(C.sshListHosts),
    addHost: (input) => ipcRenderer.invoke(C.sshAddHost, input),
  },
  connections: {
    list: () => ipcRenderer.invoke(C.connectionsList),
    upsert: (conn) => ipcRenderer.invoke(C.connectionsUpsert, conn),
    remove: (id) => ipcRenderer.invoke(C.connectionsRemove, id),
    onChanged: (cb) => onSignal(E.connectionsChanged, cb),
  },
  lab: {
    status: (url) => ipcRenderer.invoke(C.labStatus, url),
    test: (target) => ipcRenderer.invoke(C.labTest, target),
    hostKey: {
      scan: (target) => ipcRenderer.invoke(C.labHostKeyScan, target),
      accept: (target, expectedFingerprint) => ipcRenderer.invoke(C.labHostKeyAccept, target, expectedFingerprint),
    },
    open: (conn, opts) => ipcRenderer.invoke(C.labOpen, conn, opts),
    connect: (conn, verbose = false, opts) => ipcRenderer.invoke(C.labConnect, conn, verbose, opts),
    update: (conn, opts) => ipcRenderer.invoke(C.labUpdate, conn, opts),
    cancel: (connId) => ipcRenderer.invoke(C.labCancel, connId),
    down: (conn) => ipcRenderer.invoke(C.labDown, conn),
    onOutput: (cb) => onPayload<LabOutputEvent>(E.labOutput, cb),
    onPhase: (cb) => onPayload<LabPhaseEvent>(E.labPhase, cb),
  },
  update: {
    getState: () => ipcRenderer.invoke(C.updateGetState),
    install: () => ipcRenderer.invoke(C.updateInstall),
    onState: (cb) => onPayload<UpdateState>(E.updateState, cb),
  },
  labView: {
    hide: () => ipcRenderer.invoke(C.labHide),
    goBack: () => ipcRenderer.invoke(C.labGoBack),
    goForward: () => ipcRenderer.invoke(C.labGoForward),
    onNavState: (cb) => onPayload<NavState>(E.labNavState, cb),
    onOpened: (cb) => onPayload<LabOpenedEvent>(E.labOpened, cb),
    onState: (cb) => onPayload<LabStateEvent>(E.labState, cb),
    onViewVis: (cb) => onPayload<ViewVis>(E.labViewVis, cb),
  },
  viewer: {
    retry: (deployment) => ipcRenderer.invoke(C.viewerRetry, deployment),
    onRecovery: (cb) => onPayload<RecoveryState>(E.viewerRecovery, cb),
    onTitle: (cb) => onPayload<string>(E.viewerTitle, cb),
    onContentReady: (cb) => onPayload<false | undefined>(E.viewerContentReady, (p) => cb(p !== false)),
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("silico", api);
  } catch (err) {
    console.error(err);
  }
} else {
  console.warn("contextIsolation is disabled; the silico bridge was not exposed");
}
