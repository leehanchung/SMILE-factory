#!/bin/bash
# Serve Qwen3.5-2B-Base via vLLM as an OpenAI-compatible endpoint on :8000.
#
# Notes:
#   - VLLM_USE_FLASHINFER_SAMPLER=0 uses vLLM's native top-k/top-p sampler and
#     avoids flashinfer's JIT (which needs `ninja` + nvcc on PATH).
#   - venv/bin is prepended to PATH so any remaining JIT path can find `ninja`.
#   - --served-model-name is the alias pi/benchflow target (vllm/qwen35-2b-base).
set -euo pipefail

VENV="${VLLM_VENV:-$HOME/venvs/vllm-qwen}"
MODEL="${MODEL:-Qwen/Qwen3.5-2B-Base}"
SERVED_NAME="${SERVED_NAME:-qwen35-2b-base}"
PORT="${PORT:-8000}"
GPU="${CUDA_VISIBLE_DEVICES:-0}"

HOST="${HOST:-127.0.0.1}"
ENGINE_API_KEY="${ENGINE_API_KEY:-}"

# Bind to loopback by default. vLLM's API key only guards some path prefixes
# (/v1/...); other routes such as /invocations serve the same inference without
# it. So a non-loopback HOST (e.g. HOST=0.0.0.0 so BenchFlow task containers can
# reach it via host.docker.internal) needs ENGINE_API_KEY AND ALLOW_PUBLIC_BIND=1,
# the latter confirming the port sits behind a firewall/network policy or an
# authenticating reverse proxy that covers every endpoint.
case "$HOST" in
  127.0.0.1 | localhost | ::1) ;;
  *)
    if [[ -z "$ENGINE_API_KEY" ]]; then
      echo "error: HOST=$HOST is not loopback; set ENGINE_API_KEY to require auth" >&2
      exit 1
    fi
    if [[ "${ALLOW_PUBLIC_BIND:-}" != 1 ]]; then
      echo "error: vLLM's API key does not cover every endpoint (e.g. /invocations)." >&2
      echo "Restrict port $PORT with a firewall/network policy or an authenticating" >&2
      echo "reverse proxy, then rerun with ALLOW_PUBLIC_BIND=1." >&2
      exit 1
    fi
    ;;
esac
# vLLM reads VLLM_API_KEY from its environment, which keeps the key out of argv.
if [[ -n "$ENGINE_API_KEY" ]]; then
  export VLLM_API_KEY="$ENGINE_API_KEY"
fi

export PATH="$VENV/bin:$PATH"
export VLLM_USE_FLASHINFER_SAMPLER=0
export CUDA_VISIBLE_DEVICES="$GPU"

# --enable-auto-tool-choice + --tool-call-parser are REQUIRED for the pi agent:
# pi sends OpenAI-native tool definitions with tool_choice=auto, which vLLM
# rejects with HTTP 400 unless a parser is configured. `hermes` is Qwen's
# tool-call format. (TOOL_PARSER overridable: hermes | qwen3xml | qwen3coder.)
exec "$VENV/bin/vllm" serve "$MODEL" \
  --served-model-name "$SERVED_NAME" \
  --host "$HOST" --port "$PORT" \
  --max-model-len "${MAX_MODEL_LEN:-16384}" \
  --gpu-memory-utilization "${GPU_MEM_UTIL:-0.85}" \
  --enable-auto-tool-choice \
  --tool-call-parser "${TOOL_PARSER:-hermes}"
