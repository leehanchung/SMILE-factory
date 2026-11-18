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

# SGLang gets no API key from this script. SGLang 0.5.23 (the latest release)
# echoes the resolved server args, api_key included, in its startup log and
# /server_info (sgl-project/sglang#37457), so any key handed to it leaks into
# logs. Bind to loopback by default; a non-loopback HOST (e.g. HOST=0.0.0.0 so
# BenchFlow task containers can reach it via host.docker.internal) serves
# unauthenticated, so it requires ALLOW_PUBLIC_BIND=1 confirming the port sits
# behind a firewall/network policy, or keep SGLang on loopback and expose an
# authenticating reverse proxy instead (ENGINE_API_KEY is then that proxy's key).
case "$HOST" in
  127.0.0.1 | localhost | ::1) ;;
  *)
    if [[ "${ALLOW_PUBLIC_BIND:-}" != 1 ]]; then
      echo "error: HOST=$HOST is not loopback and SGLang will serve it unauthenticated." >&2
      echo "Restrict port $PORT with a firewall/network policy (or keep HOST on loopback and" >&2
      echo "put an authenticating reverse proxy in front), then rerun with ALLOW_PUBLIC_BIND=1." >&2
      exit 1
    fi
    ;;
esac
if [[ -n "${ENGINE_API_KEY:-}" ]]; then
  echo "note: ENGINE_API_KEY is not passed to SGLang (it would be logged); enforce it in the proxy in front." >&2
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
  --context-length "${CONTEXT_LEN:-16384}" \
  --mem-fraction-static "${MEM_FRACTION:-0.85}" \
  --tool-call-parser "${TOOL_PARSER:-qwen3_coder}" \
  --attention-backend "${ATTN_BACKEND:-triton}" \
  --sampling-backend "${SAMPLING_BACKEND:-pytorch}"
