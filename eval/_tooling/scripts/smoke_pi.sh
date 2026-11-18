#!/bin/bash
# Smoke test: drive Qwen3.5-2B-Base through the pi coding agent against the
# local SGLang endpoint — no Docker, no benchflow. Validates the model+harness
# pair end to end (provider config -> pi -> vLLM -> answer).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PI="${PI:-$HOME/.npm-global/bin/pi}"
export PATH="$HOME/.nvm/versions/node/v22.23.0/bin:$PATH"   # pi needs Node >= 22

# pi reads ~/.pi/agent/models.json; install our provider config (and the
# engine key, if ENGINE_API_KEY is set) there.
bash "$HERE/install_pi_config.sh"

echo "node: $(node --version)"
echo "pi:   $("$PI" --version 2>/dev/null)"
echo "--- pi sees the model? ---"
"$PI" --list-models 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -i qwen || echo "(model not listed)"
echo "--- asking Qwen a factual question through pi (print mode, no tools) ---"
"$PI" -p --model sglang/qwen35-2b-base --no-tools \
  "What is the capital of France? Answer with only the city name." 2>&1 | tail -20
