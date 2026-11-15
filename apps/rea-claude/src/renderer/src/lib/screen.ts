/**
 * App screen precedence [renderer §2 content list, §3 top-level render
 * decision, compact picker, app:navigate]. Encoded once here so the ordering
 * is unit-testable.
 */
import type { AuthState, NavigateDest, SettingsTab } from "@shared/ipc";
import type { LabCover, LabModel, View } from "./types";

/** `app:navigate` destination -> view + tab. Unknown destinations mean labs. */
export function parseNavigate(dest: NavigateDest): { view: View; tab?: SettingsTab } {
  if (typeof dest === "string" && dest.startsWith("settings")) {
    return { view: "settings", tab: settingsTabFrom(dest.split(":")[1]) };
  }
  return { view: "labs" };
}

/** Tab word from `settings:<tab>` or `#settings-modal/<tab>`; defaults to notifications. */
export function settingsTabFrom(word: string | undefined): SettingsTab {
  return word === "profile" || word === "developer" ? word : "notifications";
}

export type RootKind = { kind: "settings-modal"; tab: SettingsTab } | { kind: "viewer" } | { kind: "app" };

/** Which root app a window renders, from `location.hash`. */
export function rootFromHash(hash: string): RootKind {
  const m = /^#settings-modal\/(\w+)$/.exec(hash);
  if (m) return { kind: "settings-modal", tab: settingsTabFrom(m[1]) };
  if (hash === "#viewer") return { kind: "viewer" };
  return { kind: "app" };
}

export type ContentKind =
  | "settings"
  | "lab-loading"
  | "edit"
  | "add"
  | "opening"
  | "labs-empty"
  | "labs-list";

/** Pane content, first match wins. */
export function selectContent(s: {
  view: View;
  lab: LabModel | null;
  editing: boolean;
  adding: boolean;
  /** openingId resolves to a connection AND it has a conn state. */
  openingActive: boolean;
  visibleCount: number;
}): ContentKind {
  if (s.view === "settings") return "settings";
  if (s.lab && s.lab.state === "loading") return "lab-loading";
  if (s.editing) return "edit";
  if (s.adding) return "add";
  if (s.openingActive) return "opening";
  return s.visibleCount === 0 ? "labs-empty" : "labs-list";
}

/** Content kinds drawn full-window (no rail / picker chrome). */
export function isOpeningFull(c: ContentKind): boolean {
  return c === "lab-loading" || c === "opening";
}

export type ScreenKind =
  | "signup"
  | "auth-loading"
  | "sign-in"
  | "opening-full"
  | "launch-gate"
  | "lab-cover"
  | "lab-down"
  | "shell";

/** Top-level App branch, in precedence order. */
export function selectScreen(s: {
  signupOpen: boolean;
  auth: AuthState | undefined;
  content: ContentKind;
  launchGate: boolean;
  labCover: LabCover;
  lab: LabModel | null;
}): ScreenKind {
  if (s.signupOpen) return "signup";
  if (s.auth === undefined) return "auth-loading";
  if (s.auth.status === "signed-out") return "sign-in";
  if (isOpeningFull(s.content)) return "opening-full";
  if (s.launchGate) return "launch-gate";
  if (s.labCover.shown || s.lab?.state === "ready") return "lab-cover";
  if (s.lab?.state === "down") return "lab-down";
  return "shell";
}

/** Compact picker chrome vs full rail shell. */
export function isLabsPicker(s: {
  signedIn: boolean;
  signupOpen: boolean;
  launchGate: boolean;
  lab: LabModel | null;
  openingId: string | null;
  view: View;
  adding: boolean;
  editing: boolean;
  pickerPage: boolean;
}): boolean {
  const inPickerWindow = s.signedIn && !s.signupOpen && !s.launchGate && !s.lab && !s.openingId;
  if (!inPickerWindow) return false;
  const subflow = s.view === "settings" || s.adding || s.editing;
  return subflow ? s.pickerPage : s.view === "labs";
}

/** setCompact may run once the landing is known. */
export function isLandingKnown(
  auth: AuthState | undefined,
  isInitialWin: boolean | null,
  launchGate: boolean,
): boolean {
  return auth !== undefined && isInitialWin !== null && (isInitialWin || !launchGate);
}
