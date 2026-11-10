// @vitest-environment jsdom
/**
 * App flow tests beyond app.test.tsx: open routing, cancel races, stop,
 * held-elsewhere, auto-add, wizard save, reachability polling, auth events
 * [renderer §4.2, §4.5, §4.7, §4.10-4.12, §4.15, §4.17, §4.20, §8].
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@shared/config";
import type { AuthState, Connection, DiscoveredLab, LabReach, Settings } from "@shared/ipc";
import { HostKeyPanel } from "@renderer/components/HostKeyPanel";
import { App, DISCOVERY_POLL_MS, REACH_POLL_MS } from "@renderer/screens/App";
import { SettingsModal } from "@renderer/screens/SettingsModal";
import { SIGNED_IN, installFakeSilico } from "./helpers/fakeSilico";
import type { FakeSilico } from "./helpers/fakeSilico";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const GW = SIGNED_IN.gatewayUrl;

/** Self-hosted cluster row with a deployment id (owner-stamped, so visible once discovered). */
const ROW: Connection = {
  id: "row1",
  name: "Cluster One",
  icon: "flask",
  deploymentId: "dep1",
  labUrl: "",
  routeMode: "cluster",
  ssh: { host: "c1" },
  owner: "alice",
};

/** Heartbeating, up-to-date discovery record for ROW. */
const LIVE: DiscoveredLab = {
  deploymentId: "dep1",
  labPublicHost: "",
  routeMode: "cluster",
  host: "dep1.silico.run",
  port: 8443,
  stale: false,
  updateAvailable: false,
  updateRequired: false,
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => act(async () => {});

/** Poll `check` across microtask flushes (waitFor's own interval is frozen under fake setInterval). */
async function until(check: () => void, tries = 50): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      check();
      return;
    } catch (e) {
      if (i >= tries) throw e;
      await flush();
    }
  }
}

function discover(fake: FakeSilico, labs: DiscoveredLab[], login = "alice"): void {
  vi.mocked(fake.api.labs.list).mockResolvedValue({ ok: true, labs, gatewayUrl: GW, login });
}

/** Signed-in App with ROW saved and `disc` discovered; waits for the row and the first probe. */
async function renderWithRow(opts: { disc?: DiscoveredLab; settings?: Settings; reach?: LabReach } = {}) {
  const fake = installFakeSilico({ auth: SIGNED_IN, settings: opts.settings });
  vi.mocked(fake.api.connections.list).mockResolvedValue([ROW]);
  discover(fake, [opts.disc ?? LIVE]);
  if (opts.reach) vi.mocked(fake.api.lab.status).mockResolvedValue(opts.reach);
  render(<App />);
  expect(await screen.findByText("Cluster One")).toBeTruthy();
  const d = opts.disc ?? LIVE;
  if (!d.stale && d.host) await waitFor(() => expect(fake.api.lab.status).toHaveBeenCalled());
  await flush();
  return fake;
}

describe("openHere routing [§4.7 step 8, §8 chooseOpenAction]", () => {
  it("live, reachable, up to date → lab.open with the 3 s budget, not connect", async () => {
    const fake = await renderWithRow({ reach: "up" });
    vi.mocked(fake.api.lab.open).mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(fake.api.lab.open).toHaveBeenCalledWith(ROW, { reachTimeoutMs: 3000 }));
    expect(fake.api.lab.connect).not.toHaveBeenCalled();
    expect(fake.api.lab.update).not.toHaveBeenCalled();
  });

  it("out of date → lab.update(row, {preview:false})", async () => {
    const fake = await renderWithRow({ disc: { ...LIVE, updateAvailable: true }, reach: "up" });
    vi.mocked(fake.api.lab.update).mockReturnValue(new Promise(() => {}));
    expect(screen.getByText("Update available")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(fake.api.lab.update).toHaveBeenCalledWith(ROW, { preview: false }));
    expect(fake.api.lab.open).not.toHaveBeenCalled();
    expect(fake.api.lab.connect).not.toHaveBeenCalled();
    expect(await screen.findByText("Updating Cluster One")).toBeTruthy();
  });
});

describe("reachability polling [§4.15, §8 openReachBudgetMs]", () => {
  it("probes labBaseUrl(host, port) for live labs only, every 20 s", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const stale: DiscoveredLab = { ...LIVE, deploymentId: "old", host: "10.0.0.9", port: 8000, stale: true };
    const fake = await renderWithRow({ disc: LIVE });
    discover(fake, [LIVE, stale]);
    await act(async () => {
      vi.advanceTimersByTime(DISCOVERY_POLL_MS);
    });
    await flush();
    const urls = vi.mocked(fake.api.lab.status).mock.calls.map((c) => c[0]);
    expect(urls).toContain("https://dep1.silico.run:8443");
    expect(urls).not.toContain("http://10.0.0.9:8000");
    const before = vi.mocked(fake.api.lab.status).mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(REACH_POLL_MS);
    });
    expect(vi.mocked(fake.api.lab.status).mock.calls.length).toBeGreaterThan(before);
    expect(vi.mocked(fake.api.lab.status).mock.calls.map((c) => c[0])).not.toContain("http://10.0.0.9:8000");
  });

  it('probe "up" → lab.open budget 3000', async () => {
    const fake = await renderWithRow({ reach: "up" });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(fake.api.lab.open).toHaveBeenCalledWith(ROW, { reachTimeoutMs: 3000 }));
  });

  it('probe "down" → unreachable, so open falls back to connect', async () => {
    const fake = await renderWithRow({ reach: "down" });
    vi.mocked(fake.api.lab.connect).mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(fake.api.lab.connect).toHaveBeenCalledWith(ROW, false, undefined));
    expect(fake.api.lab.open).not.toHaveBeenCalled();
  });

  it("probe not answered yet → lab.open budget 90000", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    vi.mocked(fake.api.connections.list).mockResolvedValue([ROW]);
    discover(fake, [LIVE]);
    vi.mocked(fake.api.lab.status).mockReturnValue(new Promise(() => {}));
    vi.mocked(fake.api.lab.open).mockReturnValue(new Promise(() => {}));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    await waitFor(() => expect(fake.api.lab.open).toHaveBeenCalledWith(ROW, { reachTimeoutMs: 90000 }));
  });
});

describe("cancel races [§4.7 cancelOpening, §4.15 lab view events]", () => {
  it("a lab:opened arriving after cancel hides the view and is otherwise ignored", async () => {
    const fake = await renderWithRow({ disc: { ...LIVE, stale: true } });
    vi.mocked(fake.api.lab.connect).mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open a different lab" }));
    expect(fake.api.lab.cancel).toHaveBeenCalledWith("row1");
    expect(await screen.findByText("Cluster One")).toBeTruthy();
    act(() => fake.events.labOpened.emit({ id: "row1", title: "Cluster One" }));
    await waitFor(() => expect(fake.api.labView.hide).toHaveBeenCalled());
    expect(screen.queryByText("Opening Cluster One")).toBeNull();
    expect(screen.getByText("Labs", { selector: "h1" })).toBeTruthy();
    expect(fake.api.lastOpened.set).not.toHaveBeenCalled();
  });
});

describe("SignIn stale attempts [§4.2]", () => {
  it("a superseded attempt's rejection is dropped; the latest attempt wins", async () => {
    const fake = installFakeSilico();
    const first = deferred<AuthState>();
    const second = deferred<AuthState>();
    vi.mocked(fake.api.auth.signIn).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    discover(fake, []);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    fireEvent.click(await screen.findByText("Try again"));
    expect(fake.api.auth.signIn).toHaveBeenCalledTimes(2);
    await act(async () => first.reject(new Error("Sign-in restarted.")));
    expect(screen.queryByText("Sign-in restarted.")).toBeNull();
    expect(screen.getByRole("button", { name: "Waiting for your browser…" })).toBeTruthy();
    await act(async () => second.resolve(SIGNED_IN));
    expect(await screen.findByText("Labs", { selector: "h1" })).toBeTruthy();
  });
});

describe("Stop Lab [§4.5 row menu, §4.7 stopLab]", () => {
  const dev: Settings = { ...DEFAULT_SETTINGS, developerMode: true };

  it("stops via lab.down; the stopped lab then opens with connect, not open", async () => {
    const fake = await renderWithRow({ settings: dev, reach: "up" });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop Lab" }));
    await waitFor(() => expect(fake.api.lab.down).toHaveBeenCalledWith(ROW));
    await flush();
    vi.mocked(fake.api.lab.connect).mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(fake.api.lab.connect).toHaveBeenCalledWith(ROW, false, undefined));
    expect(fake.api.lab.open).not.toHaveBeenCalled();
  });

  it("Open is ignored while stopping", async () => {
    const fake = await renderWithRow({ settings: dev, reach: "up" });
    vi.mocked(fake.api.lab.down).mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop Lab" }));
    await waitFor(() => expect(fake.api.lab.down).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await flush();
    expect(fake.api.lab.open).not.toHaveBeenCalled();
    expect(fake.api.lab.connect).not.toHaveBeenCalled();
    expect(screen.queryByText("Opening Cluster One")).toBeNull();
  });

  it("lab.down rejecting marks the row failed (STOP_FAILED)", async () => {
    const fake = await renderWithRow({ settings: dev, reach: "up" });
    vi.mocked(fake.api.lab.down).mockRejectedValue("not an Error");
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Stop Lab" }));
    // stopLab never sets openingId, so the failure surfaces as the row pill.
    expect(await screen.findByText("Can’t connect")).toBeTruthy();
    // Still live (stop didn't take), so the menu offers Stop again.
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: "Stop Lab" })).toBeTruthy();
  });
});

describe("discovery reply needing auth [§4.15]", () => {
  it("labs.list {ok:false, needsAuth:true} → sign-in card", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    vi.mocked(fake.api.labs.list).mockResolvedValue({ ok: false, error: "expired", needsAuth: true });
    render(<App />);
    expect(await screen.findByText("Welcome to Silico")).toBeTruthy();
  });
});

describe("auth:changed [§4.15 auth events]", () => {
  const zeta: DiscoveredLab = { ...LIVE, deploymentId: "zeta", stale: true, host: undefined, port: undefined };

  it("a different login clears discovery and re-polls", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    discover(fake, [zeta]);
    render(<App />);
    expect(await screen.findByText("zeta")).toBeTruthy();
    const calls = vi.mocked(fake.api.labs.list).mock.calls.length;
    vi.mocked(fake.api.labs.list).mockReturnValue(new Promise(() => {}));
    act(() => fake.events.authChanged.emit({ ...SIGNED_IN, login: "bob" }));
    await waitFor(() => expect(screen.queryByText("zeta")).toBeNull());
    await waitFor(() => expect(vi.mocked(fake.api.labs.list).mock.calls.length).toBe(calls + 1));
  });

  it("the same login and gateway keeps discovery and does not re-poll", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    discover(fake, [zeta]);
    render(<App />);
    expect(await screen.findByText("zeta")).toBeTruthy();
    await flush();
    const calls = vi.mocked(fake.api.labs.list).mock.calls.length;
    act(() => fake.events.authChanged.emit({ ...SIGNED_IN, expiresAt: SIGNED_IN.expiresAt - 1 }));
    await flush();
    expect(screen.getByText("zeta")).toBeTruthy();
    expect(vi.mocked(fake.api.labs.list).mock.calls.length).toBe(calls);
  });
});

describe("held elsewhere [§4.5, §4.7 openLab]", () => {
  it("focuses the holding window instead of connecting", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    vi.mocked(fake.api.connections.list).mockResolvedValue([ROW]);
    discover(fake, [{ ...LIVE, stale: true }]);
    vi.mocked(fake.api.labs.heldElsewhere).mockResolvedValue(["row1"]);
    vi.mocked(fake.api.labs.focusHeld).mockResolvedValue(true);
    render(<App />);
    expect(await screen.findByText("Already open")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(fake.api.labs.focusHeld).toHaveBeenCalledWith("row1"));
    await flush();
    expect(fake.api.lab.connect).not.toHaveBeenCalled();
    expect(fake.api.lab.open).not.toHaveBeenCalled();
  });

  it("falls back to opening here when no window was focused", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    vi.mocked(fake.api.connections.list).mockResolvedValue([ROW]);
    discover(fake, [{ ...LIVE, stale: true }]);
    vi.mocked(fake.api.labs.heldElsewhere).mockResolvedValue(["row1"]);
    vi.mocked(fake.api.labs.focusHeld).mockResolvedValue(false);
    vi.mocked(fake.api.lab.connect).mockReturnValue(new Promise(() => {}));
    render(<App />);
    expect(await screen.findByText("Already open")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(fake.api.lab.connect).toHaveBeenCalledWith(ROW, false, undefined));
    expect(fake.api.labs.focusHeld).toHaveBeenCalledWith("row1");
  });
});

describe("remove [§4.5]", () => {
  it("a hosted (managed) row is dismissed via upsert, not removed", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    const managed: Connection = { ...ROW, routeMode: "managed", ssh: undefined, gatewayUrl: GW };
    vi.mocked(fake.api.connections.list).mockResolvedValue([managed]);
    render(<App />);
    expect(await screen.findByText("Cluster One")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    await waitFor(() => expect(fake.api.connections.upsert).toHaveBeenCalledWith({ ...managed, dismissed: true }));
    expect(fake.api.connections.remove).not.toHaveBeenCalled();
  });
});

describe("auto-add hosted labs [§4.15]", () => {
  it("upserts exactly one row for a single discovered managed lab, then reloads", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fake = installFakeSilico({ auth: SIGNED_IN });
    const hosted: DiscoveredLab = {
      deploymentId: "hosted",
      labPublicHost: "hosted.silico.run",
      routeMode: "managed",
      stale: false,
      updateAvailable: false,
      updateRequired: false,
    };
    discover(fake, [hosted]);
    const pending = deferred<Connection>();
    vi.mocked(fake.api.connections.upsert).mockReturnValue(pending.promise);
    render(<App />);
    await until(() => expect(fake.api.connections.upsert).toHaveBeenCalledTimes(1));
    const row = vi.mocked(fake.api.connections.upsert).mock.calls[0]![0] as Connection;
    expect(row).toMatchObject({
      id: `managed:alice:hosted:${GW}`,
      name: "hosted",
      deploymentId: "hosted",
      labUrl: "https://hosted.silico.run",
      routeMode: "managed",
      owner: "alice",
      gatewayUrl: GW,
    });
    // Re-renders while the upsert is in flight: a discovery poll (new array) and a settings push.
    await act(async () => {
      vi.advanceTimersByTime(DISCOVERY_POLL_MS);
    });
    act(() => fake.events.settingsChanged.emit({ ...DEFAULT_SETTINGS, verbose: true }));
    await flush();
    expect(fake.api.connections.upsert).toHaveBeenCalledTimes(1);
    const listCalls = vi.mocked(fake.api.connections.list).mock.calls.length;
    vi.mocked(fake.api.connections.list).mockResolvedValue([row]);
    await act(async () => pending.resolve(row));
    await until(() => expect(vi.mocked(fake.api.connections.list).mock.calls.length).toBe(listCalls + 1));
    await act(async () => {
      vi.advanceTimersByTime(DISCOVERY_POLL_MS);
    });
    await flush();
    expect(fake.api.connections.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("AddWizard save [§4.11-4.12, §4.7 connect]", () => {
  it("self-hosted: stamps owner, connects the saved row, shows the Opening screen", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    discover(fake, [{ ...LIVE, deploymentId: "zeta", stale: true, host: undefined, port: undefined }]);
    vi.mocked(fake.api.ssh.listHosts).mockResolvedValue([{ alias: "hostA", hostName: "a.example" }]);
    vi.mocked(fake.api.lab.connect).mockReturnValue(new Promise(() => {}));
    const saved: Connection[] = [];
    vi.mocked(fake.api.connections.upsert).mockImplementation(async (c) => {
      const row = { ...c, id: c.id ?? "new-id" } as Connection;
      saved.push(row);
      return row;
    });
    vi.mocked(fake.api.connections.list).mockImplementation(async () => [...saved]);
    render(<App />);
    expect(await screen.findByText("zeta")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(await screen.findByRole("radio", { name: /hostA/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(fake.api.connections.upsert).toHaveBeenCalled());
    const draft = vi.mocked(fake.api.connections.upsert).mock.calls[0]![0];
    expect(draft).toMatchObject({ deploymentId: "zeta", owner: "alice", ssh: { host: "hostA", user: "" } });
    expect(draft.gatewayUrl).toBeUndefined();
    await waitFor(() =>
      expect(fake.api.lab.connect).toHaveBeenCalledWith(expect.objectContaining({ id: "new-id", owner: "alice" }), false, undefined),
    );
    expect(await screen.findByText("Opening zeta")).toBeTruthy();
    expect(screen.getByText("Checking the cluster…")).toBeTruthy();
  });

  it("hosted: stamps the gateway and shows the Lab loading screen", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    const hosted: DiscoveredLab = {
      deploymentId: "hosted",
      labPublicHost: "hosted.silico.run",
      routeMode: "managed",
      stale: false,
      updateAvailable: false,
      updateRequired: false,
    };
    discover(fake, [hosted]);
    // A dismissed row suppresses auto-add but stays hidden, so the wizard still offers the lab.
    const dismissed: Connection = {
      id: "managed:alice:hosted:x",
      name: "hosted",
      icon: "flask",
      deploymentId: "hosted",
      labUrl: "",
      routeMode: "managed",
      owner: "alice",
      gatewayUrl: GW,
      dismissed: true,
    };
    vi.mocked(fake.api.connections.list).mockResolvedValue([dismissed]);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    await waitFor(() => expect(fake.api.connections.upsert).toHaveBeenCalled());
    expect(vi.mocked(fake.api.connections.upsert).mock.calls[0]![0]).toMatchObject({
      deploymentId: "hosted",
      owner: "alice",
      gatewayUrl: GW,
      routeMode: "managed",
    });
    await waitFor(() => expect(fake.api.lab.connect).toHaveBeenCalled());
    // connect resolved "opened" (openingId cleared) but the Lab loading screen stays until lab state arrives.
    expect(await screen.findByText("Opening hosted")).toBeTruthy();
    expect(fake.api.lab.test).not.toHaveBeenCalled();
  });
});

describe("LabStatePanel Reconnect [§4.10]", () => {
  it("clears the lab and runs open routing again", async () => {
    const fake = await renderWithRow({ disc: { ...LIVE, stale: true } });
    act(() => fake.events.labOpened.emit({ id: "row1", title: "Cluster One" }));
    act(() => fake.events.labState.emit({ id: "row1", state: "down" }));
    expect(await screen.findByText("Your lab isn’t running")).toBeTruthy();
    vi.mocked(fake.api.lab.connect).mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(fake.api.lab.connect).toHaveBeenCalledWith(ROW, false, undefined));
    expect(screen.queryByText("Your lab isn’t running")).toBeNull();
    expect(await screen.findByText("Opening Cluster One")).toBeTruthy();
  });
});

describe("LabsList row click [§8 behavioral details]", () => {
  it("row click opens; the More actions trigger, backdrop and menu items don't", async () => {
    const fake = await renderWithRow({ disc: { ...LIVE, stale: true } });
    vi.mocked(fake.api.lab.connect).mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(document.querySelector(".ov__backdrop")!);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    await flush();
    expect(fake.api.lab.connect).not.toHaveBeenCalled();
    expect(await screen.findByText("Edit lab")).toBeTruthy();
    fireEvent.click(screen.getByText("Labs", { selector: "button" }));
    fireEvent.click(await screen.findByText("Cluster One"));
    await waitFor(() => expect(fake.api.lab.connect).toHaveBeenCalledWith(ROW, false, undefined));
  });
});

describe("HostKeyPanel failures [§4.20]", () => {
  it("accept {ok:false} shows the error and does not reconnect", async () => {
    const fake = installFakeSilico();
    vi.mocked(fake.api.lab.hostKey.accept).mockResolvedValue({ ok: false, error: "known_hosts is read-only" });
    const onAccepted = vi.fn();
    render(<HostKeyPanel ssh={{ host: "c1" }} kind="unknown" onAccepted={onAccepted} />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept & connect" }));
    expect(await screen.findByText("known_hosts is read-only")).toBeTruthy();
    expect(onAccepted).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Accept & connect" }).hasAttribute("disabled")).toBe(false);
  });

  it("accept {ok:false} without detail uses the default copy", async () => {
    const fake = installFakeSilico();
    vi.mocked(fake.api.lab.hostKey.accept).mockResolvedValue({ ok: false, error: "" });
    render(<HostKeyPanel ssh={{ host: "c1" }} kind="unknown" onAccepted={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept & connect" }));
    expect(await screen.findByText("Could not accept the host key.")).toBeTruthy();
  });

  it("scan rejecting shows the error and no accept button", async () => {
    const fake = installFakeSilico();
    vi.mocked(fake.api.lab.hostKey.scan).mockRejectedValue(new Error("ssh-keyscan timed out"));
    render(<HostKeyPanel ssh={{ host: "c1" }} kind="unknown" onAccepted={() => {}} />);
    expect(await screen.findByText("ssh-keyscan timed out")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept & connect" })).toBeNull();
  });
});

describe("SettingsModal events [§4.17]", () => {
  it("settings:changed flips the switch without settings.set", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    render(<SettingsModal initialTab="developer" />);
    const sw = await screen.findByRole("switch", { name: "Verbose connect logs" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    act(() => fake.events.settingsChanged.emit({ ...DEFAULT_SETTINGS, verbose: true }));
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Verbose connect logs" }).getAttribute("aria-checked")).toBe("true"),
    );
    expect(fake.api.settings.set).not.toHaveBeenCalled();
  });

  it("auth expiry closes the window", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    render(<SettingsModal initialTab="notifications" />);
    await screen.findByText("Notifications", { selector: "h1" });
    act(() => fake.events.authExpired.emit(undefined));
    expect(close).toHaveBeenCalled();
  });
});
