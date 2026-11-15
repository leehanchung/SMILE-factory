# Architecture

## Project Overview

LoRA-Instruct fine-tunes open-source causal LLMs using Low-Rank Adaptation (LoRA) via HuggingFace PEFT. It also includes an inference benchmarking tool for OpenAI-compatible endpoints. The project now lives at `training/lora_instruct/`.

> **Deep-research training + evaluation infrastructure** (the slime RL recipe,
> the shared `libs/dr_agent` library, `services/search_server`, `data/datagen`,
> and the `eval/` harness) has its own architecture doc:
> [plan-deep-agent-rl.md](plan-deep-agent-rl.md). The sections below describe the
> LoRA-Instruct SFT recipe specifically.

## Directory Structure

```
training/lora_instruct/
├── finetune.py              # Main training entrypoint (uses python-fire CLI)
├── utils/
│   ├── prompter.py          # Prompt template loading and formatting
│   ├── callbacks.py         # Streaming generation helpers (Stream, Iteratorize)
│   └── monitoring.py        # Training-monitoring callback (GPU mem, perplexity, sample gens)
├── inference/
│   ├── bench.py             # Async LLM endpoint benchmarking tool
│   ├── deploy_local.sh      # Local deployment script
│   └── sonnet.txt           # Sentence bank for benchmark prompts
├── templates/
│   └── alpaca.json          # Alpaca prompt template (prompt_input / prompt_no_input)
├── dataset/                 # Training datasets (Alpaca variants, prompts.jsonl)
├── notebook/                # Jupyter notebooks for model experimentation
└── pyproject.toml           # uv project config and dependencies (+ uv.lock)
```

## Key Components

### Fine-tuning (`training/lora_instruct/finetune.py`)

- **Entry point**: `fire.Fire(train)` — all training params are CLI flags.
- **Model loading**: `AutoModelForCausalLM` with bfloat16, optional 4-bit (nf4) or 8-bit QLoRA quantization via BitsAndBytes (`--bits 4`/`--bits 8`).
- **LoRA**: Applied via `peft.LoraConfig` with configurable rank, alpha, dropout, and target modules (default: `all-linear` — PEFT auto-targets every linear layer).
- **Data**: Loads from HuggingFace Hub or local JSON/JSONL files.
- **Distributed training**: Supports DDP via `torchrun` with `WORLD_SIZE` and `LOCAL_RANK` env vars.
- **Monitoring**: `MonitorCallback` (`utils/monitoring.py`) reports peak GPU memory, eval perplexity, and sample generations, with optional early stopping.
- **`TokenizerHelper`**: Handles prompt tokenization and optional input masking (`train_on_inputs=False`).

### Prompt System (`training/lora_instruct/utils/prompter.py`)

- `Prompter` loads JSON templates from `training/lora_instruct/templates/` directory.
- Templates define `prompt_input`, `prompt_no_input`, and `response_split` fields.
- Currently only `alpaca.json` template exists.

### Inference Benchmarking (`training/lora_instruct/inference/bench.py`)

- Async HTTP benchmarking for OpenAI-compatible chat completion endpoints.
- Uses Poisson process for request arrival simulation.
- Measures: TTFT, end-to-end latency, inter-token delay, tokens/s.
- Validates responses using embedded random numeric keys.

## Dependencies

Core: `transformers`, `peft`, `bitsandbytes`, `accelerate`, `datasets`, `torch`
Inference: `httpx`, `tiktoken`, `numpy`, `pandas`, `num2words`
Dev: `ruff`, `pytest`, `ipykernel`
