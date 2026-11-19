"""Bot entrypoint — sets up the Discord client and registers event handlers."""

from __future__ import annotations

import asyncio
import re
import sys

import discord
import structlog
from discord import app_commands

from delulu_discord.commands import register_slash_commands
from delulu_discord.dispatcher import SandboxDispatcher
from delulu_discord.handlers import MessageHandler
from delulu_discord.repo_allowlist import RepoAllowlist
from delulu_discord.repo_config import RepoConfig
from delulu_discord.session_manager import SessionManager
from delulu_discord.settings import Settings

logger = structlog.get_logger()


def _strip_mention(content: str, bot_id: int) -> str:
    """Remove the bot's own @-mention tokens from a message, leaving the prompt."""
    # Discord user mentions: <@ID> or <@!ID>
    return re.sub(rf"<@!?{bot_id}>", "", content).strip()


def create_bot(settings: Settings) -> tuple[discord.Client, SessionManager]:
    """Create and configure the Discord client.

    Returns ``(client, session_manager)`` so the caller can drive
    the SessionManager's ``connect()`` / ``close()`` lifecycle in
    the same event loop as ``client.start``.
    """
    intents = discord.Intents.default()
    intents.message_content = True
    intents.guilds = True

    client = discord.Client(intents=intents)
    # CommandTree owns the slash commands. Created here so the
    # closure-over-deps registration in commands.register_slash_commands
    # has a tree to attach to, and on_ready can call .sync() to push
    # the commands to Discord at bot startup.
    tree = app_commands.CommandTree(client)

    # ── Wire up components ───────────────────────────────────
    session_manager = SessionManager(
        db_path=settings.session_db_path,
        ttl_seconds=settings.session_ttl_seconds,
    )
    dispatcher = SandboxDispatcher(settings=settings)
    # Modal-Dict-backed channel→(repo_url, ref) binding store. Set
    # via /setrepo, looked up at @claude dispatch time.
    repo_config = RepoConfig()
    # Modal-Dict-backed per-server allowlist. Populated via the
    # admin slash commands gated on MANAGE_GUILD; consulted by
    # /setrepo to decide whether a binding is permitted.
    repo_allowlist = RepoAllowlist()
    handler = MessageHandler(
        settings=settings,
        session_manager=session_manager,
        dispatcher=dispatcher,
        repo_config=repo_config,
        repo_allowlist=repo_allowlist,
    )

    register_slash_commands(
        tree,
        repo_config=repo_config,
        repo_allowlist=repo_allowlist,
        session_manager=session_manager,
        dispatcher=dispatcher,
    )

    # ── Event handlers ───────────────────────────────────────
    @client.event
    async def on_ready():
        # Push slash command definitions to Discord. This is a
        # global sync, which can take up to ~1 hour to propagate
        # to every server the bot is installed in (Discord
        # caches command definitions per-guild). For development
        # against a single test guild, swap to
        # ``await tree.sync(guild=discord.Object(id=...))`` for
        # near-instant updates. Sync-on-startup is fine here:
        # the bot doesn't restart often, and Discord deduplicates
        # no-op syncs internally.
        try:
            synced = await tree.sync()
            logger.info("commands.synced", count=len(synced))
        except Exception:
            logger.exception("commands.sync_failed")
        logger.info("bot.ready", user=str(client.user), guilds=len(client.guilds))

    @client.event
    async def on_message(message: discord.Message):
        # Ignore own messages and other bots
        if message.author == client.user or message.author.bot:
            return

        bot_user = client.user
        if bot_user is None:
            return

        bot_mentioned = bot_user in message.mentions
        channel = message.channel

        # Thread reply: auto-continue if this thread is already ours, otherwise
        # require an explicit @-mention to pull us into the conversation.
        if isinstance(channel, discord.Thread):
            # Check ``channel.owner_id`` first — purely in-memory and
            # avoids the DB hit on the common case (bot-created
            # threads). Only fall through to ``get_session`` when we
            # might own the thread but didn't create it ourselves
            # (e.g. session inherited a thread created by the user).
            owns_thread = channel.owner_id == bot_user.id
            if not owns_thread:
                owns_thread = await session_manager.get_session(channel.id) is not None
            if not (owns_thread or bot_mentioned):
                return
            prompt = _strip_mention(message.content, bot_user.id)
            if not prompt:
                return
            await handler.handle_thread_reply(message, prompt)
            return

        # Top-level channel message: only respond when explicitly mentioned.
        if isinstance(channel, discord.TextChannel):
            if not bot_mentioned:
                return
            prompt = _strip_mention(message.content, bot_user.id)
            if not prompt:
                return
            await handler.handle_channel_message(message, prompt)

    return client, session_manager


async def _run(settings: Settings) -> None:
    """Bring up SessionManager, start the Discord client, tear down cleanly.

    The ``finally`` runs on KeyboardInterrupt and on Discord-side
    exceptions alike, so the SQLite WAL gets checkpointed and the
    connection released even on hard restarts.
    """
    client, session_manager = create_bot(settings)
    await session_manager.connect()
    try:
        await client.start(settings.discord_bot_token.get_secret_value())
    finally:
        await session_manager.close()


def main() -> None:
    """Entrypoint for `delulu-discord` console script."""
    structlog.configure(
        processors=[
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.add_log_level,
            structlog.dev.ConsoleRenderer(),
        ],
    )

    try:
        settings = Settings()  # type: ignore[call-arg]
    except Exception as e:
        logger.error("config.invalid", error=str(e))
        sys.exit(1)

    asyncio.run(_run(settings))


if __name__ == "__main__":
    main()
