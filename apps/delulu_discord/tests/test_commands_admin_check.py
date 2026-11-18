"""Tests for the in-bot admin gate on ``/admin_*`` slash commands.

``default_permissions(manage_guild=True)`` is only a default that guild
admins can override per role/channel, so ``commands.admin_only`` re-checks
``Manage Server`` inside the bot. A regression here would let any member
an admin accidentally exposed the command to edit the repo allowlist.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import discord
import pytest
from discord import app_commands

from delulu_discord.commands import (
    AdminCheckFailure,
    _is_guild_admin,
    _require_manage_guild,
    handle_app_command_error,
    register_slash_commands,
)

ADMIN_COMMANDS = ("admin_addrepo", "admin_removerepo", "admin_listrepos")
USER_COMMANDS = ("setrepo", "unsetrepo", "commit")


def _interaction(
    *,
    guild_id: int | None = 123,
    manage_guild: bool | None = True,
    response_done: bool = False,
) -> MagicMock:
    """Fake ``discord.Interaction``; ``manage_guild=None`` means a non-Member user."""
    inter = MagicMock()
    inter.guild_id = guild_id
    inter.guild = MagicMock() if guild_id is not None else None
    if manage_guild is None:
        inter.user = SimpleNamespace(id=42)  # discord.User: no guild_permissions
    else:
        inter.user = SimpleNamespace(
            id=42,
            guild_permissions=discord.Permissions(manage_guild=manage_guild),
        )
    inter.command = SimpleNamespace(qualified_name="admin_addrepo")
    inter.response.is_done = MagicMock(return_value=response_done)
    inter.response.send_message = AsyncMock()
    inter.followup.send = AsyncMock()
    return inter


# ── predicate ────────────────────────────────────────────────


def test_allows_member_with_manage_guild():
    assert _require_manage_guild(_interaction(manage_guild=True)) is True


def test_rejects_member_without_manage_guild():
    with pytest.raises(AdminCheckFailure, match="Manage Server"):
        _require_manage_guild(_interaction(manage_guild=False))


def test_rejects_dm():
    with pytest.raises(AdminCheckFailure, match="only be used in a server"):
        _require_manage_guild(_interaction(guild_id=None))


def test_rejects_user_without_guild_permissions():
    """A plain ``discord.User`` (no member perms) must fail closed."""
    with pytest.raises(AdminCheckFailure, match="Manage Server"):
        _require_manage_guild(_interaction(manage_guild=None))


@pytest.mark.parametrize(
    ("guild_id", "manage_guild", "expected"),
    [(123, True, True), (123, False, False), (None, True, False), (123, None, False)],
)
def test_is_guild_admin_does_not_raise(guild_id, manage_guild, expected):
    inter = _interaction(guild_id=guild_id, manage_guild=manage_guild)
    assert _is_guild_admin(inter) is expected


def test_admin_check_failure_is_check_failure():
    """discord.py only routes CheckFailure subclasses as "check failed"."""
    assert issubclass(AdminCheckFailure, app_commands.CheckFailure)


# ── error handler ────────────────────────────────────────────


async def test_denial_replies_ephemerally():
    inter = _interaction(manage_guild=False)
    handled = await handle_app_command_error(inter, AdminCheckFailure("nope"))
    assert handled is True
    inter.response.send_message.assert_awaited_once_with("nope", ephemeral=True)


async def test_denial_uses_followup_when_already_responded():
    inter = _interaction(manage_guild=False, response_done=True)
    await handle_app_command_error(inter, AdminCheckFailure("nope"))
    inter.followup.send.assert_awaited_once_with("nope", ephemeral=True)
    inter.response.send_message.assert_not_awaited()


async def test_other_errors_are_not_handled():
    inter = _interaction()
    handled = await handle_app_command_error(inter, app_commands.CheckFailure("other"))
    assert handled is False
    inter.response.send_message.assert_not_awaited()


# ── registration wiring ──────────────────────────────────────


@pytest.fixture()
def repo_allowlist() -> MagicMock:
    allowlist = MagicMock()
    allowlist.get = AsyncMock(return_value=["acme/secret-repo"])
    return allowlist


@pytest.fixture()
def tree(repo_allowlist) -> app_commands.CommandTree:
    client = MagicMock()
    client._connection._command_tree = None  # MagicMock attrs are truthy
    tree = app_commands.CommandTree(client)
    register_slash_commands(
        tree,
        repo_config=MagicMock(),
        repo_allowlist=repo_allowlist,
        session_manager=MagicMock(),
        dispatcher=MagicMock(),
    )
    return tree


@pytest.mark.parametrize("name", ADMIN_COMMANDS)
def test_admin_commands_carry_check(tree, name):
    command = tree.get_command(name)
    assert command is not None
    assert _require_manage_guild in command.checks


@pytest.mark.parametrize("name", USER_COMMANDS)
def test_user_commands_have_no_admin_check(tree, name):
    command = tree.get_command(name)
    assert command is not None
    assert _require_manage_guild not in command.checks


@pytest.mark.parametrize("name", ADMIN_COMMANDS)
async def test_admin_command_check_blocks_non_admin(tree, name):
    """The check runs via discord.py's own check machinery and blocks the callback."""
    command = tree.get_command(name)
    with pytest.raises(AdminCheckFailure):
        await command._check_can_run(_interaction(manage_guild=False))
    assert await command._check_can_run(_interaction(manage_guild=True)) is True


async def test_tree_error_handler_replies_on_denial(tree):
    inter = _interaction(manage_guild=False)
    await tree.on_error(inter, AdminCheckFailure("denied"))
    inter.response.send_message.assert_awaited_once_with("denied", ephemeral=True)


# ── autocomplete gate ────────────────────────────────────────


def _repo_autocomplete(tree):
    return tree.get_command("admin_removerepo")._params["repo"].autocomplete


@pytest.mark.parametrize(
    ("guild_id", "manage_guild"),
    [(123, False), (None, True), (123, None)],
)
async def test_admin_removerepo_autocomplete_hidden_from_non_admins(
    tree, repo_allowlist, guild_id, manage_guild
):
    """discord.py skips checks for autocomplete, so the callback gates itself."""
    inter = _interaction(guild_id=guild_id, manage_guild=manage_guild)
    assert await _repo_autocomplete(tree)(inter, "") == []
    repo_allowlist.get.assert_not_awaited()


async def test_admin_removerepo_autocomplete_lists_repos_for_admins(tree, repo_allowlist):
    choices = await _repo_autocomplete(tree)(_interaction(manage_guild=True), "")
    assert [c.value for c in choices] == ["acme/secret-repo"]
    repo_allowlist.get.assert_awaited_once_with(123)
