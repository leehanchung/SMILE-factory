"""Claude Code session runner.

Instead of a custom Python agent loop, this runs the real `claude` CLI
binary inside the sandbox. The Discord plugin (or any MCP plugin) provides
the I/O channel.

Each session is:
  claude --channels plugin:discord@claude-plugins-official \
         --system-prompt "..." \
         --allowedTools "..." \
         --model claude-sonnet-4-20250514

The Discord MCP server (server.ts on Bun) runs as a child process of
Claude Code, bridging Discord messages ↔ Claude tool calls.

Environment per session:
  ANTHROPIC_API_KEY     — API key for Claude
  DISCORD_BOT_TOKEN     — unique bot token per session
  DISCORD_STATE_DIR     — isolated state dir per session
  CLAUDE_CODE_HOME      — isolated config dir per session
"""

import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class ClaudeCodeSessionConfig:
    """Configuration for a single Claude Code + Discord session."""

    # Identity
    session_id: str
    name: str = ""  # Human-readable name for this bot instance

    # Claude Code settings
    model: str = "claude-sonnet-4-20250514"
    system_prompt: str = ""
    system_prompt_file: Optional[str] = None  # Path to CLAUDE.md or similar
    max_turns: int = 0  # 0 = unlimited
    allowed_tools: list[str] = field(default_factory=list)  # Empty = all tools

    # API access
    anthropic_api_key: str = ""  # Per-session key, or shared

    # Discord integration
    discord_bot_token: str = ""
    discord_access_policy: str = "allowlist"  # "pairing" or "allowlist"
    discord_allowed_users: list[str] = field(default_factory=list)  # Discord user snowflake IDs
    discord_allowed_servers: list[str] = field(default_factory=list)  # Guild IDs
    discord_allowed_channels: list[str] = field(default_factory=list)  # Channel IDs

    # Plugins (Discord is default, but can add more)
    plugins: list[str] = field(
        default_factory=lambda: ["discord@claude-plugins-official"]
    )

    # Workspace
    workspace_dir: str = "/workspace"  # Working directory inside sandbox
    git_repos: list[str] = field(default_factory=list)  # Repos to clone into workspace

    # Resource hints (used by scheduler, not by Claude Code itself)
    cpu_millicores: int = 1000
    memory_mb: int = 2048
    gpu_count: int = 0
    timeout_seconds: int = 0  # 0 = run forever (long-lived bot)

    # MCP servers (additional, beyond Discord)
    mcp_servers: dict = field(default_factory=dict)  # name → {command, args, env}


def build_claude_code_command(config: ClaudeCodeSessionConfig) -> list[str]:
    """Build the `claude` CLI command for a session.

    Returns the command + args to exec inside the sandbox.
    """
    cmd = ["claude"]

    # Channel plugins
    for plugin in config.plugins:
        cmd += ["--channels", f"plugin:{plugin}"]

    # Model
    if config.model:
        cmd += ["--model", config.model]

    # System prompt
    if config.system_prompt:
        cmd += ["--system-prompt", config.system_prompt]

    # Max turns
    if config.max_turns > 0:
        cmd += ["--max-turns", str(config.max_turns)]

    # Allowed tools
    if config.allowed_tools:
        cmd += ["--allowedTools", ",".join(config.allowed_tools)]

    return cmd


def build_session_environment(
    config: ClaudeCodeSessionConfig,
    state_dir: str = "/home/agent/.claude",
) -> dict[str, str]:
    """Build environment variables for the Claude Code process.

    Each session gets isolated state directories so multiple instances
    don't stomp on each other's config/state.
    """
    env = {
        # Claude Code
        "ANTHROPIC_API_KEY": config.anthropic_api_key,
        "HOME": "/home/agent",
        "CLAUDE_CODE_HOME": state_dir,

        # Discord plugin
        "DISCORD_BOT_TOKEN": config.discord_bot_token,
        "DISCORD_STATE_DIR": f"{state_dir}/channels/discord",

        # General
        "SESSION_ID": config.session_id,
        "TERM": "xterm-256color",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
    }

    # Filter out empty values
    return {k: v for k, v in env.items() if v}


def build_access_config(config: ClaudeCodeSessionConfig) -> dict:
    """Build the Discord access.json for this session.

    This controls who can talk to the bot — critical when running
    multiple bots, each with different access policies.
    """
    access = {
        "policy": config.discord_access_policy,
        "allowlist": {},
    }

    # Add allowed users (DM access)
    for user_id in config.discord_allowed_users:
        access["allowlist"][user_id] = {"type": "user"}

    # Add allowed servers/guilds
    for guild_id in config.discord_allowed_servers:
        entry = {"type": "guild"}
        # If specific channels are allowed within this guild
        channels_for_guild = [
            ch for ch in config.discord_allowed_channels
        ]
        if channels_for_guild:
            entry["channels"] = channels_for_guild
        access["allowlist"][guild_id] = entry

    return access


def _write_secret_file(path: Path, content: str) -> None:
    """Write a credentials file readable only by its owner (mode 0600, umask-independent)."""
    fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)  # O_CREAT's mode doesn't apply if the file already existed
    with os.fdopen(fd, "w") as f:
        f.write(content)


def prepare_session_filesystem(
    config: ClaudeCodeSessionConfig,
    workspace_root: Path,
) -> Path:
    """Create the directory structure a Claude Code session expects.

    Layout:
      {workspace_root}/{session_id}/
        workspace/          — the working directory (repos, files)
        .claude/            — Claude Code config home
          channels/
            discord/
              .env          — DISCORD_BOT_TOKEN
              access.json   — access control rules
          CLAUDE.md         — system prompt (if file-based)
        .mcp.json           — additional MCP server configs
    """
    base = workspace_root / config.session_id
    workspace = base / "workspace"
    claude_home = base / ".claude"
    discord_state = claude_home / "channels" / "discord"

    # Create dirs
    for d in [workspace, claude_home, discord_state]:
        d.mkdir(parents=True, exist_ok=True)

    # Write Discord .env
    env_file = discord_state / ".env"
    _write_secret_file(env_file, f"DISCORD_BOT_TOKEN={config.discord_bot_token}\n")

    # Write access.json
    access = build_access_config(config)
    access_file = discord_state / "access.json"
    access_file.write_text(json.dumps(access, indent=2))

    # Write system prompt as CLAUDE.md if provided
    if config.system_prompt and not config.system_prompt_file:
        claude_md = workspace / "CLAUDE.md"
        claude_md.write_text(config.system_prompt)
    elif config.system_prompt_file:
        # Will be bind-mounted or copied during sandbox setup
        pass

    # Write additional MCP server config
    if config.mcp_servers:
        mcp_config = {"mcpServers": config.mcp_servers}
        mcp_file = claude_home / ".mcp.json"
        mcp_file.write_text(json.dumps(mcp_config, indent=2))

    return base


def build_multi_session_configs(
    sessions_yaml: dict,
    shared_api_key: str = "",
) -> list[ClaudeCodeSessionConfig]:
    """Parse a multi-session YAML config into individual session configs.

    Expected YAML structure:
      defaults:
        model: claude-sonnet-4-20250514
        anthropic_api_key: sk-ant-...
        discord_access_policy: allowlist
        cpu_millicores: 1000
        memory_mb: 2048

      sessions:
        - name: code-review-bot
          discord_bot_token: MTIz...
          system_prompt: "You are a code review assistant..."
          discord_allowed_servers: ["123456789"]
          git_repos: ["https://github.com/org/repo"]

        - name: ops-bot
          discord_bot_token: NDU2...
          system_prompt: "You are an ops assistant..."
          discord_allowed_users: ["987654321"]
          model: claude-sonnet-4-20250514
    """
    defaults = sessions_yaml.get("defaults", {})
    sessions = sessions_yaml.get("sessions", [])

    configs = []
    for i, session_def in enumerate(sessions):
        # Merge defaults with per-session overrides
        merged = {**defaults, **session_def}

        config = ClaudeCodeSessionConfig(
            session_id=merged.get("session_id", f"session-{i:04d}"),
            name=merged.get("name", f"bot-{i}"),
            model=merged.get("model", "claude-sonnet-4-20250514"),
            system_prompt=merged.get("system_prompt", ""),
            system_prompt_file=merged.get("system_prompt_file"),
            max_turns=int(merged.get("max_turns", 0)),
            allowed_tools=merged.get("allowed_tools", []),
            anthropic_api_key=merged.get("anthropic_api_key", shared_api_key),
            discord_bot_token=merged.get("discord_bot_token", ""),
            discord_access_policy=merged.get("discord_access_policy", "allowlist"),
            discord_allowed_users=merged.get("discord_allowed_users", []),
            discord_allowed_servers=merged.get("discord_allowed_servers", []),
            discord_allowed_channels=merged.get("discord_allowed_channels", []),
            plugins=merged.get("plugins", ["discord@claude-plugins-official"]),
            workspace_dir=merged.get("workspace_dir", "/workspace"),
            git_repos=merged.get("git_repos", []),
            cpu_millicores=int(merged.get("cpu_millicores", 1000)),
            memory_mb=int(merged.get("memory_mb", 2048)),
            timeout_seconds=int(merged.get("timeout_seconds", 0)),
            mcp_servers=merged.get("mcp_servers", {}),
        )

        if not config.discord_bot_token:
            logger.warning(f"Session {config.name} has no discord_bot_token — skipping")
            continue

        if not config.anthropic_api_key:
            logger.warning(f"Session {config.name} has no anthropic_api_key — skipping")
            continue

        configs.append(config)

    return configs


__all__ = [
    "ClaudeCodeSessionConfig",
    "build_claude_code_command",
    "build_session_environment",
    "build_access_config",
    "prepare_session_filesystem",
    "build_multi_session_configs",
]
