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

# Bind to loopback by default. A non-loopback HOST (e.g. HOST=0.0.0.0 so
# BenchFlow task containers can reach it via host.docker.internal) needs
# ENGINE_API_KEY AND ALLOW_PUBLIC_BIND=1. SGLang's key covers every route except
# /health, /ready and /metrics, but the same key is handed to the evaluated
# agents (see README "Engine auth"), so the opt-in confirms the port also sits
# behind a firewall/network policy or an authenticating reverse proxy.
case "$HOST" in
  127.0.0.1 | localhost | ::1) ;;
  *)
    if [[ -z "$ENGINE_API_KEY" ]]; then
      echo "error: HOST=$HOST is not loopback; set ENGINE_API_KEY to require auth" >&2
      exit 1
    fi
    if [[ "${ALLOW_PUBLIC_BIND:-}" != 1 ]]; then
      echo "error: restrict port $PORT with a firewall/network policy or an authenticating" >&2
      echo "reverse proxy, then rerun with ALLOW_PUBLIC_BIND=1." >&2
      exit 1
    fi
    ;;
esac

# SGLang has no API-key environment variable, so pass the key through a
# --config YAML file (0600, in a private temp dir, removed on exit) instead of
# --api-key, which would put it in `ps` / /proc/<pid>/cmdline.
CONFIG_ARGS=()
if [[ -n "$ENGINE_API_KEY" ]]; then
  cfg_dir=$(mktemp -d)
  trap 'rm -rf "$cfg_dir"' EXIT
  (umask 077 && ENGINE_API_KEY="$ENGINE_API_KEY" "$VENV/bin/python" -c \
    'import json, os; print("api_key: " + json.dumps(os.environ["ENGINE_API_KEY"]))' \
    > "$cfg_dir/sglang.yaml")
  CONFIG_ARGS=(--config "$cfg_dir/sglang.yaml")
fi

export PATH="$VENV/bin:$PATH"
export CUDA_VISIBLE_DEVICES="$GPU"
# CuDNN check aborts on a PyTorch 2.9.1 Conv3d/vision bug irrelevant to this
# text-only model; skip it so startup proceeds.
export SGLANG_DISABLE_CUDNN_CHECK=1

# Triton attention + PyTorch sampling avoid flashinfer's nvcc JIT, which would
# otherwise compile sm_89 kernels with the system CUDA 11.7 toolkit (too old for
# the RTX 4090) and abort. Triton compiles via LLVM — no CUDA toolkit needed.
# Not exec'd, so the EXIT trap can delete the key file; INT/TERM are forwarded.
"$VENV/bin/python" -m sglang.launch_server \
  --model-path "$MODEL" \
  --served-model-name "$SERVED_NAME" \
  --host "$HOST" --port "$PORT" \
  ${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"} \
  --context-length "${CONTEXT_LEN:-16384}" \
  --mem-fraction-static "${MEM_FRACTION:-0.85}" \
  --tool-call-parser "${TOOL_PARSER:-qwen3_coder}" \
  --attention-backend "${ATTN_BACKEND:-triton}" \
  --sampling-backend "${SAMPLING_BACKEND:-pytorch}" &
server_pid=$!
trap 'kill -TERM "$server_pid" 2>/dev/null' INT TERM
rc=0
wait "$server_pid" || rc=$?
# A forwarded signal interrupts the first wait; wait again for the real exit.
if kill -0 "$server_pid" 2>/dev/null; then wait "$server_pid" || rc=$?; fi
exit "$rc"
