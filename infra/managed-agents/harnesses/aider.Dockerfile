# Harness: Aider (AI pair programming)
#
# Build:
#   docker build -f harnesses/aider.Dockerfile -t managed-agents-aider:latest .

FROM python:3.13-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir aider-chat

RUN groupadd -g 1000 agent && useradd -u 1000 -g agent -m -d /home/agent agent
RUN mkdir -p /workspace && chown -R agent:agent /workspace

ENV HOME=/home/agent
WORKDIR /workspace
USER agent

ENTRYPOINT ["aider"]
