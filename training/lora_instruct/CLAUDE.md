# CLAUDE.md — training/lora_instruct

LoRA SFT training recipe for fine-tuning open-source causal LLMs with HuggingFace PEFT.

## Quick Reference

This project is run from its own directory, not the repo root:

```bash
cd training/lora_instruct/
```

- **Setup**: `uv sync` (training stack only; add `--extra inference` for vllm/openai)
- **Lint**: `uv run ruff check .` (fix with `--fix`)
- **Test**: `uv run pytest`
- **CLI help**: `uv run python finetune.py --help`
- **Train**: `uv run python finetune.py --base_model '<model>' --output_dir '<dir>'`

## Notes

- This project uses **uv** (`pyproject.toml` + `uv.lock`), like the rest of the
  monorepo. `uv sync` installs the lean training stack; vllm/openai/tiktoken are
  in an optional `inference` extra (`uv sync --extra inference`). The CUDA build
  of torch (`2.14.x`, cu13) comes straight from PyPI — no extra index needed, and
  the system `nvcc` is irrelevant (torch wheels bundle their own CUDA runtime).
- `finetune.py` reads its training config from CLI flags via `fire`. See the
  `train()` signature in `finetune.py` for the full list of knobs (batch size,
  LoRA rank, target modules, `--bits` for QLoRA, `--gradient_checkpointing`,
  prompt template, etc.). Default base precision is bf16; `--bits 4/8` enables
  quantized QLoRA via `bitsandbytes`. `--lora_target_modules` defaults to
  `all-linear`.
- `--trust_remote_code` is **off by default**: it executes Python shipped in
  the model repo. Pass it only for base models whose repo code you trust and
  that need it (e.g. MPT-style custom architectures, as in `notebook/`).
- `inference/deploy_local.sh` binds vLLM to `127.0.0.1` by default. Set
  `VLLM_API_KEY` to require a bearer token (passed via the environment, never
  argv); `inference/bench.py` sends `OPENAI_API_KEY` as the bearer, so set it to
  the same value. A non-loopback `HOST` also needs `ALLOW_PUBLIC_BIND=1` and an
  authenticating proxy or network policy in front: vLLM's key does not cover
  every route (e.g. `/invocations`).
- Resuming from a pickle-based `adapter_model.bin` requires
  `LORA_ALLOW_BIN_CHECKPOINT=1`: the torch 2.14 that vLLM pins is affected by
  GHSA-v32g-mr63-3j83 even with `weights_only=True`. Prefer safetensors.
- Default dataset is `yahma/alpaca-cleaned`; default prompt template is
  `alpaca` (see `templates/alpaca.json`).
- Multi-GPU is **DDP via `torchrun --nproc_per_node=<N>`** (don't export
  `WORLD_SIZE` yourself — torchrun sets it). `train()` pins a full model copy to
  each rank's GPU and splits grad-accum across ranks. Each rank logs its
  placement (`[rank i/N] model params on cuda:i`). See the README invocation.

## Layout

- `finetune.py` — entry point, PEFT/LoRA training loop.
- `utils/prompter.py` — prompt construction from templates.
- `templates/` — prompt templates (alpaca by default).
- `dataset/` — bundled instruction datasets (alpaca, gpt4 variants).
- `inference/` — local inference + benchmarking scripts.
- `notebook/` — exploratory notebooks per base model.
- `tests/` — lightweight pytest suite (prompter, template structure,
  dataset file integrity). Heavy ML imports are out of scope —
  these run without GPU or transformers/peft installed.
