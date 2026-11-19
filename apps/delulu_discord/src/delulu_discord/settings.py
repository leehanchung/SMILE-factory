"""Application settings loaded from environment variables."""

from __future__ import annotations

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Central config — reads from env vars or .env file."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # ── Discord ──────────────────────────────────────────────
    # SecretStr keeps the token out of repr()/logs/tracebacks; unwrap
    # with .get_secret_value() only at the point of use.
    discord_bot_token: SecretStr

    # ── Modal ────────────────────────────────────────────────
    modal_volume_name: str = "claude-workspaces"
    modal_app_name: str = "discord-orchestrator"
    sandbox_memory_mb: int = 4096
    sandbox_timeout_seconds: int = 300  # max time per Claude Code invocation

    # ── Session behavior ─────────────────────────────────────
    session_ttl_seconds: int = 3600  # 1 hour before session resets
    max_output_length: int = 1900  # Discord limit minus some margin
    # SQLite file backing SessionManager. Defaults to /data/sessions.db
    # which is the named-volume mount point set in the Makefile's
    # `restart` target — the volume survives `docker rm`, so per-thread
    # sessions persist across deploys (the bug fixed by this layer).
    # Override to a tmp path in tests; override to anywhere else for
    # local-dev runs that don't have the /data mount.
    session_db_path: str = "/data/sessions.db"

    # ── Repo provisioning ────────────────────────────────────
    # The bare-cache root on the Modal Volume. Mirrors the constant
    # in delulu_sandbox_modal.repo_provisioner; the bot doesn't read
    # the volume directly but the value is exposed here so admin
    # commands and observability code have one source of truth.
    repo_cache_root: str = "/vol/repo-cache"
    # Default git ref for /setrepo when the user doesn't pass one.
    default_git_ref: str = "HEAD"
