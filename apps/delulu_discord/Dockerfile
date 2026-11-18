# Dockerfile for the always-on Discord bot process.
# This does NOT run Claude Code — it only hosts the bot that dispatches to Modal.

FROM python:3.14-slim

WORKDIR /app

# uv for installing from the lockfile. Copied from the official image,
# pinned by version AND digest so the build is reproducible and can't
# pick up a tampered/unreviewed release. Bump both together.
COPY --from=ghcr.io/astral-sh/uv:0.13.9@sha256:d3b601f0c7b118bc1753febf7c41cc80981df678445e0254284eecf84db79a7d /uv /uvx /bin/

# Copy project files
COPY pyproject.toml uv.lock .python-version ./
COPY src/ src/
# Install the exact, audited versions pinned in uv.lock (runtime deps only),
# then the project itself without re-resolving its dependencies.
RUN uv export --frozen --no-hashes --no-emit-project -o /tmp/requirements.txt \
    && uv pip install --system --no-cache -r /tmp/requirements.txt \
    && uv pip install --system --no-cache --no-deps . \
    && rm /tmp/requirements.txt

# Persistent state directory. The Makefile's ``restart`` target
# mounts the named Docker volume ``disco-data`` here so the bot's
# SQLite session DB (``/data/sessions.db``) survives ``docker rm``.
# Creating the dir at build time means the bot starts cleanly even
# on the first deploy before the volume has any contents.
RUN mkdir -p /data

# The bot is lightweight — ~50MB RAM
CMD ["python", "-m", "delulu_discord.main"]
