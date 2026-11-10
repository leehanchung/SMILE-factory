// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@shared/config";
import type { ConnectionUpsert } from "@shared/ipc";
import { Root, applyPlatform } from "@renderer/Root";
import { ConfigureForm } from "@renderer/components/ConfigureForm";
import { OverflowMenu } from "@renderer/components/OverflowMenu";
import { UpdateFooter } from "@renderer/components/UpdateFoot";
import { SettingsModal } from "@renderer/screens/SettingsModal";
import { ViewerShell } from "@renderer/screens/ViewerShell";
import { SIGNED_IN, installFakeSilico } from "./helpers/fakeSilico";

afterEach(() => cleanup());

const DRAFT: ConnectionUpsert = {
  name: "dep",
  icon: "flask",
  deploymentId: "dep",
  labUrl: "",
  routeMode: "cluster",
  ssh: { host: "", user: "" },
};

describe("ConfigureForm", () => {
  it("X3: unknown host key is scanned and accepted by fingerprint before saving", async () => {
    const fake = installFakeSilico();
    vi.mocked(fake.api.ssh.listHosts).mockResolvedValue([{ alias: "hostA", hostName: "a.example" }]);
    vi.mocked(fake.api.lab.test)
      .mockResolvedValueOnce({ ok: false, detail: "Host key not trusted", hostKey: "unknown" })
      .mockResolvedValueOnce({ ok: true, detail: "ok" });
    const onSave = vi.fn(async () => {});
    render(<ConfigureForm initial={DRAFT} onBack={() => {}} onCancel={() => {}} onSave={onSave} />);
    fireEvent.click(await screen.findByRole("radio", { name: /hostA/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Host key not trusted")).toBeTruthy();
    expect(await screen.findByText("ssh-ed25519 · SHA256:abc")).toBeTruthy();
    expect(fake.api.lab.hostKey.scan).toHaveBeenCalledWith({ host: "hostA" });
    fireEvent.click(screen.getByRole("button", { name: "Accept host key & add" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(fake.api.lab.hostKey.accept).toHaveBeenCalledWith({ host: "hostA" }, "SHA256:abc");
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: "dep", ssh: { host: "hostA", user: "" } }));
  });

  it("new-host mode adds an SSH config entry with a derived alias", async () => {
    const fake = installFakeSilico();
    const onSave = vi.fn(async () => {});
    render(<ConfigureForm initial={{ ...DRAFT, name: "" }} onBack={() => {}} onCancel={() => {}} onSave={onSave} />);
    // No hosts and no initial host -> starts in "new" mode.
    const host = await screen.findByPlaceholderText("login.your-cluster.example");
    expect(screen.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(host, { target: { value: "login.example" } });
    fireEvent.change(screen.getByPlaceholderText("22"), { target: { value: "2222" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(fake.api.lab.test).toHaveBeenCalledWith({ host: "login.example", user: undefined, port: 2222, identityFile: undefined });
    expect(fake.api.ssh.addHost).toHaveBeenCalledWith({
      alias: "silico-dep",
      hostName: "login.example",
      user: undefined,
      port: 2222,
      identityFile: undefined,
    });
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: "dep", ssh: { host: "silico-dep" } }));
  });

  it("shows test errors and save errors", async () => {
    const fake = installFakeSilico();
    vi.mocked(fake.api.lab.test).mockResolvedValue({ ok: true, detail: "ok" });
    vi.mocked(fake.api.ssh.addHost).mockRejectedValue(new Error("The identity file path must not contain double quotes."));
    render(<ConfigureForm initial={DRAFT} onBack={() => {}} onCancel={() => {}} onSave={vi.fn()} />);
    fireEvent.change(await screen.findByPlaceholderText("login.your-cluster.example"), { target: { value: "h" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("The identity file path must not contain double quotes.")).toBeTruthy();
  });

  it("edit mode saves without testing; icon picker changes the icon", async () => {
    const fake = installFakeSilico();
    vi.mocked(fake.api.ssh.listHosts).mockResolvedValue([{ alias: "h1" }]);
    const onSave = vi.fn(async () => {});
    render(
      <ConfigureForm initial={{ ...DRAFT, id: "x", ssh: { host: "h1" } }} onCancel={() => {}} onSave={onSave} />,
    );
    expect(screen.getByText("Edit lab")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Labs" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pick an icon" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "rocket" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ icon: "rocket", id: "x" })));
    expect(fake.api.lab.test).not.toHaveBeenCalled();
  });

  it("host search appears only with more than five hosts", async () => {
    const fake = installFakeSilico();
    vi.mocked(fake.api.ssh.listHosts).mockResolvedValue(
      ["a", "b", "c", "d", "e", "f"].map((alias) => ({ alias })),
    );
    render(<ConfigureForm initial={DRAFT} onBack={() => {}} onCancel={() => {}} onSave={vi.fn()} />);
    const search = await screen.findByRole("searchbox", { name: "Search SSH hosts" });
    fireEvent.change(search, { target: { value: "zz" } });
    expect(screen.getByText("No hosts match “zz”.")).toBeTruthy();
  });
});

describe("SettingsModal", () => {
  it("renders tabs, toggles settings, confirms staging and closes on Escape", async () => {
    const fake = installFakeSilico({ auth: SIGNED_IN });
    const close = vi.spyOn(window, "close").mockImplementation(() => {});
    render(<SettingsModal initialTab="developer" />);
    expect(await screen.findByText("Developer settings", { selector: "h1" })).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Verbose connect logs" }));
    await waitFor(() => expect(fake.api.settings.set).toHaveBeenCalledWith({ verbose: true }));
    fireEvent.click(screen.getByRole("switch", { name: "Staging environment" }));
    await waitFor(() => expect(fake.api.auth.signOutEverywhere).toHaveBeenCalled());
    expect(fake.api.confirm).toHaveBeenCalledWith({
      message: "Switch to staging (dev twins)?",
      detail: "This signs you out and re-authenticates.",
      confirmLabel: "Switch",
    });
    expect(fake.api.settings.set).toHaveBeenCalledWith({ staging: true });
    await waitFor(() => expect(close).toHaveBeenCalled());
    close.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Profile" }));
    expect(await screen.findByText("@alice")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(close).toHaveBeenCalled();
    close.mockRestore();
  });

  it("does not switch staging when the confirm is declined; dependent toggles disable", async () => {
    const fake = installFakeSilico({
      auth: SIGNED_IN,
      settings: { ...DEFAULT_SETTINGS, notifications: { ...DEFAULT_SETTINGS.notifications, enabled: false } },
    });
    vi.mocked(fake.api.confirm).mockResolvedValue(false);
    render(<SettingsModal initialTab="notifications" />);
    const badge = await screen.findByRole("switch", { name: "App icon badge" });
    await waitFor(() => expect(badge.hasAttribute("disabled")).toBe(true));
    expect(screen.getByRole("switch", { name: "Enable notifications" }).hasAttribute("disabled")).toBe(false);
    // Developer tab hidden for a non-developer with no dev settings.
    expect(screen.queryByRole("button", { name: "Developer settings" })).toBeNull();
    act(() => fake.events.navigate.emit("settings:developer"));
    fireEvent.click(await screen.findByRole("switch", { name: "Staging environment" }));
    await waitFor(() => expect(fake.api.confirm).toHaveBeenCalled());
    expect(fake.api.settings.set).not.toHaveBeenCalled();
  });

  it("renders nothing until signed in", () => {
    installFakeSilico();
    const { container } = render(<SettingsModal initialTab="profile" />);
    expect(container.innerHTML).toBe("");
  });
});

describe("ViewerShell", () => {
  it("splash, recovery choose/error and retry failure", async () => {
    const fake = installFakeSilico();
    render(<ViewerShell />);
    expect(screen.getByRole("status", { name: "Loading page" })).toBeTruthy();
    act(() => fake.events.recovery.emit({ kind: "loading", message: "Restoring this page…" }));
    expect(screen.getByRole("status", { name: "Restoring this page…" })).toBeTruthy();
    act(() => fake.events.recovery.emit({ kind: "choose", message: "Pick one", deployments: ["d1", "d2"] }));
    expect(screen.getByText("Choose a Lab")).toBeTruthy();
    vi.mocked(fake.api.viewer.retry).mockRejectedValueOnce(new Error("x"));
    fireEvent.click(screen.getByRole("button", { name: "d2" }));
    expect(fake.api.viewer.retry).toHaveBeenCalledWith("d2");
    expect(await screen.findByText("Could not restore this page. Please try again.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(fake.api.viewer.retry).toHaveBeenLastCalledWith(undefined);
    act(() => fake.events.recovery.emit({ kind: "signin", staging: true, message: "" }));
    expect(screen.getByText("Staging environment")).toBeTruthy();
    act(() => {
      fake.events.recovery.emit({ kind: "idle" });
      fake.events.contentReady.emit(true);
      fake.events.viewerTitle.emit("Doc");
      fake.events.navState.emit({ canGoBack: true, canGoForward: false });
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Doc")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(fake.api.labView.goBack).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Forward" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("Root, platform and update footer", () => {
  it("selects the root by hash and sets data-platform", async () => {
    installFakeSilico({ auth: SIGNED_IN });
    applyPlatform(document, "win32");
    expect(document.documentElement.dataset.platform).toBe("win32");
    const { unmount } = render(<Root hash="#settings-modal/profile" />);
    expect(await screen.findByText("The GitHub account this app signs in as.")).toBeTruthy();
    unmount();
    render(<Root hash="#viewer" />);
    expect(screen.getByRole("status", { name: "Loading page" })).toBeTruthy();
  });

  it("shows the restart banner when an update is downloaded", async () => {
    const fake = installFakeSilico();
    render(<UpdateFooter />);
    expect(await screen.findByText("Version 1.2.3")).toBeTruthy();
    expect(screen.queryByText("Update ready")).toBeNull();
    act(() => fake.events.updateState.emit({ phase: "downloaded", currentVersion: "1.2.3", newVersion: "1.3.0" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(fake.api.update.install).toHaveBeenCalled();
  });
});

describe("OverflowMenu", () => {
  it("opens, runs an item and closes; backdrop closes", () => {
    const onClick = vi.fn();
    render(<OverflowMenu items={[{ label: "Edit", onClick }]} contextSub={["Up to date · abc1234"]} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByText("Up to date · abc1234")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(onClick).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(document.querySelector(".ov__backdrop") as Element);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
