// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Connection, ConnectOutcome, DiscoveredLab } from "@shared/ipc";
import { App } from "@renderer/screens/App";
import { SIGNED_IN, installFakeSilico } from "./helpers/fakeSilico";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ROW: Connection = {
  id: "row1",
  name: "Cluster One",
  icon: "flask",
  deploymentId: "",
  labUrl: "",
  ssh: { host: "c1" },
  owner: "alice",
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("App sign-in", () => {
  it("shows the welcome card and signs in", async () => {
    const fake = installFakeSilico();
    const pending = deferred<typeof SIGNED_IN>();
    vi.mocked(fake.api.auth.signIn).mockReturnValue(pending.promise);
    vi.mocked(fake.api.labs.list).mockResolvedValue({ ok: true, labs: [], gatewayUrl: SIGNED_IN.gatewayUrl, login: "alice" });
    render(<App />);
    expect(await screen.findByText("Welcome to Silico")).toBeTruthy();
    expect(screen.getByText("Sign-in opens in your browser.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("button", { name: "Waiting for your browser…" })).toBeTruthy();
    expect(fake.api.auth.signIn).toHaveBeenCalledWith(false, false);
    fireEvent.click(screen.getByText("Try again"));
    expect(fake.api.auth.signIn).toHaveBeenLastCalledWith(false, true);
    expect(screen.getByRole("button", { name: "Opening browser…" })).toBeTruthy();
    await act(async () => pending.resolve(SIGNED_IN));
    expect(await screen.findByText("Labs", { selector: "h1" })).toBeTruthy();
  });

  it("shows sign-in errors", async () => {
    const fake = installFakeSilico();
    vi.mocked(fake.api.auth.signIn).mockRejectedValue(new Error("browser closed"));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("browser closed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("shows the keyring notice when persistence is unavailable", async () => {
    const fake = installFakeSilico();
    vi.mocked(fake.api.auth.persistence).mockResolvedValue("none-no-keyring");
    render(<App />);
    expect(await screen.findByText(/Your system keyring isn’t available/)).toBeTruthy();
  });
});

describe("App labs list", () => {
  it("empty state lists discovered labs and opens the wizard pre-picked", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    const disc: DiscoveredLab = {
      deploymentId: "zeta",
      labPublicHost: "zeta.silico.run",
      routeMode: "cluster",
      stale: true,
      updateAvailable: false,
      updateRequired: false,
    };
    vi.mocked(fake.api.labs.list).mockResolvedValue({ ok: true, labs: [disc], gatewayUrl: SIGNED_IN.gatewayUrl, login: "alice" });
    render(<App />);
    expect(await screen.findByText("Where do you want to research?")).toBeTruthy();
    expect(await screen.findByText("zeta")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Add a lab")).toBeTruthy();
    expect(screen.getByText("Which SSH host reaches zeta?")).toBeTruthy();
    expect(screen.getByDisplayValue("zeta")).toBeTruthy();
  });

  it("empty state with no discovered labs shows the nudge", async () => {
    installFakeSilico({ auth: SIGNED_IN });
    render(<App />);
    expect(
      await screen.findByText("Create a new lab (top right), or use “Add lab” to connect an existing one."),
    ).toBeTruthy();
  });

  it("New lab menu opens the wizard or signup", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a lab" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Create a new lab" }));
    expect(fake.api.signup.open).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add a lab" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Connect an existing lab" }));
    expect(await screen.findByText("Connect an existing lab", { selector: "h1" })).toBeTruthy();
    expect(screen.getByText("You’re not registered on any Silico clusters yet. If you expected to see one, you may be signed in with the wrong account.")).toBeTruthy();
  });

  it("removes a row from the overflow menu", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    vi.mocked(fake.api.connections.list).mockResolvedValue([ROW]);
    render(<App />);
    expect(await screen.findByText("Cluster One")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.queryByText("Open via SSH tunnel")).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    await waitFor(() => expect(fake.api.connections.remove).toHaveBeenCalledWith("row1"));
  });
});

describe("App connect phases", () => {
  it("shows progress, phase updates and a failure card", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    vi.mocked(fake.api.connections.list).mockResolvedValue([ROW]);
    const pending = deferred<ConnectOutcome>();
    vi.mocked(fake.api.lab.connect).mockReturnValue(pending.promise);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    expect(fake.api.lab.connect).toHaveBeenCalledWith(ROW, false, undefined);
    expect(await screen.findByText("Opening Cluster One")).toBeTruthy();
    expect(screen.getByText("Checking the cluster…")).toBeTruthy();
    act(() => fake.events.labPhase.emit({ id: "row1", phase: "setup" }));
    expect(screen.getByText("Setting up this cluster for the first time. This can take a few minutes.")).toBeTruthy();
    act(() => fake.events.labOutput.emit({ id: "row1", chunk: "hello log\n" }));
    fireEvent.click(screen.getByRole("button", { name: "View logs" }));
    expect(screen.getByText(/hello log/)).toBeTruthy();
    await act(async () => pending.resolve({ status: "error", message: "ssh exploded\nmore" }));
    expect(await screen.findByText("Couldn't open Cluster One")).toBeTruthy();
    expect(screen.getByText("ssh exploded")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open a different lab" }));
    expect(fake.api.lab.cancel).not.toHaveBeenCalled();
    expect(await screen.findByText("Can’t connect")).toBeTruthy();
  });

  it("cancels an in-progress open", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    vi.mocked(fake.api.connections.list).mockResolvedValue([ROW]);
    vi.mocked(fake.api.lab.connect).mockReturnValue(new Promise(() => {}));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open a different lab" }));
    expect(fake.api.lab.cancel).toHaveBeenCalledWith("row1");
    expect(await screen.findByText("Cluster One")).toBeTruthy();
  });

  it("forbidden shows the account-named message and Switch account", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    vi.mocked(fake.api.connections.list).mockResolvedValue([ROW]);
    vi.mocked(fake.api.lab.connect).mockResolvedValue({ status: "forbidden", login: "alice" });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    expect(await screen.findByText(/You’re signed in as @alice/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));
    await waitFor(() => expect(fake.api.auth.signOutEverywhere).toHaveBeenCalled());
    expect(await screen.findByText("Welcome to Silico")).toBeTruthy();
  });

  it("host key: scans, shows the fingerprint, accepts it and reconnects", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    vi.mocked(fake.api.connections.list).mockResolvedValue([ROW]);
    vi.mocked(fake.api.lab.connect)
      .mockResolvedValueOnce({ status: "host-key", host: "c1", kind: "unknown" })
      .mockReturnValueOnce(new Promise(() => {}));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    expect(await screen.findByText("First time connecting to c1")).toBeTruthy();
    expect(await screen.findByText("ssh-ed25519 · SHA256:abc")).toBeTruthy();
    expect(fake.api.lab.hostKey.scan).toHaveBeenCalledWith({ host: "c1" });
    fireEvent.click(screen.getByRole("button", { name: "Accept & connect" }));
    await waitFor(() => expect(fake.api.lab.hostKey.accept).toHaveBeenCalledWith({ host: "c1" }, "SHA256:abc"));
    await waitFor(() => expect(fake.api.lab.connect).toHaveBeenCalledTimes(2));
  });

  it("host key changed shows the alarm and the removal command", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    vi.mocked(fake.api.connections.list).mockResolvedValue([ROW]);
    vi.mocked(fake.api.lab.connect).mockResolvedValue({ status: "host-key", host: "c1", kind: "changed" });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    expect(await screen.findByText("Host key changed for c1")).toBeTruthy();
    expect(screen.getByText("ssh-keygen -R c1")).toBeTruthy();
    expect(fake.api.lab.hostKey.scan).not.toHaveBeenCalled();
  });

  it("lab view events drive loading, cover and down panel", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    vi.mocked(fake.api.connections.list).mockResolvedValue([ROW]);
    render(<App />);
    await screen.findByText("Cluster One");
    act(() => fake.events.labOpened.emit({ id: "row1", title: "Cluster One" }));
    expect(await screen.findByText("Opening Cluster One")).toBeTruthy();
    expect(fake.api.lastOpened.set).toHaveBeenCalledWith("alice", "row1");
    expect(document.title).toBe("Cluster One — Rea Claude");
    act(() => fake.events.labState.emit({ id: "row1", state: "ready" }));
    expect(document.querySelector(".labcover")).toBeTruthy();
    act(() => fake.events.labState.emit({ id: "row1", state: "down" }));
    expect(await screen.findByText("Your lab isn’t running")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(fake.api.labView.hide).toHaveBeenCalled();
  });
});

describe("App navigation and settings", () => {
  it("app:navigate opens settings tabs; Escape returns to labs", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    render(<App />);
    await screen.findByText("Labs", { selector: "h1" });
    act(() => fake.events.navigate.emit("settings:profile"));
    expect(await screen.findByText("The GitHub account this app signs in as.")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByText("Labs", { selector: "h1" })).toBeTruthy();
  });

  it("toggles a notification setting", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    render(<App />);
    await screen.findByText("Labs", { selector: "h1" });
    act(() => fake.events.navigate.emit("settings:notifications"));
    fireEvent.click(await screen.findByRole("switch", { name: "Play sound" }));
    await waitFor(() =>
      expect(fake.api.settings.set).toHaveBeenCalledWith({
        notifications: expect.objectContaining({ sound: false, enabled: true }),
      }),
    );
  });

  it("new user with nothing discovered lands on signup (initial window)", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN, initial: true });
    render(<App />);
    await waitFor(() => expect(fake.api.signup.open).toHaveBeenCalled());
    act(() => fake.events.signupOpened.emit(undefined));
    expect(await screen.findByRole("button", { name: "Back" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(fake.api.signup.close).toHaveBeenCalled();
  });

  it("auto-opens the last opened lab on the initial window", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN, initial: true });
    const other: Connection = { ...ROW, id: "row2", name: "Two" };
    vi.mocked(fake.api.connections.list).mockResolvedValue([ROW, other]);
    vi.mocked(fake.api.lastOpened.get).mockResolvedValue("row2");
    vi.mocked(fake.api.lab.connect).mockReturnValue(new Promise(() => {}));
    render(<App />);
    await waitFor(() => expect(fake.api.lab.connect).toHaveBeenCalledWith(other, false, undefined));
    expect(await screen.findByText("Opening Two")).toBeTruthy();
  });

  it("auth expiry returns to sign-in", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    render(<App />);
    await screen.findByText("Labs", { selector: "h1" });
    act(() => fake.events.authExpired.emit(undefined));
    expect(await screen.findByText("Welcome to Silico")).toBeTruthy();
  });
});
