# Packaged renderer and UI contract

## Evidence and scope

This is static inspection of the application-owned files extracted from Silico
0.137.0. No UI, SSH command, sign-in, lab, or backend request was executed for this
report. The renderer and CSS are already readable in the shipped archive: named
functions, line breaks, and many source comments survive bundling. No source-map
recovery or beautification was needed.

References below use original extracted paths relative to `extracted/app/`:

- **R**: `out/renderer/assets/index-2TXBFSxH.js`, 713,236 bytes,
  SHA-256 `73e5e1bacdcae2758f2fc2ff350bff74062b09a42d12885431b09c3669c67e47`.
- **C**: `out/renderer/assets/index-AagaZYJm.css`, 67,473 bytes,
  SHA-256 `5e83a7435d7be3c8f9734ab5cf94e71563e07b19c9da8379b44d0af4cf5adc06`.
- **H**: `out/renderer/index.html`.
- **P**: `out/preload/index.js`; **L**: `out/preload/lab.js`.

Line references are local source evidence, not REA Evidence IDs. They can be
verified with `sed -n '<start>,<end>p' extracted/app/<path>` after extraction.

## What is actually bundled

**Observed:** This renderer implements the desktop connection manager, settings,
sign-in gate, connection progress, and chrome around lab/viewer content. It
bundles React/ReactDOM, Carbon icons, fonts, styles, and the Goodfire mark. The
bundled ReactDOM reports version 19.2.7 (R:12483); the package manifest's `^19.2.0`
is a declared dependency range rather than that exact bundled version.

H:5–11 declares a CSP permitting local script/style and GitHub avatar images.
Its comment says opened Labs use a separate BrowserWindow. R:14806–14815 renders
only a titlebar and cover when lab content is ready. P exposes desktop services
as `window.silico`, whereas L exposes a different `window.silicoDesktop` API to
lab content. These jointly establish a strong desktop/remote-content boundary;
the main-process report supplies the actual window-loading details.

**Inference:** A faithful offline replica of the packaged shell is feasible from
these files and an IPC-compatible fixture adapter. It would not reconstruct the
remote experiment/chat/editor product or its backend. Lab functionality is
referred to by notification, navigation, and checkout APIs, but those APIs are
not the remote application's implementation.

## Entry modes and screens

R:15902 onward selects one of three roots using the URL hash:

| Mode | Selection | Contents |
| --- | --- | --- |
| Connection manager | Default | `App`, including sign-in, Labs picker, add/edit flow, settings, progress, recovery |
| Viewer | `#viewer` | `ViewerShell`: title/navigation, content-ready splash, sign-in/recovery/choose-deployment states |
| Settings sheet | `#settings-modal/<word>` | `SettingsModal`: notifications/developer/profile tabs, update footer, close action |

The default `App` has these principal render branches (R:14262–14845):

1. Signup active: display `SignupShell`, with Back and environment indicator;
   actual signup content is supplied outside this renderer.
2. Auth unknown: loading gate. Signed out: `SignIn`.
3. Signed in: show settings, a full opening screen, edit form, add wizard, or Labs.
4. First-launch gate: temporary splash while automatic opening is resolved.
5. Ready lab: titlebar/cover, leaving content to the main process.
6. Down lab: recovery panel, with managed versus cluster-specific retry copy.

The normal picker is compact and asks the main process to resize to measured
content height. Other contexts use a rail with Labs, Notifications, Developer
settings (conditional), and Profile. R:13836–13883 and 14714–14805 implement this
layout choice and resize request. CSS determines appearance; actual native window
dimensions are owned by the main process.

## Recovered data shapes

These are the fields actually constructed/consumed by the renderer, not a claim
that the backend accepts only these fields. Optionality is inferred from fallback
and branch logic, not recovered TypeScript declarations.

| Object | Observed fields | Source |
| --- | --- | --- |
| Saved connection | `id`, `name`, `icon`, `deploymentId`, `labUrl`, `routeMode`, `ssh`, `owner`, `gatewayUrl`, `dismissed` | R:12502–12520, 13440–13446, 13978–13993, 14234–14255 |
| SSH target | `host`, optional `user`, `port`, `identityFile` | R:15123–15129 |
| Add-SSH-host request | `alias`, `hostName`, optional `user`, `port`, `identityFile` | R:15176–15185 |
| Discovered deployment | `deploymentId`, `routeMode`, `labPublicHost`, `host`, `port`, `stale`, `currentSha`, `targetSha`, `updateRequired`, `updateAvailable`, `reportsVersion` | R:12579–12593, 13890–13915, 13968–13994 |
| Signed-in identity | `status: "signed-in"`, `login`, `sub`, `gatewayUrl`, optional `developer` | R:13579–13606, 14981–15012 |
| Signed-out identity | `status: "signed-out"` | R:13647–13654 |
| Connection progress | `phase`, `startedAt`, `log`, optional `message`, `host`, `hostKeyKind` | R:13504–13506, 14035–14061 |
| Lab display state | `id`, `title`, `state` (`loading`, `ready`, `down` observed), optional `reason` | R:13721–13740, 14806–14844 |
| Navigation state | `canGoBack`, `canGoForward` | R:13561–13564, 15765–15802 |

Only `routeMode === "managed"` and `routeMode === "local"` receive named helper
tests; other values/absence follow cluster behavior. Do not invent a third enum
member from this renderer alone. Managed IDs are deterministic:
`managed:<login>:<deploymentId>:<gatewayUrl>` (R:12511–12513).

Local development drafts use deployment ID `goodfire-local`, an integer port in
1–65535, HTTP localhost URL, default CPU icon, and no SSH. Local row IDs are
`local:<project>`. Discovery of these local stacks is gated by both `isDevBuild`
and staging; it runs on focus and every three seconds (R:12521–12547,
14003–14024, 14330–14339).

## Identity isolation and discovery

`isVisibleTo` rejects dismissed connections, environment mismatches, and owner
mismatches. A connection without a gateway stamp needs discovery to vouch for its
deployment, except that unavailable discovery permits an owner-matched legacy
row. A missing owner is accepted only when vouched for (R:12508–12520).

Authenticated discovery repeats every 20 seconds. Results are treated as current
only when their login and gateway match the current session. Auth expiry resets
discovery and the visible lab. Session identity changes reset reachability and
stopped-deployment state (R:13580–13627, 13645–13676, 13703–13709).

Previously unclaimed rows are stamped with the current owner after successful
discovery. Newly discovered managed deployments are added automatically with
environment-qualified IDs and no SSH. Removing such a managed row persists
`dismissed: true`; removing a non-managed row calls `connections.remove`.
The auto-add existence check includes dismissed rows, preventing immediate
reappearance (R:13926–13998, 14234–14243).

This is renderer-level visibility logic, not proof of authorization enforcement.
Authorization must be assessed at the main-process and gateway boundaries.

## Opening, updating, and progress

`openHere` chooses among three operations (R:14199–14215):

- An out-of-date non-managed lab is updated unless version checks are skipped.
- A non-stale discovered lab that was not stopped and is not known unreachable
  gets the fast `lab.open` path.
- Other cases use `lab.connect`.

Before opening, a lab already held by another window is focused there when
possible. Known reachability gives the fast-open call a 3-second budget; unknown
reachability gives it 90 seconds. Discovered running endpoints are probed through
`lab.status` every 20 seconds (R:12572–12577, 13890–13919, 14091–14146,
14186–14198). These are configured branches, not measured timing.

The full running-phase set is:
`checking`, `ssh`, `setup`, `starting`, `updating`, `opening`, `claiming`,
`tunneling`, `waiting`, `waking`, `stopping` (R:13447–13459).

Terminal or action-needed display phases include `done`, `error`, `host-key`,
`needs-setup`, `forbidden`, and `still-waking`. They are not a single linear
sequence. IPC events update a row's phase only while its existing phase is in
the running set; log chunks append by connection ID. `opened` and `canceled`
operation outcomes both map to `done`. Cancellation records IDs so that a late
opened event can hide the unwanted lab view (R:13710–13739, 14035–14078,
14216–14224).

`still-waking` is deliberately a benign retry state for managed labs, rather
than a generic failed connection. Forbidden outcomes include the signed-in
login in the message. Errors generally reveal the log panel; forbidden,
still-waking, and canceled outcomes do not automatically do so
(R:12548–12571, 14041–14062).

Update checks combine explicit required/available flags, missing reported
versions, and exact 40-character SHA mismatches when pinned checking is enabled.
Preview builds bypass that exact stable-pin comparison. Managed labs bypass
this cluster update choice (R:12578–12593, 14206–14215).

Displayed logs suppress `INFO [httpx] HTTP Request:` lines and coalesce repeated
booting/timestamped messages by replacing their earlier displayed entry. The raw
accumulated `log` remains distinct from this presentation transform
(R:13514–13530).

## Automatic opening on launch

Only the initial window attempts automatic opening; a user interaction retires
the attempt. The UI waits for connections and discovery, with a six-second
launch-gate escape timer (R:13628–13643, 13780–13835).

- No deployments and no saved visible rows: open signup.
- Exactly one deployment and a corresponding visible row: open it.
- Exactly one managed deployment awaiting auto-add: wait while the gate remains.
- Otherwise: read the user's `lastOpened` ID and open it if still visible.

Successful opened events persist `lastOpened` except for local development IDs
(R:13721–13737). This persistence request is delegated to the main process.

## Add/edit and SSH trust workflow

The add wizard first lists deployments discovered for the current account and
excludes deployment IDs already saved. It distinguishes loading, unavailable
discovery, empty account, and all-deployments-already-added states. Picking a
deployment creates a draft preserving the returned route mode and public host
(R:14982–15087).

The form provides name/icon, existing SSH alias selection, or new host inputs.
Alias search appears above five available aliases and matches alias or hostname.
New hosts accept host, user, optional port, and optional identity file via the
native picker. Saving a new host creates a `silico-<sanitized-deployment-or-host>`
alias and stores that alias in the connection (R:15100–15190).

Managed/local connections save without an SSH target. SSH connections test via
`lab.test` before the test-and-save flow proceeds. Unknown host-key handling can
accept the key, retest, and save. Changed keys instead display an alarm and
manual `ssh-keygen -R` guidance; this screen does not offer the unknown-key
accept button (R:14934–14980, 15130–15159). Host-key cryptographic verification
and write behavior belong to the main-process implementation.

## Settings and auxiliary interfaces

Notifications default to enabled, needs-input enabled, experiment-finished
enabled, sound enabled, badge enabled, and notify-when-active disabled
(R:12594–12601). Each toggle merges a patch into the notification object and
calls `settings.set`. Disabling the master toggle disables subordinate controls
(R:15589–15710).

Developer controls are `developerMode`, `previewBuilds`, `skipVersionCheck`,
`staging`, and `verbose`, all falling back to false. Developer-settings visibility
depends on the identity's developer flag or an already-enabled developer-related
setting. Switching staging asks for confirmation, saves the setting, and signs
out (R:13582–13588, 15611–15623, 15712–15762).

Developer mode reveals SSH tunnel opening, manual updates, non-managed Stop Lab,
and build details in the row overflow menu. Edit/Remove remain ordinary actions
(R:14649–14692).

Sign-in opens through `auth.signIn(staging, force)`. Attempt counters ignore
obsolete completions; force retry has a 2.5-second UI cooldown. A keyring notice
appears for persistence status `none-no-keyring`. The update UI listens for a
downloaded phase and calls `update.install` on restart (R:15407–15588).

ViewerShell handles recovery kinds `idle`, `signin`, `error`, `choose`, and
`loading`; it may request a deployment selection before `viewer.retry`.
The actual content is not rendered by this React component
(R:15803–15824).

## Visual system recoverable from CSS

The shipped C:1–98 declares Suisse Intl for body/interface, Newsreader for serif
headings, and IBM Plex Mono for technical text. Fonts are bundled assets. Core
tokens are white paper `#ffffff`, dark text `#1d272a`, muted gray `#7b7b7b`, ember
accent `#c4650d`, border `#e3e3e3`, and selected surface `#e3e3db`. Controls have
4px corners and panels 6px. The style intentionally favors flat surfaces.

The sign-in card is centered with a 360px maximum width, brand mark, serif title,
one primary action, error/waiting states, and terms text (C:675–727). Native chrome
uses 32px titlebar/drag strips, with platform-specific CSS and interactive
controls opted out of dragging. Scrollbars are thin gray pills within 10px
tracks (C:102–155, 881–925). A reconstruction should preserve CSS behavior rather
than infer dimensions solely from a screenshot.

## Reconstruction boundary and remaining checks

**Answered statically:** shell routes, forms, settings defaults, connection field
use, identity filtering, phase rendering, automatic-opening decisions, and local
visual tokens.

**Not established:** actual runtime appearance on this machine, accessibility
behavior under a screen reader, timing/order of real IPC events, validity of
server responses, authenticated remote lab screens, or a complete backend schema.

## Implemented offline shell preview

`web/bridge.js` implements the recovered `window.silico` surface with synthetic
fixtures. `scripts/build_preview.py` copies the extracted renderer into the
ignored `preview/shell/` folder, injects this adapter before the original bundle,
and replaces only the copied page's CSP with a local-only policy. The installed
application and extracted source remain unchanged. GitHub avatars are blocked;
external links are intercepted. No live auth, SSH, update, lab, or API operation
is implemented by this adapter.

Open `/shell/?reset=1` for managed, cluster, and local fixture rows. The scenario
selector supports `signed-out`, `empty`, `host-key` (open the GPU cluster),
`waking`, `forbidden`, and `error`. For example,
`/shell/?reset=1&scenario=host-key` exercises trust-and-retry UI using an explicitly
fake fingerprint. Successful lab opens navigate to the separate local
`/workspace/` reconstruction. Signup also routes to that workspace as a demo
substitute, not to a real account-creation flow.

Settings, connections, aliases, identity, and last-opened IDs persist only under
the browser localStorage prefix `rea-astra:shell:`. `reset=1` clears those known
keys and does not clear unrelated browser data. The adapter works with in-memory
state when browser storage is unavailable. Cancellation prevents later open
events and navigation for the canceled operation.

`node --test tests/bridge.test.mjs` verifies persistence and copy isolation,
phase events, subscription disposal, local navigation, host-key acceptance,
failure states, pending cancellation, namespace-scoped reset, malformed-storage
fallback, and SSH alias/port validation. These are tests of our adapter; they do
not establish that the original application's runtime follows every inferred
branch.
