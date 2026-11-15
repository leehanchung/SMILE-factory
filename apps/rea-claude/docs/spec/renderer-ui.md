# Silico renderer UI — behavioral spec (clean-room)

Subject: Silico.app v0.137.0 ("Silico desktop connection manager", Goodfire), renderer bundle.
Source read: `pretty/renderer.js` (23,175 lines), `pretty/preload-index.js`, `out/renderer/index.html`, plus a few lines of `pretty/main.js` to confirm which `app:navigate` payloads exist.
All line numbers below refer to `pretty/renderer.js` unless prefixed `preload:` or `main:`.
Visual styling is out of scope; class names are listed so a styling analyst can map them.

---

## 1. Overview and where the app code lives

The renderer is one Vite bundle (`index-*.js`) loaded by `index.html` into `<div id="root">`. The page has a strict CSP: the only remote images allowed are `https://github.com` and `https://avatars.githubusercontent.com` (used for the GitHub avatar). Window title in HTML is `Silico`.

Bundle layout:

| Lines | Content |
|---|---|
| 1 – ~17731 | Library code: React 19, react-dom/client, scheduler, jsx-runtime, prop-types. `ReactDOM` default export bound at 17731. |
| 17732 – 17879 | **App pure helpers** (visibility rules, local-dev drafts, recovery copy, update flags, default notification settings, staging constant, `EmptyLabDiscoveryMessage` component). |
| 17880 – 19239 | `@carbon/icons-react` base `Icon` + individual icon components (tree-shaken subset). |
| 19240 – 19398 | App constants + helpers: logo asset, connection-icon map, `ConnIcon`, `Avatar`, phase tables, log shaper, URL helpers. |
| 19399 – 21386 | `App` — the main connection-manager root component (all state lives here). |
| 21387 – 23160 | Child components: `LabStatePanel`, `OverflowMenu`, `ProgressPanel`, `HostKeyPanel`, `ChooseLab`, `AddWizard`, `ConfigureForm`, `SignIn`, `SignupShell`, `ToggleRow`, hooks, update footers, `SettingsView`, `TitlebarStrip`, `ViewerShell`, `SettingsModal`. |
| 23161 – 23175 | Bootstrap: sets `<html data-platform>`; picks root component by `location.hash`. |

Three root "apps" share the same bundle, selected by URL hash at startup (23163–23174):

| Hash | Root component | Purpose |
|---|---|---|
| `#settings-modal/<word>` | `SettingsModal` (initialTab = `<word>`) | Separate settings sheet window. main opens it via `loadURL(...#settings-modal/<tab>)` (main:7438). |
| `#viewer` | `ViewerShell` | Chrome strip + splash/recovery shown above an opened Lab in a separate viewer window (main:3322). |
| anything else | `App` | Main connection manager: sign-in, labs list, add/edit, settings, opening/loading, lab cover. |

All three are wrapped in `React.StrictMode`. Bootstrap also sets `document.documentElement.dataset.platform = window.silico.platform` when available (23161–23162).

The renderer uses **no** localStorage/sessionStorage/IndexedDB (grep found none in app region). All persistence is via `window.silico` (main process). The only browser API used besides DOM: `navigator.clipboard.writeText` (Copy log), `ResizeObserver` (compact sizing), `window.close()` (modal), `window` `focus` and `keydown` listeners.

---

## 2. Component tree

Names are assigned by me (minified names in the bundle happen to be readable; I kept them where sensible).

```
<Root by hash>
├─ SettingsModal {initialTab}                       (23057)  — settings sheet window
│   ├─ close button (Close icon) → window.close()
│   ├─ aside.smodal__rail
│   │   ├─ nav.rail__nav: Notifications | [Developer settings] | Profile
│   │   └─ UpdateFooter                              (22683)
│   │       ├─ RestartFoot (if update downloaded)    (22649)
│   │       └─ "Version x.y.z"
│   └─ .smodal__main → SettingsView {section=tab}
│
├─ ViewerShell                                        (22972)  — viewer window chrome
│   ├─ TitlebarStrip {title, nav}                    (22934)
│   └─ one of: SignIn (recovery=signin) | RecoveryCard (error/choose) | Splash (until content ready)
│
└─ App                                                (19399)  — main window
    ├─ SignupShell {staging, onBack}                  (22554)  if signup overlay open
    ├─ AuthLoadingGate (inline)                       (20318)  if auth unknown
    ├─ SignIn {staging, onSignedIn}                   (22427)  if signed-out
    │   └─ KeyringNotice {surface:"gate"}             (22625)
    ├─ OpenFull wrapper (div.openfull + dragstrip)    (21094)  when an "opening" screen is shown
    │   ├─ LabLoadingScreen (inline, lab.state==="loading")      (20489)
    │   │   └─ ProgressPanel (logs)                   (21524)
    │   └─ OpeningScreen (inline, openingId set & conn state)    (20605)
    │       ├─ HostKeyPanel                           (21572)
    │       ├─ FailureCard / StillStartingCard / Progress center
    │       └─ ProgressPanel
    ├─ LaunchGate placeholder (inline)                (21106)  first ~6 s after sign-in
    ├─ LabCover: TitlebarStrip + div.labcover         (21348)  when lab view is ready / cover shown
    ├─ LabStatePanel {managed, reason, onReconnect, onBack}   (21387)  when lab.state==="down"
    └─ Shell (one of two chromes around `content`)
        ├─ PickerShell (compact window, div.picker)   (21172)
        │   ├─ .picker__body → content
        │   ├─ UpdateReadyFoot                        (22670)
        │   └─ .picker__foot: Avatar, login, [Staging], "Desktop settings" link
        └─ FullShell (div.shell)                      (21219)
            ├─ aside.rail: brand (logo, "Silico", [Staging]); nav (Labs, Notifications, [Developer settings], Profile);
            │   UpdateReadyFoot; account (Avatar, login, RailVersion)
            └─ main.pane → .pane__bar, .pane__body → content

  content (exactly one, priority order, 20469–21093):
    1. SettingsView                (view==="settings")
    2. LabLoadingScreen            (lab && lab.state==="loading")
    3. ConfigureForm (edit)        (editing)
    4. AddWizard                   (adding)
         ├─ ChooseLab              (21659)
         │   └─ EmptyLabDiscoveryMessage (17853)
         └─ ConfigureForm (wizard) (21903)
    5. OpeningScreen               (openingId && conn state exists)
    6. LabsEmpty (inline)          (no visible saved connections)
    7. LabsList (inline)           (≥1 visible saved connection)
         └─ per row: ConnIcon, pills, "Open", OverflowMenu (21439)
       both 6/7 include LabActionsMenu (OverflowMenu "New lab") and LocalStacksSection (dev only)

Shared leaf components
  ConnIcon {name, size=18}       (19267) – maps icon key → Carbon icon; falls back to "flask"
  Avatar {login, size=32}        (19271) – GitHub avatar <img>, hides itself on error/no login
  ToggleRow {label, desc, on, disabled, onToggle}  (22584) – role=switch button
  OverflowMenu                   (21439)
  ProgressPanel {cs, onHide}     (21524)
  KeyringNotice {surface}        (22625)
  RailVersion                    (22676)
```

### Component responsibilities, props, local state

| Component | Props | Local state | Responsibility |
|---|---|---|---|
| `App` | — | see §3 `AppState` | Everything in the main window: auth gate, discovery polling, auto-open on launch, lab connect/open/update/stop orchestration, list rendering, compact-window sizing, document title. |
| `LabStatePanel` | `managed=false`, `reason?`, `onReconnect?`, `onBack` | — | Full-window card when the open Lab went down. Copy from `labRecoveryCopy`. |
| `OverflowMenu` | `items: {label, onClick, danger?}[]`, `contextSub?: string[]`, `open?` (controlled), `onOpenChange?`, `trigger?: ReactNode`, `triggerClassName="ov__btn"`, `triggerLabel="More actions"` | `selfOpen`, `up` (flip upward) | Button + click-outside backdrop + menu. Flips upward when menu height + 8px > space below the button (layout effect). Clicking an item closes the menu then calls `onClick`. |
| `ProgressPanel` | `cs: ConnState?`, `onHide` | ref to `<pre>` | Log console with phase label + elapsed timer, "Copy log", "Hide". Auto-scrolls to bottom on every content change. |
| `HostKeyPanel` | `ssh`, `kind: "unknown"\|"changed"\|...`, `onAccepted` | `scan`, `accepting`, `err` | SSH host-key trust UI inside OpeningScreen. |
| `ChooseLab` | `discovered`, `discoveryStatus`, `onRetryDiscovery`, `connections`, `auth`, `onPick`, `onSwitchAccount`, `onCancel` | — | Step 1 of Add wizard: lists discovered labs not yet saved. |
| `AddWizard` | `discovered`, `discoveryStatus`, `onRetryDiscovery`, `connections`, `auth`, `initialPick?`, `onSwitchAccount`, `onSave`, `onCancel` | `picked` | Two-step: ChooseLab → ConfigureForm with a draft built from the picked lab. |
| `ConfigureForm` | `initial: ConnectionDraft`, `onBack?` (wizard mode iff present), `onCancel`, `onSave` | `form`, `hosts`, `mode: "pick"\|"new"`, `newHost`, `error`, `showEmoji`, `testing`, `testMsg`, `hostQuery` | Add/edit a lab: name+icon, SSH host selection or new host entry, SSH test, save. |
| `SignIn` | `staging`, `onSignedIn(state)` | `busy`, `error`, `cooldown`; refs `attempt`, `signInOpening`, `cooldownTimer` | Welcome/sign-in card. |
| `SignupShell` | `staging`, `onBack` | — | Thin header bar shown while main overlays a signup web view. |
| `SettingsView` | `auth`, `settings`, `section: "profile"\|"notifications"\|"developer"\|"all"`, `developerVisible=true`, `showBack=false`, `onSaveSettings`, `onSignOut`, `onBack` | — | Settings content; Escape key → `onBack`. |
| `TitlebarStrip` | `title`, `nav: {canGoBack, canGoForward}` | — | Back/Forward buttons + title above a Lab. |
| `ViewerShell` | — | `title`, `nav`, `contentReady`, `recovery` | Viewer window chrome. |
| `SettingsModal` | `initialTab` | `auth`, `settings`, `tab` | Settings sheet window. |
| `UpdateReadyFoot` / `UpdateFooter` / `RailVersion` / `RestartFoot` | — | via `useSelfUpdate` | Self-update banner + version label. |

---

## 3. Navigation / view model

There is no router library. Navigation is driven by a handful of `App` state fields; rendering picks the first matching branch.

```ts
// ----- Data shapes observed in the renderer (fields actually read/written) -----
type RouteMode = "managed" | "local" | string; // anything else = SSH / self-hosted cluster

interface SshRef { host: string; user?: string; port?: number; identityFile?: string }

interface Connection {
  id: string;
  name: string;
  icon: ConnIconKey;          // see §4.12
  deploymentId: string;       // cluster id ("" allowed)
  labUrl: string;
  ssh?: SshRef;               // absent for managed / local
  routeMode?: RouteMode;
  owner?: string;             // GitHub login that owns the row
  gatewayUrl?: string;        // environment stamp (prod vs staging gateway)
  dismissed?: boolean;        // soft-delete for managed rows
}
type ConnectionDraft = Omit<Connection, "id"> & { id?: string };

interface DiscoveredLab {
  deploymentId: string;
  routeMode: RouteMode;
  labPublicHost?: string;
  host?: string; port?: number;   // present when running
  stale: boolean;                  // false => heartbeating/live
  currentSha?: string; targetSha?: string;
  updateRequired?: boolean; updateAvailable?: boolean; reportsVersion?: boolean;
}

type AuthState =
  | { status: "signed-out" }
  | { status: "signed-in"; login: string; gatewayUrl: string; sub: string; developer?: boolean };

interface Settings {
  verbose: boolean; staging: boolean; skipVersionCheck: boolean;
  developerMode: boolean; previewBuilds: boolean;
  notifications: NotificationSettings;
}
interface NotificationSettings {
  enabled: boolean; needsInput: boolean; experimentFinished: boolean;
  sound: boolean; notifyWhenActive: boolean; badge: boolean;
}
// DEFAULT_NOTIFICATIONS (17837): all true except notifyWhenActive=false.

type Phase =
  | "checking" | "ssh" | "setup" | "starting" | "updating" | "opening" | "claiming"
  | "tunneling" | "waiting" | "waking" | "stopping"            // RUNNING set (19303)
  | "done" | "error" | "host-key" | "needs-setup" | "forbidden" | "still-waking";

interface ConnState {          // per connection id, App.conn
  phase: Phase; startedAt: number; log: string;
  message?: string; host?: string; hostKeyKind?: "unknown" | "changed" | string;
}

// ----- Navigation state in App -----
type View = "labs" | "settings";
type SettingsTab = "notifications" | "developer" | "profile";

interface LabViewState { id: string; title: string; state: "loading" | "ready" | "down"; reason?: string }

interface AppNavState {
  view: View;                         // default "labs"
  settingsTab: SettingsTab;           // default "notifications"
  editing: Connection | null;         // ConfigureForm (edit)
  adding: boolean;                    // AddWizard
  addPick: DiscoveredLab | null;      // AddWizard initial pick (skip ChooseLab)
  openingId: string | null;           // OpeningScreen target
  lab: LabViewState | null;           // embedded lab view lifecycle
  labCover: { shown: boolean; title?: string };   // from labView.onViewVis
  labNav: { canGoBack: boolean; canGoForward: boolean };
  pickerPage: boolean;                // subflow opened from the compact picker (shows Back links / "all" settings)
  launchGate: boolean;                // initial-window placeholder while auto-open decides
  signupOpen: boolean;                // SignupShell overlay
  menuFor: string | null;             // which row's overflow menu is open (also via right-click)
}

// ----- app:navigate payloads (main → renderer) -----
type NavigateDest = "connections" | "settings:notifications" | "settings:developer" | "settings:profile" | string;
```

### Top-level render decision (App, 20309–21385), in order

1. `signupOpen` → `SignupShell`.
2. `auth === undefined` → auth loading gate (spinner card).
3. `auth.status === "signed-out"` → `SignIn`.
4. Compute `content` (priority list in §2).
5. If `content` was an opening screen (`openingFull`) → `div.openfull` (dragstrip + content). **This wins over the launch gate and the lab cover.**
6. Else if `launchGate` → launch placeholder (logo only; title/phase/footer rendered but `visibility:hidden` to reserve layout).
7. Build `shell` = `PickerShell` if `labsPicker`, else `FullShell`.
8. If `labCover.shown || lab?.state === "ready"` → `TitlebarStrip` + `div.labcover` (logo mark). The real Lab content is a separate native view drawn by main over this area (Inferred from "labcover" + `labView.*` API).
9. Else if `lab?.state === "down"` → `LabStatePanel`.
10. Else → `shell`.

### Compact ("picker") mode

- `inPickerWindow = signed-in && !signupOpen && !launchGate && !lab && !openingId` (19760).
- `inPickerSubflow = view==="settings" || adding || !!editing`.
- `labsPicker = inPickerWindow && (inPickerSubflow ? pickerPage : view==="labs")`.
- Effect (19782): once `landingKnown` (auth known, `isInitialWin` known, and either initial window or launch gate closed), call `window.silico.setCompact(labsPicker, contentHeight)`. `contentHeight` is only computed when `labsPicker && view==="labs"`: inner content height + body padding top/bottom + (window.innerHeight − body height), ceil'd. Re-runs when content resizes (ResizeObserver on `.picker__body` and its first child, 19772) or list lengths change. Errors swallowed.
- So: the labs list renders in a compact, content-sized window with a footer; subflows entered *from* the compact picker (`pickerPage=true`) stay compact and show "‹ Labs" back links; settings entered from the picker show `section="all"` (one scrolling page titled "Desktop settings"). Otherwise the full rail shell is used.

### `app:navigate` handling

App (19566): on any destination → mark window touched, close launch gate, clear `lab`, `adding`, `editing`, `addPick`, `openingId`, `pickerPage`. Then:
- `dest` starts with `"settings"` → tab = part after `:` if `profile`/`developer`, else `notifications`; `view="settings"`.
- otherwise (e.g. `"connections"`, sent by main on signup deep link and menu) → `view="labs"`.

Note: the lab is cleared in renderer state but `labView.hide()` is NOT called here (Observed; main presumably hides it itself — Unknown).

SettingsModal (23073): only reacts to `settings*` destinations and switches tab with the same mapping.

main senders seen: `"connections"` (main:7241, 7492), `"settings:notifications"`, `"settings:developer"`, `"settings:profile"` (menu items main:7522–7532). In some conditions main routes settings to the separate modal window instead (main:7489 `Qo`) — not the renderer's concern.

### Transitions (user actions)

| From | Action | Result |
|---|---|---|
| Labs | "New lab" → "Connect an existing lab" | `pickerPage=labsPicker; addPick=null; adding=true` → ChooseLab |
| Labs | "New lab" → "Create a new lab" | `signup.open()` (main shows signup overlay → `signup:opened` → SignupShell) |
| Labs (empty) | discovered row "Add" | `pickerPage=labsPicker; addPick=lab; adding=true` → ConfigureForm (wizard) directly |
| Labs | row click / "Open" | `openLab(c)` (§4.7) |
| Labs | row ⋯ → "Edit" | `pickerPage=labsPicker; editing=c` |
| Labs | row ⋯ → "Remove" | `remove(c.id)` |
| Labs (picker) | "Desktop settings" | `pickerPage=true; settingsTab="notifications"; view="settings"` (section "all") |
| Rail | "Labs" | `view="labs"`, clear editing/adding/addPick/openingId; if lab, clear and `labView.hide()` |
| Rail | Notifications / Developer settings / Profile | if lab, clear + `labView.hide()`; set tab; `view="settings"` |
| Settings | Back link / Escape | `pickerPage=false; view="labs"` |
| ChooseLab | "‹ Labs" | `adding=false; addPick=null` |
| ChooseLab | pick a lab | ConfigureForm(wizard) |
| ConfigureForm(wizard) | "‹ Connect an existing lab" | back to ChooseLab (`picked=null`) |
| ConfigureForm(edit) | "‹ Labs" | `editing=null` |
| Opening | "Open a different lab" | see §4.7 |
| LabStatePanel | Back | `lab=null; labView.hide()` |
| LabStatePanel | Reconnect/Try again | `lab=null; openLab(c)` |

---

## 4. Screens

### 4.1 Auth loading gate (App, 20318)
- Shown while `auth.status()` hasn't resolved.
- Layout: `div.gate` > `div.dragstrip` (aria-hidden) + `div.gate__card.gate__card--loading` containing `span.spinner`. No text.

### 4.2 Sign-in (`SignIn`, 22427)
Layout `div.gate` > `div.dragstrip` + `div.gate__card`:
- `img.gate__logo` (Goodfire icon PNG `goodfire-icon-*.png`).
- `h1.gate__title`: **"Welcome to Silico"**
- `p.gate__intro`: **"Sign-in opens in your browser."**
- If `staging`: `div.gate__env` **"Staging environment"**
- If error: `div.gate__error` with the error message (Error.message or String(e)).
- `div.gate__actions` > button `btn btn--primary gate__btn`: **"Sign in"**; while busy **"Waiting for your browser…"** and disabled.
- While busy: `p.gate__waiting` **"Complete sign-in in your browser, then return here. Hit a snag?"** + `button.linkbtn` **"Try again"** (during 2.5 s cooldown: **"Opening browser…"**, disabled).
- `KeyringNotice surface="gate"`.
- `p.gate__terms`: "By signing in, I agree to the **[Silico Terms of Use]** and confirm that I have read Goodfire's **[Privacy Policy]**. I understand that Goodfire may send me marketing emails, which I can unsubscribe from at any time." Links: `https://www.goodfire.com/legal/tos`, `https://www.goodfire.com/legal/privacy`, `target=_blank rel=noreferrer`.
- second `p.gate__terms`: "If my organization has a separate written agreement with Goodfire governing its use of any Goodfire product or service, that agreement applies instead."

Behavior:
- "Sign in" → `go(false)`: ignored if a sign-in is already in flight (ref guard). Increments an attempt counter; `busy=true`, clear error; `await auth.signIn(staging, force)`. If the attempt is still the latest: success → `onSignedIn(state)` (App: `setAuth`). On throw → show error, `busy=false`, release guard. Note: on success busy is never reset (component unmounts as auth flips).
- "Try again" (restart) → cooldown true for 2500 ms, then `go(true)` (force bypasses guard and supersedes the previous attempt; stale results are dropped by attempt id).
- Cooldown timer cleared on unmount.

### 4.3 Signup shell (`SignupShell`, 22554)
- Shown whenever `signupOpen` (from `signup.status()` initially, then `signup.onOpened` / `onClosed`). Main overlays the signup web page; renderer only draws the header bar.
- `div.signup-shell` > `header.signup-shell__bar`: button `.signup-shell__back` [ArrowLeft 16] **"Back"**; `div.signup-shell__title` with logo `img alt="Goodfire"`; if staging, `span.signup-shell__env` **"Staging beta"**.
- Back → `signupOpen=false` locally and `signup.close()`.

### 4.4 Launch gate placeholder (21106)
- Shown on the initial window after sign-in while the app decides whether to auto-open a lab (max 6 s, see §4.14).
- Same structure as the Opening screen (`div.openfull` > `div.opening.opening--loading` > `.opening__center` with logo) but title "Opening", phase "Connecting to your lab…", track and footer ("Open a different lab" • "View logs") are present with `visibility:hidden`/`aria-hidden`/`tabIndex=-1` to reserve layout without being visible or interactive.

### 4.5 Labs list (App content, 20897) and empty state (20824)

Common header `div.pane__inner.labs` > `div.labs__head`: `h1.pane__h1` **"Labs"** + **LabActionsMenu**:
- `div.labs__actions` > `OverflowMenu` with trigger class `btn`, aria-label **"Add a lab"**, trigger content [Add icon 16] **"New lab"**. Opening the menu marks the window "touched".
- Items: **"Connect an existing lab"**, **"Create a new lab"**.

**Visibility of saved connections** — `isVisibleTo(c, login, activeGateway, discoveryStatus, byDeployment)` (17744), pure:
1. hidden if `dismissed`.
2. hidden if `c.gatewayUrl` set and ≠ active gateway.
3. `vouched` = no deploymentId, or (discovery ok and deploymentId is in discovered set).
4. if no `gatewayUrl` and not vouched and not (discovery `unavailable` and owner === login) → hidden.
5. if `owner` set → visible iff owner === login; else visible iff vouched.

`discoveryStatus` (19442): `"loading"` until signed-in and first `labs.list` reply; then `"ok"` if last successful reply's gateway+login match current auth, else `"unavailable"`.

**Empty state** (no visible saved connections):
- `p.labs__question` **"Where do you want to research?"**
- If discovery ok and discovered non-empty: `ul.lablist` of `li.labrow.labrow--disc` sorted case-insensitively by deploymentId: [BareMetalServer 16] `span.labrow__name.labrow__name--muted` = deploymentId, `button.linkbtn.labrow__addlink` **"Add"** → opens AddWizard pre-picked.
- Else if discovery ok and none: `p.labs__nudge` **"Create a new lab (top right), or use “Add lab” to connect an existing one."** (Note: the actual button reads "New lab"; copy mismatch is in the original.)
- Else (loading/unavailable): nothing.
- Then LocalStacksSection.

**List state**:
- If LocalStacksSection is present, an `h2.labs__subhead.labs__subhead--first` **"Saved labs"** precedes the list.
- Rows sorted: `justAdded` row first, then by `name || deploymentId` case-insensitive (`localeCompare`, sensitivity base).
- Row `li.labrow`:
  - click anywhere not inside a `button` or `.ov` → `openLab(c)`.
  - right-click (contextmenu) → preventDefault, open this row's overflow menu (`menuFor=c.id`).
  - `span.labrow__icon` > `ConnIcon(c.icon, 16)`.
  - `span.labrow__name` = `name || deploymentId || "Untitled"`.
  - Pill: if failed (conn phase error/needs-setup/forbidden/host-key) → `span.labrow__pill.labrow__pill--danger` **"Can’t connect"**; else if held open in another window → `labrow__pill--open` **"Already open"**.
  - `span.labrow__actions`: if out-of-date and not failed → `span.labrow__hint` **"Update available"**; `button.btn.labrow__open` **"Open"** → `openLab(c)`; row `OverflowMenu` (⋯ trigger, aria-label "More actions").
- Row overflow menu items (in order):
  - Developer mode only:
    - **"Open via SSH tunnel"** if `c.ssh.host` and not busy → `openingId=c.id; connect(c, {tunnel:true})`.
    - **"Update Lab"** / **"Update Lab (preview)"** (when preview pinned) if ssh host, deploymentId, not busy, not out-of-date → `openingId=c.id; updateLab(c)`.
    - **"Stop Lab"** if live, not busy, not managed → `stopLab(c)`.
  - **"Edit"** → `pickerPage=labsPicker; editing=c`.
  - **"Remove"** (danger style) → `remove(c.id)`. No confirmation.
  - Context header lines (`contextSub`, `div.ov__context-sub`) — version info, see `versionLines` in §8.

**LocalStacksSection** (20390) — only if dev build AND staging AND detected stacks > 0:
- `section.addlocal` > `h2.labs__subhead` **"Local dev stacks"** > `ul.lablist` rows `li.labrow.labrow--stacked`: [Laptop 16], `labrow__name` = `localStackName(st)`, optional "Already open" pill, `span.labrow__host` "localhost:<port>", `button.btn.labrow__open` **"Open"**. Row click (not on a button) or Open → `connectLocal(conn)` where conn = `buildLocalDevDraft({name, port})` + `id: "local:<project>"`.

### 4.6 Picker shell footer / full-shell rail
PickerShell (21172): `div.picker` > dragstrip, `div.picker__body` (scroll container, ref), `UpdateReadyFoot`, `div.picker__foot`: Avatar(18), `span.picker__login` (title "Signed in as <login>"), if staging `span.brand__env` **"Staging"**, and when not in settings `button.linkaction.picker__settings` **"Desktop settings"**.

FullShell (21219): `div.shell` > `aside.rail`:
- `div.rail__top` > `div.brand`: logo, `span.brand__name` **"Silico"**, staging `span.brand__env` **"Staging"**.
- `nav.rail__nav`: `button.rail__item` (+`rail__item--active`) [Chemistry 14] **"Labs"**; [Notification 14] **"Notifications"**; [Code 14] **"Developer settings"** (only if developer settings visible); [User 14] **"Profile"**. Active: Labs when `view==="labs"`; tab buttons when `view==="settings"` and tab matches.
- `div.rail__spacer`, `UpdateReadyFoot`, `div.rail__acct` > `div.rail__acct-row` (Avatar 22, `span.rail__login` title "Signed in as <login>") + `RailVersion` ("Version <currentVersion>" or "Version —").
- `main.pane` > `div.pane__bar` (empty) + `div.pane__body` (ref) > content.

`developerSettingsVisible` (19458) = signed-in with `auth.developer`, OR any of settings developerMode/staging/previewBuilds/verbose/skipVersionCheck is true. If the developer tab is selected but becomes invisible (once settings+auth loaded), tab resets to notifications (19944).

### 4.7 Opening a lab — logic and the Opening screen

`openLab(c)` (20205): mark touched. If `c.id` is in `heldElsewhere` → `labs.focusHeld(c.id)`; if main returns falsy, drop it from heldElsewhere and `openHere(c)`; errors swallowed. Otherwise `openHere(c)`.

`openHere(c)` (20220):
1. If current phase is `stopping` → do nothing.
2. `openingId = c.id`.
3. If already running (RUNNING phase) or phase `host-key` → stop (just shows screen).
4. Find discovery record by deploymentId (only when discovery ok).
5. `live` = disc.stale === false && deploymentId && not in locally `stopped` set.
6. `reachable` = probe result for that deployment.
7. `outOfDate` = !skipVersionCheck && !managed && `labUpdateFlags(disc, {pinnedExactCheck: !previewPinned && !staging}).any`.
8. outOfDate → `updateLab(c)`; else live && reachable !== "unreachable" → `openRunning(c)`; else → `connect(c)`.

`connect(c, opts?)` (19992): clear cancelled flag; un-stop deployment; conn[c.id] = fresh `checking` state; `await lab.connect(c, verbose, opts)`. Map outcome → phase: `opened`/`canceled` → `done`, else the status string. message: forbidden → `forbiddenMessage(outcome.login)`; still-waking → STILL_WAKING_MESSAGE; else `outcome.message` if present. Also copies `host` and `hostKeyKind` (=outcome.kind when host-key). If not opened: auto-expand logs unless forbidden/still-waking/canceled; clear `lab` if it's this one and not `ready`. If opened with a new `labUrl` ≠ saved → `connections.upsert({...c, labUrl})` + reload. On exception → phase `error`, message (Error.message or **"Connect failed unexpectedly."**), expand logs, clear non-ready lab. Finally clear cancel flag, `refreshDiscovery()`.

`openRunning(c)` (20077): skip if running. conn = `opening`. `lab.open(c, {reachTimeoutMs: 3000 if reach==="reachable" else 90000})`. Result:
- `unreachable` → error with message: managed: **"The app couldn't reach this Lab at {url}. Check your internet connection, then try again."**; else **"This Lab is heartbeating but the app couldn't reach it at {url}. It may be behind a VPN/Tailscale, still starting up, or shutting down. Check, then try again."**; expand logs.
- `canceled` → done; clear non-ready lab.
- `forbidden` → phase forbidden + forbiddenMessage; clear non-ready lab.
- `still-waking` → phase still-waking + STILL_WAKING_MESSAGE; clear non-ready lab.
- `other` and managed → error **"This Lab couldn't be opened right now. If it keeps happening, reach out to Goodfire on Slack."**; expand logs.
- anything else → done.
- throw → error, message or **"Opening the Lab failed unexpectedly."**; expand logs.
- finally clear cancel flag, refreshDiscovery.

`updateLab(c)` (20140): skip if running. `preview = previewPinned`. conn = `updating`. `lab.update(c, {preview})`. Outcome mapping as connect; logs expanded unless opened/forbidden/still-waking/canceled; forbidden clears non-ready lab; labUrl write-back like connect. Throw → **"Update failed unexpectedly."**

`stopLab(c)` (20254): skip if running; conn=`stopping`; `lab.down(c)`; add deploymentId to `stopped`; phase done. Throw → **"Stopping the Lab failed unexpectedly."**, expand logs. Finally refreshDiscovery.

`cancelOpening(c)` (20245): `lab.cancel(c.id)`; add to `cancelledOpens`; `openingId=null`; delete conn[c.id].

`openingId` auto-clears when its conn phase becomes `done` (19979).

**Opening screen** (20605; shown when `openingId` has a conn state and no higher-priority branch). `failed` = phase error|needs-setup|forbidden. Name shown = `c.name || c.deploymentId || "this Lab"` (failure title) / `|| "Lab"` (progress title).
- Wrapper class `opening opening--loading` while "working" (not host-key-with-ssh, not failed, not still-waking), else `opening`.
- **Host key** (phase host-key and c.ssh): `div.opening__hk` > `HostKeyPanel` (onAccepted → `connect(c)`), + `div.opening__actions` `btn btn--ghost` **"Cancel"** → cancelOpening.
- **Failure** (`div.opening__fail` role=alert): WarningAltFilled 20 (`opening__fail-icon`); `h2.opening__fail-title` **"Couldn't open {name}"**; `p.opening__fail-msg` = first line of: for needs-setup **"This cluster isn't set up yet, and setup couldn't start automatically. Check that you're allowlisted on it and signed in."**, else message or **"This lab couldn't be opened. Try again in a moment."**; actions: if forbidden `btn` **"Switch account"** → `signOut()`; `btn btn--primary` **"Retry"** → `openLab(c)`; secondary `button.linkaction` **"Open a different lab"** → `openingId=null` (does NOT cancel).
- **Still starting** (`role=status`, deliberately no icon): `h2` **"Still starting"**, message (default STILL_WAKING_MESSAGE = **"Your lab is taking longer than usual to start. Try opening it again in a moment."**), `btn btn--primary` **"Try again"** → `openLab(c)`, secondary **"Open a different lab"** → `openingId=null`.
- **In progress**: `.opening__center`: logo, `div.opening__title` **"Updating {name}"** if phase updating else **"Opening {name}"**; `p.opening__phase` = `phaseStatus(phase)` (keyed by text so it re-mounts/animates on change); `div.opening__track` (indeterminate bar); ProgressPanel if `showLog`. Footer `div.opening__footer`: `linkaction` **"Open a different lab"** → cancelOpening; `span.opening__sep` "•"; `button.opening__logs` toggles **"Hide logs"/"View logs"**.
- After failure/still-waking: if showLog → ProgressPanel, else `button.opening__logs` **"View logs"**.
- `showLog = open[c.id] ?? (developerMode || verbose)`.

`phaseStatus(p)` (19335): checking/ssh **"Checking the cluster…"**; setup **"Setting up this cluster for the first time. This can take a few minutes."**; starting **"Firing up your lab…"**; updating **"Installing the latest lab version. This can take a few minutes."**; waiting **"Waiting for your lab to come online…"**; waking **"Getting your lab ready. This usually takes under a minute."**; done **"Almost ready…"**; anything else **"Connecting to your lab…"**.

`forbiddenMessage(login)`: with login **"You’re signed in as @{login}, which can’t open this Lab. You may have the wrong GitHub account."**; without **"This account can’t open this Lab. You may be signed in with the wrong GitHub account."**

### 4.8 Lab loading screen (lab.state === "loading", 20489)
Shown once main reports `lab:opened` (or after an Add/local connect sets it). Same `opening opening--loading` center: logo, **"Opening {lab.title}"**, status = `phaseStatus("waking")` if conn phase is waking or the lab was flagged waking via `lab:phase`, else `phaseStatus(conn phase)`; track; ProgressPanel only if conn state exists AND `open[lab.id]` is true. Footer: **"Open a different lab"** → `lab=null`, `labView.hide()`, and if `openingId` refers to this lab → cancelOpening; if conn state exists, "•" + **"View logs"/"Hide logs"** toggle.

### 4.9 Lab cover (lab ready / viewvis shown, 21348)
`TitlebarStrip(title = lab.title ?? labCover.title ?? "", nav = labNav)` + `div.labcover` (aria-hidden) with `img.labcover__mark`. The lab itself is a native view managed by main (Inferred).

`TitlebarStrip` (22934): `div.labbar` > `div.labbar__nav` with two `button.labbar__navbtn`: [ArrowLeft 18] title/aria **"Back"** → `labView.goBack()`, disabled unless `canGoBack`; [ArrowRight 18] **"Forward"** → `labView.goForward()`, disabled unless `canGoForward`; `span.labbar__title`.

### 4.10 Lab down panel (`LabStatePanel`, 21387)
`div.centered` > dragstrip + `div.labstate` (role=status only if benign): [Renew 38] in `labstate__icon`, `labstate__title`, `p.labstate__sub`, actions `btn btn--ghost` **"Back"** + (if connection still known) `btn btn--primary` {action}.
`labRecoveryCopy({managed, reason})` (17788):
- managed + reason `still-waking` → "Still starting" / STILL_WAKING_MESSAGE / "Try again" / benign.
- managed → **"Can’t reach your lab right now"** / **"This is usually temporary. Try again — and if it keeps happening, reach out to Goodfire on Slack and we’ll take a look."** / "Try again".
- otherwise → **"Your lab isn’t running"** / **"Reconnect to start it again."** / **"Reconnect"**.

### 4.11 Add wizard — Choose lab (`ChooseLab`, 21659)
`div.pane__inner.labs`; `div.backbar` > `button.backlink` [ChevronLeft 16] **"Labs"** → onCancel; `div.labs__head.labs__head--tight` > h1 **"Connect an existing lab"**. Then by status:
- loading: `p.labs__sub` **"Looking for clusters your account can reach…"**
- unavailable: **"Couldn’t check which clusters your account can reach."** + `btn` **"Try again"** → `refreshDiscovery`.
- discovered empty: `EmptyLabDiscoveryMessage` + `div.addacct` (Avatar 34, `settings__k` login, `settings__kk` **"Signed in as this account"**, `btn` **"Switch account"** → App: `adding=false; addPick=null; signOut()`) + `p.labs__nudge.addacct__note` **"Don’t see one you expected? Reach out to Goodfire on Slack."**
  - `EmptyLabDiscoveryMessage` (17853): if `auth.sub` starts with `google:` → "You signed in with Google, but this Google account isn’t connected to a Silico account yet. Sign in with Google at **[silico.goodfire.com]** and follow the instructions there to connect your existing Silico account. Once connected, you can use either Google or GitHub to sign in to the app." (staging gateway → `silico-staging.goodfire.com`; link opens `_blank`). Otherwise **"You’re not registered on any Silico clusters yet. If you expected to see one, you may be signed in with the wrong account."**
- all already added (`fresh` empty): **"You’ve added every cluster your account can reach."**
- else: **"Labs your account can reach that you haven’t added yet. Pick one to set it up."** + list of `button.labrow.labrow--pick` (inside `li`): [BareMetalServer 16], `labrow__name` deploymentId, optional `labrow__host` labPublicHost, [ChevronRight 16 `labrow__chev`] → onPick(lab).
`fresh` = discovered whose deploymentId is not among the *visible* connections' deploymentIds, sorted case-insensitively.

When the wizard is given discovered labs, App passes `discovered` only when discovery ok (else `[]`).

Draft built on pick (21870): `{name: deploymentId, icon: nextUnusedIcon(visibleConnections), deploymentId, labUrl: labPublicHost ? "https://"+host : "", routeMode, ssh: managed ? undefined : {host:"",user:""}}`.

### 4.12 Configure form (`ConfigureForm`, 21903) — add (wizard) / edit
- `isEdit = !!initial.id`; `isWizard = !!onBack`; `managed`; `noSsh = managed || local`.
- Back bar: `backlink` [ChevronLeft] **"Connect an existing lab"** (wizard → onBack) or **"Labs"** (edit → onCancel).
- h1: **"Edit lab"** if edit else **"Add a lab"**.
- `div.form`:
  - Field `span.label` **"Name & icon"**; `div.nameicon` > `div.iconpick` > `button.iconpick__btn` (aria-label **"Pick an icon"**, aria-expanded) showing ConnIcon(18) + ChevronDown 11 (`iconpick__car`). When open: `ov__backdrop` (click closes) + `div.icon-grid` role=menu with one `button.icon-btn` (`icon-btn--active` when selected, role=menuitemradio, aria-checked, aria-label = icon key) per icon; click sets icon and closes. `input.nameicon__name` placeholder **"Name this Lab"**.
  - SSH field (only if not noSsh): label **"Which SSH host reaches {deploymentId || "this cluster"}?"**.
    - If > 5 options: `input.hostpick__search` type=search placeholder **"Search hosts"** aria-label **"Search SSH hosts"**; filters by alias or hostName substring (case-insensitive, trimmed).
    - radiogroup aria-label **"SSH host"**: if options exist, `ul.hostpick` (if filter yields none: `li.hostpick__none` **"No hosts match “{query}”."**), each `label.hostpick__opt` > radio (`choice__radio`, name `sshhost`, checked when mode pick and form.ssh.host === alias; change → mode pick, set ssh.host, clear test message) + `hostpick__alias` alias + optional `hostpick__host` hostName.
    - Always: `label.hostpick__opt.hostpick__new` radio (checked when mode new) **"Set up a new Lab"** / **"I have an SSH key that isn’t in my config yet"**.
    - Options = `ssh.listHosts()` result, plus the current `form.ssh.host` prepended if not in the list; sorted case-insensitively by alias.
    - Initial mode: `pick`; switches to `new` when hosts list is empty and initial has no ssh host.
    - Mode new → `div.nest`: **"Host"** + `lbl__opt` **"the cluster’s SSH login node"** input placeholder **"login.your-cluster.example"**; row2: **"Username"** placeholder **"your cluster user"**; **"Port"** (`fld--port`) placeholder **"22"** `inputMode=numeric`; **"SSH key"** + **"optional, uses your agent if blank"** input placeholder **"~/.ssh/id_ed25519"** + `btn` **"Browse…"** → `pickSshKey()`; returned path fills identityFile. Editing any new-host field clears the test message.
- Test message row (if test result not ok): `div.test-row` > `span.test-msg test-msg--warn` (when `hostKey==="unknown"`, no icon) or `test-msg--err` (WarningAltFilled 14) + `detail`.
- `div.form__actions`: primary button, disabled when `!canSave || testing`; label: testing → spinner + **"Verifying SSH…"**; edit → **"Save"**; managed → **"Add"**; test said hostKey unknown → **"Accept host key & add"**; else **"Add"**. Click: edit or managed → `handleSave()`; hostKey unknown → `acceptKeyAndSave()`; else `testAndSave()`. Error from save shown as `span.hint.hint--warn`.
  - Note: local (non-managed) add also goes through `testAndSave` path (Observed: condition uses `managed`, not `noSsh`) — it would call `lab.test` with an empty host. Local drafts are not created through this form in the observed UI (they're opened directly), so this is latent. Flag as **Unknown/edge**.

### 4.13 Settings (`SettingsView`, 22699)
`div.pane__inner.sview`. Optional back bar (`showBack`) `backlink` [ChevronLeft] **"Labs"** → onBack. Escape key anywhere (window keydown) → onBack.
h1: **"Profile" / "Notifications" / "Developer settings"** per section, **"Desktop settings"** for `all`.
In `all` mode each section gets an `h2.labs__subhead` heading ("Profile" with `--first`, "Notifications", "Developer" — the last only if developerVisible).

- **Profile** (`section.sview__sec`): `p.sview__secsub` **"The GitHub account this app signs in as."**; `div.settings__item` > `div.settings__id` (Avatar 36, `settings__k` login, `settings__kk` "@login") + `btn` **"Switch account"** → onSignOut; `KeyringNotice surface="settings"`.
- **Notifications** (ToggleRows; all but first disabled when `enabled` is off). Each toggle calls `onSaveSettings({notifications: {...current, [key]: !value}})`:
  | Label | Description | key |
  |---|---|---|
  | Enable notifications | Native notifications for the moments that need you. Off silences all of them. | enabled |
  | Needs your input | Notify when an experiment is waiting on you. | needsInput |
  | Experiment finished | Notify when an experiment completes. | experimentFinished |
  | Play sound | Play the system sound with each notification. | sound |
  | Notify about the experiment I’m viewing | By default nothing shows for the experiment you’re already looking at. Turn on to notify anyway. | notifyWhenActive |
  | App icon badge | Show how many threads need you on the app icon — or a dot for unread activity. | badge |
  If `settings.notifications` missing → DEFAULT_NOTIFICATIONS.
- **Developer** (shown when section developer, or `all && developerVisible`):
  | Label | Description | Action |
  |---|---|---|
  | Developer mode | Show developer detail across the app: connect logs, Lab versions, and advanced Lab actions like SSH tunnels. | `{developerMode: !v}` |
  | Preview build | Run Labs on the unreleased preview build. Updates move them onto it automatically. Off, Labs return to the stable build on their next update. | `{previewBuilds: !v}` |
  | Skip build update | Open Labs as they are, without updating them to the pinned version first. Useful for running untagged builds. | `{skipVersionCheck: !v}` |
  | Staging environment | Use `silico-dev` instead of production. Switching signs you out, then asks you to sign in again. | confirm flow ↓ |
  | Verbose connect logs | Show the full command output while a Lab connects or updates. | `{verbose: !v}` |
  Staging toggle: `window.silico.confirm({message: "Switch to staging (dev twins)?" | "Switch to production?", detail: "This signs you out and re-authenticates.", confirmLabel: "Switch"})`; if confirmed → `onSaveSettings({staging: next})` then `onSignOut()`.

`ToggleRow` (22584): `div.settings__item` > label/desc (`settings__k`, `settings__kk`) + `button.toggle` (`toggle--on`), `role=switch`, `aria-checked`, `aria-label=label`, `disabled`.

In App: `onSaveSettings` = `settings.set(patch)` then set returned settings; `onSignOut` = `pickerPage=false; view="labs"; auth.signOutEverywhere()` (renderer does not set auth itself; relies on `auth:changed`); `onBack` = `pickerPage=false; view="labs"`.

`KeyringNotice` (22625): calls `auth.persistence()` once; renders only when result is `"none-no-keyring"`: `p.keyring-note.keyring-note--{surface}` **"Your system keyring isn’t available, so Silico can’t remember this sign-in — you’ll need to sign in again next launch."**

### 4.14 Auto-open on launch (App effect 19687) and launch gate
- `launchGate` starts true. If `isInitialWindow()` resolves false → gate off. When signed in and nothing tried/touched and initial window not false → gate on; a 6000 ms timer always forces it off (re-armed when `signedIn`/`isInitialWin` change).
- "Touched" (`winTouched`) is set by any user navigation/action (menu open, rail clicks, app:navigate, lab opened, view not labs, editing/adding/opening/menu open).
- Decision runs once (`autoConnectTried`), after `isInitialWin` known and signed in:
  - If touched → retire (and on initial window, a `lastOpened.get(login)` call whose result is ignored — Observed, purpose Unknown, perhaps to consume/clear) and gate off.
  - Wait until connections and discovery loaded. Non-initial window → done, gate off.
  - With discovery ok:
    - no discovered labs and no visible rows → retire, gate off, `signup.open()` (new user lands on signup).
    - exactly one discovered lab: if a visible row matches it → open it. Else if that lab is managed and gate still up → **wait** (the auto-add effect will create a row; re-evaluates). Else retire, gate off.
  - Otherwise: `lastOpened.get(login)` → if not touched and id present and matches a visible row → `openLab(row)`; gate off.
- `lab:opened` records `lastOpened.set(login, id)` for non-`local:` ids (19626).

### 4.15 Background data effects in App
- **Connections**: `connections.list()` on mount and after every mutation (`reload`). (`connections.onChanged` exists in preload but is **not** subscribed by the renderer.)
- **Discovery**: when signed in, `labs.list()` immediately and every **20 s** (19591). Reply `{ok:true, labs, gatewayUrl, login}` → store; `{ok:false, needsAuth:true}` → treat as signed-out; other failure → source null ⇒ status "unavailable".
- **Reachability probes**: when discovery ok, for every discovered lab with `!stale && host && port`, `lab.status(labBaseUrl(host, port))` immediately and every **20 s**; `"up"` → reachable else unreachable (19816).
- **Session reset**: when `login+gateway` key changes, clear `reach` and `stopped`.
- **Auto-claim legacy rows** (19848): rows not dismissed, with deploymentId in discovery, and (no owner, or owner===login && managed && no gatewayUrl) → upsert with `owner ??= login`, `gatewayUrl ??= (managed ? gateway : undefined)`; then reload. Single-flight guard.
- **Auto-add managed labs** (19890): every discovered managed lab without a matching row (same deploymentId, in environment, owner empty or me) → upsert `{...EMPTY, id: managedRowId(login, deploymentId, gw), name: deploymentId, icon: nextUnusedIcon(existing+added), deploymentId, labUrl: https://labPublicHost or "", routeMode, ssh: undefined, owner: login, gatewayUrl: gw}` sequentially, then reload. Single-flight guard.
- **Held elsewhere**: while `view==="labs"` and no lab, `labs.heldElsewhere()` on mount and on every window `focus` (19669).
- **Local stacks**: if dev build and staging: `detectLocalStacks()` immediately, on window focus, and every **3 s**; otherwise cleared.
- **Elapsed ticker**: while any conn is in a RUNNING phase, re-render every **1 s** (for `ProgressPanel` elapsed).
- **justAdded**: scroll pane to top smoothly when set; clear 1500 ms after its conn reaches `done`.
- **Document title** (19806): app name = **"Silico (local development · staging auth gateway)"** if the open lab is a local connection; **"Silico (Staging)"** if staging; else **"Silico"**. With a lab: `"{lab.title} — {app}"`.
- **Log/phase streaming**: `lab.onOutput({id, chunk})` appends to conn[id].log (only if a state exists); `lab.onPhase({id, phase})` updates phase only while current phase is RUNNING. A second `onPhase` subscription tracks `labWaking[id]` (true on `waking`, false on any other phase / lab opened / lab state ≠ loading).
- **Lab view events**: `labView.onOpened({id,title})` → mark tried/touched, gate off; if id was cancelled → `labView.hide()` and ignore; else `view="labs"`, `lab={id,title,state:"loading"}`, record lastOpened. `labView.onState({id,state,reason})` → update matching lab. `labView.onViewVis(p)` → `labCover=p`. `labView.onNavState` → `labNav`.
- **Auth events**: `auth.onExpired` → signed-out, clear discovery, `lab=null`, `view="labs"`. `auth.onChanged(state)` → set auth; if identity (login+gateway) changed, clear discovery.

### 4.16 Viewer window (`ViewerShell`, 22972)
- Subscribes: `viewer.onTitle` → title; `labView.onNavState` → nav; `viewer.onContentReady(bool)`; `viewer.onRecovery(state)`.
- Always renders `TitlebarStrip`.
- `recovery.kind === "signin"` → `SignIn` with `staging = recovery.staging`, no-op onSignedIn.
- `"error"` or `"choose"` → `div.viewer-recovery` role=status: logo, h1 **"Choose a Lab"** (choose) or **"Could not restore this page"** (error), `p` = recovery.message; choose → one `btn` per deployment (label = deployment id) → `viewer.retry(deployment)`; error → `btn` **"Try again"** → `viewer.retry()`. If `retry` rejects → recovery = error **"Could not restore this page. Please try again."**
- Otherwise, until content ready: `div.viewer-splash` role=status, aria-label = recovery.message when kind `loading` (main sends "Restoring this page…", main:2906) else **"Loading page"**; logo image.
- Recovery kinds observed: `idle` (initial), `loading{message}`, `signin{staging}`, `error{message}`, `choose{message, deployments: string[]}`.

### 4.17 Settings modal window (`SettingsModal`, 23057)
- Loads `auth.status()` + `auth.onChanged`; `settings.get()` + `settings.onChanged`; `onNavigate` (settings tabs only); `auth.onExpired` → `window.close()`.
- Renders nothing until signed in.
- `div.smodal`: `button.smodal__close` (aria-label/title **"Close"**, Close icon 18) → `window.close()`; `aside.smodal__rail` > `nav.rail__nav` (Notifications / [Developer settings] / Profile, same icons, active class) + spacer + `UpdateFooter`; `div.smodal__main` > `SettingsView(section=tab)` with: save → `settings.set(patch)`; sign out → `auth.signOutEverywhere()` then `window.close()`; back (Escape) → `window.close()`.
- Developer tab visible if `auth.developer`, or any dev setting on, **or the developer tab is currently selected** (differs from App, which hides/redirects it).

### 4.18 Self-update UI
- `useSelfUpdate()` (22634): `update.getState()` once + `update.onState` subscription. State fields used: `phase`, `currentVersion`.
- `RestartFoot` when `phase === "downloaded"`: `div.foot.foot--banner`: `foot__title` **"Update ready"**, `p.foot__sub` **"Restart to apply the new version."**, `button.linkbtn.foot__restart` **"Restart to update"** → `update.install()`.
- `UpdateReadyFoot` (App rail and picker): only the RestartFoot when downloaded.
- `UpdateFooter` (modal): RestartFoot if downloaded + `div.foot > div.foot__ver` "Version {currentVersion|—}".
- `RailVersion` (App rail): `div.rail__ver` "Version {currentVersion|—}".

### 4.19 Progress/log panel (`ProgressPanel`, 21524)
`div.panel` > `div.panel__bar`: `span.panel__phase` = `PHASE_LABEL[phase]` (or "Idle" without state) + ` · m:ss` elapsed while running; `div.panel__actions`: `btn` **"Copy log"** (clipboard ← shaped log), `btn` **"Hide"** → onHide. `pre.console` = shaped log or **"(no output yet)"**; auto-scrolled to bottom.

`PHASE_LABEL` (19316): checking "Checking the cluster…", ssh "Connecting over SSH…", setup "Setting up the cluster (first run)…", starting "Firing up your lab…", updating "Updating your lab…", opening "Opening…", claiming "Binding your account…", tunneling "Connecting through SSH tunnel…", waiting "Waiting for your lab to come online…", waking "Firing up your lab…", stopping "Stopping your lab…", done "Done", error "Failed", host-key "Host key needed", needs-setup "Setup needed", forbidden "Not authorized", still-waking "Still starting…".

### 4.20 Host key panel (`HostKeyPanel`, 21572)
- kind `changed` → `div.hk.hk--alarm`: title [WarningFilled 15] **"Host key changed for {host}"**; body **"The host key for this server changed since you last trusted it. That can mean the cluster was rebuilt, or that the connection is being intercepted. Don’t accept it unless you expected this. If the cluster was re-provisioned, remove the old key and reconnect:"**; `code.hk__cmd` `ssh-keygen -R {host}`. No accept button.
- otherwise → `div.hk`: title **"First time connecting to {host}"**. On mount when kind === "unknown": `lab.hostKey.scan(ssh)`. Until result: **"Fetching the host key…"**. Scan ok: **"Make sure this matches the cluster’s fingerprint, then accept to trust it:"**, `code.hk__fp` "{keyType} · {fingerprint}", error `p.hk__err`, `btn btn--primary` **"Accept & connect"** / **"Accepting…"** (disabled while accepting) → `lab.hostKey.accept(ssh)`; ok → onAccepted (re-connect) else error (default **"Could not accept the host key."**). Scan not ok: `p.hk__err` = scan.error.
- Note: if kind is neither "unknown" nor "changed", scan is never triggered and the panel shows "Fetching the host key…" forever (Observed edge).

---

## 5. `window.silico` usage matrix

| API member (IPC channel) | Component(s) | When |
|---|---|---|
| `platform` | bootstrap | startup → `html[data-platform]` |
| `ping` | — | not used |
| `isDevBuild()` | App | mount |
| `isInitialWindow()` | App | mount |
| `setCompact(compact, contentHeight?)` | App | whenever picker/view/content size changes after landing known |
| `openSettingsSheet()` | — | not used by renderer |
| `detectLocalStacks()` | App | dev build + staging: mount, focus, every 3 s |
| `pickSshKey()` | ConfigureForm | "Browse…" |
| `confirm({message, detail, confirmLabel})` | SettingsView | staging toggle |
| `onNavigate(cb)` | App, SettingsModal | mount subscription |
| `auth.status()` | App, SettingsModal | mount |
| `auth.persistence()` | KeyringNotice | mount |
| `auth.signIn(staging, force)` | SignIn | Sign in / Try again |
| `auth.signOutEverywhere()` | App (signOut, settings onSignOut), SettingsModal | Switch account, staging switch, forbidden "Switch account", ChooseLab "Switch account" |
| `auth.onExpired` | App, SettingsModal | mount |
| `auth.onChanged` | App, SettingsModal | mount |
| `signup.open()` | App | "Create a new lab"; auto-open when user has no labs |
| `signup.close()` | App (SignupShell Back) | Back |
| `signup.status()` / `onOpened` / `onClosed` | App | mount |
| `labs.list()` | App | signed in: immediately, every 20 s, after each connect/open/update/stop, ChooseLab "Try again" |
| `labs.heldElsewhere()` | App | labs view w/o lab: mount + window focus |
| `labs.focusHeld(id)` | App | opening a lab/local stack held by another window |
| `settings.get()` / `onChanged` | App, SettingsModal | mount |
| `settings.set(patch)` | App, SettingsModal | any toggle |
| `lastOpened.get(login)` | App | auto-open decision |
| `lastOpened.set(login, id)` | App | on `lab:opened` (non-local ids) |
| `ssh.listHosts()` | ConfigureForm | mount (non-managed) |
| `ssh.addHost({alias, hostName, user?, port?, identityFile?})` | ConfigureForm | save in "new host" mode |
| `connections.list()` | App | mount, after mutations |
| `connections.upsert(conn)` | App | save, remove (managed soft-dismiss), auto-claim, auto-add managed, labUrl write-back |
| `connections.remove(id)` | App | Remove (non-managed) |
| `connections.onChanged` | — | not subscribed |
| `lab.status(baseUrl)` | App | reachability probe, every 20 s |
| `lab.test(sshTarget)` | ConfigureForm | Add (SSH) |
| `lab.hostKey.scan(ssh)` | HostKeyPanel | mount when kind unknown |
| `lab.hostKey.accept(ssh)` | HostKeyPanel, ConfigureForm | accept |
| `lab.open(conn, {reachTimeoutMs})` | App.openRunning | open a live lab |
| `lab.connect(conn, verbose, opts?)` | App.connect | open non-live lab; tunnel; retry; after add; local |
| `lab.update(conn, {preview})` | App.updateLab | out-of-date open; "Update Lab" |
| `lab.cancel(id)` | App.cancelOpening | "Open a different lab" during progress / host-key Cancel |
| `lab.down(conn)` | App.stopLab | "Stop Lab" |
| `lab.onOutput` / `lab.onPhase` | App | mount |
| `update.getState()` / `onState` | useSelfUpdate (UpdateReadyFoot, RailVersion, UpdateFooter) | mount |
| `update.install()` | RestartFoot | "Restart to update" |
| `labView.hide()` | App | leaving loading lab, rail nav while lab open, LabStatePanel Back, cancelled open arriving |
| `labView.goBack()` / `goForward()` | TitlebarStrip | buttons |
| `labView.onNavState` | App, ViewerShell | mount |
| `labView.onOpened` / `onState` / `onViewVis` | App | mount |
| `viewer.retry(deployment?)` | ViewerShell | recovery buttons |
| `viewer.onRecovery` / `onTitle` / `onContentReady` | ViewerShell | mount |

---

## 6. Forms and validation rules

**ConfigureForm**
- Save enabled iff not testing AND (`noSsh` OR (mode pick ⇒ `form.ssh.host.trim()` non-empty) OR (mode new ⇒ `newHost.hostName.trim()` non-empty)). Name is never required.
- Port: free text with numeric keyboard hint; converted via `Number(port)` only when non-empty. **No range/NaN validation** (Observed).
- Name on save: noSsh → `name.trim() || deploymentId`; SSH → `name.trim() || deploymentId || ssh.host || ""`. Note the saved `name` is trimmed but other fields (deploymentId, labUrl) are passed through.
- New host alias: `"silico-" + slug`, slug = (deploymentId || hostName) lowercased, runs of non `[a-z0-9]` → `-`, leading/trailing `-` stripped; empty slug → `host`. The new host is written to SSH config via `ssh.addHost` before saving; the saved connection gets `ssh = {host: alias}`.
- Flow for adding an SSH lab: `lab.test(target)` → store result → if ok save. If the test result has `hostKey === "unknown"`, the button becomes "Accept host key & add": accept → re-test → save if ok. Edits skip testing entirely.
- Test target: pick mode `{host: ssh.host.trim()}`; new mode `{host, user?, port?, identityFile?}` (trimmed, empties → undefined).
- Save errors (e.g., addHost throwing) shown as warn hint.
- App `save(draft)` stamps `owner = draft.owner ?? login` and `gatewayUrl = draft.gatewayUrl ?? (managed ? auth.gatewayUrl : undefined)`, upserts, closes edit, reloads, returns saved row. Add path then: set `justAdded`, for managed/local set `lab` loading, close wizard, `openingId = saved.id`, `connect(saved)`.

**buildLocalDevDraft** throws `invalid local Lab port: <port>` unless integer 1..65535; default name `Local dev (:<port>)`; icon `cpu`; deploymentId `goodfire-local`; labUrl `http://localhost:<port>`; routeMode `local`.

**Remove**: managed rows with deploymentId are soft-dismissed (`dismissed: true`) so auto-add doesn't recreate them; others hard-removed. No confirmation dialog.

**SignIn**: no input fields. Single-flight guard; forced retry with 2.5 s cooldown.

---

## 7. Evidence ledger

### Observed (direct reading)
- Root selection by hash: 23161–23175.
- App state + effects: 19399–20308; render tree 20309–21385.
- Pure helpers: 17732–17852 (`isVisibleTo` 17744, `localStackName` 17761, `buildLocalDevDraft` 17770, `labRecoveryCopy` 17788, `openReachBudgetMs` 17815, `labUpdateFlags` 17821, `DEFAULT_NOTIFICATIONS` 17837, `signOutThenClose` 17845, `isStaging` 17850).
- Icon map 19242–19266; `nextUnusedIcon` 19288; `EMPTY` 19296; `RUNNING` 19303; `PHASE_LABEL` 19316; `PHASE_STATUS` 19335; `forbiddenMessage` 19349; `fmtElapsed` 19353; `shapeLog` 19366; `labBaseUrl` 19391; `shortSha` 19396.
- Components: LabStatePanel 21387, OverflowMenu 21439, ProgressPanel 21524, HostKeyPanel 21572, ChooseLab 21659, AddWizard 21856, ConfigureForm 21903, SignIn 22427, SignupShell 22554, ToggleRow 22584, usePersistenceStatus 22612, KeyringNotice 22625, useSelfUpdate 22634, RestartFoot 22649, UpdateReadyFoot 22670, RailVersion 22676, UpdateFooter 22683, SettingsView 22699, TitlebarStrip 22934, ViewerShell 22972, SettingsModal 23057.
- Only keyboard handling: Escape in SettingsView (22717–22723). No other shortcuts in the renderer (menu accelerators, if any, live in main).
- No localStorage/sessionStorage usage.
- Timers: discovery 20 s (19594), reach probe 20 s (19837), local stacks 3 s (19969), elapsed 1 s (19845), launch gate 6 s (19521), justAdded clear 1.5 s (19985), sign-in cooldown 2.5 s (22459). Reach budgets 3 s / 90 s (17813).
- `app:navigate` payloads from main: `connections`, `settings:notifications|developer|profile` (main:7241, 7378, 7492–7498, 7522–7532).

### Inferred
- Lab content is a native view (WebContentsView/BrowserView) layered by main over `div.labcover`; the renderer draws chrome/cover only.
- `SignupShell` header sits above a main-managed signup web view.
- `lab:viewvis` `{shown, title}` signals the cover should show even before `lab` state is set (e.g., view restored).
- `setCompact(true, h)` resizes the main window to a compact picker of height `h`.

### Unknowns
- Full shape of `labs.list()` failure replies beyond `ok`/`needsAuth`; shape of `ConnectOutcome` besides fields read (`status`, `message`, `login`, `host`, `kind`, `labUrl`).
- Exact values of `labView.onState` `reason` besides `still-waking`.
- `update` state phases other than `downloaded`.
- `auth.persistence()` values other than `"none-no-keyring"`.
- Why the initial-window "retire" path calls `lastOpened.get` and discards the result (side effect in main?).
- Whether main hides the lab view on `app:navigate` (renderer only clears its state).
- `HostKeyPanel` kinds other than `unknown`/`changed` (would show "Fetching…" indefinitely).
- `ConfigureForm` for a `local` draft would call `lab.test` with empty host (unreachable in observed flows).
- `routeMode` values besides `managed`/`local` (SSH clusters presumably `undefined` or another string).

### Carbon icons used (and where)
| Icon | Where |
|---|---|
| Add | "New lab" trigger |
| ArrowLeft | SignupShell Back; TitlebarStrip Back |
| ArrowRight | TitlebarStrip Forward |
| BareMetalServer | discovered-lab rows (empty state, ChooseLab) |
| ChevronDown | icon picker caret |
| ChevronLeft | back links (ChooseLab, ConfigureForm, SettingsView) |
| ChevronRight | ChooseLab row chevron |
| Close | SettingsModal close |
| Code | "Developer settings" nav item |
| Laptop | Local dev stack rows |
| Notification | "Notifications" nav item |
| OverflowMenuHorizontal | default OverflowMenu trigger (row ⋯) |
| Renew | LabStatePanel icon |
| User | "Profile" nav item |
| WarningAltFilled | Opening failure icon; ConfigureForm test error |
| WarningFilled | Host key changed |
| Chemistry | "Labs" nav item; also connection icon `flask` |
| Connection icon set | flask→Chemistry, microscope→Microscope, testtube→ChemistryReference, brain→Cognitive, bot→Bot, heartbeat→HealthCross, pulse→Activity, cpu→Chip, sparkle→AiGenerate, planet→Globe, rocket→Rocket, star→Star, sun→Sun, tree→Tree, sprout→Sprout, bee→Bee, mountains→Mountain, lightning→Lightning, snowflake→Snowflake, drop→RainDrop, fire→Fire (order matters for `nextUnusedIcon`) |

Non-Carbon image: `goodfire-icon-*.png` (logo in gate, opening screens, brand, cover, signup, viewer).

---

## 8. Reimplementation notes

### Suggested file breakdown
```
src/renderer/
  main.tsx                       // hash → <SettingsModal|ViewerShell|App>, data-platform
  types.ts                       // §3 types
  lib/
    visibility.ts                // isManaged, isLocal, inEnvironment, isVisibleTo, managedRowId
    localDev.ts                  // localStackName, buildLocalDevDraft, LOCAL_DEV_DEPLOYMENT_ID
    copy.ts                      // labRecoveryCopy, phaseStatus, PHASE_LABEL, forbiddenMessage, messages
    update.ts                    // labUpdateFlags, isFullSha, versionLines, shortSha
    urls.ts                      // labBaseUrl, openReachBudgetMs, isStaging
    log.ts                       // shapeLog, fmtElapsed
    icons.ts                     // CONN_ICONS, nextUnusedIcon
    sshAlias.ts                  // alias slug builder
  hooks/
    useAuth.ts, useSettings.ts, useSelfUpdate.ts, usePersistenceStatus.ts
    useDiscovery.ts              // labs.list polling + discoveryStatus
    useReachability.ts           // lab.status polling
    useLabEvents.ts              // labView.* + lab.onOutput/onPhase subscriptions
    useConnectFlows.ts           // connect/openRunning/updateLab/stopLab/cancel
    useAutoOpen.ts               // launch gate + auto-open decision
    useCompactWindow.ts          // setCompact + ResizeObserver
  components/
    App.tsx, PickerShell.tsx, FullShell.tsx, LabsList.tsx, LabsEmpty.tsx, LabRow.tsx,
    LocalStacksSection.tsx, LabActionsMenu.tsx, OverflowMenu.tsx, OpeningScreen.tsx,
    LabLoadingScreen.tsx, LaunchGate.tsx, LabCover.tsx, LabStatePanel.tsx,
    ProgressPanel.tsx, HostKeyPanel.tsx, AddWizard.tsx, ChooseLab.tsx,
    EmptyLabDiscoveryMessage.tsx, ConfigureForm.tsx, SignIn.tsx, SignupShell.tsx,
    SettingsView.tsx, ToggleRow.tsx, KeyringNotice.tsx, UpdateFoot.tsx,
    TitlebarStrip.tsx, ViewerShell.tsx, SettingsModal.tsx, ConnIcon.tsx, Avatar.tsx
```
Keep a single source of truth for App state (a reducer is a good fit); the original's many booleans have ordering-sensitive precedence (§3), so encode the precedence in one `selectScreen(state)` pure function and unit-test it.

### Hook subscription pattern
Every `window.silico.*.onX(cb)` returns an unsubscribe; use it directly as the effect cleanup. StrictMode double-mount must be safe (all effects are idempotent in the original).

### Pure functions to unit-test (with cases)

- `isVisibleTo(c, login, gw, discovery, byDeployment)`
  - dismissed → false.
  - `c.gatewayUrl="A"`, gw `"B"` → false.
  - no gatewayUrl, deploymentId "x", discovery ok, byDeployment has x, owner undefined → true.
  - same but discovery "loading" → false.
  - no gatewayUrl, deploymentId "x", discovery "unavailable", owner = login → true; owner = other → false.
  - gatewayUrl = gw, owner = login, deploymentId not discovered → true (owner rule wins once env matches).
  - no deploymentId, no owner → true (vouched).
- `localStackName({branch, worktree, project})`
  - `{branch:"feat/x", project:"p"}` → `"x"`; `{branch:"main", worktree:"wt"}` → `"wt"`; `{branch:"HEAD", project:"silico-local-foo"}` → `"local foo"`; `{branch:" ", worktree:"", project:"bar"}` → `"bar"`.
- `buildLocalDevDraft({name:"", port:5173})` → name `"Local dev (:5173)"`, labUrl `http://localhost:5173`, icon `cpu`, routeMode `local`, deploymentId `goodfire-local`; port 0 / 70000 / 1.5 → throws `invalid local Lab port: …`.
- `labRecoveryCopy` — three branches above.
- `openReachBudgetMs("reachable")` → 3000; `"unreachable"`/undefined → 90000.
- `labUpdateFlags`
  - undefined → all false.
  - `{updateRequired:true}` → required, any.
  - `{updateAvailable:true}` → soft, any.
  - `{reportsVersion:false}` → soft.
  - `{stale:true, updateRequired:true}` → all false (stale ignores server flags) unless off-pin.
  - full 40-hex cur ≠ tgt with `pinnedExactCheck:true` → soft (even when stale); case-insensitive equality → not off-pin; short shas → not off-pin.
- `versionLines(managed, skipVersionCheck||staging, live, sha, outOfDate, targetSha)` (20957):
  - managed → none.
  - skip/staging: live && sha → `["Version · abc1234"]` else none.
  - outOfDate → `["Current version · <7>"]` (if sha) + `"Update available · <7>"` or `"Update available"`.
  - live && sha → `["Up to date · <7>"]`.
- `labBaseUrl("h", 443)` → `https://h`; `("x.silico.run", 8443)` → `https://x.silico.run:8443`; `("10.0.0.1", 8000)` → `http://10.0.0.1:8000`.
- `fmtElapsed(0)` → `"0:00"`; `65_400` → `"1:05"`; negative → `"0:00"`.
- `shapeLog`
  - drops lines matching `INFO [httpx] HTTP Request:`.
  - lines with leading `YYYY-MM-DD HH:MM:SS ` timestamp are de-duplicated by the message after the timestamp: a later identical message replaces the earlier line in place.
  - all lines starting with `Lab is booting...` collapse into one (latest wins, original position).
  - other lines kept verbatim.
- `nextUnusedIcon([])` → `"flask"`; with flask used → `"microscope"`; rows with unknown icon count as `flask`; all used → `"flask"`.
- `phaseStatus(undefined)` → `"Connecting to your lab…"`; `"tunneling"` → `"Connecting to your lab…"` (not in map).
- `forbiddenMessage("alice")` / `forbiddenMessage(undefined)`.
- SSH alias: deploymentId `"My Cluster_01"` → `silico-my-cluster-01`; deploymentId `""`, hostName `"--"` → `silico-host`.
- `discoveryStatus(auth, loaded, source)` → loading/ok/unavailable as in §4.5.
- `developerSettingsVisible(auth, settings)` (App) vs modal variant (adds `tab==="developer"`).
- Open decision `chooseOpenAction({skipVersionCheck, managed, flags, live, reachable})` → `"update" | "open" | "connect"` (§4.7 step 8).
- Outcome → phase mapping (`opened`/`canceled` → `done`) and whether logs auto-expand.

### Behavioral details worth preserving
- Click on a row ignores clicks inside `button` or `.ov` (menu) — use `closest()`.
- `p.opening__phase` keyed by its text so a transition replays.
- OverflowMenu supports controlled `open` (row menus, so right-click can open them).
- In the opening failure state, "Open a different lab" only clears `openingId` (no cancel), whereas during progress it cancels.
- Sign-out paths differ: App.signOut (forbidden/ChooseLab) resets auth/discovery/conn/lab locally; settings "Switch account" only calls main and navigates back to labs.
