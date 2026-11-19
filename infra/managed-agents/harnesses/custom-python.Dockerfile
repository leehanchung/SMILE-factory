# Harness: Custom Python agent loop
#
# Runs the built-in agent loop (src.runtime.agent_loop) with tool
# implementations for bash, file ops, web fetch, etc.
#
# Build:
#   docker build -f harnesses/custom-python.Dockerfile -t managed-agents-runtime:latest .

FROM python:3.13-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1

# System packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget git ca-certificates \
    build-essential \
    jq vim less \
    && rm -rf /var/lib/apt/lists/*

# Node.js 24 LTS (for tool execution) -- copied from the official image
# instead of piping the NodeSource setup script into bash.
COPY --from=node:24-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:24-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

WORKDIR /app

# Install Python dependencies
COPY pyproject.toml poetry.lock* ./
ARG POETRY_VERSION=2.4.0
RUN pip install --no-cache-dir "poetry==${POETRY_VERSION}" && \
    poetry config virtualenvs.create false && \
    poetry install --no-interaction --no-ansi --only main --no-root

# Copy application code. Dependencies are installed with --no-root, so the
# project itself is not on sys.path; PYTHONPATH lets `python3 -m src...`
# resolve from /workspace.
COPY src/ ./src/
ENV PYTHONPATH=/app

# Non-root user
RUN groupadd -g 1000 agent && useradd -u 1000 -g agent -m -d /home/agent agent
RUN mkdir -p /workspace && chown -R agent:agent /workspace /app

ENV HOME=/home/agent
WORKDIR /workspace
USER agent

ENTRYPOINT ["python3", "-m", "src.runtime.agent_loop"]
