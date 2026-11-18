# Harness: Claude Code + MCP plugins (Discord, Slack, etc.)
#
# This is the primary harness for running Claude Code as a long-lived bot.
# Includes: claude CLI, Bun (MCP server runtime), Node.js, Python, Go.
#
# Build:
#   docker build -f harnesses/claude-code.Dockerfile -t managed-agents-claude-code:latest .

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# System packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget git ca-certificates gnupg \
    build-essential pkg-config \
    python3 python3-pip python3-venv \
    jq vim less zip unzip \
    bash zsh netcat-openbsd dnsutils \
    && rm -rf /var/lib/apt/lists/*

# Node.js 24 LTS + Bun -- copied from the official images instead of piping
# install scripts (NodeSource, bun.sh) into bash.
COPY --from=node:24-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:24-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=oven/bun:1.4.4-slim /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s bun /usr/local/bin/bunx

# Claude Code CLI
ARG CLAUDE_CODE_VERSION=2.1.327
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# Pre-install Discord plugin
# Pinned to a commit for reproducible, reviewable builds; bump deliberately.
ARG CLAUDE_PLUGINS_REF=e6143c9807a001832badb63e89d58ffe25d542ec
RUN mkdir -p /opt/claude-plugins/claude-plugins-official && \
    cd /opt/claude-plugins/claude-plugins-official && \
    git init -q && \
    git remote add origin https://github.com/anthropics/claude-plugins-official.git && \
    git fetch -q --depth 1 origin "${CLAUDE_PLUGINS_REF}" && \
    git checkout -q --detach FETCH_HEAD && \
    test "$(git rev-parse HEAD)" = "${CLAUDE_PLUGINS_REF}" && \
    cd external_plugins/discord && \
    bun install --frozen-lockfile

# Common Python packages (venv: Ubuntu 24.04 system Python is externally managed)
RUN python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir \
    httpx requests beautifulsoup4 pyyaml numpy pandas
ENV PATH="/opt/venv/bin:$PATH"

# Non-root user (Ubuntu 24.04 ships a default "ubuntu" user at uid/gid 1000)
RUN userdel -r ubuntu 2>/dev/null || true
RUN groupadd -g 1000 agent && useradd -u 1000 -g agent -m -d /home/agent agent

# Directories
RUN mkdir -p /workspace /home/agent/.claude/channels/discord && \
    chown -R agent:agent /workspace /home/agent

ENV CLAUDE_PLUGINS_DIR="/opt/claude-plugins/claude-plugins-official/external_plugins" \
    TERM=xterm-256color \
    NODE_ENV=production \
    HOME=/home/agent

WORKDIR /workspace
USER agent

ENTRYPOINT ["claude"]
