"""Git operations for per-thread workspace provisioning.

Three-layer scheme on the Modal Volume:

1.  **Shared bare cache** at ``/vol/repo-cache/<host>/<org>/<repo>.git``.
    Created on first sighting of a URL via
    ``git clone --bare --filter=blob:none``. Partial clone skips blobs
    at clone time, so even large-repo cold clones are small.

2.  **Per-thread worktree** at ``/vol/workspaces/<thread_id>/``, created
    via ``git worktree add``. Shares ``.git/objects`` with the bare
    cache, so disk cost is O(files actually checked out), not
    O(repo-size × thread-count). Stable per thread_id keeps Claude
    Code's ``~/.claude/projects/<hash-of-cwd>/`` session continuity
    intact — ``claude --continue`` keeps working unchanged.

3.  **Refresh policy.** New thread → ensure cache, fetch ref, add
    worktree. Resumed thread → worktree already exists, short-circuit
    via a marker file so we skip all git ops for the warm path.

Everything here is pure Python + ``subprocess`` (no Modal decorators,
no structlog, no bot-side imports). The module sits alongside
``app.py`` but is imported by it at runtime — keeping the decorated
Modal function in ``app.py`` avoids the double-import footgun
documented in that file's module docstring.

All concurrency serialization lives at the Modal layer via
``@app.function(max_containers=1)`` on the wrapping Modal function in
``app.py``. This module deliberately contains **no locking primitives**:
filesystem-based locks don't work on Modal Volumes (see
``apps/delulu_sandbox_modal/tools/verify_flock.py`` for the scout
evidence), and ``max_containers=1`` provides global mutual exclusion
without any lock code at all.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from urllib.parse import urlparse

REPO_CACHE_ROOT = "/vol/repo-cache"
WORKSPACES_ROOT = "/vol/workspaces"

# Written into the per-thread workspace directory after a successful
# provision. On subsequent calls, if the marker records the same
# (repo_url, ref) as the current request, we short-circuit the git
# ops entirely — the worktree is already what the caller wants.
PROVISION_MARKER_NAME = ".provision.json"


@dataclass
class ProvisionTiming:
    """Wall-clock timings for `provision.timing` observability."""

    total_ms: int = 0
    cold_clone_ms: int = 0
    fetch_ms: int = 0
    worktree_ms: int = 0
    short_circuit: bool = False


def provision_workspace(
    thread_id: int,
    repo_url: str | None,
    ref: str = "HEAD",
    *,
    github_token: str | None = None,
) -> tuple[str, ProvisionTiming]:
    """Ensure a workspace exists at ``/vol/workspaces/<thread_id>`` and return its path.

    Called from inside the Modal ``provision_workspace`` function in
    ``app.py``, which has ``max_containers=1`` and serializes all
    invocations at the Modal orchestration layer. No lock code is
    needed here because there's only ever one caller active at a time.

    ``github_token`` (when non-empty) is used to authenticate the
    clone and fetch via ``GIT_ASKPASS``. Public-repo callers pass
    ``None`` (or omit the kwarg) and the git operations run
    unauthenticated. Private-repo callers must pass a real PAT —
    refuse-and-instruct on missing PAT happens earlier (in
    ``app.run_claude_code``) so we don't reach this function with
    a known-private repo and an empty token.

    Behavior:

    - ``repo_url is None``: empty workspace for general Q&A mode. No
      git ops, no cache touching. Creates the directory if missing.
    - ``repo_url`` set, worktree missing or stale: ensure the bare
      cache, fetch the ref, create or recreate the worktree, write
      the provision marker.
    - ``repo_url`` set, worktree exists and marker matches: short-
      circuit and return immediately. ``timings.short_circuit = True``.
    """
    start = time.monotonic()
    timings = ProvisionTiming()
    workspace_path = _workspace_path(thread_id)

    if repo_url is None:
        # General Q&A mode — empty workspace, no git.
        os.makedirs(workspace_path, exist_ok=True)
        timings.total_ms = _elapsed_ms(start)
        return workspace_path, timings

    if _workspace_matches(workspace_path, repo_url, ref):
        # Resumed thread on the same repo/ref: short-circuit.
        timings.short_circuit = True
        timings.total_ms = _elapsed_ms(start)
        return workspace_path, timings

    # Ensure the bare cache exists.
    bare_path = _bare_cache_path(repo_url)
    cold_clone = not os.path.isdir(bare_path)
    if cold_clone:
        clone_start = time.monotonic()
        _clone_bare(repo_url, bare_path, github_token=github_token)
        timings.cold_clone_ms = _elapsed_ms(clone_start)
    else:
        # Warm cache — fetch the ref to pick up upstream changes.
        fetch_start = time.monotonic()
        _fetch_bare(bare_path, ref, github_token=github_token)
        timings.fetch_ms = _elapsed_ms(fetch_start)

    # Make sure the bare cache's ``info/exclude`` ignores our marker
    # file BEFORE the worktree is created/refreshed. Without this,
    # ``commit_workspace_changes`` sees ``.provision.json`` as
    # untracked and ``git add -A`` stages it on every /commit —
    # leaking the bot's internal state into the user's branch.
    # Idempotent: covers both cold clones and pre-existing caches
    # that predate this fix.
    _ensure_marker_excluded(bare_path)

    # Create (or replace) the per-thread worktree.
    worktree_start = time.monotonic()
    _ensure_worktree(bare_path, workspace_path, ref, github_token=github_token)
    timings.worktree_ms = _elapsed_ms(worktree_start)

    # Record the marker so the next provision on the same thread
    # can short-circuit instead of redoing git work.
    _write_marker(workspace_path, repo_url, ref)

    timings.total_ms = _elapsed_ms(start)
    return workspace_path, timings


def _workspace_path(thread_id: int) -> str:
    return f"{WORKSPACES_ROOT}/{thread_id}"


def _bare_cache_path(repo_url: str) -> str:
    host, org, repo = _parse_repo_url(repo_url)
    return f"{REPO_CACHE_ROOT}/{host}/{org}/{repo}.git"


def _ensure_marker_excluded(bare_path: str) -> None:
    """Append ``PROVISION_MARKER_NAME`` to the bare cache's ``info/exclude``.

    The bare cache's ``info/exclude`` is shared by every worktree
    git creates from it (per ``git-worktree(1)``), so writing the
    rule once on the bare side ignores the marker in every per-thread
    worktree's ``git status``. Without this, every ``/commit`` would
    stage ``.provision.json`` via ``git add -A`` and push the bot's
    internal state to the user's branch.

    Idempotent — reads the existing file and only appends when the
    marker name isn't already there. Safe to call on every provision.
    """
    exclude_path = os.path.join(bare_path, "info", "exclude")
    os.makedirs(os.path.dirname(exclude_path), exist_ok=True)

    existing = ""
    if os.path.exists(exclude_path):
        with open(exclude_path) as f:
            existing = f.read()
    if PROVISION_MARKER_NAME in existing.splitlines():
        return

    with open(exclude_path, "a") as f:
        if existing and not existing.endswith("\n"):
            f.write("\n")
        f.write(f"{PROVISION_MARKER_NAME}\n")


def _parse_repo_url(repo_url: str) -> tuple[str, str, str]:
    """Return (host, org, repo) for the on-disk cache layout.

    Accepts ``https://github.com/owner/repo[.git]`` and
    ``git@host:owner/repo[.git]`` forms. Raises ``ValueError`` on
    anything it can't parse cleanly — deliberately strict, because a
    bad parse here would silently point at the wrong cache directory.
    """
    url = repo_url.strip()
    if not url:
        raise ValueError("repo_url is empty")

    # Normalize trailing junk. Order matters: strip slash → strip .git
    # → strip slash again, so inputs like
    # ``https://github.com/alice/api-service.git/`` normalize the
    # same as ``.../api-service``.
    url = url.rstrip("/")
    if url.endswith(".git"):
        url = url[:-4]
    url = url.rstrip("/")

    if url.startswith("git@"):
        # git@host:owner/repo
        rest = url[len("git@") :]
        host, sep, path = rest.partition(":")
        if not sep:
            raise ValueError(f"cannot parse SSH git URL: {repo_url!r}")
    else:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            raise ValueError(
                f"unsupported URL scheme {parsed.scheme!r} in {repo_url!r} "
                "(only http/https/ssh are accepted)"
            )
        host = parsed.hostname or ""
        path = parsed.path.lstrip("/")

    if not host:
        raise ValueError(f"cannot parse host from {repo_url!r}")

    parts = path.split("/")
    if len(parts) < 2 or not parts[0] or not parts[1]:
        raise ValueError(f"cannot parse owner/repo from {repo_url!r}")

    # Guard against path-traversal in any component used to build the
    # on-disk cache path.  A URL like ``git@../../etc:alice/repo`` would
    # otherwise resolve outside the volume entirely.
    for label, value in (("host", host), ("org", parts[0]), ("repo", parts[1])):
        if ".." in value or "/" in value:
            raise ValueError(f"unsafe {label} component {value!r} in {repo_url!r}")

    return host, parts[0], parts[1]


def _clone_bare(repo_url: str, bare_path: str, *, github_token: str | None = None) -> None:
    """``git clone --bare --filter=blob:none <repo_url> <bare_path>``.

    Creates parent directories if missing. Partial clone keeps the
    bare cache small on cold start — file-content blobs are fetched
    on demand when files are actually opened.

    When ``github_token`` is set, runs the clone under
    ``GIT_ASKPASS`` so private repos resolve. The token is never
    embedded in the URL or written into ``.git/config`` — see
    ``_askpass_env``.
    """
    os.makedirs(os.path.dirname(bare_path), exist_ok=True)
    _run_git(
        [
            "clone",
            "--bare",
            "--filter=blob:none",
            repo_url,
            bare_path,
        ],
        github_token=github_token,
    )


def _fetch_bare(bare_path: str, ref: str, *, github_token: str | None = None) -> None:
    """``git -C <bare_path> fetch --filter=blob:none origin <ref>``.

    Fetches metadata for the requested ref so ``git worktree add``
    can materialize it. Partial clone keeps this cheap on warm
    caches — usually well under a second.

    When ``github_token`` is set, runs the fetch under
    ``GIT_ASKPASS`` so private-repo refresh works. See
    ``_askpass_env`` for the auth mechanism.
    """
    _run_git(
        [
            "-C",
            bare_path,
            "fetch",
            "--filter=blob:none",
            "origin",
            ref,
        ],
        github_token=github_token,
    )


def _ensure_worktree(
    bare_path: str,
    workspace_path: str,
    ref: str,
    *,
    github_token: str | None = None,
) -> None:
    """Create or reuse a worktree at ``workspace_path`` checked out at ``ref``.

    Handles three cases:

    1.  Workspace doesn't exist → ``git worktree add``.
    2.  Workspace exists and has a ``.git`` file pointing into the bare
        cache → treat as a valid worktree and just ``git checkout`` the
        requested ref. Cheap refresh path.
    3.  Workspace exists but isn't a worktree (e.g. leftover stub from
        an earlier layout) → wipe it and recreate.

    Prunes stale worktree registrations first so the bare cache's
    ``worktrees/`` dir doesn't accumulate dead entries.

    ``github_token`` authenticates the lazy blob fetches that
    ``git checkout`` and ``git worktree add`` trigger against the
    bare cache's promisor remote (origin) — without it, private-repo
    worktrees fail with "could not read Username for
    'https://github.com'" the moment a missing blob has to be
    materialized. ``git worktree prune`` is local-only and doesn't
    need the token.
    """
    # Prune any dead worktree registrations cheaply.
    _run_git(["-C", bare_path, "worktree", "prune"], check=False)

    if os.path.isdir(workspace_path):
        git_marker = os.path.join(workspace_path, ".git")
        if os.path.exists(git_marker):
            # Valid worktree — just checkout the ref.
            _run_git(["-C", workspace_path, "checkout", ref], github_token=github_token)
            return
        # Exists but not a worktree. Wipe and recreate below.
        shutil.rmtree(workspace_path)

    os.makedirs(os.path.dirname(workspace_path), exist_ok=True)
    _run_git(
        [
            "-C",
            bare_path,
            "worktree",
            "add",
            "--force",
            workspace_path,
            ref,
        ],
        github_token=github_token,
    )


def _workspace_matches(workspace_path: str, repo_url: str, ref: str) -> bool:
    """True if an existing workspace already matches the requested (url, ref).

    Used by the resumed-thread short-circuit in ``provision_workspace``.
    Reads the ``.provision.json`` marker written at the end of a
    successful provision.
    """
    marker_path = os.path.join(workspace_path, PROVISION_MARKER_NAME)
    if not os.path.isfile(marker_path):
        return False
    try:
        with open(marker_path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return False
    return data.get("repo_url") == repo_url and data.get("ref") == ref


def _write_marker(workspace_path: str, repo_url: str, ref: str) -> None:
    """Record the provisioned (repo_url, ref) for next-call short-circuit."""
    marker_path = os.path.join(workspace_path, PROVISION_MARKER_NAME)
    with open(marker_path, "w") as f:
        json.dump({"repo_url": repo_url, "ref": ref}, f)


def _run_git(
    args: list[str],
    *,
    check: bool = True,
    github_token: str | None = None,
) -> subprocess.CompletedProcess[str]:
    """Wrapper around ``subprocess.run`` for git commands.

    Captures stderr so callers (and the `provision.timing` logs)
    surface actionable error context on failure. Uses ``text=True``
    so git output is decoded as UTF-8 strings rather than bytes.

    When ``github_token`` is non-empty, the subprocess runs under
    ``GIT_ASKPASS`` (via ``_askpass_env``) so authenticated git
    operations can proceed without an interactive credential prompt.
    On error any occurrence of the token in stderr/stdout is
    scrubbed before being raised.
    """
    with _askpass_env(github_token) as env:
        try:
            return subprocess.run(
                ["git", *args],
                check=check,
                capture_output=True,
                text=True,
                env=env,
            )
        except subprocess.CalledProcessError as exc:
            # Re-raise with stderr attached to the message — the default
            # CalledProcessError __str__ drops stderr, and debugging a
            # silent git failure against a Modal Volume is painful
            # without it. Scrub the token first so we don't leak it
            # into logs or error rendering.
            stderr = _scrub_pat((exc.stderr or "").strip(), github_token or "")
            stdout = _scrub_pat((exc.stdout or "").strip(), github_token or "")
            raise RuntimeError(
                f"git {' '.join(args)} failed with exit code {exc.returncode}: "
                f"stderr={stderr!r} stdout={stdout!r}"
            ) from exc


# Env var the askpass script reads the PAT from. The token is passed only
# through the git subprocess's environment — it is never interpolated into
# the script body, so tokens containing shell metacharacters (``'``, ``$``,
# backticks, ...) can't break quoting or inject commands, and the token is
# never written to disk.
ASKPASS_TOKEN_ENV = "DELULU_GIT_ASKPASS_TOKEN"


def _write_askpass_script(*, log_prompt: bool = False) -> str:
    """Write a token-free ``GIT_ASKPASS`` script and return its path.

    Git calls the script with the prompt as ``$1``: it answers ``git``
    for the username prompt and prints ``$DELULU_GIT_ASKPASS_TOKEN``
    (verbatim, via ``printf '%s\\n'``) for the password prompt. The file
    is mode 0700; the caller is responsible for deleting it.
    """
    with tempfile.NamedTemporaryFile(
        mode="w",
        suffix=".sh",
        delete=False,
        dir="/tmp",
        prefix="git-askpass-",
    ) as f:
        f.write("#!/bin/sh\n")
        if log_prompt:
            # Log to stderr so we can confirm the script was actually
            # invoked by git.
            f.write('echo "ASKPASS: called with prompt: $1" >&2\n')
        f.write('case "$1" in\n')
        f.write("  Username*) printf '%s\\n' 'git' ;;\n")
        f.write(f"  Password*) printf '%s\\n' \"${ASKPASS_TOKEN_ENV}\" ;;\n")
        f.write("esac\n")
        askpass_path = f.name
    os.chmod(askpass_path, stat.S_IRWXU)
    return askpass_path


@contextmanager
def _askpass_env(github_token: str | None):
    """Yield an env dict with ``GIT_ASKPASS`` configured for ``github_token``.

    When the token is empty/None, yields ``None`` so subprocess.run
    inherits the parent's env unchanged — the unauthenticated path
    stays free of any extra setup cost.

    When the token is set, writes a tiny token-free temp shell script
    to ``/tmp`` (see ``_write_askpass_script``) that responds with
    ``git`` for the username prompt and ``$DELULU_GIT_ASKPASS_TOKEN``
    for the password prompt, puts the token in that env var, sets
    ``GIT_ASKPASS`` to point at the script, and
    ``GIT_TERMINAL_PROMPT=0`` to refuse interactive fallback. The
    script is deleted on context exit.

    This mirrors the auth pattern in ``_push_with_askpass`` (used by
    /commit), which landed on GIT_ASKPASS after http.extraheader and
    URL-embedded credentials proved unreliable for ``git push``. For
    clone/fetch/ls-remote the choice is consistency with what works:
    one auth mechanism across the codebase, no per-operation
    decision-making about which auth flavor to use.
    """
    if not github_token:
        yield None
        return

    askpass_path = _write_askpass_script()

    try:
        yield {
            **os.environ,
            "GIT_ASKPASS": askpass_path,
            ASKPASS_TOKEN_ENV: github_token,
            "GIT_TERMINAL_PROMPT": "0",
        }
    finally:
        try:
            os.unlink(askpass_path)
        except OSError:
            pass


def _elapsed_ms(start: float) -> int:
    return int((time.monotonic() - start) * 1000)


# ─────────────────────────────────────────────────────────────────
# Repo-access validation (used by /admin_addrepo)
# ─────────────────────────────────────────────────────────────────

# Possible classifications returned by ``validate_repo_access``.
# Treated as opaque strings on the bot side so the admin command
# can render the right user-facing message per case.
ACCESS_PUBLIC = "public"
ACCESS_PRIVATE = "private"
ACCESS_NOT_FOUND = "not_found"
ACCESS_ERROR = "error"


@dataclass
class RepoAccessResult:
    """Outcome of a ``validate_repo_access`` probe.

    ``status`` is one of the ``ACCESS_*`` constants. ``error`` carries
    the underlying message when ``status == ACCESS_ERROR`` (network
    failures, malformed URLs, etc.) so the bot can surface something
    actionable rather than a generic "validation failed."
    """

    status: str
    error: str | None = None


def validate_repo_access(
    repo_url: str,
    *,
    github_token: str | None = None,
) -> RepoAccessResult:
    """Classify a GitHub repo as public / private / not_found via ``git ls-remote``.

    Runs ``git ls-remote`` first anonymously, then (if the anonymous
    probe failed AND a token is provided) authenticated. The pair of
    outcomes drives the classification:

    - anonymous succeeds → ``public``
    - anonymous fails, authenticated succeeds → ``private``
    - both fail → ``not_found``  (could be private without PAT
      access, deleted, or never existed — GitHub deliberately
      doesn't distinguish)

    ``error`` is reserved for *infrastructural* failures (URL won't
    parse, git binary missing, etc.) — anything where we can't even
    make the network request. A 404-equivalent from GitHub is
    ``not_found``, not ``error``.

    Used by the bot's ``/admin_addrepo`` slash command via
    ``validate_repo_access.remote()`` (defined in ``app.py``).
    """
    try:
        _parse_repo_url(repo_url)
    except ValueError as exc:
        return RepoAccessResult(status=ACCESS_ERROR, error=str(exc))

    # Anonymous probe first — public repos respond immediately and
    # we can skip the authenticated round-trip entirely.
    if _ls_remote_succeeds(repo_url, github_token=None):
        return RepoAccessResult(status=ACCESS_PUBLIC)

    # Anonymous failed. If we have a token, try authenticated.
    if github_token and _ls_remote_succeeds(repo_url, github_token=github_token):
        return RepoAccessResult(status=ACCESS_PRIVATE)

    # Both failed (or no token to try). Treat as not_found — we can't
    # distinguish "doesn't exist" from "private but our PAT can't see it"
    # from the response, so the user-facing message bundles both.
    return RepoAccessResult(status=ACCESS_NOT_FOUND)


def _ls_remote_succeeds(repo_url: str, *, github_token: str | None) -> bool:
    """``git ls-remote <repo_url> HEAD``, returning True on exit 0.

    Uses ``ls-remote`` with the ``HEAD`` ref so we transfer no refs
    beyond what's needed to confirm access — a few hundred bytes
    even on huge repos. Fails closed on any nonzero exit.
    """
    with _askpass_env(github_token) as env:
        try:
            proc = subprocess.run(
                ["git", "ls-remote", "--exit-code", repo_url, "HEAD"],
                capture_output=True,
                text=True,
                env=env,
                timeout=15,
            )
        except (subprocess.TimeoutExpired, OSError):
            return False
    return proc.returncode == 0


# ``_scrub_pat`` is defined below in the /commit-back section.
# Both code paths call into it from distinct error-handling sites.


def _resolve_branch_name(workspace_path: str, thread_id: int, message: str) -> str:
    """Return the branch name for this thread, creating or reusing as needed.

    First /commit: derives a conventional-commit-style branch name
    from the commit message and caches it in ``.commit-branch`` on
    the workspace. Subsequent /commits reuse the cached name so the
    branch is stable even if the message changes.

    Examples:
        ``feat: add rate limiting`` → ``feat/add-rate-limiting-494242``
        ``fix(auth): resolve timeout`` → ``fix/resolve-timeout-494242``
        ``just update the readme`` → ``claude/update-the-readme-494242``
    """
    marker_path = os.path.join(workspace_path, COMMIT_BRANCH_MARKER)
    if os.path.isfile(marker_path):
        try:
            with open(marker_path) as f:
                cached = f.read().strip()
            if cached:
                return cached
        except OSError:
            pass

    branch = _make_branch_name(thread_id, message)
    with open(marker_path, "w") as f:
        f.write(branch)
    return branch


def _make_branch_name(thread_id: int, message: str) -> str:
    """Build a branch name like ``feat/add-rate-limiting-494242``.

    Parses the commit message for a conventional-commit type prefix
    (``feat:``, ``fix:``, etc.). If found, uses that as the branch
    prefix. Otherwise falls back to ``claude/``. The subject is
    slugified (lowercased, non-alphanum replaced with dashes,
    trimmed to 50 chars). A short suffix from the thread_id ensures
    uniqueness across threads with similar messages.
    """
    # Parse "type: subject" or "type(scope): subject"
    match = re.match(
        r"^(" + "|".join(CONVENTIONAL_TYPES) + r")(?:\([^)]*\))?:\s*(.+)",
        message,
        re.IGNORECASE,
    )
    if match:
        type_prefix = match.group(1).lower()
        subject = match.group(2)
    else:
        type_prefix = COMMIT_BRANCH_DEFAULT_PREFIX
        subject = message

    slug = re.sub(r"[^a-z0-9]+", "-", subject.lower()).strip("-")[:50]
    short_id = str(thread_id)[-6:]
    return f"{type_prefix}/{slug}-{short_id}"


# ─────────────────────────────────────────────────────────────────
# Commit-back: stage, commit, and push pending changes from a
# per-thread workspace to a `claude/<thread_id>` branch on the
# upstream repo.
# ─────────────────────────────────────────────────────────────────
#
# Lives here (rather than in a separate module) because it's another
# pure-git operation on the same workspaces that ``provision_workspace``
# creates. Same import-isolation rules: no Modal decorators, no bot-
# side imports. The Modal function wrapper that calls this lives in
# ``app.py``.
#
# Refuse-and-instruct UX: callers are expected to check the
# ``GITHUB_TOKEN`` env var BEFORE calling ``commit_workspace_changes``.
# This module doesn't touch the env directly — it just takes the
# token as a parameter so the function is testable without env
# munging and the auth check stays at the boundary.

# Default branch prefix when the commit message doesn't have a
# conventional-commit type prefix. If the message starts with
# "feat:", "fix:", etc., the branch uses that type as the prefix
# instead. One branch per thread — multiple /commit calls stack
# on the same branch.
COMMIT_BRANCH_DEFAULT_PREFIX = "claude"

# Marker file written to the workspace after the first /commit to
# lock the branch name. Subsequent /commits reuse it so the branch
# name is stable even if the commit message changes.
COMMIT_BRANCH_MARKER = ".commit-branch"

# Conventional commit types we recognize for branch naming.
CONVENTIONAL_TYPES = frozenset(
    {"feat", "fix", "docs", "refactor", "test", "chore", "ci", "build", "perf", "style"}
)

# The git author identity for bot-made commits. The ACTUAL pusher
# (visible in GitHub's UI as "pushed by") is whoever owns the PAT
# stored in the ``github-pat`` Modal secret; this name/email is
# only what shows up in the commit object's Author/Committer
# fields and in ``git log``. Defaults to a generic bot identity
# so commits can be filtered out of git log easily; can be
# overridden via env vars on the github-pat secret (see README).
DEFAULT_GIT_AUTHOR_NAME = "Claude Code"
DEFAULT_GIT_AUTHOR_EMAIL = "claude@bot.local"


@dataclass
class CommitResult:
    """Result of a /commit operation.

    The ``status`` field is the primary signal the bot side renders
    into a Discord response; the other fields carry additional
    context for the success and partial-failure cases.
    """

    status: str  # "ok" | "no_changes" | "no_workspace" | "push_failed"
    branch: str | None = None
    commit_sha: str | None = None
    pr_compare_url: str | None = None
    error: str | None = None


def commit_workspace_changes(
    thread_id: int,
    message: str,
    github_token: str,
    *,
    author_name: str = DEFAULT_GIT_AUTHOR_NAME,
    author_email: str = DEFAULT_GIT_AUTHOR_EMAIL,
) -> CommitResult:
    """Stage, commit, and push pending changes in ``/vol/workspaces/<thread_id>``.

    Idempotent in the no-op sense: if there are no changes, returns
    ``status="no_changes"`` without making a commit. If there ARE
    changes, makes one new commit on the ``claude/<thread_id>``
    branch (creating the branch if missing) and pushes it to
    ``origin``.

    Auth: ``github_token`` is embedded in the push URL as
    ``https://x-access-token:<pat>@host/owner/repo[.git]`` for
    the single ``git push`` invocation. Never persisted to
    ``.git/config``, never written to the remote's stored URL.
    See ``_build_push_url_with_pat`` for the URL construction
    and ``_scrub_pat`` for why error messages get sanitized
    before being surfaced.

    Caller must verify ``github_token`` is non-empty BEFORE calling
    this function — refuse-and-instruct on missing PAT happens at
    the boundary in ``app.py``, not here.
    """
    if not github_token:
        # Defensive — caller should have refused already, but
        # guarding here means a programming error never causes a
        # broken push attempt with empty auth.
        raise ValueError("github_token must not be empty")

    workspace_path = _workspace_path(thread_id)
    if not os.path.isdir(workspace_path):
        return CommitResult(
            status="no_workspace",
            error=f"workspace {workspace_path} does not exist (no prior dispatch in this thread?)",
        )

    # Check for pending changes. ``git status --porcelain`` emits
    # one line per dirty path (modified, added, deleted, untracked);
    # empty output means a clean working tree.
    status_result = _run_git(
        ["-C", workspace_path, "status", "--porcelain"],
    )
    has_uncommitted = bool(status_result.stdout.strip())

    branch = _resolve_branch_name(workspace_path, thread_id, message)

    if has_uncommitted:
        # Check out the thread's branch. Try switching first; if
        # the branch doesn't exist yet, create it.
        try:
            _run_git(["-C", workspace_path, "checkout", branch])
        except RuntimeError:
            _run_git(["-C", workspace_path, "checkout", "-b", branch])

        # Stage everything and commit with the bot's git identity.
        # ``-c user.name=...`` is per-command, not persisted to config.
        _run_git(["-C", workspace_path, "add", "-A"])
        _run_git(
            [
                "-c",
                f"user.name={author_name}",
                "-c",
                f"user.email={author_email}",
                "-C",
                workspace_path,
                "commit",
                "-m",
                message,
            ]
        )
    else:
        # No uncommitted changes. But there might be previously
        # committed-but-unpushed changes from a prior /commit
        # attempt that failed at the push step. Check if the
        # branch exists locally — if it does, fall through to
        # the push step which will push the existing commits.
        branch_check = _run_git(
            ["-C", workspace_path, "rev-parse", "--verify", branch],
            check=False,
        )
        if branch_check.returncode != 0:
            return CommitResult(status="no_changes")
        # Branch exists — make sure we're on it for the push.
        _run_git(["-C", workspace_path, "checkout", branch])

    # Capture the current HEAD SHA (new commit or existing unpushed).
    sha_result = _run_git(["-C", workspace_path, "rev-parse", "HEAD"])
    commit_sha = sha_result.stdout.strip()

    # Push using GIT_ASKPASS — git's own non-interactive credential
    # mechanism. We write a tiny temp shell script that provides
    # username + password when git prompts, and point GIT_ASKPASS at
    # it. The remote URL stays untouched (no URL-embedded credentials).
    #
    # Why not URL-embedded credentials? Four failed attempts:
    #
    # 1. `-c http.extraheader=Authorization: Basic <b64>` — git
    #    intermittently fell through to interactive prompt.
    # 2. `x-access-token:<pat>@github.com` in URL — the
    #    x-access-token username is for GitHub App tokens, not PATs.
    #    GitHub rejects with misleading "password auth not supported."
    # 3. `<pat>@github.com` (token-only userinfo) — GitHub rejects
    #    the empty password; git prompted interactively for password.
    # 4. `git:<pat>@github.com` — GitHub still rejects with
    #    "Invalid username or token. Password authentication is not
    #    supported for Git operations."
    #
    # GIT_ASKPASS avoids ALL of these by not touching the URL at all.
    # Git's own credential prompting asks our script for username +
    # password, and we provide them. No URL encoding issues, no
    # username convention issues, no auth-layer routing issues.
    try:
        _push_with_askpass(workspace_path, branch, github_token)
    except RuntimeError as exc:
        return CommitResult(
            status="push_failed",
            branch=branch,
            commit_sha=commit_sha,
            error=_scrub_pat(str(exc), github_token),
        )

    pr_compare_url = _build_pr_compare_url(workspace_path, branch)

    return CommitResult(
        status="ok",
        branch=branch,
        commit_sha=commit_sha,
        pr_compare_url=pr_compare_url,
    )


def _push_with_askpass(
    workspace_path: str,
    branch: str,
    github_token: str,
) -> None:
    """Push to ``origin`` using ``GIT_ASKPASS`` for non-interactive auth.

    Writes a tiny temp shell script that provides credentials when
    git prompts, sets ``GIT_ASKPASS`` to point at it, and runs
    ``git push origin <branch>``. The remote URL is **untouched** —
    no URL-embedded credentials, no ``http.extraheader``, no
    credential helper config changes.

    ``GIT_ASKPASS`` is git's own non-interactive credential mechanism
    (see ``git-credential(7)``). Git calls the script once for the
    username prompt and once for the password prompt, reading the
    response from stdout. We provide ``git`` as a placeholder
    username and the PAT as the password — matching what GitHub's
    interactive HTTPS flow expects.

    **Why not URL-embedded credentials?** Four failed attempts at
    building the push URL with credentials led to four distinct
    failure modes across GitHub's auth layer (see the comments in
    ``commit_workspace_changes`` for the full saga). GIT_ASKPASS
    sidesteps ALL of them because it never touches the URL — it
    operates at git's credential-prompting layer instead of the
    URL-parsing layer.

    The PAT is passed to the script only through the subprocess env
    (``DELULU_GIT_ASKPASS_TOKEN``), never written into it; the temp
    script is still deleted in a ``finally`` block.
    """
    # The script answers the username/password prompts; the PAT reaches
    # it only via the subprocess env (ASKPASS_TOKEN_ENV), never the file.
    askpass_path = _write_askpass_script(log_prompt=True)

    # Capture the remote URL for diagnostics (sanitized — no PAT).
    try:
        origin_result = subprocess.run(
            ["git", "-C", workspace_path, "config", "--get", "remote.origin.url"],
            capture_output=True,
            text=True,
            check=False,
        )
        origin_url = origin_result.stdout.strip()
    except Exception:
        origin_url = "<unknown>"

    try:
        subprocess.run(
            ["git", "-C", workspace_path, "push", "origin", branch],
            check=True,
            capture_output=True,
            text=True,
            env={
                **os.environ,
                "GIT_ASKPASS": askpass_path,
                ASKPASS_TOKEN_ENV: github_token,
                # Suppress the fallback to /dev/tty if GIT_ASKPASS
                # somehow fails. Without this, a broken script would
                # hang the sandbox waiting for interactive input.
                "GIT_TERMINAL_PROMPT": "0",
                # GIT_TRACE shows which credential helpers git calls
                # and what commands it runs. Dropped GIT_CURL_VERBOSE
                # because the TLS handshake output was filling the
                # entire stderr budget and truncating before the
                # actual error.
                "GIT_TRACE": "1",
            },
        )
    except subprocess.CalledProcessError as exc:
        stderr = _scrub_pat((exc.stderr or "").strip(), github_token)

        # Take the LAST 2000 chars of stderr — the actual error
        # message and GitHub's response are at the end, not the
        # beginning. Previous versions took the first 1500 chars
        # which was entirely consumed by TLS handshake noise from
        # GIT_CURL_VERBOSE (now removed), truncating before the
        # useful part.
        stderr_tail = stderr[-2000:] if len(stderr) > 2000 else stderr
        raise RuntimeError(
            f"git push origin {branch} failed (exit {exc.returncode}).\n"
            f"Remote: {_scrub_pat(origin_url, github_token)}\n"
            f"GIT_ASKPASS: {askpass_path}\n"
            f"PAT length: {len(github_token)} chars\n"
            f"stderr (last 2000 chars, with GIT_TRACE):\n{stderr_tail}"
        ) from exc
    finally:
        try:
            os.unlink(askpass_path)
        except OSError:
            pass


def _build_push_url_with_pat(origin_url: str, github_token: str) -> str:
    """**DEPRECATED** — kept only for tests that haven't been migrated.

    URL-embedded credentials don't work reliably on GitHub — see the
    ``_push_with_askpass`` function and the comments in
    ``commit_workspace_changes`` for the five-attempt saga. Do NOT
    use this function for new code.
    """
    from urllib.parse import urlparse, urlunparse

    if not github_token:
        raise ValueError("github_token must not be empty")

    parsed = urlparse(origin_url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(
            f"cannot push via PAT to non-HTTPS origin {origin_url!r} "
            "(v1 only supports https:// remotes; use a fork or switch "
            "the remote's URL scheme)"
        )

    host = parsed.hostname or ""
    if not host:
        raise ValueError(f"cannot parse host from origin URL {origin_url!r}")

    netloc = f"git:{github_token}@{host}"
    if parsed.port:
        netloc = f"{netloc}:{parsed.port}"

    return urlunparse(parsed._replace(netloc=netloc))


def _scrub_pat(message: str, github_token: str) -> str:
    """Replace every occurrence of ``github_token`` in ``message`` with a placeholder.

    Used to sanitize ``git push`` error messages before they hit
    Discord or the bot log. Because we build the push URL with
    the PAT embedded, any git error message that echoes the args
    (which ``_run_git`` does) carries the PAT verbatim — a leak
    straight into whatever renders the error.

    Idempotent and safe to call on empty strings or empty tokens;
    returns the input unchanged in the degenerate cases.
    """
    if not github_token or github_token not in message:
        return message
    return message.replace(github_token, "***PAT***")


def _build_pr_compare_url(workspace_path: str, branch: str) -> str | None:
    """Build a ``github.com/<owner>/<repo>/compare/<base>...<branch>`` link.

    Returns ``None`` if we can't extract the upstream URL or the
    base ref — display code degrades to "branch pushed, open a PR
    yourself" rather than crashing.
    """
    try:
        # Get the origin URL.
        origin_result = _run_git(
            ["-C", workspace_path, "config", "--get", "remote.origin.url"],
        )
        origin_url = origin_result.stdout.strip()
        if not origin_url:
            return None

        # Parse owner/repo out of the origin URL (same logic as the
        # bot side's _short_repo_name in streaming.py, kept inline
        # to avoid cross-app imports).
        host, org, repo = _parse_repo_url(origin_url)
        if host != "github.com":
            # Compare URLs only documented for github.com; skip for
            # other hosts.
            return None

        # Determine the base branch. The worktree was created from a
        # specific ref; we want to compare against that. Read the
        # ref from the .provision.json marker if present.
        marker_path = os.path.join(workspace_path, PROVISION_MARKER_NAME)
        base_ref = "main"
        if os.path.isfile(marker_path):
            try:
                with open(marker_path) as f:
                    base_ref = json.load(f).get("ref") or "main"
            except (OSError, json.JSONDecodeError):
                pass
        if base_ref == "HEAD":
            base_ref = "main"  # GitHub doesn't accept HEAD in compare URLs

        return f"https://github.com/{org}/{repo}/compare/{base_ref}...{branch}?expand=1"
    except (RuntimeError, ValueError):
        return None
