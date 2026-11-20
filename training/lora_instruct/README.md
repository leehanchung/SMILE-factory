# LoRA-Instruct

LoRA fine-tuning recipe for permissive open-source causal LLMs, built on
HuggingFace `transformers` + `peft`. This project applies
[low-rank adaptation (LoRA)](https://arxiv.org/abs/2106.09685) to decoder-only
models for instruction tuning, and is tested against the
[Stanford Alpaca](https://crfm.stanford.edu/2023/03/13/alpaca.html) dataset.

Inspired by [Alpaca-LoRA](https://github.com/tloen/alpaca-lora).

## Quick Start

Run everything from this directory:

```bash
cd training/lora_instruct/
uv sync          # training stack only; add --extra inference for vllm/openai
```

Train a LoRA adapter on top of a base model:

```bash
uv run python finetune.py \
    --base_model 'Qwen/Qwen2.5-1.5B' \
    --output_dir './lora-qwen'
```

Train **Qwen3.5-9B** with 4-bit QLoRA (fits one RTX 4090):

```bash
uv run python finetune.py \
    --base_model 'Qwen/Qwen3.5-9B' \
    --output_dir './lora-qwen3.5-9b' \
    --bits 4 --micro_batch_size 1 --cutoff_len 512
```

Default dataset is `yahma/alpaca-cleaned`; override with `--data_path`. See the
`train()` signature in `finetune.py` for the full set of CLI flags (batch size,
LoRA rank, dropout, target modules, prompt template, etc.).

By default training runs in **bf16** with no quantization. To save memory on a
larger base model, enable quantized **QLoRA** with `--bits 4` (nf4) or `--bits 8`
(int8) — both use `bitsandbytes` and `prepare_model_for_kbit_training`
under the hood. `--gradient_checkpointing` (on by default) further trades compute
for memory. `--lora_target_modules` defaults to `all-linear` (PEFT auto-targets
every linear layer, so it works across architectures).

`--trust_remote_code` is **off by default** because it runs arbitrary Python
from the model repo. Models with custom architectures (e.g. MPT-style models,
see the MPT notebook) require it — only pass it for repos you trust.

> Dependencies are managed with **uv** (`uv.lock`). `uv sync` installs the lean
> training stack; the vllm/openai inference deps live in an optional extra
> (`uv sync --extra inference`).

## Distributed Training (multi-GPU DDP)

For multi-GPU training, launch with `torchrun` — it sets `RANK`/`LOCAL_RANK`/
`WORLD_SIZE` for you (don't export them yourself). `finetune.py` detects DDP, pins
a full copy of the model to each rank's GPU, and splits the grad-accum across
ranks so `--batch_size` stays the global effective batch:

```bash
uv run torchrun \
    --nproc_per_node=2 \
    --master_port=29501 \
    finetune.py \
    --base_model 'Qwen/Qwen3.5-9B' \
    --bits 4 \
    --output_dir './lora-qwen3.5-9b'
```

`--nproc_per_node` = number of GPUs. Restrict which GPUs to use with
`CUDA_VISIBLE_DEVICES=0,1`. On startup each rank logs its placement, e.g.
`[rank 0/2] model params on cuda:0` / `[rank 1/2] model params on cuda:1`.

## Trained Models

| Model        | Runs | Training Time | Link |
|:-------------|:----:|:-------------:|:----:|
| LLaMA 3B     |      |               |      |
| LLaMA 7B     |      |               |      |
| RedPajama 3B | yes  | 1:44:14       |      |
| RedPajama 7B | yes  | 3:09:58       |      |
| MPT 3B       |      |               |      |
| MPT 7B       |      |               |      |
| Falcon 7B    | yes  |               |      |

Estimated wall-clock for fine-tuning RedPajama-INCITE-Base-7B-v0.1 with
Stanford Alpaca:

- ~12 hours on a single RTX 3090.
- ~6.5 hours on RTX 3090 + RTX Titan.

### Training Hardware Spec

Verified working on:

```
WSL2 (Linux), uv-managed env
2 × NVIDIA GeForce RTX 4090 (24 GB, sm_89)
Driver 591.86 (CUDA 13.1 capable)
torch 2.11.0+cu130 · transformers 5.x · peft 0.19 · bitsandbytes 0.49
```

Verified: Qwen3.5-9B 4-bit QLoRA trains on a single 4090, and on both via
`torchrun --nproc_per_node=2` (DDP, each rank pins a full copy to its GPU). The
PyTorch wheels bundle their own CUDA runtime, so the system `nvcc` (11.7 here) is
irrelevant — no kernels are compiled from source.

## Where things live

- `finetune.py` — entry point. Straightforward application of PEFT / LoRA to
  a decoder-only model, plus prompt construction and tokenization glue.
- `utils/` — `prompter.py` (template-driven prompt builder) and training
  callbacks.
- `templates/` — prompt templates loaded by `Prompter`. Default is
  `alpaca.json`.
- `dataset/` — bundled instruction datasets (`alpaca_data.json`,
  `alpaca_data_cleaned_archive.json`, `alpaca_data_gpt4.json`,
  `prompts.jsonl`).
- `inference/` — local inference + benchmarking (`bench.py`,
  `deploy_local.sh`).
- `notebook/` — per-base-model exploratory notebooks (LLaMA-7B, MPT-7B,
  RedPajama-INCITE-7B).

## References

- [LoRA: Low-Rank Adaptation of Large Language Models](https://arxiv.org/abs/2106.09685)
- [State-of-the-art Parameter-Efficient Fine-Tuning (PEFT) methods](https://github.com/huggingface/peft)
- [Stanford Alpaca: An Instruction-following LLaMA Model](https://github.com/tatsu-lab/stanford_alpaca)
- [EMNLP 2022 Tutorial: Modular and Parameter-Efficient Fine-Tuning for NLP Models](https://www.youtube.com/watch?v=KoOlcX3XLd4)
