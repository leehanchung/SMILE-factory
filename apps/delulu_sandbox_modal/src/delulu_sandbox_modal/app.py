"""Modal app definition — image, volume, secrets, and the sandbox function.

This is the sole deploy target: `modal deploy src/delulu_sandbox_modal/app.py`.

The sandbox function `run_claude_code` is defined here (not in a separate
module) so Modal's deploy importer and Python's package importer agree on a
single `app` instance. Previously the function lived in a sibling file and
this module re-imported it at the bottom — which worked when imported as a
package but broke under `modal deploy`, because Modal imports this file as a
standalone script, which then imports the package path a *second* time and
registers the decorator on a different `app` object.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import TYPE_CHECKING, Any

import modal
import structlog

if TYPE_CHECKING:
    # Imported for type-checking only. At runtime the generator yields plain
    # dicts — keeping this off the runtime import graph avoids any chance of
    # re-entering app.py through a sibling module during ``modal deploy``
    # (see the module docstring for the full rationale).
    from delulu_sandbox_modal.events import Event

logger = structlog.get_logger()

# ── Modal App ────────────────────────────────────────────────
app = modal.App("discord-orchestrator")

# ── Persistent Volume ────────────────────────────────────────
# Shared across all sandboxes. Holds workspaces and Claude Code session history.
volume = modal.Volume.from_name("claude-workspaces", create_if_missing=True)

# ── Container Image ──────────────────────────────────────────
# Pinned Claude Code CLI version baked into the sandbox image. Pinning keeps
# image rebuilds reproducible and stops an unreviewed npm release from
# landing in production on the next deploy. To bump: run
# `npm view @anthropic-ai/claude-code version`, update this constant, then
# redeploy (`make modal-deploy` / CI) and smoke-test a task.
CLAUDE_CODE_VERSION = "2.1.327"

# Pre-bake Claude Code into the image so sandbox startup is fast.
sandbox_image = (
    # Requires Modal Image Builder 2025.06 or newer — the default 2023.12
    # builder only supports Python 3.10–3.12. Set workspace-wide with:
    #   modal config set image_builder_version 2025.06
    modal.Image.debian_slim(python_version="3.14")
    .apt_install("git", "curl", "ca-certificates", "gnupg")
    # app.py is imported inside the sandbox to call run_claude_code, so any
    # third-party module it imports at module level must be present here too.
    .pip_install("structlog>=25.5")
    .run_commands(
        # Install Node.js (required by Claude Code). Node 24 is the
        # current LTS line; Node 20 reached end-of-life in April 2026.
        # Uses NodeSource's apt repo with its signing key pinned via
        # `signed-by=` (same pattern as `gh` below) instead of piping
        # their setup script into bash, so apt verifies every package.
        "mkdir -p -m 755 /etc/apt/keyrings",
        (
            # Download to a file first (not a pipe) so a failed fetch fails
            # the build instead of dearmoring empty input under /bin/sh.
            "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key "
            "-o /tmp/nodesource-repo.gpg.key "
            "&& gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg "
            "/tmp/nodesource-repo.gpg.key "
            "&& rm /tmp/nodesource-repo.gpg.key "
            "&& chmod go+r /etc/apt/keyrings/nodesource.gpg"
        ),
        (
            'echo "deb [arch=$(dpkg --print-architecture) '
            "signed-by=/etc/apt/keyrings/nodesource.gpg] "
            'https://deb.nodesource.com/node_24.x nodistro main" '
            "| tee /etc/apt/sources.list.d/nodesource.list > /dev/null"
        ),
        "apt-get update && apt-get install -y nodejs",
        # Install Claude Code globally, pinned (see CLAUDE_CODE_VERSION).
        f"npm install -g @anthropic-ai/claude-code@{CLAUDE_CODE_VERSION}",
        # Install the GitHub CLI (`gh`) so Claude can push branches,
        # open pull requests, list issues, etc. directly via its Bash
        # tool when the user asks for things like "commit and open a
        # PR." Uses GitHub's official apt repo — shorter install path
        # than downloading the .deb manually and also gets security
        # updates via `apt upgrade` on future image rebuilds.
        (
            "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg "
            "| tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null "
            "&& chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg"
        ),
        (
            'echo "deb [arch=$(dpkg --print-architecture) '
            "signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] "
            'https://cli.github.com/packages stable main" '
            "| tee /etc/apt/sources.list.d/github-cli.list > /dev/null"
        ),
        "apt-get update && apt-get install -y gh",
    )
    # Bundle the whole `delulu_sandbox_modal` package into the image so
    # that runtime `from delulu_sandbox_modal import repo_provisioner`
    # resolves inside the container. `modal deploy` only auto-mounts
    # the entry file (app.py) at /root/app.py by default — sibling
    # modules in the same package have to be added explicitly. Without
    # this line, provision_workspace crashes at import time with
    # `ModuleNotFoundError: No module named 'delulu_sandbox_modal'`.
    .add_local_python_source("delulu_sandbox_modal")
)

# ── Secrets ──────────────────────────────────────────────────
# Claude Code OAuth credentials (Pro/Max subscription). Seeded into the volume on
# first run, then refreshed-in-place on the volume so rotated refresh tokens
# survive across sandbox invocations.
#
# Create with:
#   modal secret create claude-oauth \
#     CLAUDE_CREDENTIALS_JSON="$(cat ~/.claude/.credentials.json)"
claude_oauth_secret = modal.Secret.from_name("claude-oauth")

# GitHub PAT for /commit push-back. The secret MUST exist for the
# Modal app to deploy — Modal's `Secret.from_name` doesn't have an
# optionality flag. To set up:
#
#     modal secret create github-pat GITHUB_TOKEN=ghp_xxxxxx
#
# The token can be a placeholder if /commit isn't going to be used
# yet (e.g. `GITHUB_TOKEN=placeholder`); the runtime check in
# `commit_workspace` will refuse-and-instruct when the value is
# empty or doesn't look like a real PAT, leaving the workspace
# untouched. Replace with a real fine-grained PAT scoped to the
# repos in the allowlist when ready to enable push.
#
# Optional override env vars on the same secret control the git
# author identity used for bot commits (defaults: "Claude Code"
# / "claude@bot.local"):
#
#     modal secret create github-pat \
#         GITHUB_TOKEN=ghp_xxxxxx \
#         GIT_AUTHOR_NAME="Han Lee" \
#         GIT_AUTHOR_EMAIL="han@example.com"
github_pat_secret = modal.Secret.from_name("github-pat")


# ── Stream-json helpers (module-level for testability) ───────
# These parse Claude Code's ``--output-format stream-json`` lines into the
# internal event dicts declared in ``events.py``. They live here rather
# than in a sibling module because ``app.py`` is imported as ``__main__``
# by ``modal deploy`` (see the module docstring); keeping helpers inline
# avoids the double-import footgun that broke the previous layout.


def _summarize_tool_input(tool: str, input_data: dict[str, Any]) -> str:
    """Return a short one-liner describing a tool invocation for display."""
    if tool in ("Read", "Edit", "Write"):
        path = input_data.get("file_path") or ""
        return f"`{path}`" if path else ""
    if tool == "Bash":
        cmd = input_data.get("command") or ""
        return f"`{cmd[:80]}`" if cmd else ""
    if tool in ("Grep", "Glob"):
        pattern = input_data.get("pattern") or ""
        return f"`{pattern}`" if pattern else ""
    return ""


def _summarize_tool_result(content: Any) -> str:
    """Return a short preview of a tool result.

    Claude Code's ``tool_result`` content may be a string, a list of
    content blocks, or something else depending on CC version — parse
    defensively.
    """
    if content is None:
        return ""
    if isinstance(content, str):
        stripped = content.strip()
        if not stripped:
            return ""
        first_line = stripped.splitlines()[0]
        return (first_line[:80] + "…") if len(first_line) > 80 else first_line
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                return _summarize_tool_result(block.get("text"))
        return ""
    return str(content)[:80]


def _flatten_stream_event(
    parsed: dict[str, Any],
    tool_names_by_id: dict[str, str],
) -> list[dict[str, Any]]:
    """Map a Claude Code stream-json line to zero-or-more internal events.

    Unknown event types are skipped. ``tool_names_by_id`` is mutated so
    subsequent ``tool_result`` blocks can be labelled with their tool name.
    """
    out: list[dict[str, Any]] = []
    kind = parsed.get("type")

    if kind == "assistant":
        message = parsed.get("message") or {}
        for block in message.get("content") or []:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "text":
                text = block.get("text") or ""
                if text:
                    out.append({"type": "text", "text": text})
            elif btype == "tool_use":
                tool_id = block.get("id") or ""
                tool = block.get("name") or "?"
                if tool_id:
                    tool_names_by_id[tool_id] = tool
                summary = _summarize_tool_input(tool, block.get("input") or {})
                out.append({"type": "tool_use", "tool": tool, "summary": summary})
            elif btype == "thinking":
                thought = block.get("thinking") or ""
                if thought:
                    out.append({"type": "thinking", "text": thought})
    elif kind == "user":
        message = parsed.get("message") or {}
        for block in message.get("content") or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_result":
                tool_id = block.get("tool_use_id") or ""
                tool = tool_names_by_id.get(tool_id, "")
                is_error = bool(block.get("is_error"))
                summary = _summarize_tool_result(block.get("content"))
                out.append(
                    {
                        "type": "tool_result",
                        "tool": tool,
                        "ok": not is_error,
                        "summary": summary,
                    }
                )
    return out


# ── Provisioning Modal Function ──────────────────────────────
# Dedicated function for git operations (clone, fetch, worktree add).
# `max_containers=1` is load-bearing: it's how we get cross-container
# mutual exclusion on provisioning without writing any lock code. The
# flock scout at `tools/verify_flock.py` empirically confirmed that no
# filesystem lock primitive (flock, mkdir, link) provides cross-
# container atomicity on Modal Volumes, so concurrency has to live at
# Modal's orchestration layer instead. See the "Concurrency" section
# of `apps/delulu_discord/prd/repo-provisioning.md` for the full rationale.
#
# The image intentionally omits nodejs/claude-code — this function
# only needs git, and reusing `sandbox_image` would pull in the
# ~200MB Claude Code install on every provisioning container spin-up.
provisioner_image = (
    modal.Image.debian_slim(python_version="3.14")
    .apt_install("git", "ca-certificates")
    .pip_install("structlog>=25.5")
    # Same rationale as sandbox_image above — provision_workspace
    # and commit_workspace both import `repo_provisioner` at
    # runtime, so the package has to be in the container.
    .add_local_python_source("delulu_sandbox_modal")
)


@app.function(
    image=provisioner_image,
    volumes={"/vol": volume},
    secrets=[github_pat_secret],
    max_containers=1,
    timeout=300,
)
def provision_workspace(
    thread_id: int,
    repo_url: str | None,
    ref: str = "HEAD",
) -> str:
    """Ensure a workspace exists at ``/vol/workspaces/<thread_id>`` and return its path.

    Called via ``.remote()`` from ``run_claude_code``. Modal's
    `max_containers=1` serializes all concurrent invocations of this
    function at the orchestration layer, so the underlying git work
    runs without any locking primitive of its own.

    Commits the volume before returning so the caller's subsequent
    ``volume.reload()`` picks up the newly-created worktree.

    Mounts the ``github-pat`` secret so private-repo clones/fetches
    can authenticate via ``GIT_ASKPASS``. The token is passed
    through to the underlying ``repo_provisioner.provision_workspace``
    only when non-empty + non-placeholder; public-repo clones run
    unauthenticated as before. Refuse-and-instruct on missing PAT
    for a known-private repo lives in ``run_claude_code`` so the
    error path doesn't burn the ``max_containers=1`` slot.
    """
    import os

    # Lazy import — see /commit's notes for the rationale.
    from delulu_sandbox_modal import repo_provisioner

    github_token = (os.environ.get("GITHUB_TOKEN") or "").strip()
    if github_token == "placeholder":
        github_token = ""

    workspace_path, timings = repo_provisioner.provision_workspace(
        thread_id=thread_id,
        repo_url=repo_url,
        ref=ref,
        github_token=github_token or None,
    )

    logger.info(
        "provision.timing",
        thread_id=thread_id,
        repo_url=repo_url,
        ref=ref,
        workspace_path=workspace_path,
        total_ms=timings.total_ms,
        cold_clone_ms=timings.cold_clone_ms,
        fetch_ms=timings.fetch_ms,
        worktree_ms=timings.worktree_ms,
        short_circuit=timings.short_circuit,
    )

    # Commit so the caller (`run_claude_code` in its own container)
    # can `volume.reload()` and see the fresh worktree + bare cache.
    volume.commit()
    return workspace_path


# ── Allowlist validation Modal Function ──────────────────────
# Sandbox-side `git ls-remote` probe used by /admin_addrepo.
# Lives here (not on the bot) because the bot's image is
# `python:3.14-slim` with no git binary and no github-pat secret
# mounted — extending either would widen the bot's secret/binary
# surface for a single-call admin command. The provisioner image
# already has both, and the call is cheap (~1s warm) so the Modal
# round-trip fits inside Discord's 3s interaction-token budget
# (the slash command defers immediately, giving us 15 minutes).
@app.function(
    image=provisioner_image,
    secrets=[github_pat_secret],
    timeout=30,
)
def validate_repo_access(repo_url: str) -> dict[str, Any]:
    """Classify ``repo_url`` as public / private / not_found.

    Wraps ``repo_provisioner.validate_repo_access`` (which does the
    actual ``git ls-remote`` probes). The PAT is read from the
    mounted ``github-pat`` secret; placeholder/empty values are
    treated as no-token, which means private repos that need the
    PAT to be visible will return ``not_found`` rather than
    ``private`` — the right failure mode (admin gets a clear
    error, fixes the secret, retries).

    Returns a JSON-serializable dict so Modal's RPC layer doesn't
    try to (de)serialize the dataclass across the boundary.
    """
    import os

    from delulu_sandbox_modal import repo_provisioner

    github_token = (os.environ.get("GITHUB_TOKEN") or "").strip()
    if github_token == "placeholder":
        github_token = ""

    result = repo_provisioner.validate_repo_access(
        repo_url,
        github_token=github_token or None,
    )

    logger.info(
        "validate_repo_access",
        repo_url=repo_url,
        status=result.status,
        had_token=bool(github_token),
    )

    return {"status": result.status, "error": result.error}


# ── Commit-back Modal Function ───────────────────────────────
# Dedicated function for /commit. Stages, commits, and pushes the
# pending changes in a thread's workspace to a `claude/<thread_id>`
# branch on the upstream repo.
#
# Same `provisioner_image` as `provision_workspace` — we only need
# git, not Claude Code or nodejs. NOT decorated with
# `max_containers=1`: each /commit invocation operates on a
# distinct per-thread workspace, so there's no cross-call contention
# and the Modal hop overhead is wasted. (Same-thread races are
# avoided at the bot level — Discord serializes a single user's
# slash command invocations per channel.)
@app.function(
    image=provisioner_image,
    volumes={"/vol": volume},
    secrets=[github_pat_secret],
    timeout=120,
)
def commit_workspace(thread_id: int, message: str) -> dict[str, Any]:
    """Stage, commit, and push pending changes in the thread's workspace.

    Pre-flight check: refuses with ``status="no_pat"`` if the
    ``GITHUB_TOKEN`` env var (from the github-pat secret) is empty
    or missing. **No local commit is made in that case** — refuse-
    and-instruct semantics, decided in
    ``apps/delulu_discord/prd/repo-provisioning.md``'s "Commit-back flow"
    section.

    Returns a dict (not a dataclass — Modal needs JSON-serializable
    return values) with one of these shapes:

        {"status": "ok", "branch": ..., "commit_sha": ...,
         "pr_compare_url": ...}
        {"status": "no_pat"}
        {"status": "no_workspace", "error": "..."}
        {"status": "no_changes"}
        {"status": "push_failed", "branch": ..., "commit_sha": ...,
         "error": "..."}
    """
    import os

    # Lazy import — same rationale as in `provision_workspace`.
    from delulu_sandbox_modal import repo_provisioner

    # Pre-flight: refuse-and-instruct on missing PAT. Empty-string
    # is the documented "secret exists but value is a placeholder"
    # state — we treat it as missing.
    github_token = (os.environ.get("GITHUB_TOKEN") or "").strip()
    if not github_token or github_token == "placeholder":
        logger.info(
            "commit.refused_no_pat",
            thread_id=thread_id,
        )
        return {"status": "no_pat"}

    # Optional author identity overrides — see the secret comment
    # at the top of this file.
    author_name = os.environ.get("GIT_AUTHOR_NAME") or repo_provisioner.DEFAULT_GIT_AUTHOR_NAME
    author_email = os.environ.get("GIT_AUTHOR_EMAIL") or repo_provisioner.DEFAULT_GIT_AUTHOR_EMAIL

    # The workspace must be loaded from the most recently committed
    # state of the volume — `provision_workspace` (or any concurrent
    # /commit on this same thread, though that's prevented by
    # bot-side serialization) might have changed it since this
    # container started.
    volume.reload()

    result = repo_provisioner.commit_workspace_changes(
        thread_id=thread_id,
        message=message,
        github_token=github_token,
        author_name=author_name,
        author_email=author_email,
    )

    logger.info(
        "commit.result",
        thread_id=thread_id,
        status=result.status,
        branch=result.branch,
        commit_sha=result.commit_sha,
        error=result.error,
    )

    # Commit the volume so the new commit on the local branch is
    # persisted across container restarts (in case the user runs
    # /commit again later from a fresh container).
    volume.commit()

    # Convert to a plain dict for Modal serialization. dataclass
    # instances aren't auto-serializable across the Modal RPC
    # boundary in all versions — using a dict is the safe lowest-
    # common-denominator.
    return {
        "status": result.status,
        "branch": result.branch,
        "commit_sha": result.commit_sha,
        "pr_compare_url": result.pr_compare_url,
        "error": result.error,
    }


# ── Modal Function (runs inside the sandbox) ─────────────────
# `github_pat_secret` is attached here (in addition to
# `commit_workspace`) so Claude can natively use `git push` and
# `gh pr create` via its Bash tool when the user asks for things
# like "commit and open a PR." Previously the PAT was only
# available in the dedicated /commit flow; expanding access lets
# the @claude natural-language path handle the full branch →
# commit → push → PR loop without a slash command.
#
# Security note: the PAT becomes visible to any `run_claude_code`
# invocation, not just `commit_workspace`. A rogue/prompt-injected
# Claude has access to anything the PAT can do on the allowlisted
# repos. For the v1 single-user scope this is acceptable; see
# `apps/delulu_discord/prd/repo-provisioning.md`'s access-control section for why the
# allowlist + narrow PAT scope is the primary defense.
@app.function(
    image=sandbox_image,
    volumes={"/vol": volume},
    secrets=[claude_oauth_secret, github_pat_secret],
    memory=4096,
    timeout=300,
)
def run_claude_code(
    session_id: str,
    prompt: str,
    *,
    workspace_path: str | None = None,
    thread_id: int | None = None,
    repo_url: str | None = None,
    ref: str = "HEAD",
    is_private: bool = False,
    resume: bool = False,
    attachments: list[tuple[str, bytes]] | None = None,
    message_id: int | None = None,
) -> Iterator[Event]:
    """Execute a Claude Code task inside an ephemeral Modal sandbox.

    This is a Modal **generator function**: callers invoke it via
    ``.remote_gen(...)`` and receive an iterator of event dicts as
    Claude Code progresses. A terminal ``DoneEvent`` carries the final
    assistant text and run stats; on nonzero subprocess exit an
    ``ErrorEvent`` is yielded instead and the function returns.

    Workspace derivation — two paths, transitional during the
    repo-provisioning rollout:

    1.  **Legacy (Phase 1):** caller passes ``workspace_path``
        directly (current bot behavior). Used as-is, no provisioning
        call. Keeps the bot side working without changes while Phase
        2 rewires `dispatcher.run_task` to pass `thread_id` instead.

    2.  **New (Phase 2+):** caller passes ``thread_id`` (and
        optionally ``repo_url`` / ``ref``). The sandbox derives the
        workspace via ``provision_workspace.remote(...)``, which
        handles the bare-cache clone, fetch, and worktree creation
        under Modal's ``max_containers=1`` serialization. The
        subsequent ``volume.reload()`` picks up the committed state
        so this container sees the fresh worktree.

    Once Phase 2 lands, the ``workspace_path`` kwarg can be removed
    in a follow-up — keeping it now minimizes the blast radius of
    the signature change.
    """
    import json
    import os
    import re
    import shutil
    import subprocess
    import threading

    # ── Refuse-and-instruct: private repo with no PAT ──────
    # Private repos require GITHUB_TOKEN for the clone/fetch path.
    # Catch the missing-PAT case here, before the provision_workspace
    # round-trip, so the user gets a clear instruction instead of an
    # opaque clone failure. Public repos and unbound channels skip
    # this check entirely.
    if is_private and repo_url is not None:
        github_token = (os.environ.get("GITHUB_TOKEN") or "").strip()
        if not github_token or github_token == "placeholder":
            logger.info(
                "dispatch.refused_no_pat",
                session_id=session_id,
                thread_id=thread_id,
                repo_url=repo_url,
            )
            yield {
                "type": "error",
                "message": (
                    "Can't dispatch — `github-pat` Modal secret missing or empty, "
                    "and this channel is bound to a private repo.\n\n"
                    "Run on your laptop:\n"
                    "```\nmodal secret create github-pat GITHUB_TOKEN=<your-pat> --force\n```\n"
                    "Then re-mention `@claude` in this thread."
                ),
            }
            return

    # ── Workspace derivation ────────────────────────────────
    if workspace_path is None:
        if thread_id is None:
            raise ValueError(
                "run_claude_code requires either `workspace_path` (legacy) or "
                "`thread_id` (for provision_workspace.remote). Got neither."
            )
        if repo_url is None:
            # **Fast path: no-repo / general-Q&A mode.** When there's
            # no repo to provision, there's nothing for the
            # max_containers=1 serialization to coordinate — every
            # call would just `os.makedirs` an empty directory in
            # its own private container. Skip the Modal function hop
            # entirely and create the workspace inline. Saves the
            # ~1–2s per-dispatch orchestration overhead for the
            # common no-binding case (which is every channel until
            # Phase 3 ships /setrepo).
            workspace_path = f"/vol/workspaces/{thread_id}"
        else:
            workspace_path = provision_workspace.remote(
                thread_id=thread_id,
                repo_url=repo_url,
                ref=ref,
            )
            # The provisioning function committed the volume. Reload
            # so this container sees the newly-created worktree on
            # its mounted view of /vol — without this, the cwd we're
            # about to use doesn't exist from this container's
            # perspective.
            volume.reload()

    os.makedirs(workspace_path, exist_ok=True)

    # ── Materialize Discord attachments onto the workspace ───
    # Claude Code only sees what's in the prompt and on disk, so any files
    # the user attached have to be written into the workspace and then
    # referenced explicitly in the prompt. We scope each message's files
    # under _attachments/<message_id>/ so repeated uploads in the same
    # thread can't collide on filename.
    attachment_lines: list[str] = []
    if attachments:
        bucket = str(message_id) if message_id is not None else "latest"
        att_dir = os.path.join(workspace_path, "_attachments", bucket)
        os.makedirs(att_dir, exist_ok=True)
        for raw_name, data in attachments:
            safe = re.sub(r"[^A-Za-z0-9._-]", "_", raw_name).strip(".") or "file"
            path = os.path.join(att_dir, safe)
            with open(path, "wb") as f:
                f.write(data)
            rel = os.path.relpath(path, workspace_path)
            attachment_lines.append(f"- {rel} ({len(data)} bytes)")

    if attachment_lines:
        prompt = (
            f"{prompt}\n\n"
            "[The user attached the following files to this message. "
            "Read them from the workspace before responding:]\n" + "\n".join(attachment_lines)
        )

    # ── Persistent Claude Code home on the Modal Volume ──────
    # Point HOME at /vol/claude-home so Claude Code reads and writes its
    # entire state directory (credentials, settings, session history under
    # ~/.claude/projects/<hash-of-cwd>/) directly on the persistent volume.
    # Combined with a deterministic per-thread workspace_path, this is what
    # makes `claude --continue` work across ephemeral sandbox invocations.
    claude_home = "/vol/claude-home"
    claude_config = f"{claude_home}/.claude"
    creds_file = f"{claude_config}/.credentials.json"
    os.makedirs(claude_config, exist_ok=True)

    # One-time migration from the previous /vol/claude-auth/ layout.
    legacy_creds = "/vol/claude-auth/.credentials.json"
    if not os.path.exists(creds_file) and os.path.exists(legacy_creds):
        shutil.copyfile(legacy_creds, creds_file)
        os.chmod(creds_file, 0o600)

    # Seed credentials from the Modal secret on first run.
    if not os.path.exists(creds_file):
        seed = os.environ.get("CLAUDE_CREDENTIALS_JSON")
        if not seed:
            raise RuntimeError(
                "No persisted Claude credentials and CLAUDE_CREDENTIALS_JSON "
                "secret is empty — re-create the claude-oauth Modal secret."
            )
        with open(creds_file, "w") as f:
            f.write(seed)
        os.chmod(creds_file, 0o600)

    cmd = [
        "claude",
        "--print",
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        # --output-format stream-json requires --verbose in Claude Code;
        # without it, CC errors out before producing any events.
        "--verbose",
        # Per-tool allowlist so file edits, writes, and shell commands
        # execute without prompting in -p mode. The earlier attempt at
        # `--dangerously-skip-permissions` (PR #53) was correct in
        # spirit but hit Claude Code's hard refusal:
        #
        #     Claude Code exited with code 1:
        #     --dangerously-skip-permissions cannot be used with
        #     root/sudo privileges for security reasons
        #
        # Modal containers run as root by default, and Claude Code
        # specifically blocks bypassPermissions mode under root
        # regardless of the actual threat model — running the sandbox
        # as non-root would be cleaner but requires a substantial image
        # rewrite (user creation, /vol ownership, node_modules perms,
        # HOME directory migration).
        #
        # `--allowedTools` takes an explicit per-tool allowlist and
        # doesn't have the root check — it's a targeted "these specific
        # tools don't need a prompt" rather than a blanket "bypass all
        # prompts." Per the Claude Code CLI docs, tools listed here
        # execute without prompting; tools NOT listed still fall through
        # to the default mode (which in -p mode means refused).
        #
        # The list below covers every tool Claude Code commonly uses
        # for a code-editing task. Read/Glob/Grep are redundant (they're
        # always allowed anyway) but listed for clarity — the file is
        # supposed to be "here's the whole set of tools this bot is
        # allowed to use," not "here's the minimum delta over the
        # implicit defaults."
        #
        # If Claude Code adds a new tool in a future version that we
        # forgot to list, it'll fall through to the refused path and
        # we'll see a ✗ in the status message rather than silent
        # surprise — fail-closed is the right default.
        #
        # Safe because the Modal sandbox is the trust boundary — see
        # PR #53's commit message for the full argument. Each invocation
        # is an ephemeral container with only /vol mounted, a 300s
        # wall-clock timeout, and no access to production systems.
        "--allowedTools",
        "Bash",
        "Edit",
        "Glob",
        "Grep",
        "NotebookEdit",
        "Read",
        "Task",
        "TodoWrite",
        "WebFetch",
        "WebSearch",
        "Write",
    ]
    if resume:
        # --continue resumes the most recent Claude Code session in the cwd.
        # Since workspace_path is stable per thread (see session_manager) and
        # ~/.claude/projects/<cwd-hash>/ lives on the volume, this finds the
        # prior conversation. --resume wants an explicit Claude-internal UUID
        # which we don't track, so --continue is the right primitive here.
        cmd.append("--continue")

    # ANTHROPIC_API_KEY is stripped — Claude Code prefers it over OAuth if set,
    # which would bypass the Pro/Max subscription auth.
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
    env["HOME"] = claude_home
    env["CLAUDE_PROJECT_DIR"] = workspace_path

    # Surface the GitHub PAT to `gh` CLI and `git`. The `github-pat`
    # Modal secret sets `GITHUB_TOKEN` in the container; `gh` also
    # reads `GH_TOKEN` and prefers it. Setting both covers every
    # codepath Claude's Bash tool might reach for (gh pr create,
    # git push over HTTPS, etc.). If the secret value is a
    # placeholder or empty, these env vars will be empty strings —
    # gh/git will then refuse with their own clean error messages
    # rather than accidentally authenticating as nobody.
    github_token = env.get("GITHUB_TOKEN", "").strip()
    if github_token and github_token != "placeholder":
        env["GH_TOKEN"] = github_token
        # Re-assign GITHUB_TOKEN in case the secret value had
        # trailing whitespace — both gh and git are sensitive to that.
        env["GITHUB_TOKEN"] = github_token
    else:
        # Scrub placeholder/empty values so `gh auth status` and
        # `git push` fail cleanly with "not authenticated" instead
        # of trying to use the literal string "placeholder" as a
        # credential and getting a confusing 401.
        env.pop("GH_TOKEN", None)
        env.pop("GITHUB_TOKEN", None)

    logger.info(
        "sandbox.exec",
        session_id=session_id,
        resume=resume,
        workspace=workspace_path,
        prompt_preview=prompt[:80],
    )

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=workspace_path,
        env=env,
        bufsize=1,
    )

    # Belt-and-suspenders wall clock kill. Modal's function-level timeout
    # (300s) is the real ceiling; this matches the old subprocess.run
    # timeout=280 so we surface a clean ErrorEvent before Modal reaps us.
    killer = threading.Timer(280.0, proc.kill)
    killer.daemon = True
    killer.start()

    tool_names_by_id: dict[str, str] = {}
    accumulated_text: list[str] = []
    final_text = ""
    num_turns = 0
    duration_ms = 0

    # Drain stderr concurrently so the subprocess never blocks trying to write
    # to a full pipe while we're still reading stdout.  Without this, verbose
    # Claude Code output (~64 KB+ on stderr) can deadlock the generator until
    # the 280 s kill timer fires.
    stderr_lines: list[str] = []

    def _drain_stderr() -> None:
        if proc.stderr is not None:
            for _line in proc.stderr:
                stderr_lines.append(_line)

    stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
    stderr_thread.start()

    try:
        assert proc.stdout is not None
        for raw_line in proc.stdout:
            line = raw_line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                logger.warning("sandbox.stream_json.malformed", preview=line[:200])
                continue

            kind = parsed.get("type")

            if kind == "result":
                final_text = parsed.get("result") or "".join(accumulated_text)
                try:
                    num_turns = int(parsed.get("num_turns") or 0)
                except (TypeError, ValueError):
                    num_turns = 0
                try:
                    duration_ms = int(parsed.get("duration_ms") or 0)
                except (TypeError, ValueError):
                    duration_ms = 0
                continue

            if kind == "system":
                continue

            for event in _flatten_stream_event(parsed, tool_names_by_id):
                if event["type"] == "text":
                    accumulated_text.append(event["text"])
                yield event  # type: ignore[misc]

        returncode = proc.wait()
        stderr_thread.join()
        stderr_text = "".join(stderr_lines)
    finally:
        killer.cancel()
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        # Persist everything Claude Code wrote: rotated refresh tokens, new
        # session history files, any settings updates. Must be inside finally
        # so it runs even when the caller abandons the generator (GeneratorExit
        # is thrown at a yield), preventing loss of OAuth tokens and session
        # history on mid-stream cancellation.
        volume.commit()

    if returncode != 0:
        logger.warning(
            "sandbox.nonzero_exit",
            session_id=session_id,
            returncode=returncode,
            stderr=stderr_text[:500],
        )
        yield {
            "type": "error",
            "message": (f"Claude Code exited with code {returncode}: {stderr_text.strip()[:500]}"),
        }
        return

    yield {
        "type": "done",
        "final_text": final_text or "".join(accumulated_text),
        "num_turns": num_turns,
        "duration_ms": duration_ms,
    }
