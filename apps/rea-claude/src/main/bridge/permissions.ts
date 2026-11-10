/**
 * Session permission handlers [bridge §5, windows §6.4]. Electron-free: the
 * focused-Lab lookup, dialog and webContents accessors are injected so the
 * decision logic is unit-testable.
 *
 * - non-media: grant only ALLOWED_PERMISSIONS (clipboard-sanitized-write,
 *   fullscreen); notifications and everything else are denied.
 * - media: Lab partition only, main frame, exactly ["audio"], requester is the
 *   focused window's shown Lab (same origin as the Lab), no prompt in flight;
 *   remembered origin → grant; else confirm with the user and re-check.
 */
import { ALLOWED_PERMISSIONS } from "@shared/config";

const ALLOWED = new Set(ALLOWED_PERMISSIONS);

export const MIC_DIALOG = {
  type: "question",
  title: "Microphone access",
  message: "Allow microphone access for dictation?",
  buttons: ["Allow microphone", "Cancel"],
  defaultId: 1,
  cancelId: 1,
  noLink: true,
} as const;

export function micDialogDetail(origin: string): string {
  return `${origin}\nAudio is sent to your Lab's transcription service when you finish dictating.`;
}

export interface MicDialogOptions {
  type: "question";
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
}

export interface PermissionDeps<W extends object, Win> {
  /** True for the `persist:silico` partition (signup partition → false). */
  isLabPartition: boolean;
  /** `Dn`: focused window whose shown Lab is `wc`, with `url` and wc's URL same-origin as the Lab. */
  focusedLabWindowFor(wc: W, url: string | undefined): Win | null;
  getURL(wc: W): string;
  isDestroyed(wc: W): boolean;
  showDialog(win: Win, opts: MicDialogOptions): Promise<{ response: number }>;
}

export interface RequestDetailsLike {
  isMainFrame: boolean;
  requestingUrl?: string;
  mediaTypes?: readonly string[];
}

export interface CheckDetailsLike {
  isMainFrame: boolean;
  requestingUrl?: string;
  mediaType?: string;
}

/** `URL.origin` or null. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Shared grant memory (`wc -> origin`, in-memory only) and in-flight prompt set. */
export class MicGrants<W extends object> {
  readonly granted = new WeakMap<W, string>();
  readonly prompting = new WeakSet<W>();
}

function isAudioOnly(d: RequestDetailsLike): boolean {
  return Array.isArray(d.mediaTypes) && d.mediaTypes.length === 1 && d.mediaTypes[0] === "audio";
}

/** Build a `setPermissionRequestHandler` callback. */
export function createPermissionRequestHandler<W extends object, Win>(
  deps: PermissionDeps<W, Win>,
  grants: MicGrants<W>,
): (wc: W, permission: string, callback: (granted: boolean) => void, details: RequestDetailsLike) => void {
  return (wc, permission, callback, details) => {
    if (permission !== "media") {
      callback(ALLOWED.has(permission));
      return;
    }
    if (!deps.isLabPartition || !details.isMainFrame || !isAudioOnly(details)) {
      callback(false);
      return;
    }
    const win = deps.focusedLabWindowFor(wc, details.requestingUrl);
    if (!win || grants.prompting.has(wc)) {
      callback(false);
      return;
    }
    const url = deps.getURL(wc);
    const origin = originOf(url);
    if (!origin) {
      callback(false);
      return;
    }
    if (grants.granted.get(wc) === origin) {
      callback(true);
      return;
    }
    grants.prompting.add(wc);
    let dialog: Promise<{ response: number }>;
    try {
      dialog = deps.showDialog(win, { ...MIC_DIALOG, buttons: [...MIC_DIALOG.buttons], detail: micDialogDetail(origin) });
    } catch {
      grants.prompting.delete(wc);
      callback(false);
      return;
    }
    dialog.then(
      ({ response }) => {
        grants.prompting.delete(wc);
        const ok =
          response === 0 &&
          !deps.isDestroyed(wc) &&
          deps.getURL(wc) === url &&
          deps.focusedLabWindowFor(wc, details.requestingUrl) === win;
        if (ok) grants.granted.set(wc, origin);
        callback(ok);
      },
      () => {
        grants.prompting.delete(wc);
        callback(false);
      },
    );
  };
}

/** Build a `setPermissionCheckHandler` callback. */
export function createPermissionCheckHandler<W extends object, Win>(
  deps: PermissionDeps<W, Win>,
  grants: MicGrants<W>,
): (wc: W | null, permission: string, requestingOrigin: string, details: CheckDetailsLike) => boolean {
  return (wc, permission, requestingOrigin, details) => {
    if (permission !== "media") return ALLOWED.has(permission);
    return (
      deps.isLabPartition &&
      details.isMainFrame &&
      details.mediaType === "audio" &&
      !!wc &&
      !!deps.focusedLabWindowFor(wc, details.requestingUrl ?? requestingOrigin) &&
      grants.granted.get(wc) === requestingOrigin
    );
  };
}

/** Pure part of `Dn`: same-origin checks once the focused shown Lab is known. */
export function sameOrigin(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const oa = originOf(a);
  return oa !== null && oa === originOf(b);
}
