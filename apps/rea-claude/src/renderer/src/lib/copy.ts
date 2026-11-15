/** User-facing copy tables and message builders [renderer §4.7-§4.10, §4.15, §4.19]. */
import { PRODUCT_NAME } from "@shared/config";
import type { Phase } from "./types";

export const STILL_WAKING_MESSAGE =
  "Your lab is taking longer than usual to start. Try opening it again in a moment.";

export const WAKING_MESSAGE = "Getting your lab ready. This usually takes under a minute.";

export const NEEDS_SETUP_MESSAGE =
  "This cluster isn't set up yet, and setup couldn't start automatically. Check that you're allowlisted on it and signed in.";

export const DEFAULT_FAIL_MESSAGE = "This lab couldn't be opened. Try again in a moment.";

export const MANAGED_OTHER_MESSAGE =
  "This Lab couldn't be opened right now. If it keeps happening, reach out to Goodfire on Slack.";

export const CONNECT_FAILED = "Connect failed unexpectedly.";
export const OPEN_FAILED = "Opening the Lab failed unexpectedly.";
export const UPDATE_FAILED = "Update failed unexpectedly.";
export const STOP_FAILED = "Stopping the Lab failed unexpectedly.";

export interface RecoveryCopy {
  heading: string;
  body: string;
  action: string;
  /** Benign states get role=status. */
  benign: boolean;
}

/** Copy for the "Lab went down" panel. */
export function labRecoveryCopy(opts: { managed: boolean; reason?: string }): RecoveryCopy {
  if (opts.managed && opts.reason === "still-waking") {
    return { heading: "Still starting", body: STILL_WAKING_MESSAGE, action: "Try again", benign: true };
  }
  if (opts.managed) {
    return {
      heading: "Can’t reach your lab right now",
      body: "This is usually temporary. Try again — and if it keeps happening, reach out to Goodfire on Slack and we’ll take a look.",
      action: "Try again",
      benign: false,
    };
  }
  return {
    heading: "Your lab isn’t running",
    body: "Reconnect to start it again.",
    action: "Reconnect",
    benign: false,
  };
}

/** Short label shown in the ProgressPanel bar. */
export const PHASE_LABEL: Readonly<Record<Phase, string>> = {
  checking: "Checking the cluster…",
  ssh: "Connecting over SSH…",
  setup: "Setting up the cluster (first run)…",
  starting: "Firing up your lab…",
  updating: "Updating your lab…",
  opening: "Opening…",
  claiming: "Binding your account…",
  tunneling: "Connecting through SSH tunnel…",
  waiting: "Waiting for your lab to come online…",
  waking: "Firing up your lab…",
  stopping: "Stopping your lab…",
  done: "Done",
  error: "Failed",
  "host-key": "Host key needed",
  "needs-setup": "Setup needed",
  forbidden: "Not authorized",
  "still-waking": "Still starting…",
};

const PHASE_STATUS: Partial<Record<Phase, string>> = {
  checking: "Checking the cluster…",
  ssh: "Checking the cluster…",
  setup: "Setting up this cluster for the first time. This can take a few minutes.",
  starting: "Firing up your lab…",
  updating: "Installing the latest lab version. This can take a few minutes.",
  waiting: "Waiting for your lab to come online…",
  waking: WAKING_MESSAGE,
  done: "Almost ready…",
};

/** Sentence under the Opening title. */
export function phaseStatus(phase: Phase | undefined): string {
  return (phase && PHASE_STATUS[phase]) || "Connecting to your lab…";
}

export function forbiddenMessage(login: string | undefined): string {
  return login
    ? `You’re signed in as @${login}, which can’t open this Lab. You may have the wrong GitHub account.`
    : "This account can’t open this Lab. You may be signed in with the wrong GitHub account.";
}

export function unreachableMessage(managed: boolean, url: string): string {
  return managed
    ? `The app couldn't reach this Lab at ${url}. Check your internet connection, then try again.`
    : `This Lab is heartbeating but the app couldn't reach it at ${url}. It may be behind a VPN/Tailscale, still starting up, or shutting down. Check, then try again.`;
}

/** First line of the failure message on the Opening screen. */
export function failureMessage(phase: Phase, message: string | undefined): string {
  const full = phase === "needs-setup" ? NEEDS_SETUP_MESSAGE : (message ?? DEFAULT_FAIL_MESSAGE);
  return full.split("\n")[0] ?? "";
}

/** Window title (D1: app chrome uses PRODUCT_NAME). */
export function documentTitle(opts: {
  labTitle?: string;
  localLab: boolean;
  staging: boolean;
}): string {
  const app = opts.localLab
    ? `${PRODUCT_NAME} (local development · staging auth gateway)`
    : opts.staging
      ? `${PRODUCT_NAME} (Staging)`
      : PRODUCT_NAME;
  return opts.labTitle !== undefined ? `${opts.labTitle} — ${app}` : app;
}

export function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}
