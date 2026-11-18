#!/bin/bash
# Serve a model with vLLM's OpenAI-compatible API server.
#
# Env knobs:
#   MODEL              model to serve (default: meta-llama/Llama-2-7b-chat-hf)
#   HOST               bind address (default: 127.0.0.1, loopback only)
#   PORT               listen port (default: 8000)
#   VLLM_API_KEY       bearer token for the /v1 API. Optional on loopback,
#                      required off loopback. vLLM reads it from the
#                      environment, so it never appears in this process's argv.
#   ALLOW_PUBLIC_BIND  set to 1 to bind a non-loopback HOST.
#
# vLLM's API key only guards some path prefixes; other routes (for example
# /invocations) serve inference without it. So the key alone is not enough to
# expose the server: off loopback, put an authenticating reverse proxy or a
# network policy that allowlists clients in front of it, then opt in with
# ALLOW_PUBLIC_BIND=1.
set -euo pipefail

MODEL="${MODEL:-meta-llama/Llama-2-7b-chat-hf}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8000}"

# Literal loopback addresses only. A hostname like 127.example.com could
# resolve anywhere, so it does not count.
if [[ $HOST =~ ^127(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}$ || $HOST == "::1" || $HOST == "localhost" ]]; then
    is_loopback=1
else
    is_loopback=0
fi

if [[ $is_loopback -eq 0 ]]; then
    if [[ "${ALLOW_PUBLIC_BIND:-}" != "1" ]]; then
        echo "Refusing to bind non-loopback HOST=$HOST. vLLM's API key does not cover every route" >&2
        echo "(e.g. /invocations), so put an authenticating reverse proxy or network policy in front," >&2
        echo "then set ALLOW_PUBLIC_BIND=1 (and VLLM_API_KEY)." >&2
        exit 1
    fi
    if [[ -z "${VLLM_API_KEY:-}" ]]; then
        echo "Refusing to bind $HOST without auth: set VLLM_API_KEY." >&2
        exit 1
    fi
fi

# Locate the NCCL lib bundled with torch's nvidia-nccl wheel, searching only the
# installed `nvidia` namespace package (not the whole filesystem). `|| true`
# because `head` closing the pipe early would otherwise fail under pipefail.
nvidia_dirs=$(python -c 'import nvidia; print("\n".join(nvidia.__path__))' 2>/dev/null || true)
nccl_dir=""
if [[ -n $nvidia_dirs ]]; then
    nccl_lib=$(echo "$nvidia_dirs" | xargs -I{} find {} -name libnccl.so.2 2>/dev/null | head -n 1 || true)
    [[ -n $nccl_lib ]] && nccl_dir=$(dirname "$nccl_lib")
fi

if [[ -n $nccl_dir ]]; then
    export LD_LIBRARY_PATH="$nccl_dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
else
    echo "libnccl.so.2 not found in the nvidia python packages" >&2
fi

# No --api-key flag: vLLM picks VLLM_API_KEY up from the environment, which
# keeps the token out of `ps` and /proc/<pid>/cmdline.
[[ -n "${VLLM_API_KEY:-}" ]] && export VLLM_API_KEY

exec python -m vllm.entrypoints.openai.api_server --model "$MODEL" --host "$HOST" --port "$PORT"
