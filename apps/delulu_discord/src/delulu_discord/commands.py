"""Discord slash command handlers for repo binding and admin allowlist management.

Five commands ship in Phase 3:

- ``/setrepo repo:<owner>/<repo> ref:<HEAD>`` — bind the current
  channel to a repo. User-facing, no permission gate, but rejects
  any repo not on the server's allowlist (set via
  ``/admin_addrepo`` below).
- ``/unsetrepo`` — clear the current channel's binding.
- ``/admin_addrepo repo:<owner>/<repo>`` — admin only. Validates
  the repo via the sandbox-side ``validate_repo_access`` Modal
  function and adds it to this server's allowlist tagged with its
  visibility (``public`` / ``private``).
- ``/admin_removerepo repo:<owner>/<repo>`` — admin only.
  Autocomplete-fed remove from the allowlist.
- ``/admin_listrepos`` — admin only. Show the current allowlist.

All admin commands are gated twice:

1. ``@app_commands.default_permissions(manage_guild=True)`` hides
   them from unprivileged users by default. This is only a
   *default*: guild admins can override it per role/channel under
   Server Settings → Integrations, so it is UX, not authorization.
2. ``@admin_only()`` — an ``app_commands.check`` that runs in the
   bot before the handler and requires the invoking member to hold
   ``Manage Server`` (``guild_permissions.manage_guild``) and the
   interaction to come from a guild. Denials raise
   ``AdminCheckFailure``, which the tree error handler installed by
   ``register_slash_commands`` turns into an ephemeral reply. This
   is the actual authorization boundary.

**Why a sandbox-side Modal function instead of an HTTP probe from
the bot?** Validating private repos requires the ``github-pat``
Modal secret. The sandbox image has both git and the secret
mounted; the bot image is ``python:3.14-slim`` with neither.
Routing validation through ``validate_repo_access.remote()``
keeps the secret-mount surface to one container type and lets the
probe use ``git ls-remote`` directly — same operation Claude Code
will eventually perform on the same repo. See
``prd/private-repos.md`` "User decisions locked in" for the
locked-in choice.

**Repo identity format.** Slash commands accept ``owner/repo``
short form and the allowlist stores the same. ``RepoConfig``
stores the full URL (``https://github.com/owner/repo``)
reconstructed at bind time, because that's what the sandbox needs
for ``git clone``. The display side (LiveStatus repo subtitle)
parses ``owner/repo`` back out of the full URL — see
``streaming._short_repo_name``.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

import discord
import structlog
from discord import app_commands

from delulu_discord.repo_allowlist import VISIBILITY_PRIVATE, VISIBILITY_PUBLIC

if TYPE_CHECKING:
    from delulu_discord.dispatcher import SandboxDispatcher
    from delulu_discord.repo_allowlist import RepoAllowlist
    from delulu_discord.repo_config import RepoConfig
    from delulu_discord.session_manager import SessionManager

logger = structlog.get_logger()

# Discord caps slash command autocomplete at 25 choices.
AUTOCOMPLETE_CHOICE_LIMIT = 25

# owner/repo format: alphanumeric, dots, dashes, underscores in
# both segments. Matches GitHub's repo naming rules. Path-traversal
# attempts (`..`, leading dots) are rejected by the character class.
OWNER_REPO_RE = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]*/[A-Za-z0-9_-][A-Za-z0-9._-]*$")


class AdminCheckFailure(app_commands.CheckFailure):
    """Raised by ``admin_only`` when the invoker may not run an admin command.

    Carries the user-facing denial text so the tree error handler
    can reply without re-deriving why the check failed.
    """

    def __init__(self, user_message: str) -> None:
        super().__init__(user_message)
        self.user_message = user_message


def _require_manage_guild(interaction: discord.Interaction) -> bool:
    """``app_commands.check`` predicate: guild-only + Manage Server.

    Does not trust ``default_permissions`` (which guild admins can
    override); re-checks the member's guild-level permissions on
    every invocation. Fails closed: a DM, a non-``Member`` user, or
    a missing permissions object all deny.
    """
    if interaction.guild_id is None or interaction.guild is None:
        raise AdminCheckFailure("❌ This command can only be used in a server.")
    perms = getattr(interaction.user, "guild_permissions", None)
    if perms is None or not perms.manage_guild:
        raise AdminCheckFailure("❌ You need the **Manage Server** permission to use this command.")
    return True


def _is_guild_admin(interaction: discord.Interaction) -> bool:
    """Non-raising form of :func:`_require_manage_guild`.

    discord.py does not run ``app_commands.check`` predicates for
    autocomplete callbacks, so admin autocompletes call this directly.
    """
    try:
        return _require_manage_guild(interaction)
    except AdminCheckFailure:
        return False


def admin_only():
    """Decorator gating an app command on ``Manage Server`` (see module docstring)."""
    return app_commands.check(_require_manage_guild)


async def _send_ephemeral(interaction: discord.Interaction, content: str) -> None:
    """Reply ephemerally whether or not the interaction was already responded to."""
    if interaction.response.is_done():
        await interaction.followup.send(content, ephemeral=True)
    else:
        await interaction.response.send_message(content, ephemeral=True)


async def handle_app_command_error(
    interaction: discord.Interaction,
    error: app_commands.AppCommandError,
) -> bool:
    """Handle errors this module knows about. Returns True if handled."""
    if isinstance(error, AdminCheckFailure):
        command = interaction.command.qualified_name if interaction.command else None
        logger.warning(
            "commands.admin_denied",
            command=command,
            user_id=getattr(interaction.user, "id", None),
            guild_id=interaction.guild_id,
        )
        await _send_ephemeral(interaction, error.user_message)
        return True
    return False


def register_slash_commands(
    tree: app_commands.CommandTree,
    *,
    repo_config: RepoConfig,
    repo_allowlist: RepoAllowlist,
    session_manager: SessionManager,
    dispatcher: SandboxDispatcher,
) -> None:
    """Register all repo-related slash commands on the given tree.

    Called once at bot startup from ``main.create_bot``. After this
    returns the ``CommandTree`` has the commands defined; the
    ``on_ready`` handler is responsible for calling ``tree.sync()``
    to push them to Discord. Closures over the data store deps
    (``repo_config``, ``repo_allowlist``) and the bot-state deps
    (``session_manager``, ``dispatcher``) keep each command body
    self-contained without needing a holder class.

    The ``session_manager`` and ``dispatcher`` deps are only used
    by ``/commit``, which needs to look up the current thread's
    session (for ``thread_id`` and the implicit repo binding) and
    then dispatch the commit to the sandbox.
    """

    # Route admin-check denials to an ephemeral reply; defer every
    # other error to discord.py's default handler (which logs it).
    @tree.error
    async def on_app_command_error(
        interaction: discord.Interaction,
        error: app_commands.AppCommandError,
    ) -> None:
        if await handle_app_command_error(interaction, error):
            return
        await app_commands.CommandTree.on_error(tree, interaction, error)

    # ── /setrepo ────────────────────────────────────────────
    @tree.command(
        name="setrepo",
        description="Bind a GitHub repo to this channel for @claude tasks",
    )
    @app_commands.describe(
        repo="Repository in owner/repo format (must be on the server's allowlist)",
        ref="Git ref to use (default: HEAD)",
    )
    async def setrepo(
        interaction: discord.Interaction,
        repo: str,
        ref: str = "HEAD",
    ) -> None:
        if interaction.guild_id is None or interaction.channel_id is None:
            await interaction.response.send_message(
                "❌ This command can only be used in a server channel.",
                ephemeral=True,
            )
            return

        repo = repo.strip()
        if not OWNER_REPO_RE.match(repo):
            await interaction.response.send_message(
                f"❌ `{repo}` is not in `owner/repo` format. Example: `alice/api-service`.",
                ephemeral=True,
            )
            return

        if not await repo_allowlist.contains(interaction.guild_id, repo):
            current = await repo_allowlist.get(interaction.guild_id)
            if current:
                listing = "\n".join(f"  • `{r}`" for r in current)
                msg = (
                    f"❌ `{repo}` is not on this server's allowlist.\n\n"
                    f"Currently allowed:\n{listing}\n\n"
                    "Ask a server admin to run `/admin_addrepo` to add it."
                )
            else:
                msg = (
                    "❌ This server has no allowed repos yet. "
                    "Ask a server admin to run `/admin_addrepo` first."
                )
            await interaction.response.send_message(msg, ephemeral=True)
            return

        # Reconstruct the canonical full URL for storage. The sandbox
        # needs this form for `git clone`; the bot's display code
        # parses owner/repo back out of it via _short_repo_name.
        full_url = f"https://github.com/{repo}"
        await repo_config.set(interaction.channel_id, full_url, ref)

        await interaction.response.send_message(
            f"✅ Channel bound to `{repo}@{ref}`. "
            "New `@claude` mentions in this channel will run against this repo.",
            ephemeral=True,
        )

    @setrepo.autocomplete("repo")
    async def setrepo_autocomplete(
        interaction: discord.Interaction,
        current: str,
    ) -> list[app_commands.Choice[str]]:
        if interaction.guild_id is None:
            return []
        return _build_autocomplete_choices(
            await repo_allowlist.get(interaction.guild_id),
            current,
        )

    # ── /unsetrepo ──────────────────────────────────────────
    @tree.command(
        name="unsetrepo",
        description="Clear this channel's repo binding",
    )
    async def unsetrepo(interaction: discord.Interaction) -> None:
        if interaction.channel_id is None:
            await interaction.response.send_message(
                "❌ This command can only be used in a channel.",
                ephemeral=True,
            )
            return

        await repo_config.unset(interaction.channel_id)
        await interaction.response.send_message(
            "✅ Channel unbound. New `@claude` mentions will run with no repo (general Q&A mode).",
            ephemeral=True,
        )

    # ── /admin_addrepo ──────────────────────────────────────
    @tree.command(
        name="admin_addrepo",
        description="Add a GitHub repo to this server's allowlist (admin only)",
    )
    @app_commands.default_permissions(manage_guild=True)
    @admin_only()
    @app_commands.describe(repo="Repository in owner/repo format")
    async def admin_addrepo(interaction: discord.Interaction, repo: str) -> None:
        if interaction.guild_id is None:
            await interaction.response.send_message(
                "❌ This command can only be used in a server.",
                ephemeral=True,
            )
            return

        repo = repo.strip()
        if not OWNER_REPO_RE.match(repo):
            await interaction.response.send_message(
                f"❌ `{repo}` is not in `owner/repo` format.",
                ephemeral=True,
            )
            return

        # Defer — the sandbox round-trip + git ls-remote can take a
        # couple seconds and Discord wants an initial response
        # within 3s. defer() shows a "Bot is thinking..." spinner
        # and gives us 15 minutes to send the followup.
        await interaction.response.defer(ephemeral=True, thinking=True)

        repo_url = f"https://github.com/{repo}"
        try:
            result = await dispatcher.validate_repo_access(repo_url)
        except Exception as exc:
            logger.exception("admin_addrepo.validate_failed", repo=repo)
            await interaction.followup.send(
                f"⚠️ Couldn't reach the sandbox to validate `{repo}`: `{type(exc).__name__}: {exc}`",
                ephemeral=True,
            )
            return

        status = result.get("status")
        if status == VISIBILITY_PUBLIC:
            visibility_label = "public"
        elif status == VISIBILITY_PRIVATE:
            visibility_label = "private"
        elif status == "not_found":
            await interaction.followup.send(
                f"❌ Couldn't add `{repo}`: GitHub returned not-found.\n"
                "Either the repo doesn't exist, or it's private and the "
                "`github-pat` Modal secret can't see it. Check the URL and "
                "the PAT's repo scope, then retry.",
                ephemeral=True,
            )
            return
        else:  # status == "error" (or anything unexpected)
            err = result.get("error") or "validation failed"
            await interaction.followup.send(
                f"❌ Couldn't add `{repo}`: {err}",
                ephemeral=True,
            )
            return

        await repo_allowlist.add(interaction.guild_id, repo, visibility=status)
        await interaction.followup.send(
            f"✅ `{repo}` ({visibility_label}) added to this server's allowlist.\n"
            "Users can now `/setrepo` against it.",
            ephemeral=True,
        )

    # ── /admin_removerepo ───────────────────────────────────
    @tree.command(
        name="admin_removerepo",
        description="Remove a repo from this server's allowlist (admin only)",
    )
    @app_commands.default_permissions(manage_guild=True)
    @admin_only()
    @app_commands.describe(repo="Repository to remove")
    async def admin_removerepo(interaction: discord.Interaction, repo: str) -> None:
        if interaction.guild_id is None:
            await interaction.response.send_message(
                "❌ This command can only be used in a server.",
                ephemeral=True,
            )
            return

        repo = repo.strip()
        if not await repo_allowlist.contains(interaction.guild_id, repo):
            await interaction.response.send_message(
                f"`{repo}` isn't on this server's allowlist — nothing to remove.",
                ephemeral=True,
            )
            return

        await repo_allowlist.remove(interaction.guild_id, repo)
        await interaction.response.send_message(
            f"✅ `{repo}` removed from this server's allowlist.\n\n"
            "*Note: existing channel bindings to this repo are NOT cleared. "
            "Run `/unsetrepo` in any affected channels.*",
            ephemeral=True,
        )

    @admin_removerepo.autocomplete("repo")
    async def admin_removerepo_autocomplete(
        interaction: discord.Interaction,
        current: str,
    ) -> list[app_commands.Choice[str]]:
        # Autocomplete bypasses admin_only(), so gate it here or any
        # member could enumerate the allowlist by typing the command.
        if not _is_guild_admin(interaction):
            return []
        return _build_autocomplete_choices(
            await repo_allowlist.get(interaction.guild_id),
            current,
        )

    # ── /admin_listrepos ────────────────────────────────────
    @tree.command(
        name="admin_listrepos",
        description="Show this server's allowed repos (admin only)",
    )
    @app_commands.default_permissions(manage_guild=True)
    @admin_only()
    async def admin_listrepos(interaction: discord.Interaction) -> None:
        if interaction.guild_id is None:
            await interaction.response.send_message(
                "❌ This command can only be used in a server.",
                ephemeral=True,
            )
            return

        current = await repo_allowlist.list_with_visibility(interaction.guild_id)
        if not current:
            await interaction.response.send_message(
                "*This server has no allowed repos yet. Add one with `/admin_addrepo`.*",
                ephemeral=True,
            )
            return

        listing = "\n".join(_format_listrepos_line(r, v) for r, v in current)
        await interaction.response.send_message(
            f"**Allowed repos for this server:**\n{listing}",
            ephemeral=True,
        )

    # ── /commit ─────────────────────────────────────────────
    @tree.command(
        name="commit",
        description="Commit and push the current thread's workspace changes",
    )
    @app_commands.describe(message="Commit message")
    async def commit(interaction: discord.Interaction, message: str) -> None:
        # /commit only makes sense inside a Claude Code thread —
        # the workspace it operates on is the per-thread one.
        if not isinstance(interaction.channel, discord.Thread):
            await interaction.response.send_message(
                "❌ `/commit` must be run inside a Claude Code thread.",
                ephemeral=True,
            )
            return

        # The session must exist (so we know there's a workspace
        # this thread is bound to) and must have a repo binding
        # (so there's something meaningful to commit and push).
        session = await session_manager.get_session(interaction.channel.id)
        if session is None:
            await interaction.response.send_message(
                "❌ No active session in this thread. Mention `@claude` first to create one.",
                ephemeral=True,
            )
            return
        if session.repo_url is None:
            await interaction.response.send_message(
                "❌ This thread has no repo binding — there's nothing to push to. "
                "Use `/setrepo` in the parent channel to bind a repo, then start "
                "a fresh `@claude` thread against it.",
                ephemeral=True,
            )
            return

        # Strip a trailing whitespace-only message defensively;
        # discord.py allows zero-length strings through and git
        # commit -m "" creates an empty-message commit which is
        # confusing in git log.
        message = message.strip()
        if not message:
            await interaction.response.send_message(
                "❌ Commit message can't be empty.",
                ephemeral=True,
            )
            return

        # Defer — the sandbox roundtrip + git push can take 5–10s.
        await interaction.response.defer(thinking=True)

        try:
            result = await dispatcher.commit_workspace(
                thread_id=session.thread_id,
                message=message,
            )
        except Exception as exc:
            logger.exception("commit.dispatch_failed", thread_id=session.thread_id)
            await interaction.followup.send(
                f"⚠️ /commit dispatch failed: `{type(exc).__name__}: {exc}`"
            )
            return

        await _render_commit_result(interaction, result)

    logger.info("commands.registered", count=6)


def _build_autocomplete_choices(
    items: list[str],
    current: str,
) -> list[app_commands.Choice[str]]:
    """Return up to 25 autocomplete choices matching ``current`` substring.

    Discord truncates anything beyond 25, and the search is intentionally
    a substring match (not just prefix) so users can find a repo by
    typing any part of the name.
    """
    needle = current.lower()
    matches = [r for r in items if needle in r.lower()]
    return [app_commands.Choice(name=r, value=r) for r in matches[:AUTOCOMPLETE_CHOICE_LIMIT]]


async def _render_commit_result(
    interaction: discord.Interaction,
    result: dict,
) -> None:
    """Translate a sandbox-side commit_workspace result dict into a Discord followup.

    The result shape is documented on
    ``delulu_sandbox_modal.app.commit_workspace`` — five possible
    ``status`` values, each with its own user-facing rendering.
    Kept as a free function (not a method) because it has no
    state of its own and lives next to the slash command for
    readability.
    """
    status = result.get("status")

    if status == "ok":
        branch = result.get("branch", "claude/<thread>")
        commit_sha = (result.get("commit_sha") or "")[:7]
        pr_url = result.get("pr_compare_url")
        body = f"✅ Committed `{commit_sha}` and pushed to branch `{branch}`."
        if pr_url:
            body += f"\n\nOpen a PR: {pr_url}"
        await interaction.followup.send(body)
        return

    if status == "no_pat":
        # Refuse-and-instruct, exactly as decided in the PRD.
        await interaction.followup.send(
            "❌ Can't commit — `github-pat` Modal secret missing or empty.\n\n"
            "Run on your laptop:\n"
            "```\nmodal secret create github-pat GITHUB_TOKEN=<your-pat>\n```\n"
            "Then re-run `/commit`. Your workspace changes are still there."
        )
        return

    if status == "no_changes":
        await interaction.followup.send(
            "ℹ️ Nothing to commit — the workspace has no pending changes."
        )
        return

    if status == "no_workspace":
        # Edge case: session exists but the per-thread workspace
        # was never materialized (e.g. session created but no
        # @claude dispatch followed). Tell the user to run a
        # dispatch first.
        error = result.get("error", "workspace not found")
        await interaction.followup.send(
            f"❌ No workspace for this thread — `{error}`.\n\n"
            "Mention `@claude` in the thread first to materialize the workspace, "
            "then re-run `/commit`."
        )
        return

    if status == "push_failed":
        # Local commit landed but push failed — most likely an
        # invalid PAT (401) or insufficient scopes. The local
        # commit is preserved on the workspace branch, so a
        # subsequent /commit after rotating the PAT will catch
        # everything up.
        branch = result.get("branch", "claude/<thread>")
        commit_sha = (result.get("commit_sha") or "")[:7]
        error = result.get("error", "unknown push error")
        await interaction.followup.send(
            f"⚠️ Local commit `{commit_sha}` landed on `{branch}` but push failed.\n\n"
            f"Git error: ```\n{error}\n```\n"
            "Most likely the PAT is invalid or lacks `contents: write` on this repo. "
            "Rotate the secret and re-run `/commit` — the queued commit will push too."
        )
        return

    # Defensive: any unrecognized status. Better to surface "unexpected"
    # than to silently succeed.
    await interaction.followup.send(f"⚠️ Unexpected /commit result: `{result}`")


def _format_listrepos_line(owner_repo: str, visibility: str) -> str:
    """Render a single line in /admin_listrepos.

    Public repos render as plain entries; private repos get a 🔒
    prefix to match the LiveStatus subtitle's visual convention.
    """
    if visibility == VISIBILITY_PRIVATE:
        return f"• 🔒 `{owner_repo}` (private)"
    return f"• `{owner_repo}`"
