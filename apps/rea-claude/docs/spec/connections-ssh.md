# Spec: Connections model and SSH (Silico desktop v0.137.0)

Clean-room behavioral spec. Line numbers refer to the prettified sources under
`$SC/pretty/` (`main.js` unless noted; `R:` = `renderer.js`, `P:` = `preload-index.js`).

---

## 1. Overview

A **Connection** (UI name: "Lab") is a small JSON record that the renderer creates and edits and the
main process stores **without validating it** in `<userData>/connections.json`. There are three
routing modes (`routeMode`):

| routeMode | Meaning | Uses SSH? | Persisted? |
|---|---|---|---|
| `"managed"` | Goodfire-hosted Lab, reached over public HTTPS | no (`ssh: undefined`) | yes |
| `"cluster"` (also the default when `routeMode` is missing) | Self-hosted Lab on an HPC/cluster login node, reached over SSH | yes (`ssh.host` required) | yes |
| `"local"` | Local docker dev stack at `http://localhost:<port>` (dev builds and staging only) | no | **no**: kept only in renderer state |

The SSH part covers:
- Reading `~/.ssh/config` for a host picker (`ssh:listHosts`). This is a very small line parser
  with **no Include support**.
- Appending a new `Host` block to `~/.ssh/config` (`ssh:addHost`).
- Picking a private key file (`dialog:pickFile`).
- Checking a host: running `ssh` in BatchMode with `command -v silico…` and classifying the error (`lab:test`).
- Host-key trust on first use: running `ssh -G`, `ssh-keyscan -H` and `ssh-keygen -lf -`, then
  appending to `~/.ssh/known_hosts` (`lab:hostKey:scan` and `lab:hostKey:accept`).

All `ssh*` binaries are spawned directly (no shell) through one resolver that caches the binary
path and falls back to the Windows built-in OpenSSH path. Before the first spawn, the main process
imports `PATH` and `SSH_AUTH_SOCK` from the user's login shell. The app sets no ControlMaster,
ControlPath, StrictHostKeyChecking or UserKnownHostsFile options.

---

## 2. IPC contract

Every channel below is registered with `y(channel, fn)` (`ipcMain.handle`) and rejects with
`Error("Blocked '<channel>': untrusted sender.")` unless the sender frame URL is `file:` or matches
the origin of `ELECTRON_RENDERER_URL` (main.js 6418-6437). The renderer reaches them through
`window.silico` (P:11, 79-101).

| Channel | Dir | Args | Returns | Behavior | Errors |
|---|---|---|---|---|---|
| `connections:list` | R→M invoke | none | `Connection[]` | Reads the store file (§3). A missing file gives `[]`. A file without a `connections` array gives `[]`. | Rejects on a JSON parse error or any read error other than ENOENT. |
| `connections:upsert` | R→M invoke | `conn: Partial<Connection>` (any object) | `Connection` (the stored object, with `id`) | Serialized via a mutex. `id = conn.id ?? crypto.randomUUID()`. If an existing record has that id, it is **replaced wholesale** with `{...conn, id}` (no field merge); otherwise the record is appended. The file is rewritten atomically. | Same read errors as list; write or rename errors. No validation. |
| `connections:remove` | R→M invoke | `id: string` | `void` | Serialized. Filters out every record with that id and rewrites the file. A missing id is a no-op that still rewrites. | Read and write errors. |
| `connections:changed` | M→R event (`webContents.send`, no payload) | none | none | Sent **only** after the signup flow adopts a new managed Lab, and only to the signup's parent window (5340). It is **not** sent by upsert or remove. Preload exposes `connections.onChanged(cb) → unsubscribe` (P:87-92), but the bundled renderer never subscribes. | n/a |
| `ssh:listHosts` | R→M invoke | none | `SshHostEntry[]` | Parses `~/.ssh/config` (§4.4). | Never rejects: any error gives `[]`. |
| `ssh:addHost` | R→M invoke | `AddHostInput` | `void` | Validates, checks for a duplicate alias, then appends a Host block (§4.5). | Throws `Error` with the exact messages in §4.5. |
| `dialog:pickFile` | R→M invoke (`window.silico.pickSshKey()`) | none | `string \| null` | Native open dialog (§4.6). | n/a |
| `lab:test` | R→M invoke | `SshTarget` | `TestResult` | §4.7. | Can reject only on unexpected spawn errors (not ENOENT). |
| `lab:hostKey:scan` | R→M invoke | `SshTarget` | `HostKeyScanResult` | §4.8. | Normally resolves `{ok:false,error}`. |
| `lab:hostKey:accept` | R→M invoke | `SshTarget` | `{ok:true} \| {ok:false; error:string}` | §4.9. | Rejects if mkdir or appendFile of known_hosts throws (not caught). |

```ts
// Shapes passed over IPC
interface SshTarget {            // main.js 768-780 reads exactly these
  host: string;                  // ssh alias or hostname; empty => "No SSH host"
  user?: string;
  port?: number;
  identityFile?: string;
  jump?: string;                 // ProxyJump spec; read by main, never set by the bundled renderer
}
interface SshHostEntry { alias: string; hostName?: string; user?: string; identityFile?: string; port?: number }
interface AddHostInput { alias: string; hostName?: string; user?: string; port?: number | string; identityFile?: string }
type TestResult =
  | { ok: true;  detail: string }
  | { ok: false; detail: string; hostKey?: "changed" | "unknown" };
type HostKeyScanResult =
  | { ok: true; host: string /* "h" or "h:port" */; keyType: string /* upper-case */; fingerprint: string /* "SHA256:..." */ }
  | { ok: false; error: string };
```

---

## 3. Data model and persistence

```ts
type RouteMode = "managed" | "cluster" | "local";   // Ms(): anything other than managed/local => "cluster" (main 22-24)

interface Connection {
  id: string;              // randomUUID() if absent on upsert; managed rows use
                           //   `managed:${login}:${deploymentId}:${gatewayUrl}` (main 34-36, R:17741-17743)
                           //   local rows use `local:${project}` (R:20409, never persisted)
  name: string;            // display name; defaults to deploymentId, then ssh.host (R:22019)
  icon: string;            // a key of CONN_ICONS, default "flask" (R:19242-19266)
  deploymentId: string;    // "" if unknown; local => "goodfire-local"
  labUrl: string;          // "https://<labPublicHost>" or "" ; local => "http://localhost:<port>"
  routeMode?: RouteMode;   // copied from discovery; absent => treated as cluster
  ssh?: { host: string; user?: string; port?: number; identityFile?: string; jump?: string };
                           // cluster: usually just { host: <ssh alias> }; managed/local: undefined
  owner?: string;          // GitHub login that owns the row (stamped by renderer save/claim)
  gatewayUrl?: string;     // environment stamp, e.g. "https://my.silico.run" or "https://my-staging.silico.run"
  dismissed?: boolean;     // managed rows are "removed" by setting this rather than deleting
}

interface ConnectionsFile { version: 1; connections: Connection[] }
```

- Location: `path.join(app.getPath("userData"), "connections.json")` (main 164-166).
- Format: `JSON.stringify({version:1, connections}, null, 2)`, UTF-8 (main 181-185).
- Write strategy: `mkdir -p userData`, write `connections.json.tmp`, then `rename` over the target
  (atomic replace). No file mode is passed (default `0o666 & ~umask`). No fsync. (main 177-187)
- Concurrency: upsert and remove go through a promise-chain mutex `on()` (main 151-162, 188). A failed
  task does not break the chain. `list` is not serialized.
- Migrations: **none**. `version` is written but never read back (main 167-176).
- Validation: **none** in main. All invariants are enforced by the renderer.
- Renderer draft defaults: `EMPTY = {name:"", icon:"flask", deploymentId:"", labUrl:"", ssh:{host:"",user:""}}` (R:19296-19302).
- Removal (R:20274-20282): a managed row with a `deploymentId` is soft-deleted with `upsert({...c, dismissed:true})`; any other row is removed with `connections.remove(id)`.
- Visibility filter (R:17744-17756): hide the row if it is dismissed, or if `gatewayUrl` is set and differs from the active gateway. Owner-stamped rows are visible only to that login. Unstamped rows need discovery to vouch for their `deploymentId`.
- Renderer also writes back `labUrl` after a successful connect, update or open (R:20033-20039, 20183-20189) and stamps `owner` and `gatewayUrl` on save and on the "claim" pass (R:19849-19880, 20284-20294).

Other files written by this area:

| File | Op | Mode | Backup |
|---|---|---|---|
| `~/.ssh/` | `mkdir -p` | `0o700` (448), applies only on creation | n/a |
| `~/.ssh/config` | `appendFile` | `0o600` (384), applies only on creation | **none** |
| `~/.ssh/known_hosts` | `appendFile` | `0o644` (420), applies only on creation | **none** |

---

## 4. Flows

### 4.1 Process environment bootstrap (`Co()`, main 647-697)
Memoized once per process. It runs before every `zt` / `q` spawn.
1. On `win32`, do nothing.
2. Pick the shell: `$SHELL`, else `os.userInfo().shell`, else `/bin/bash`.
3. Build argv: `["-c", script]` if the shell basename is `csh` or `tcsh`, else `["-ilc", script]`. The script is
   `printf %s __SILICO_SHELL_ENV__; env; printf %s __SILICO_SHELL_ENV__`. stdin and stderr are ignored.
4. Kill with SIGKILL after **5000 ms** (`ya`). On close, error or timeout, parse the stdout between the first and
   last marker as `KEY=VALUE` lines (a key must match `^[A-Za-z_][A-Za-z0-9_]*$`, split at the first `=`).
5. If `SSH_AUTH_SOCK` was captured, overwrite `process.env.SSH_AUTH_SOCK`. If `PATH` was captured, set
   `process.env.PATH = shellPATH + ":" + oldPATH`, removing duplicates and empty entries while keeping the first occurrence.

### 4.2 Binary resolution (`Io`, main 717-745)
1. Spawn `cache[tool] ?? tool` with `child_process.spawn(cmd, args)` (no options, so the child inherits `process.env`).
2. On `spawn`, cache `tool → cmd` and resolve with the ChildProcess.
3. On `error`:
   - If the code is not ENOENT, drop the cache entry and reject.
   - If it is ENOENT, record the failed cmd. If the platform is `win32` and `SystemRoot` is set, try
     `%SystemRoot%\System32\OpenSSH\<tool>.exe` next. Otherwise reject with a `ToolMissing` error whose message is:
     - base: ``The OpenSSH client isn't installed on this machine (couldn't find `<tool>`). Silico uses it to connect to clusters.``
     - plus on win32: ` To install it, open Windows Settings → System → Optional features and add "OpenSSH Client", then try again.`
     - plus elsewhere: ` Install OpenSSH with your system's package manager, then try again.`
4. Callers (`zt`, `q`) turn `ToolMissing` into the result `{code:255, stdout:"", stderr:<message>, toolMissing:true}` (main 746-748).

### 4.3 Running a remote command (`q(ssh, cmd, onChunk?, onSpawn?, abortSignal?)`, main 784-811)
1. Await `Co()`. If already aborted, return `{code:null, stdout:"", stderr:""}`.
2. Spawn `ssh` with argv from `sshArgs(target)` (§5) followed by `[dest, cmd]`.
3. If the signal aborted during the spawn, SIGTERM the child and return `{code:null, ...}`.
4. Otherwise, collect stdout and stderr (streaming each chunk to `onChunk(text, "stdout"|"stderr")`) and resolve `{code, stdout, stderr}` on `close`.
   The only time limit is ssh's own `ConnectTimeout=10`; the app sets no timer of its own.

### 4.4 `ssh:listHosts` (main 4896-4935)
1. Read `path.join(os.homedir(), ".ssh", "config")`. Any error (missing file included) gives `[]`.
2. For each line split on `\n`: trim it. Skip it if it is empty or starts with `#`.
3. keyword = the text up to the first whitespace, lower-cased. value = the rest, trimmed (quotes are **not**
   stripped and inline comments are not removed). The `key=value` form is **not** supported.
4. If keyword is `host`, split the value on whitespace and take the **first** token that contains none of `*`, `?` or `!`.
   If there is one, start a new entry `{alias: token}` and push it. Otherwise set the current entry to `null`, so options
   up to the next `Host` line are ignored.
5. Any other keyword, while a current entry exists:
   - `hostname` → `hostName`
   - `user` → `user`
   - `identityfile` → `identityFile`
   - `port` → `Number(v) || undefined`
   - anything else is ignored. A later repeat **overwrites** the earlier value (ssh itself is first-wins).
6. Not handled:
   - `Include` is ignored, so hosts in included files are not listed.
   - `Match` is not a block boundary, so options after a `Match` line are attached to the previous Host entry.
   - Duplicate aliases produce duplicate entries.
7. The renderer sorts entries case-insensitively by alias. A search box appears when there are more than 5 options; it filters by alias or hostName substring (R:21973-21991).

### 4.5 `ssh:addHost` (main 4936-4975)
Validation runs in this order. Errors are thrown with these exact strings:
1. alias: trim it. If it contains a control character (`[\x00-\x1f\x7f]`) or any whitespace, throw `The alias must not contain spaces or control characters.`
   If it is empty, throw `An alias is required.`
2. hostName (`?? ""`): same check, with label `hostname / IP`, so the message is `The hostname / IP must not contain spaces or control characters.`
   If it is empty, throw `A hostname / IP is required.`
3. user (`?? ""`): same check, with label `user`. Empty is allowed.
4. identityFile: trim it (`?? ""`). Only control characters are rejected: `The identity file path must not contain control characters.`
   **Spaces are allowed and are written unquoted** (latent bug).
5. port: if present, `Number(port)` must be an integer from 1 to 65535. Otherwise throw `The port must be a whole number between 1 and 65535.`
6. Duplicate check: if `listHosts()` has an entry whose `alias` exactly matches (case-sensitive), throw ``An SSH host "<alias>" already exists in ~/.ssh/config.``
7. Run `mkdir -p ~/.ssh` with mode 0o700.
8. Append to `~/.ssh/config` (mode 0o600 if the file is created). The text is a leading `\n`, the lines joined by `\n`, and a trailing `\n`:
   ```
   Host <alias>
       HostName <hostName>
       User <user>                 (only if non-empty)
       Port <port>                 (only if set)
       IdentityFile <identityFile> (only if non-empty)
   ```
   Indentation is 4 spaces. No backup copy is made, nothing is written atomically, and there is no file lock.
9. Renderer alias generation (R:22004-22017): take `deploymentId || hostName`, lower-case it, replace runs of `[^a-z0-9]` with `-`,
   and trim `-` from both ends. The alias is `silico-<slug>`, or `silico-host` if the slug is empty. The saved connection gets `ssh = {host: alias}` only.

### 4.6 `dialog:pickFile` (main 6556-6564)
`dialog.showOpenDialog` is called with **no parent window** and these options: `title: "Select SSH private key"`, `defaultPath: ~/.ssh` if it exists (else the home directory),
`properties: ["openFile","showHiddenFiles"]`, and no filters. It returns the first path, or `null` on cancel or an empty selection.

### 4.7 `lab:test` (main 4166-4199)
1. If `!target.host`, return `{ok:false, detail:"No SSH host configured."}`.
2. `staging = St(await gatewayUrl())`, which is true when the active gateway is `https://my-staging.silico.run` (main 1712-1717, 238-240).
3. Remote command, wrapped by `wt` with the `PATH="$PATH:$HOME/.local/bin" ` prefix:
   - if staging: `command -v silico-dev >/dev/null 2>&1`
   - otherwise: `command -v silico >/dev/null 2>&1 || command -v silico-setup >/dev/null 2>&1`
4. Run it with `q(target, cmd)` (§4.3).
5. On exit 0, return `{ok:true, detail:"SSH OK: <silico|silico-dev> present on the cluster."}`.
6. On exit 255, classify the host key (`gi`):
   - The lower-cased stderr contains `remote host identification has changed`:
     `{ok:false, hostKey:"changed", detail:"The host key for <host> has CHANGED since it was last trusted. Possible security issue; investigate before connecting."}`
   - It contains `host key verification failed`:
     `{ok:false, hostKey:"unknown", detail:"First time connecting to <host>. Trust its host key to continue."}`
   - Otherwise `{ok:false, detail: classifySshError(result)}` (§8).
7. Any other code (including `null`):
   - staging: `{ok:false, detail:"The dev CLI (silico-dev) isn't installed on this cluster. On its login node, update the Silico CLI, then run \`silico-dev setup\`."}`
   - otherwise: `{ok:false, detail:"Connected, but the silico CLI was not found on the cluster."}`
8. No retries.

Renderer use (ConfigureForm, R:21898-22050). The primary button runs one of these:
- edit or managed: `handleSave()`;
- the last test returned `hostKey==="unknown"`: `acceptKeyAndSave()`, which calls hostKey.accept, re-tests, and saves on success;
- otherwise: `testAndSave()`, which saves only when `ok`.

Labels: `Verifying SSH…`, `Save`, `Add`, `Accept host key & add`. In "pick" mode the test target is
`{host: alias}`. In "new" mode it is the raw `{host: hostName, user, port, identityFile}`, so the test runs **before** the
config block is appended.

### 4.8 `lab:hostKey:scan` (main 847-913)
1. If `!target.host`, return `{ok:false, error:"No SSH host."}`.
2. Resolve with `resolveViaSshG(target)`. The defaults are `host=target.host`, `port=target.port ?? 22` and `proxyJump=!!target.jump`.
   Run `ssh -G <target.host>` (only the host, with no `-p` or `-l`). On exit 0, for each output line split it into a keyword and the rest:
   - `hostname <v>` sets host;
   - `port <v>` sets port to `Number(v) || port`;
   - `proxyjump <v>` with v ≠ `none` (case-insensitive) sets proxyJump = true.
   Failures are ignored.
   *Inferred quirk:* `ssh -G` always prints `port`, so an explicit `target.port` that is not in ssh_config is overridden (normally to 22).
3. If proxyJump: ``{ok:false, error:"<target.host> is reached through a jump host; automatic key fetch isn't supported yet. Run `ssh <target.host>` once to accept it."}``
4. Run `ssh-keyscan -H -p <port> <host>`. Spawn errors are swallowed and treated as null. If the tool is missing, return `{ok:false, error:<missing msg>}`.
   If the trimmed stdout is empty, return `{ok:false, error:"Couldn't reach <host> to read its host key. Check the host and your network / VPN."}`.
   The exit code is ignored. No `-T` timeout is passed, so keyscan's own default applies.
5. Run `ssh-keygen -lf -` with stdin = the scanned lines followed by `\n`. A missing tool gives an error as in step 4.
6. Parse each stdout line with `/\b(SHA256:[A-Za-z0-9+/=]+)\b.*\(([A-Za-z0-9]+)\)\s*$/` → `{fingerprint, keyType: upper}`.
   Sort by preference `ED25519 < ECDSA < RSA < others (99)` and take the first.
7. Return `{ok:true, host: port===22 ? host : "host:port", keyType, fingerprint}`, or
   `{ok:false, error:"Could not read the host key fingerprint."}`.
8. The UI shows "First time connecting to <ssh.host>", then "Fetching the host key…", then `<keyType> · <fingerprint>` and an "Accept & connect" button (R:21571-21647).
   It only scans when kind === "unknown". For "changed" it shows a warning and the command hint `ssh-keygen -R <host>`, and offers no accept button.

### 4.9 `lab:hostKey:accept` (main 914-944)
1. If `!target.host`, return `{ok:false, error:"No SSH host."}`.
2. Resolve as in §4.8. If proxyJump, return `{ok:false, error:"Jump-host key fetch is not supported yet."}`.
3. **Re-run** `ssh-keyscan -H -p <port> <host>`. A missing tool gives the missing-tool error. Empty output gives `{ok:false, error:"Couldn't reach <host> to read its host key."}`.
4. `mkdir -p ~/.ssh` with mode 0o700. Read `~/.ssh/known_hosts`. If it is non-empty and does not end in `\n`, prefix the append with `\n`.
5. Append the trimmed keyscan stdout plus `\n`. That is **every** key type returned, hashed (`|1|…`). For a non-22 port, keyscan writes `[host]:port`.
   The mode is 0o644 if the file is created. No deduplication and no backup. Return `{ok:true}`.
6. The accept step does not check that the keys it writes match the fingerprint the user was shown. This is a TOCTOU gap: see §6.
7. Afterwards the renderer either re-runs `lab.test` (ConfigureForm) or `connect(c)` (HostKeyPanel `onAccepted`).

### 4.10 Connection CRUD from the renderer (summary)
- **Add, managed**: AddWizard builds a draft from discovery (`routeMode` copied, `ssh: undefined`, and `labUrl` set to `https://<labPublicHost>`).
  Save calls `upsert({...draft, owner: login, gatewayUrl})`. Managed rows with no match are also auto-added with a deterministic id (R:19883-19939).
- **Add, cluster**: Either pick an existing alias, or fill in the "Set up a new Lab" fields (login node, Username, Port with placeholder `22`, and SSH key "optional, uses your agent if blank" with a "Browse…" button).
  Then test (and accept the host key if needed), then call addHost if this is a new host, then `upsert`.
- **Edit**: the same form. Save skips the test.
- **Remove**: §3.

---

## 5. External commands

Common ssh option builder `sshArgs(t)` (`pi`, main 768-777), in this order:
```
-o BatchMode=yes -o ConnectTimeout=10 [-i <identityFile> -o IdentitiesOnly=yes] [-p <port>] [-J <jump>]
```
`dest = user ? "user@host" : host` (`Ro`, main 765-767).

| Purpose | argv | stdin | Parse |
|---|---|---|---|
| Login-shell env capture | `<shell> -ilc 'printf %s __SILICO_SHELL_ENV__; env; printf %s __SILICO_SHELL_ENV__'` (csh/tcsh use `-c`) | ignored | Text between the markers, as KEY=VALUE lines. 5 s SIGKILL. |
| Remote command (`lab:test` and the connect flow) | `ssh <sshArgs> <dest> <cmd>` | none | Exit code (0 / 255 / other) plus the stderr classifier. |
| Config resolution | `ssh -G <host>` | none | Keyword `hostname`, `port` or `proxyjump`, split on whitespace. |
| Host key fetch | `ssh-keyscan -H -p <port> <host>` | none | Trimmed stdout, used as-is. |
| Fingerprint | `ssh-keygen -lf -` | the keyscan output + `\n` | The SHA256 regex in §4.8. |
| Tunnel (cross-area) | `ssh <sshArgs> -N -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -L <localPort>:<labHost>:<labPort> <dest>` | none | Liveness is checked by a TCP connect to 127.0.0.1:localPort (main 3998-4031). |
| Manual-tunnel hint string (display only) | `ssh -N [-i f] [-p p] [-J j] -L <l>:<h>:<p> <dest>` joined with spaces | none | none |

- Environment: the child inherits `process.env`, with PATH and SSH_AUTH_SOCK updated as in §4.1. The app adds no other env.
- Not set anywhere in main.js: `ControlMaster`, `ControlPath`, `StrictHostKeyChecking`, `UserKnownHostsFile`, `-T`, `-tt`
  (grep returned no matches). StrictHostKeyChecking is therefore ssh's default (`ask`). With BatchMode, an unknown or changed key fails with exit 255 and "Host key verification failed."
- `zt` (local tool runner, main 749-764) collects stdout and stderr, writes stdin if given, and resolves on `close`. It has **no timeout**.

---

## 6. Security notes

- **TOCTOU on host-key trust**: `accept` rescans and writes whatever keys the network returns at that moment.
  It does not compare them with the fingerprint shown during `scan`. A reimplementation should pass the
  displayed fingerprint (or the exact scanned lines) to accept and verify them before writing.
- **Accept writes every key type**, not just the one displayed.
- The "changed" host key path never offers accept. The user is told to run `ssh-keygen -R`. Keep this behavior.
- `ssh:addHost` rejects whitespace and control characters in alias, host and user, which prevents ssh_config directive injection through those fields.
  `identityFile` rejects only control characters, so a path with spaces is written unquoted. ssh then reads it as multiple tokens and the IdentityFile line is broken or misparsed.
  Quote or reject such paths.
- Remote commands are fixed strings. `target.host` and `user` are separate argv entries (no shell), but a host that starts with `-` is
  not rejected by main. `listHosts` aliases come from the user's own config. Consider rejecting a leading `-` or inserting `--`.
- `BatchMode=yes` means passphrase-protected keys work only through ssh-agent. The app explains this in its "permission denied" message.
- The store has no file mode. connections.json holds no secrets (no tokens or keys, only paths and aliases).
- IPC sender check: the frame URL must be `file:` or the dev server origin (main 6418-6436).
- The app imports `SSH_AUTH_SOCK` from the login shell, so it uses whatever agent the shell sets up (for example 1Password or gpg-agent).

---

## 7. Evidence ledger

| # | Claim | Lines | O/I |
|---|---|---|---|
| 1 | IPC wrapper with sender check | main 6418-6437 | O |
| 2 | Channel registrations for this area | main 6556-6564, 6582-6584, 6598-6603 | O |
| 3 | Store path, read, atomic write, mutex | main 151-206 | O |
| 4 | Upsert replaces the record wholesale; id falls back to randomUUID | main 192-200 | O |
| 5 | `connections:changed` only sent from the signup adoption | main 5340 (only `send("connections:changed"` hit) | O |
| 6 | Renderer never subscribes to connections.onChanged | grep of `renderer.js` for `onChanged` gives only auth and settings (R:19538, 19589, 23067, 23071) | O |
| 7 | routeMode mapping and the managed id format | main 22-36, 2136-2152; R:17732-17743 | O |
| 8 | Managed adoption record shape (`ssh: undefined`, `dismissed: undefined`, `icon` "flask") | main 5318-5338 | O |
| 9 | Local rows are not persisted and use the `local:` id | R:17757-17784, 20070, 20402-20410 | O |
| 10 | Renderer EMPTY, icons, soft-delete, owner and gateway stamping | R:19242-19302, 20274-20294, 19849-19939 | O |
| 11 | Shell env capture and PATH / SSH_AUTH_SOCK import | main 631-697 | O |
| 12 | Binary resolver and the Windows OpenSSH fallback, with missing-tool messages | main 698-748 | O |
| 13 | sshArgs flags and dest form | main 765-783 | O |
| 14 | `q` remote runner, abort handling, no app timeout | main 784-811 | O |
| 15 | Error classifier strings and order | main 812-845 | O |
| 16 | `ssh -G` resolution | main 847-863 | O |
| 17 | `ssh -G` overrides an explicit port | main 848-858 plus OpenSSH behavior | I |
| 18 | keyscan, keygen, fingerprint regex, preference sort | main 864-913 | O |
| 19 | accept rescans and appends with mode 0o644; dir mode 0o700 | main 914-944 | O |
| 20 | ssh config parser | main 4896-4935 | O |
| 21 | addHost validation, text and mode 0o600 | main 4936-4975 | O |
| 22 | pickFile options | main 6556-6564 | O |
| 23 | lab:test commands and messages; `wt` PATH prefix; `no` message | main 4148-4199 | O |
| 24 | Host-key detection reused in connect (`test -f "$HOME/.silico/deployment.toml"`) | main 4696-4704 | O |
| 25 | ConfigureForm test, accept and save sequence, labels, alias slug | R:21898-22050, 22387-22413 | O |
| 26 | HostKeyPanel UI strings | R:21571-21647 | O |
| 27 | Tunnel argv and constants (retries 6, liveness 8000 ms, reset 60000 ms, backoff min(1000·2^n, 8000)) | main 3944-3947, 3998-4065 | O |
| 28 | No ControlMaster, ControlPath or StrictHostKeyChecking | grep of main.js: no matches | O |

**Unknowns**
- Original TS type names and whether `jump` was ever set by an older UI. In the bundled renderer `jump` is never written, though main reads it.
- Whether older `connections.json` versions existed. There is no migration code, so a reimplementation can treat the file as v1 only.
- The default ssh-keyscan timeout and the `ssh -G` port behavior come from the installed OpenSSH, not from the app.
- Whether multiple windows refresh after an upsert. They do not appear to, since the renderer reloads only its own list.

---

## 8. Reimplementation notes

Suggested modules (main process):
- `connections/store.ts`: `list()`, `upsert()`, `remove()`, an atomic JSON write, and the `serialize()` mutex. Keep the replace-not-merge semantics.
- `ssh/env.ts`: `captureLoginShellEnv()` (memoized) and the pure `parseEnvBlock(text, marker)`.
- `ssh/spawn.ts`: `resolveAndSpawn(tool, args)` with the cache and the pure `resolveFallback({tool, failed, platform, systemRoot})`. Also `runLocal(tool,args,stdin?)` and `runRemote(target, cmd, opts)`.
- `ssh/args.ts`: pure `sshArgs(target)` and `sshDest(target)`.
- `ssh/config.ts`: pure `parseSshConfig(text)` and `renderHostBlock(input)`, plus `validateAddHost(input)`.
- `ssh/classify.ts`: pure `classifyHostKey(stderr)` and `classifySshError({code,stderr,toolMissing})`.
- `ssh/hostkey.ts`: `resolveViaSshG`, `scan`, `accept`, the pure `parseSshG(stdout, defaults)` and `pickFingerprint(keygenStdout)`.
- `ipc/connections.ts`: wire up the channels.

Pure-function test cases (all derived from the code above):

`sshArgs`
- `{host:"h"}` → `["-o","BatchMode=yes","-o","ConnectTimeout=10"]`, dest `h`
- `{host:"h",user:"u",port:2222,identityFile:"/k",jump:"bast"}` → `[...base,"-i","/k","-o","IdentitiesOnly=yes","-p","2222","-J","bast"]`, dest `u@h`
- `{host:"h",port:0}` → no `-p` (the check is on truthiness)

`classifyHostKey(stderr)` (`gi`):
- `"@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed."` → `"changed"` (checked first)
- `"Host key verification failed.\r\n"` → `"unknown"`
- `"Permission denied (publickey)."` → `null`

`classifySshError(r)` (`hi`), checked in order:
1. `toolMissing` → return `r.stderr` verbatim.
2. `/host key verification failed|no matching host key/i` on stderr → the literal string `"host-key"`. Quirk: `lab:test` can surface `"host-key"` as its detail when stderr says "no matching host key type found".
3. Lower-cased stderr contains `permission denied` → `"SSH was refused (publickey). If your key has a passphrase, add it to your ssh-agent (\`ssh-add\`) or use a passphrase-less key — the app cannot prompt for one. Otherwise check the key registered with us matches your SSH config."`
4. Contains `timed out` → `"SSH timed out. Check the host and your network / VPN."`
5. Contains `could not resolve` or `name or service not known` → `"Could not resolve the SSH host. Check the host name."`
6. Contains `connection refused` → `"SSH connection refused. Check the host and port."`
7. Otherwise, the last 2 lines of the trimmed stderr; if that is empty, `` `ssh exited ${code}` ``.

- `{code:255, stderr:"ssh: connect to host x port 22: Operation timed out"}` → the timed-out message
- `{code:255, stderr:"ssh: Could not resolve hostname foo: nodename nor servname provided"}` → the resolve message
- `{code:255, stderr:""}` → `"ssh exited 255"`
- `{code:255, stderr:"a\nb\nc\n"}` → `"b\nc"`

`parseSshConfig(text)`
- `"Host *\n  User x\nHost a b\n  HostName 1.2.3.4\n  Port 2222\n  IdentityFile ~/.ssh/k\n"` → `[{alias:"a", hostName:"1.2.3.4", port:2222, identityFile:"~/.ssh/k"}]` (`b` is dropped and `Host *` is skipped)
- `"Host *.corp !x real\n User u"` → `[{alias:"real", user:"u"}]`
- `"# c\n\nHOST A\n\tHOSTNAME h"` → `[{alias:"A", hostName:"h"}]` (keyword is case-insensitive; the tab counts as whitespace)
- `"Host a\n Port abc"` → `[{alias:"a", port: undefined}]`
- `"Host a\n HostName=h"` → `[{alias:"a"}]` (the `=` form is unsupported)
- `"Include ~/.ssh/conf.d/*\nHost a"` → `[{alias:"a"}]` (Include is ignored)
- `"Host a\nMatch host b\n User z"` → `[{alias:"a", user:"z"}]` (Match is not a boundary)

`validateAddHost` / `renderHostBlock`
- `{alias:"silico-x", hostName:"login.c", user:"me", port:22, identityFile:"~/.ssh/id"}` → appended `"\nHost silico-x\n    HostName login.c\n    User me\n    Port 22\n    IdentityFile ~/.ssh/id\n"`
- `{alias:"a b", ...}` → throws `The alias must not contain spaces or control characters.`
- `{alias:"  ", hostName:"h"}` → throws `An alias is required.`
- `{alias:"a"}` → throws `A hostname / IP is required.`
- `{alias:"a", hostName:"h", port:"70000"}` → throws the port message. `port:"22"` is accepted (as the Number 22).
- The renderer alias slug: `deploymentId:"Goodfire Lab_1"` → `silico-goodfire-lab-1`; both empty → `silico-host`.

`parseSshG(stdout, {host:"a", port:22, proxyJump:false})`
- `"hostname 10.0.0.5\nport 2200\nproxyjump none\n"` → `{host:"10.0.0.5", port:2200, proxyJump:false}`
- `"proxyjump bastion\n"` → `proxyJump:true`

`pickFingerprint(stdout)`
- `"3072 SHA256:AAA= h (RSA)\n256 SHA256:BBB h (ED25519)\n256 SHA256:CCC h (ECDSA)"` → `{fingerprint:"SHA256:BBB", keyType:"ED25519"}`
- no matching lines → `undefined` (the caller returns "Could not read the host key fingerprint.")
- host display: `(h, 22)` → `"h"`; `(h, 2222)` → `"h:2222"`

`parseEnvBlock`
- `"junk__M__A=1\nB=x=y\n1BAD=2\nnoeq\n__M__tail"` → `{A:"1", B:"x=y"}`. If the second marker is missing, the result is `{}`.

`resolveFallback`
- `{tool:"ssh", failed:["ssh"], platform:"win32", systemRoot:"C:\\Windows"}` → spawn `C:\Windows\System32\OpenSSH\ssh.exe`
- `{tool:"ssh", failed:["ssh"], platform:"darwin"}` → missing, with the "…package manager…" message

Fix or keep decisions for a clean-room build (suggested):
- Keep the observable behavior.
- Fix the identityFile quoting and the accept TOCTOU (verify the fingerprint).
- Consider honoring an explicit `port` over the `ssh -G` output.
- Consider emitting `connections:changed` to all windows after every mutation.

---

## Cross-area notes
- `lab:connect` first runs `test -f "$HOME/.silico/deployment.toml"` over SSH and maps the result through the same classifiers.
  It returns `{status:"host-key", host, kind}`, or `{status:"error", message: classifySshError}` on exit 255 (main 4696-4704). The renderer then shows HostKeyPanel (R:20619-20635).
- SSH tunnel lifecycle, the remote `lab-host.txt` / `lab-port.txt` read and the dev-mode "Open via SSH tunnel" action belong to the Lab-connect area (main 3944-4140).
- `local:detectStacks` (`docker ps --filter name=silico-local-`, 5 s timeout) creates the non-persisted `local` connections (main 6461-6479, 125-150).
- Gateway and staging selection (`se()`, `St()`) belong to the auth and settings area. They only change which CLI `lab:test` probes for.
