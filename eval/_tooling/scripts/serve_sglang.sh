#!/bin/bash
# Serve Qwen3.5-2B-Base via SGLang as an OpenAI-compatible endpoint.
#
# SGLang is slime's RL rollout engine, so eval and RL training share one
# inference stack. OpenAI-compatible API at http://<host>:<port>/v1.
#
#   --tool-call-parser is REQUIRED for the pi agent (OpenAI tool_choice=auto);
#     `qwen25` matches Qwen's hermes-style <tool_call> format.
set -euo pipefail

VENV="${SGLANG_VENV:-$HOME/venvs/sglang-qwen}"
MODEL="${MODEL:-Qwen/Qwen3.5-2B-Base}"
SERVED_NAME="${SERVED_NAME:-qwen35-2b-base}"
PORT="${PORT:-30000}"
GPU="${CUDA_VISIBLE_DEVICES:-1}"

HOST="${HOST:-127.0.0.1}"
ENGINE_API_KEY="${ENGINE_API_KEY:-}"

# Bind to loopback by default. Exposing the engine beyond this host (e.g.
# HOST=0.0.0.0 so BenchFlow task containers can reach it via
# host.docker.internal) REQUIRES an API key — an unauthenticated OpenAI endpoint
# on the network is free GPU compute for anyone who can reach the port.
API_KEY_ARGS=()
if [[ -n "$ENGINE_API_KEY" ]]; then
  API_KEY_ARGS=(--api-key "$ENGINE_API_KEY")
elif [[ "$HOST" != "127.0.0.1" && "$HOST" != "localhost" && "$HOST" != "::1" ]]; then
  echo "error: HOST=$HOST is not loopback; set ENGINE_API_KEY to require auth" >&2
  exit 1
fi

export PATH="$VENV/bin:$PATH"
export CUDA_VISIBLE_DEVICES="$GPU"
# CuDNN check aborts on a PyTorch 2.9.1 Conv3d/vision bug irrelevant to this
# text-only model; skip it so startup proceeds.
export SGLANG_DISABLE_CUDNN_CHECK=1

# Triton attention + PyTorch sampling avoid flashinfer's nvcc JIT, which would
# otherwise compile sm_89 kernels with the system CUDA 11.7 toolkit (too old for
# the RTX 4090) and abort. Triton compiles via LLVM — no CUDA toolkit needed.
exec "$VENV/bin/python" -m sglang.launch_server \
  --model-path "$MODEL" \
  --served-model-name "$SERVED_NAME" \
  --host "$HOST" --port "$PORT" \
  ${API_KEY_ARGS[@]+"${API_KEY_ARGS[@]}"} \
  --context-length "${CONTEXT_LEN:-16384}" \
  --mem-fraction-static "${MEM_FRACTION:-0.85}" \
  --tool-call-parser "${TOOL_PARSER:-qwen3_coder}" \
  --attention-backend "${ATTN_BACKEND:-triton}" \
  --sampling-backend "${SAMPLING_BACKEND:-pytorch}"
