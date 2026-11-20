# Development Guide

> Scope: this guide covers `training/lora_instruct` (uv-managed). Run commands from
> that directory.

## Setup

```bash
cd training/lora_instruct
uv sync          # training stack only; add --extra inference for vllm/openai
```

## Linting

Ruff is configured in `pyproject.toml` with rules: E, W, F, I, C, B (ignoring E501, B008, C901).

```bash
uv run ruff check .
uv run ruff check --fix .
```

## Testing

```bash
uv run pytest
```

## Training

```bash
cd training/lora_instruct
uv run python finetune.py --base_model 'Qwen/Qwen2.5-1.5B' --output_dir './lora-qwen'
```

All training hyperparameters are CLI flags — see the `train()` function signature in `training/lora_instruct/finetune.py` for the full list (LoRA rank, `--bits` for QLoRA, `--gradient_checkpointing`, etc.).

### Distributed Training (multi-GPU DDP)

`torchrun` sets `RANK`/`LOCAL_RANK`/`WORLD_SIZE` — don't export them yourself.

```bash
cd training/lora_instruct
uv run torchrun --nproc_per_node=2 --master_port=29501 finetune.py \
    --base_model 'Qwen/Qwen3.5-9B' --bits 4 \
    --output_dir './lora-qwen3.5-9b'
```

## Inference Benchmarking

```bash
cd training/lora_instruct
uv sync --extra inference   # bench.py needs the inference deps (openai, vllm, ...)
uv run python inference/bench.py --api-url https://api.openai.com/v1/chat/completions --model gpt-3.5-turbo
```

Requires `OPENAI_API_KEY` in environment or `.env` file.

## Code Conventions

- Python 3.11+ (3.11–3.13 for `training/lora_instruct`)
- Type hints on function signatures
- `python-fire` for CLI interfaces (training knobs are `train()` args)
- `python-dotenv` for environment variable loading
