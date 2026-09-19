#!/bin/sh
# Use via `sh scripts/uv.sh ...`; all paths are anchored to this project.
set -eu
PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"
unset VIRTUAL_ENV CONDA_PREFIX PYTHONHOME PYTHONPATH
export PYTHONNOUSERSITE=1
export UV_PROJECT_ENVIRONMENT="$PROJECT_DIR/.venv"
export UV_CACHE_DIR="$PROJECT_DIR/.cache/uv"
export UV_PYTHON_INSTALL_DIR="$PROJECT_DIR/.cache/python"
export UV_PYTHON_BIN_DIR="$PROJECT_DIR/.cache/python-bin"
export UV_PYTHON_PREFERENCE=only-managed
UV_PYTHON=$(cat "$PROJECT_DIR/.python-version")
export UV_PYTHON
export XDG_CACHE_HOME="$PROJECT_DIR/.cache"
export HF_HOME="$PROJECT_DIR/.cache/huggingface"
export HF_HUB_CACHE="$HF_HOME/hub"
export HF_DATASETS_CACHE="$HF_HOME/datasets"
export TORCH_HOME="$PROJECT_DIR/.cache/torch"
export TORCHINDUCTOR_CACHE_DIR="$PROJECT_DIR/.cache/torchinductor"
export TRITON_CACHE_DIR="$PROJECT_DIR/.cache/triton"
export MPLCONFIGDIR="$PROJECT_DIR/.cache/matplotlib"
export NUMBA_CACHE_DIR="$PROJECT_DIR/.cache/numba"
export JUPYTER_CONFIG_DIR="$PROJECT_DIR/.cache/jupyter/config"
export JUPYTER_DATA_DIR="$PROJECT_DIR/.cache/jupyter/data"
export JUPYTER_RUNTIME_DIR="$PROJECT_DIR/.cache/jupyter/runtime"
export IPYTHONDIR="$PROJECT_DIR/.cache/ipython"
export HF_HUB_DISABLE_TELEMETRY=1
exec uv "$@"
