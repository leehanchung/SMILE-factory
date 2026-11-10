/** Settings rows and patches [renderer §4.13]. */
import { DEFAULT_NOTIFICATIONS } from "@shared/config";
import type { ConfirmOptions, NotificationSettings, Settings, SettingsPatch, SettingsTab } from "@shared/ipc";
import type { SettingsSection } from "./types";

export interface ToggleSpec<K extends string> {
  key: K;
  label: string;
  desc: string;
}

export const NOTIFICATION_TOGGLES: ReadonlyArray<ToggleSpec<keyof NotificationSettings>> = [
  {
    key: "enabled",
    label: "Enable notifications",
    desc: "Native notifications for the moments that need you. Off silences all of them.",
  },
  { key: "needsInput", label: "Needs your input", desc: "Notify when an experiment is waiting on you." },
  { key: "experimentFinished", label: "Experiment finished", desc: "Notify when an experiment completes." },
  { key: "sound", label: "Play sound", desc: "Play the system sound with each notification." },
  {
    key: "notifyWhenActive",
    label: "Notify about the experiment I’m viewing",
    desc: "By default nothing shows for the experiment you’re already looking at. Turn on to notify anyway.",
  },
  {
    key: "badge",
    label: "App icon badge",
    desc: "Show how many threads need you on the app icon — or a dot for unread activity.",
  },
];

export type DeveloperKey = "developerMode" | "previewBuilds" | "skipVersionCheck" | "staging" | "verbose";

export const DEVELOPER_TOGGLES: ReadonlyArray<ToggleSpec<DeveloperKey>> = [
  {
    key: "developerMode",
    label: "Developer mode",
    desc: "Show developer detail across the app: connect logs, Lab versions, and advanced Lab actions like SSH tunnels.",
  },
  {
    key: "previewBuilds",
    label: "Preview build",
    desc: "Run Labs on the unreleased preview build. Updates move them onto it automatically. Off, Labs return to the stable build on their next update.",
  },
  {
    key: "skipVersionCheck",
    label: "Skip build update",
    desc: "Open Labs as they are, without updating them to the pinned version first. Useful for running untagged builds.",
  },
  {
    key: "staging",
    label: "Staging environment",
    desc: "Use silico-dev instead of production. Switching signs you out, then asks you to sign in again.",
  },
  {
    key: "verbose",
    label: "Verbose connect logs",
    desc: "Show the full command output while a Lab connects or updates.",
  },
];

export function notificationsOf(settings: Settings | null | undefined): NotificationSettings {
  return settings?.notifications ?? DEFAULT_NOTIFICATIONS;
}

/** Toggle one notification key (whole object is sent: the patch is shallow). */
export function notificationPatch(
  current: NotificationSettings,
  key: keyof NotificationSettings,
): SettingsPatch {
  return { notifications: { ...current, [key]: !current[key] } };
}

/** Only "enabled" stays interactive while notifications are off. */
export function notificationToggleDisabled(n: NotificationSettings, key: keyof NotificationSettings): boolean {
  return key !== "enabled" && !n.enabled;
}

export function stagingConfirm(next: boolean): ConfirmOptions {
  return {
    message: next ? "Switch to staging (dev twins)?" : "Switch to production?",
    detail: "This signs you out and re-authenticates.",
    confirmLabel: "Switch",
  };
}

export function sectionTitle(section: SettingsSection): string {
  switch (section) {
    case "profile":
      return "Profile";
    case "notifications":
      return "Notifications";
    case "developer":
      return "Developer settings";
    default:
      return "Desktop settings";
  }
}

export const SETTINGS_TABS: readonly SettingsTab[] = ["notifications", "developer", "profile"];
