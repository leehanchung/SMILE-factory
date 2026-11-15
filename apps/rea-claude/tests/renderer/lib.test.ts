import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@shared/config";
import type { AuthState, Connection, DiscoveredLab } from "@shared/ipc";
import { decideAutoOpen, lastOpenedRow } from "@renderer/lib/autoOpen";
import type { AutoOpenInput } from "@renderer/lib/autoOpen";
import {
  chooseOpenAction,
  isOpeningFailed,
  isRowFailed,
  isRunningPhase,
  mapConnectOutcome,
  mapOpenResult,
  mapUpdateOutcome,
} from "@renderer/lib/connect";
import {
  STILL_WAKING_MESSAGE,
  documentTitle,
  failureMessage,
  forbiddenMessage,
  labRecoveryCopy,
  phaseStatus,
  unreachableMessage,
} from "@renderer/lib/copy";
import {
  canSave,
  filterHosts,
  hostOptions,
  newHostInput,
  primaryAction,
  primaryLabel,
  savedName,
  sshTestTarget,
} from "@renderer/lib/form";
import { nextUnusedIcon } from "@renderer/lib/icons";
import { buildLocalDevDraft, localStackConnection, localStackName } from "@renderer/lib/localDev";
import { fmtElapsed, shapeLog } from "@renderer/lib/log";
import { isLive, rowMenuEntries } from "@renderer/lib/rowMenu";
import {
  draftFromDiscovered,
  freshDiscovered,
  managedRowsToAdd,
  rowsToClaim,
  sortConnections,
  stampForSave,
} from "@renderer/lib/rows";
import {
  isLabsPicker,
  isLandingKnown,
  parseNavigate,
  rootFromHash,
  selectContent,
  selectScreen,
} from "@renderer/lib/screen";
import {
  notificationPatch,
  notificationToggleDisabled,
  sectionTitle,
  stagingConfirm,
} from "@renderer/lib/settings";
import { sshAliasFor } from "@renderer/lib/sshAlias";
import { isFullSha, isOutOfDate, labUpdateFlags, versionLines } from "@renderer/lib/update";
import { googleLinkHost, labBaseUrl, openReachBudgetMs } from "@renderer/lib/urls";
import {
  developerSettingsVisible,
  discoveryStatus,
  isVisibleTo,
  managedRowId,
  modalDeveloperVisible,
} from "@renderer/lib/visibility";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const GW = "https://my.silico.run";
const signedIn: AuthState = {
  status: "signed-in",
  login: "alice",
  sub: "github:1",
  gatewayUrl: GW,
  expiresAt: 1,
  developer: false,
};

function conn(p: Partial<Connection> = {}): Connection {
  return { id: "c1", name: "", icon: "flask", deploymentId: "", labUrl: "", ...p };
}
function lab(p: Partial<DiscoveredLab> = {}): DiscoveredLab {
  return {
    deploymentId: "d1",
    labPublicHost: "d1.silico.run",
    routeMode: "cluster",
    stale: false,
    updateAvailable: false,
    updateRequired: false,
    ...p,
  };
}

describe("isVisibleTo", () => {
  const disc = new Set(["x"]);
  it("hides dismissed rows", () => {
    expect(isVisibleTo({ ...conn(), dismissed: true }, "alice", GW, "ok", disc)).toBe(false);
  });
  it("hides rows for another gateway", () => {
    expect(isVisibleTo({ gatewayUrl: "A", deploymentId: "" }, "alice", "B", "ok", disc)).toBe(false);
  });
  it("shows an unstamped, unowned row vouched by discovery", () => {
    expect(isVisibleTo({ deploymentId: "x" }, "alice", GW, "ok", disc)).toBe(true);
  });
  it("hides the same row while discovery is loading", () => {
    expect(isVisibleTo({ deploymentId: "x" }, "alice", GW, "loading", disc)).toBe(false);
  });
  it("keeps the user's own row while discovery is unavailable", () => {
    expect(isVisibleTo({ deploymentId: "x", owner: "alice" }, "alice", GW, "unavailable", disc)).toBe(true);
    expect(isVisibleTo({ deploymentId: "x", owner: "bob" }, "alice", GW, "unavailable", disc)).toBe(false);
  });
  it("owner rule wins once the environment matches", () => {
    expect(isVisibleTo({ deploymentId: "y", gatewayUrl: GW, owner: "alice" }, "alice", GW, "ok", disc)).toBe(true);
  });
  it("rows without deployment id and owner are vouched", () => {
    expect(isVisibleTo({ deploymentId: "" }, "alice", GW, "ok", disc)).toBe(true);
  });
  it("managedRowId format", () => {
    expect(managedRowId("a", "d", GW)).toBe(`managed:a:d:${GW}`);
  });
});

describe("discoveryStatus / developer visibility", () => {
  it("loading / ok / unavailable", () => {
    expect(discoveryStatus(undefined, true, null)).toBe("loading");
    expect(discoveryStatus(signedIn, false, null)).toBe("loading");
    expect(discoveryStatus(signedIn, true, { gatewayUrl: GW, login: "alice" })).toBe("ok");
    expect(discoveryStatus(signedIn, true, { gatewayUrl: GW, login: "bob" })).toBe("unavailable");
    expect(discoveryStatus(signedIn, true, null)).toBe("unavailable");
  });
  it("developerSettingsVisible", () => {
    expect(developerSettingsVisible(signedIn, DEFAULT_SETTINGS)).toBe(false);
    expect(developerSettingsVisible({ ...signedIn, developer: true }, DEFAULT_SETTINGS)).toBe(true);
    expect(developerSettingsVisible(signedIn, { ...DEFAULT_SETTINGS, verbose: true })).toBe(true);
    expect(developerSettingsVisible(signedIn, { ...DEFAULT_SETTINGS, skipVersionCheck: true })).toBe(true);
    expect(developerSettingsVisible(undefined, null)).toBe(false);
  });
  it("modal variant also shows while the developer tab is selected", () => {
    expect(modalDeveloperVisible(signedIn, DEFAULT_SETTINGS, "developer")).toBe(true);
    expect(modalDeveloperVisible(signedIn, DEFAULT_SETTINGS, "profile")).toBe(false);
  });
});

describe("local dev", () => {
  it("localStackName", () => {
    expect(localStackName({ branch: "feat/x", project: "p" })).toBe("x");
    expect(localStackName({ branch: "main", worktree: "wt", project: "p" })).toBe("wt");
    expect(localStackName({ branch: "HEAD", project: "silico-local-foo" })).toBe("local foo");
    expect(localStackName({ branch: " ", worktree: "", project: "bar" })).toBe("bar");
  });
  it("buildLocalDevDraft", () => {
    expect(buildLocalDevDraft({ name: "", port: 5173 })).toEqual({
      name: "Local dev (:5173)",
      icon: "cpu",
      deploymentId: "goodfire-local",
      labUrl: "http://localhost:5173",
      routeMode: "local",
    });
    for (const port of [0, 70000, 1.5]) {
      expect(() => buildLocalDevDraft({ name: "", port })).toThrow(`invalid local Lab port: ${port}`);
    }
  });
  it("localStackConnection id", () => {
    expect(localStackConnection({ project: "silico-local-a", port: 3000 }).id).toBe("local:silico-local-a");
  });
});

describe("copy", () => {
  it("labRecoveryCopy branches", () => {
    expect(labRecoveryCopy({ managed: true, reason: "still-waking" })).toMatchObject({
      heading: "Still starting",
      body: STILL_WAKING_MESSAGE,
      action: "Try again",
      benign: true,
    });
    expect(labRecoveryCopy({ managed: true })).toMatchObject({
      heading: "Can’t reach your lab right now",
      action: "Try again",
      benign: false,
    });
    expect(labRecoveryCopy({ managed: false, reason: "still-waking" })).toMatchObject({
      heading: "Your lab isn’t running",
      body: "Reconnect to start it again.",
      action: "Reconnect",
    });
  });
  it("phaseStatus", () => {
    expect(phaseStatus(undefined)).toBe("Connecting to your lab…");
    expect(phaseStatus("tunneling")).toBe("Connecting to your lab…");
    expect(phaseStatus("ssh")).toBe("Checking the cluster…");
    expect(phaseStatus("done")).toBe("Almost ready…");
    expect(phaseStatus("waking")).toBe("Getting your lab ready. This usually takes under a minute.");
  });
  it("forbiddenMessage", () => {
    expect(forbiddenMessage("alice")).toBe(
      "You’re signed in as @alice, which can’t open this Lab. You may have the wrong GitHub account.",
    );
    expect(forbiddenMessage(undefined)).toBe(
      "This account can’t open this Lab. You may be signed in with the wrong GitHub account.",
    );
  });
  it("unreachableMessage and failureMessage", () => {
    expect(unreachableMessage(true, "https://x")).toContain("Check your internet connection");
    expect(unreachableMessage(false, "https://x")).toContain("VPN/Tailscale");
    expect(failureMessage("error", "first\nsecond")).toBe("first");
    expect(failureMessage("error", undefined)).toBe("This lab couldn't be opened. Try again in a moment.");
    expect(failureMessage("needs-setup", "ignored")).toMatch(/^This cluster isn't set up yet/);
  });
  it("documentTitle", () => {
    expect(documentTitle({ localLab: false, staging: false })).toBe("Rea Claude");
    expect(documentTitle({ localLab: false, staging: true })).toBe("Rea Claude (Staging)");
    expect(documentTitle({ labTitle: "L", localLab: true, staging: true })).toBe(
      "L — Rea Claude (local development · staging auth gateway)",
    );
  });
});

describe("urls", () => {
  it("openReachBudgetMs", () => {
    expect(openReachBudgetMs("reachable")).toBe(3000);
    expect(openReachBudgetMs("unreachable")).toBe(90000);
    expect(openReachBudgetMs(undefined)).toBe(90000);
  });
  it("labBaseUrl", () => {
    expect(labBaseUrl("h", 443)).toBe("https://h");
    expect(labBaseUrl("x.silico.run", 8443)).toBe("https://x.silico.run:8443");
    expect(labBaseUrl("10.0.0.1", 8000)).toBe("http://10.0.0.1:8000");
  });
  it("googleLinkHost", () => {
    expect(googleLinkHost("https://my-staging.silico.run")).toBe("silico-staging.goodfire.com");
    expect(googleLinkHost(GW)).toBe("silico.goodfire.com");
  });
});

describe("labUpdateFlags", () => {
  const none = { required: false, soft: false, any: false };
  it("undefined -> all false", () => expect(labUpdateFlags(undefined)).toEqual(none));
  it("updateRequired", () =>
    expect(labUpdateFlags({ updateRequired: true })).toEqual({ required: true, soft: false, any: true }));
  it("updateAvailable", () =>
    expect(labUpdateFlags({ updateAvailable: true })).toEqual({ required: false, soft: true, any: true }));
  it("reportsVersion false", () => expect(labUpdateFlags({ reportsVersion: false }).soft).toBe(true));
  it("stale ignores server flags", () => expect(labUpdateFlags({ stale: true, updateRequired: true })).toEqual(none));
  it("off-pin full shas count even when stale", () => {
    const d = { stale: true, currentSha: SHA_A, targetSha: SHA_B };
    expect(labUpdateFlags(d, { pinnedExactCheck: true })).toEqual({ required: false, soft: true, any: true });
    expect(labUpdateFlags(d)).toEqual(none);
  });
  it("case-insensitive equal and short shas are on-pin", () => {
    expect(labUpdateFlags({ currentSha: SHA_A, targetSha: SHA_A.toUpperCase() }, { pinnedExactCheck: true }).any).toBe(false);
    expect(labUpdateFlags({ currentSha: "abc", targetSha: "def" }, { pinnedExactCheck: true }).any).toBe(false);
  });
  it("isFullSha", () => {
    expect(isFullSha(SHA_A)).toBe(true);
    expect(isFullSha("abc")).toBe(false);
    expect(isFullSha(undefined)).toBe(false);
  });
  it("isOutOfDate respects skip/managed and the pin check", () => {
    const disc = { currentSha: SHA_A, targetSha: SHA_B };
    const base = { skipVersionCheck: false, managed: false, disc, previewPinned: false, staging: false };
    expect(isOutOfDate(base)).toBe(true);
    expect(isOutOfDate({ ...base, skipVersionCheck: true })).toBe(false);
    expect(isOutOfDate({ ...base, managed: true })).toBe(false);
    expect(isOutOfDate({ ...base, previewPinned: true })).toBe(false);
    expect(isOutOfDate({ ...base, staging: true })).toBe(false);
  });
});

describe("versionLines", () => {
  const base = { managed: false, versionless: false, live: true, sha: SHA_A, outOfDate: false, targetSha: SHA_B };
  it("managed -> none", () => expect(versionLines({ ...base, managed: true })).toBeUndefined());
  it("skip/staging", () => {
    expect(versionLines({ ...base, versionless: true })).toEqual(["Version · aaaaaaa"]);
    expect(versionLines({ ...base, versionless: true, live: false })).toBeUndefined();
  });
  it("out of date", () => {
    expect(versionLines({ ...base, outOfDate: true })).toEqual(["Current version · aaaaaaa", "Update available · bbbbbbb"]);
    expect(versionLines({ ...base, outOfDate: true, sha: undefined, targetSha: undefined })).toEqual([
      "Update available",
    ]);
  });
  it("up to date", () => {
    expect(versionLines(base)).toEqual(["Up to date · aaaaaaa"]);
    expect(versionLines({ ...base, live: false })).toBeUndefined();
  });
});

describe("log", () => {
  it("fmtElapsed", () => {
    expect(fmtElapsed(0)).toBe("0:00");
    expect(fmtElapsed(65_400)).toBe("1:05");
    expect(fmtElapsed(-5)).toBe("0:00");
  });
  it("drops httpx noise", () => {
    expect(shapeLog("a\nINFO [httpx] HTTP Request: GET x\nb")).toBe("a\nb");
  });
  it("dedupes timestamped messages in place", () => {
    const raw = "2024-01-01 10:00:00 waiting\nother\n2024-01-01 10:00:05 waiting";
    expect(shapeLog(raw)).toBe("2024-01-01 10:00:05 waiting\nother");
  });
  it("collapses booting lines (latest wins, first position)", () => {
    expect(shapeLog("Lab is booting... 1\nx\nLab is booting... 2")).toBe("Lab is booting... 2\nx");
  });
  it("keeps other lines verbatim, including duplicates", () => {
    expect(shapeLog("a\na")).toBe("a\na");
  });
});

describe("icons and alias", () => {
  it("nextUnusedIcon", () => {
    expect(nextUnusedIcon([])).toBe("flask");
    expect(nextUnusedIcon([{ icon: "flask" }])).toBe("microscope");
    expect(nextUnusedIcon([{ icon: "nope" }])).toBe("microscope");
  });
  it("all used -> flask", async () => {
    const { CONN_ICON_KEYS } = await import("@renderer/lib/icons");
    expect(nextUnusedIcon(CONN_ICON_KEYS.map((icon) => ({ icon })))).toBe("flask");
  });
  it("sshAliasFor", () => {
    expect(sshAliasFor("My Cluster_01", "")).toBe("silico-my-cluster-01");
    expect(sshAliasFor("", "--")).toBe("silico-host");
    expect(sshAliasFor("", "Login.Example.org")).toBe("silico-login-example-org");
  });
});

describe("connect decisions", () => {
  it("chooseOpenAction", () => {
    expect(chooseOpenAction({ outOfDate: true, live: true, reachable: "reachable" })).toBe("update");
    expect(chooseOpenAction({ outOfDate: false, live: true, reachable: undefined })).toBe("open");
    expect(chooseOpenAction({ outOfDate: false, live: true, reachable: "unreachable" })).toBe("connect");
    expect(chooseOpenAction({ outOfDate: false, live: false, reachable: "reachable" })).toBe("connect");
  });
  it("phase predicates", () => {
    expect(isRunningPhase("stopping")).toBe(true);
    expect(isRunningPhase("tunneling")).toBe(true);
    expect(isRunningPhase("done")).toBe(false);
    expect(isRunningPhase(undefined)).toBe(false);
    expect(isRowFailed("host-key")).toBe(true);
    expect(isOpeningFailed("host-key")).toBe(false);
    expect(isOpeningFailed("forbidden")).toBe(true);
  });
  it("mapConnectOutcome", () => {
    expect(mapConnectOutcome({ status: "opened" }, "")).toEqual({
      patch: { phase: "done", message: undefined, host: undefined, hostKeyKind: undefined },
      expandLogs: false,
      clearPendingLab: false,
      labUrl: undefined,
    });
    expect(mapConnectOutcome({ status: "opened", labUrl: "https://n" }, "https://o").labUrl).toBe("https://n");
    expect(mapConnectOutcome({ status: "opened", labUrl: "https://o" }, "https://o").labUrl).toBeUndefined();
    const canceled = mapConnectOutcome({ status: "canceled" }, "");
    expect(canceled.patch.phase).toBe("done");
    expect(canceled.expandLogs).toBe(false);
    expect(canceled.clearPendingLab).toBe(true);
    const forbidden = mapConnectOutcome({ status: "forbidden", login: "bob" }, "");
    expect(forbidden.patch).toMatchObject({ phase: "forbidden", message: forbiddenMessage("bob") });
    expect(forbidden.expandLogs).toBe(false);
    expect(mapConnectOutcome({ status: "still-waking" }, "").patch.message).toBe(STILL_WAKING_MESSAGE);
    const err = mapConnectOutcome({ status: "error", message: "boom" }, "");
    expect(err.patch).toMatchObject({ phase: "error", message: "boom" });
    expect(err.expandLogs).toBe(true);
    const hk = mapConnectOutcome({ status: "host-key", host: "h", kind: "unknown" }, "");
    expect(hk.patch).toMatchObject({ phase: "host-key", host: "h", hostKeyKind: "unknown" });
    expect(mapConnectOutcome({ status: "needs-setup" }, "").expandLogs).toBe(true);
  });
  it("mapUpdateOutcome only clears the lab on forbidden", () => {
    expect(mapUpdateOutcome({ status: "error", message: "x" }, "").clearPendingLab).toBe(false);
    expect(mapUpdateOutcome({ status: "forbidden" }, "").clearPendingLab).toBe(true);
    expect(mapUpdateOutcome({ status: "error", message: "x" }, "").expandLogs).toBe(true);
  });
  it("mapOpenResult", () => {
    const un = mapOpenResult({ status: "unreachable", url: "https://u" }, true);
    expect(un.patch.phase).toBe("error");
    expect(un.patch.message).toContain("https://u");
    expect(un.expandLogs).toBe(true);
    expect(mapOpenResult({ status: "canceled" }, false)).toMatchObject({ patch: { phase: "done" }, clearPendingLab: true });
    expect(mapOpenResult({ status: "forbidden" }, false).patch.phase).toBe("forbidden");
    expect(mapOpenResult({ status: "still-waking" }, false).clearPendingLab).toBe(true);
    expect(mapOpenResult({ status: "other" }, true).patch.phase).toBe("error");
    expect(mapOpenResult({ status: "other" }, false).patch.phase).toBe("done");
    expect(mapOpenResult({ status: "opened" }, false).patch.phase).toBe("done");
  });
});

describe("screen selection", () => {
  const nullLab = null;
  it("parseNavigate", () => {
    expect(parseNavigate("settings:profile")).toEqual({ view: "settings", tab: "profile" });
    expect(parseNavigate("settings:bogus")).toEqual({ view: "settings", tab: "notifications" });
    expect(parseNavigate("connections")).toEqual({ view: "labs" });
    expect(parseNavigate("whatever")).toEqual({ view: "labs" });
  });
  it("rootFromHash", () => {
    expect(rootFromHash("#settings-modal/developer")).toEqual({ kind: "settings-modal", tab: "developer" });
    expect(rootFromHash("#settings-modal/zzz")).toEqual({ kind: "settings-modal", tab: "notifications" });
    expect(rootFromHash("#viewer")).toEqual({ kind: "viewer" });
    expect(rootFromHash("")).toEqual({ kind: "app" });
  });
  it("selectContent priority", () => {
    const base = { view: "labs" as const, lab: nullLab, editing: false, adding: false, openingActive: false, visibleCount: 0 };
    expect(selectContent(base)).toBe("labs-empty");
    expect(selectContent({ ...base, visibleCount: 2 })).toBe("labs-list");
    expect(selectContent({ ...base, openingActive: true, adding: true })).toBe("add");
    expect(selectContent({ ...base, editing: true, adding: true })).toBe("edit");
    expect(selectContent({ ...base, editing: true, lab: { id: "a", title: "A", state: "loading" } })).toBe("lab-loading");
    expect(selectContent({ ...base, view: "settings", lab: { id: "a", title: "A", state: "loading" } })).toBe("settings");
    expect(selectContent({ ...base, openingActive: true })).toBe("opening");
  });
  it("selectScreen precedence", () => {
    const base = {
      signupOpen: false,
      auth: signedIn,
      content: "labs-list" as const,
      launchGate: false,
      labCover: { shown: false },
      lab: nullLab,
    };
    expect(selectScreen({ ...base, signupOpen: true, auth: undefined })).toBe("signup");
    expect(selectScreen({ ...base, auth: undefined })).toBe("auth-loading");
    expect(selectScreen({ ...base, auth: { status: "signed-out" } })).toBe("sign-in");
    expect(selectScreen({ ...base, content: "opening", launchGate: true, labCover: { shown: true } })).toBe("opening-full");
    expect(selectScreen({ ...base, launchGate: true, labCover: { shown: true } })).toBe("launch-gate");
    expect(selectScreen({ ...base, labCover: { shown: true } })).toBe("lab-cover");
    expect(selectScreen({ ...base, lab: { id: "a", title: "A", state: "ready" } })).toBe("lab-cover");
    expect(selectScreen({ ...base, lab: { id: "a", title: "A", state: "down" } })).toBe("lab-down");
    expect(selectScreen(base)).toBe("shell");
  });
  it("isLabsPicker", () => {
    const base = {
      signedIn: true,
      signupOpen: false,
      launchGate: false,
      lab: nullLab,
      openingId: null,
      view: "labs" as const,
      adding: false,
      editing: false,
      pickerPage: false,
    };
    expect(isLabsPicker(base)).toBe(true);
    expect(isLabsPicker({ ...base, openingId: "x" })).toBe(false);
    expect(isLabsPicker({ ...base, adding: true })).toBe(false);
    expect(isLabsPicker({ ...base, adding: true, pickerPage: true })).toBe(true);
    expect(isLabsPicker({ ...base, view: "settings", pickerPage: true })).toBe(true);
    expect(isLabsPicker({ ...base, launchGate: true })).toBe(false);
  });
  it("isLandingKnown", () => {
    expect(isLandingKnown(undefined, true, false)).toBe(false);
    expect(isLandingKnown(signedIn, null, false)).toBe(false);
    expect(isLandingKnown(signedIn, true, true)).toBe(true);
    expect(isLandingKnown(signedIn, false, true)).toBe(false);
    expect(isLandingKnown(signedIn, false, false)).toBe(true);
  });
});

describe("decideAutoOpen", () => {
  const base: AutoOpenInput = {
    tried: false,
    touched: false,
    isInitialWin: true,
    signedIn: true,
    connectionsLoaded: true,
    discoveryLoaded: true,
    discoveryStatus: "ok",
    discovered: [lab(), lab({ deploymentId: "d2" })],
    visible: [],
    launchGate: true,
  };
  it("waits until decidable", () => {
    expect(decideAutoOpen({ ...base, tried: true }).kind).toBe("wait");
    expect(decideAutoOpen({ ...base, isInitialWin: null }).kind).toBe("wait");
    expect(decideAutoOpen({ ...base, signedIn: false }).kind).toBe("wait");
    expect(decideAutoOpen({ ...base, connectionsLoaded: false }).kind).toBe("wait");
  });
  it("touched -> retire with probe on initial window", () => {
    expect(decideAutoOpen({ ...base, touched: true })).toEqual({ kind: "retire", probeLastOpened: true });
    expect(decideAutoOpen({ ...base, touched: true, isInitialWin: false })).toEqual({
      kind: "retire",
      probeLastOpened: false,
    });
  });
  it("non-initial window retires without probe", () => {
    expect(decideAutoOpen({ ...base, isInitialWin: false })).toEqual({ kind: "retire", probeLastOpened: false });
  });
  it("new user lands on signup", () => {
    expect(decideAutoOpen({ ...base, discovered: [] })).toEqual({ kind: "retire", probeLastOpened: true, signup: true });
  });
  it("single discovered lab with a row opens it", () => {
    const row = conn({ id: "r", deploymentId: "d1" });
    expect(decideAutoOpen({ ...base, discovered: [lab()], visible: [row] })).toEqual({
      kind: "retire",
      probeLastOpened: true,
      open: row,
    });
  });
  it("single managed lab without a row waits for auto-add while gated", () => {
    const managed = lab({ routeMode: "managed" });
    expect(decideAutoOpen({ ...base, discovered: [managed] }).kind).toBe("wait");
    expect(decideAutoOpen({ ...base, discovered: [managed], launchGate: false }).kind).toBe("retire");
    expect(decideAutoOpen({ ...base, discovered: [lab()] })).toEqual({ kind: "retire", probeLastOpened: true });
  });
  it("otherwise asks for the last opened lab", () => {
    expect(decideAutoOpen(base).kind).toBe("last-opened");
    expect(decideAutoOpen({ ...base, discoveryStatus: "unavailable", discovered: [] }).kind).toBe("last-opened");
  });
  it("lastOpenedRow", () => {
    const row = conn({ id: "r" });
    expect(lastOpenedRow("r", false, [row])).toBe(row);
    expect(lastOpenedRow("r", true, [row])).toBeUndefined();
    expect(lastOpenedRow(null, false, [row])).toBeUndefined();
    expect(lastOpenedRow("x", false, [row])).toBeUndefined();
  });
});

describe("rows", () => {
  it("rowsToClaim", () => {
    const rows = [
      conn({ id: "a", deploymentId: "d1" }),
      conn({ id: "b", deploymentId: "d1", owner: "alice", routeMode: "managed" }),
      conn({ id: "c", deploymentId: "d1", owner: "bob" }),
      conn({ id: "d", deploymentId: "zz" }),
      conn({ id: "e", deploymentId: "d1", dismissed: true }),
    ];
    const out = rowsToClaim(rows, [lab()], "alice", GW);
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
    expect(out[0]).toMatchObject({ owner: "alice", gatewayUrl: undefined });
    expect(out[1]).toMatchObject({ owner: "alice", gatewayUrl: GW });
  });
  it("managedRowsToAdd skips existing rows and picks distinct icons", () => {
    const discovered = [lab({ deploymentId: "m1", routeMode: "managed" }), lab({ deploymentId: "m2", routeMode: "managed", labPublicHost: "" }), lab({ deploymentId: "c1" })];
    const existing = [conn({ id: "x", deploymentId: "m1", gatewayUrl: GW, owner: "alice" })];
    const out = managedRowsToAdd(existing, discovered, "alice", GW);
    expect(out).toEqual([
      {
        id: managedRowId("alice", "m2", GW),
        name: "m2",
        icon: "microscope",
        deploymentId: "m2",
        labUrl: "",
        routeMode: "managed",
        owner: "alice",
        gatewayUrl: GW,
      },
    ]);
    expect(managedRowsToAdd([], discovered, "alice", GW).map((r) => r.icon)).toEqual(["flask", "microscope"]);
  });
  it("sortConnections puts justAdded first then name", () => {
    const rows = [conn({ id: "1", name: "b" }), conn({ id: "2", name: "A" }), conn({ id: "3", name: "", deploymentId: "c" })];
    expect(sortConnections(rows, null).map((r) => r.id)).toEqual(["2", "1", "3"]);
    expect(sortConnections(rows, "3").map((r) => r.id)).toEqual(["3", "2", "1"]);
  });
  it("freshDiscovered and draftFromDiscovered", () => {
    const visible = [conn({ deploymentId: "B" })];
    expect(freshDiscovered([lab({ deploymentId: "c" }), lab({ deploymentId: "B" }), lab({ deploymentId: "a" })], visible).map((l) => l.deploymentId)).toEqual(["a", "c"]);
    expect(draftFromDiscovered(lab(), visible)).toEqual({
      name: "d1",
      icon: "microscope",
      deploymentId: "d1",
      labUrl: "https://d1.silico.run",
      routeMode: "cluster",
      ssh: { host: "", user: "" },
    });
    expect(draftFromDiscovered(lab({ routeMode: "managed" }), []).ssh).toBeUndefined();
  });
  it("stampForSave", () => {
    expect(stampForSave({ ...conn(), routeMode: "managed" }, "alice", GW)).toMatchObject({ owner: "alice", gatewayUrl: GW });
    expect(stampForSave(conn(), "alice", GW)).toMatchObject({ owner: "alice", gatewayUrl: undefined });
    expect(stampForSave({ ...conn(), owner: "bob" }, "alice", GW).owner).toBe("bob");
  });
});

describe("row menu", () => {
  const base = {
    developerMode: true,
    sshHost: "h",
    deploymentId: "d",
    busy: false,
    outOfDate: false,
    live: true,
    managed: false,
    previewPinned: false,
  };
  it("developer entries", () => {
    expect(rowMenuEntries(base).map((e) => e.label)).toEqual(["Open via SSH tunnel", "Update Lab", "Stop Lab", "Edit", "Remove"]);
    expect(rowMenuEntries({ ...base, previewPinned: true })[1]?.label).toBe("Update Lab (preview)");
    expect(rowMenuEntries({ ...base, busy: true }).map((e) => e.action)).toEqual(["edit", "remove"]);
    expect(rowMenuEntries({ ...base, outOfDate: true }).map((e) => e.action)).toEqual(["tunnel", "stop", "edit", "remove"]);
  });
  it("non-developer only edit/remove", () => {
    const out = rowMenuEntries({ ...base, developerMode: false });
    expect(out.map((e) => e.label)).toEqual(["Edit", "Remove"]);
    expect(out[1]?.danger).toBe(true);
  });
  it("isLive", () => {
    expect(isLive({ stale: false }, "d", new Set())).toBe(true);
    expect(isLive({ stale: false }, "d", new Set(["d"]))).toBe(false);
    expect(isLive({ stale: true }, "d", new Set())).toBe(false);
    expect(isLive(undefined, "d", new Set())).toBe(false);
    expect(isLive({ stale: false }, "", new Set())).toBe(false);
  });
});

describe("form", () => {
  const nh = { hostName: " login.x ", user: "", port: "2222", identityFile: " ~/.ssh/k " };
  it("canSave", () => {
    expect(canSave({ noSsh: true, mode: "pick", pickedHost: "", newHostName: "" })).toBe(true);
    expect(canSave({ noSsh: false, mode: "pick", pickedHost: "  ", newHostName: "" })).toBe(false);
    expect(canSave({ noSsh: false, mode: "pick", pickedHost: "h", newHostName: "" })).toBe(true);
    expect(canSave({ noSsh: false, mode: "new", pickedHost: "h", newHostName: " " })).toBe(false);
  });
  it("sshTestTarget", () => {
    expect(sshTestTarget("pick", " h ", nh)).toEqual({ host: "h" });
    expect(sshTestTarget("new", undefined, nh)).toEqual({
      host: "login.x",
      user: undefined,
      port: 2222,
      identityFile: "~/.ssh/k",
    });
  });
  it("newHostInput", () => {
    expect(newHostInput("My Cluster", nh)).toEqual({
      alias: "silico-my-cluster",
      hostName: "login.x",
      user: undefined,
      port: 2222,
      identityFile: "~/.ssh/k",
    });
  });
  it("savedName", () => {
    expect(savedName({ name: "  ", deploymentId: "d" }, true)).toBe("d");
    expect(savedName({ name: " N ", deploymentId: "d" }, false, "h")).toBe("N");
    expect(savedName({ name: "", deploymentId: "", }, false, "h")).toBe("h");
    expect(savedName({ name: "", deploymentId: "" }, false)).toBe("");
  });
  it("hostOptions and filterHosts", () => {
    const hosts = [{ alias: "b" }, { alias: "A", hostName: "x.example" }];
    expect(hostOptions(hosts, "c").map((h) => h.alias)).toEqual(["A", "b", "c"]);
    expect(hostOptions(hosts, "b").map((h) => h.alias)).toEqual(["A", "b"]);
    const many = ["a1", "a2", "b1", "b2", "c1", "c2"].map((alias) => ({ alias, hostName: `${alias}.host` }));
    expect(filterHosts(many, " B ").map((h) => h.alias)).toEqual(["b1", "b2"]);
    expect(filterHosts(many, "").length).toBe(6);
    expect(filterHosts(many.slice(0, 5), "b").length).toBe(5);
    expect(filterHosts(many, "c2.host").map((h) => h.alias)).toEqual(["c2"]);
  });
  it("primary action and label", () => {
    const unknown = { ok: false as const, detail: "x", hostKey: "unknown" as const };
    expect(primaryAction({ isEdit: true, managed: false, test: unknown })).toBe("save");
    expect(primaryAction({ isEdit: false, managed: true, test: null })).toBe("save");
    expect(primaryAction({ isEdit: false, managed: false, test: unknown })).toBe("accept-and-save");
    expect(primaryAction({ isEdit: false, managed: false, test: null })).toBe("test-and-save");
    expect(primaryLabel({ testing: true, isEdit: true, managed: false, test: null })).toBe("Verifying SSH…");
    expect(primaryLabel({ testing: false, isEdit: true, managed: false, test: null })).toBe("Save");
    expect(primaryLabel({ testing: false, isEdit: false, managed: true, test: unknown })).toBe("Add");
    expect(primaryLabel({ testing: false, isEdit: false, managed: false, test: unknown })).toBe("Accept host key & add");
    expect(primaryLabel({ testing: false, isEdit: false, managed: false, test: null })).toBe("Add");
  });
});

describe("settings helpers", () => {
  it("notificationPatch sends the whole object", () => {
    const n = DEFAULT_SETTINGS.notifications;
    expect(notificationPatch(n, "sound")).toEqual({ notifications: { ...n, sound: false } });
  });
  it("dependent toggles disable when notifications are off", () => {
    const off = { ...DEFAULT_SETTINGS.notifications, enabled: false };
    expect(notificationToggleDisabled(off, "enabled")).toBe(false);
    expect(notificationToggleDisabled(off, "badge")).toBe(true);
    expect(notificationToggleDisabled(DEFAULT_SETTINGS.notifications, "badge")).toBe(false);
  });
  it("stagingConfirm", () => {
    expect(stagingConfirm(true)).toEqual({
      message: "Switch to staging (dev twins)?",
      detail: "This signs you out and re-authenticates.",
      confirmLabel: "Switch",
    });
    expect(stagingConfirm(false).message).toBe("Switch to production?");
  });
  it("sectionTitle", () => {
    expect(sectionTitle("all")).toBe("Desktop settings");
    expect(sectionTitle("developer")).toBe("Developer settings");
  });
});
