"""Discord bot token file is written owner-only."""

import os
import stat

from src.runtime.claude_code import ClaudeCodeSessionConfig, prepare_session_filesystem


def test_discord_env_file_is_0600(tmp_path):
    old_umask = os.umask(0o022)
    try:
        cfg = ClaudeCodeSessionConfig(session_id="s1", discord_bot_token="tok")
        base = prepare_session_filesystem(cfg, tmp_path)
        env_file = base / ".claude" / "channels" / "discord" / ".env"
        assert env_file.read_text() == "DISCORD_BOT_TOKEN=tok\n"
        assert stat.S_IMODE(env_file.stat().st_mode) == 0o600

        # Re-preparing over a pre-existing, world-readable file tightens it too.
        env_file.chmod(0o644)
        prepare_session_filesystem(cfg, tmp_path)
        assert stat.S_IMODE(env_file.stat().st_mode) == 0o600
    finally:
        os.umask(old_umask)
