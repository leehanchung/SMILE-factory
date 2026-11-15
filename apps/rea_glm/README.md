# rea_glm — Silico.app reverse engineering

## Target
- `/Applications/Silico.app` (Electron, `ai.goodfire.silico`, v0.137.0)
- Scratch: `/private/tmp/rea_glm/extracted/out/` (main, preload, renderer)
- REA skill: [reverse-engineer-anything](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/SKILL.md)

## Identity
- **Product**: Silico (Goodfire)
- **Bundle ID**: `ai.goodfire.silico`
- **Version**: 0.137.0
- **URL scheme**: `silico://`
- **Domains**: `silico.goodfire.com` (prod), `silico-staging.goodfire.com` (staging), `my.silico.run` / `my-staging.silico.run` (lab gateway), `docs.silico.run`
- **Icon**: `goodfire-icon-*.png` — confirms Goodfire branding

## Architecture
- **Electron main process** (`out/main/index.js`) — minified, line 173 is the IPC hub
- **Preload** (`out/preload/index.js`) — bridged API for renderer, `lab.js` for lab window
- **Renderer** (`out/renderer/assets/index-2TXBFSxH.js`) — React app

## IPC channels (main handles / renderer calls)
- `auth:*` — signIn, signOutAll, status, persistence, changed, expired
- `connections:*` — list, remove, upsert, changed
- `lab:*` — open, connect, cancel, down, goBack, goForward, hide, status, test, update, navstate, opened, output, phase, state, viewvis
- `labs:*` — list, focus-held, held-elsewhere
- `settings:*` — get, set, changed
- `ssh:*` — addHost, listHosts
- `silico:*` — begin-checkout, begin-github-connect, begin-mcp-oauth, recover-session, badge-counts, notify, open-desktop-settings, open-lab-switcher, shell-events:drain, take-github-connect-return, take-mcp-oauth-return, checkout-return, foreground, github-connect-return, mcp-oauth-return, navigate, report-issue, shell-event-nudge
- `update:*` — get-state, install, state
- `viewer:*` — retry, content-ready, recovery, title
- `window:*` — is-initial, open-settings-sheet, set-compact
- `dialog:*` — confirm, pickFile
- `local:detectStacks`, `lastOpened:get/set`, `ping`, `app:navigate`, `app:isDevBuild`

## Lab gateway
- `my.silico.run` / `my-staging.silico.run` — lab/proxy gateway
- `silico-staging.goodfire.com` — staging API
- `silico.goodfire.com` — production API

## Notes
- `silico:begin-checkout` — checkout flow (Stripe)
- `silico:begin-github-connect` / `silico:take-github-connect-return` — GitHub OAuth
- `silico:begin-mcp-oauth` / `silico:take-mcp-oauth-return` — MCP OAuth
- `silico:recover-session` — session recovery
- `silico:shell-events:drain` — shell event drain
- `silico:badge-counts` / `silico:notify` — system tray
- `silico:open-lab-switcher` — lab switcher UI
- `silico:open-desktop-settings` — desktop settings
- `silico:report-issue` — issue reporting
- `silico:foreground` — foreground event
- `silico:navigate` — navigation
- `silico:shell-event-nudge` — shell event nudge
- `silico:checkout-return` — checkout return
- `silico:github-connect-return` — GitHub OAuth return
- `silico:mcp-oauth-return` — MCP OAuth return

## Diagrams

- [Architecture](diagrams/architecture.excalidraw)
- [IPC flow](diagrams/ipc-flow.excalidraw)
- [Lab window lifecycle](diagrams/lab-window-lifecycle.excalidraw)
