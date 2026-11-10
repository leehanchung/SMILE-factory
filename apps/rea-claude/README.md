# Rea Claude

A clean-room reimplementation of the **Silico desktop connection manager**
(Goodfire's Electron app, v0.137.0), rebuilt from behavioral specs that were
produced by reverse-engineering the shipped `Silico.app` with
[REA](https://github.com/morluto/rea) and eight parallel analysis agents.

> Not affiliated with Goodfire. Silico is Goodfire's product; this project
> keeps only the interoperability surface (IPC channel names, the
> `window.silicoDesktop` bridge, gateway endpoints, on-disk formats) and
> contains no code or assets from the original. See
> [docs/reverse-engineering.md](docs/reverse-engineering.md).

## What the app does

Silico "Labs" are web applications that run on a managed cloud deployment, on
your own cluster reached over SSH, or on a local dev stack. The desktop app:

1. **Signs you in** through the system browser (a loopback callback on `127.0.0.1`) and keeps the session encrypted in the OS keychain (`safeStorage`).
2. **Manages connections**: hosted (managed) Labs discovered from the gateway, SSH cluster Labs (with `~/.ssh/config` host picking, host-key trust, connectivity test), and local stacks detected via `docker ps`.
3. **Starts Labs**: over SSH it installs or runs the remote `silico` CLI (`silico up`, `silico update`, `silico down`), streams progress phases and output, opens an `ssh -L` tunnel with reconnect, and exchanges the session for a per-Lab token.
4. **Hosts the Lab** in a `WebContentsView` on the `persist:silico` partition with a desktop bridge (`window.silicoDesktop`) for notifications, dock badges, OAuth/checkout return flows, dictation microphone access, and telemetry hand-off. It recovers from crashes, failed loads, sleep, and memory pressure.

## Running

Requires Node 22+ and npm. macOS is the primary target; Linux and Windows code paths exist.

```bash
make -C apps/rea-claude install
```

```bash
make -C apps/rea-claude dev
```

```bash
make -C apps/rea-claude check
```

Environment switches:

| Variable | Effect |
|---|---|
| `REA_CLAUDE_UPDATE_URL` | Enables auto-update from this generic electron-updater feed. Off by default. |
| `REA_CLAUDE_REGISTER_PROTOCOL=1` | Registers the app as the OS handler for `silico://` (otherwise deep links are handled only inside the app, so the real Silico keeps them). |
| `REA_CLAUDE_E2E_USER_DATA` | Test mode: alternate userData directory; the session is not persisted. |

Sign-in uses the production gateway (`https://my.silico.run`) unless the
"staging" developer setting is on. You need a Silico account.

## Documentation

| Doc | Contents |
|---|---|
| [docs/reverse-engineering.md](docs/reverse-engineering.md) | Target facts, REA runs and evidence, clean-room process, open unknowns |
| [docs/architecture.md](docs/architecture.md) | Process model, `MainContext` services, file ownership, startup order, decisions and deliberate deviations, testing strategy |
| [docs/spec/](docs/spec/) | Eight behavioral specs (auth, connections/SSH, lab lifecycle, windows/lab view/menu, lab bridge, settings/updater/lifecycle, renderer UI, design system), each with a line-cited evidence ledger |
| [docs/evidence/rea-ipc-inventory.json](docs/evidence/rea-ipc-inventory.json) | REA's machine-extracted IPC channel inventory of the original, enforced by a contract test |
