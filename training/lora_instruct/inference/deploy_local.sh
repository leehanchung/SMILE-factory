#!/bin/bash
# Serve a model with vLLM's OpenAI-compatible API server.
#
# Env knobs:
#   MODEL         model to serve (default: meta-llama/Llama-2-7b-chat-hf)
#   HOST          bind address (default: 127.0.0.1, loopback only)
#   PORT          listen port (default: 8000)
#   VLLM_API_KEY  bearer token clients must send. Optional on loopback,
#                 REQUIRED when HOST is not a loopback address.
set -euo pipefail

MODEL="${MODEL:-meta-llama/Llama-2-7b-chat-hf}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8000}"

case "$HOST" in
    127.* | localhost | ::1) is_loopback=1 ;;
    *) is_loopback=0 ;;
esac

if [[ $is_loopback -eq 0 && -z "${VLLM_API_KEY:-}" ]]; then
    echo "Refusing to bind $HOST without auth: set VLLM_API_KEY (or use a loopback HOST)." >&2
    exit 1
fi

# Locate the NCCL lib bundled with torch's nvidia-nccl wheel, searching only the
# installed `nvidia` namespace package (not the whole filesystem).
nvidia_dirs=$(python -c 'import nvidia; print("\n".join(nvidia.__path__))' 2>/dev/null || true)
nccl_dir=""
if [[ -n $nvidia_dirs ]]; then
    nccl_lib=$(echo "$nvidia_dirs" | xargs -I{} find {} -name libnccl.so.2 2>/dev/null | head -n 1)
    [[ -n $nccl_lib ]] && nccl_dir=$(dirname "$nccl_lib")
fi

if [[ -n $nccl_dir ]]; then
    export LD_LIBRARY_PATH="$nccl_dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
else
    echo "libnccl.so.2 not found in the nvidia python packages" >&2
fi

args=(--model "$MODEL" --host "$HOST" --port "$PORT")
if [[ -n "${VLLM_API_KEY:-}" ]]; then
    args+=(--api-key "$VLLM_API_KEY")
fi

exec python -m vllm.entrypoints.openai.api_server "${args[@]}"
