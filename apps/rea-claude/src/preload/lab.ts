/**
 * Lab preload: exposes `window.silicoDesktop` to remote Lab pages (Lab views
 * and lab-bridge viewer views on partition `persist:silico`). FROZEN SHARED
 * FILE. The global name and channel names are kept for interop with Lab web
 * apps served by Silico (decision D2). Shape: `SilicoDesktopApi`.
 *
 * Runs sandboxed: imports only `electron` and bundled `@shared/*` constants.
 */
import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import { LabEventChannel as E, LabInvokeChannel as I, LabSendChannel as S } from "@shared/ipc";
import type {
  CheckoutOutcome,
  ForegroundEvent,
  GithubConnectReturn,
  McpOauthReturn,
  SilicoDesktopApi,
  Unsubscribe,
} from "@shared/ipc";

function onPayload<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

function onSignal(channel: string, cb: () => void): Unsubscribe {
  const listener = (): void => cb();
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

/**
 * Pull-on-signal: on each payload-less nudge, invoke `take` and forward only
 * truthy results. A rejected take (e.g. sender not trusted, handler error) is
 * logged and swallowed so it never surfaces as an unhandled rejection in the
 * Lab page.
 */
function onPull<T>(signal: string, take: string, cb: (value: T) => void): Unsubscribe {
  const listener = (): void => {
    ipcRenderer
      .invoke(take)
      .then((value: T | null) => {
        if (value) cb(value);
      })
      .catch((err: unknown) => {
        console.warn(`[silicoDesktop] ${take} failed`, err);
      });
  };
  ipcRenderer.on(signal, listener);
  return () => {
    ipcRenderer.removeListener(signal, listener);
  };
}

const api: SilicoDesktopApi = {
  recoverSession: () => ipcRenderer.invoke(I.recoverSession),
  notify: (payload) => {
    ipcRenderer.send(S.notify, payload);
  },
  setBadgeCounts: (counts) => {
    ipcRenderer.send(S.badgeCounts, counts);
  },
  onNavigate: (cb) => onPayload<string>(E.navigate, cb),
  beginCheckout: () => ipcRenderer.invoke(I.beginCheckout),
  onCheckoutReturn: (cb) => onPayload<CheckoutOutcome>(E.checkoutReturn, cb),
  beginMcpOauth: () => ipcRenderer.invoke(I.beginMcpOauth),
  onMcpOauthReturn: (cb) => onPull<McpOauthReturn>(E.mcpOauthReturn, I.takeMcpOauthReturn, cb),
  takeMcpOauthReturn: () => ipcRenderer.invoke(I.takeMcpOauthReturn),
  beginGithubConnect: () => ipcRenderer.invoke(I.beginGithubConnect),
  onGithubConnectReturn: (cb) => onPull<GithubConnectReturn>(E.githubConnectReturn, I.takeGithubConnectReturn, cb),
  takeGithubConnectReturn: () => ipcRenderer.invoke(I.takeGithubConnectReturn),
  manageReturn: true,
  onReportIssue: (cb) => onSignal(E.reportIssue, cb),
  onForeground: (cb) => onPayload<ForegroundEvent>(E.foreground, cb),
  onShellEventNudge: (cb) => onSignal(E.shellEventNudge, cb),
  drainShellEvents: () => ipcRenderer.invoke(I.shellEventsDrain),
  openDesktopSettings: () => {
    ipcRenderer.send(S.openDesktopSettings);
  },
  openLabSwitcher: () => {
    ipcRenderer.send(S.openLabSwitcher);
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("silicoDesktop", api);
  } catch (err) {
    console.error(err);
  }
} else {
  console.warn("contextIsolation is disabled; the silicoDesktop bridge was not exposed");
}
