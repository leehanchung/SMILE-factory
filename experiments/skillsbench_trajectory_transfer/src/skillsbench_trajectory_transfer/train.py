"""LoRA training entrypoint for pre-tokenized SkillsBench trajectories.

Heavy dependencies are imported only after argument parsing, so importing this module and
requesting ``--help`` never loads a model, CUDA, a dataset, or credentials.
"""

from __future__ import annotations

import argparse
import inspect
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

CONDITIONS = ("no_skill_success", "with_skill_success")
TARGET_MODULES = ("q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj")


@dataclass(frozen=True)
class TrainConfig:
    """Resolved rank-16 Qwen LoRA training configuration."""

    model_name_or_path: str
    output_dir: str
    condition: str
    dataset_dir: str | None = None
    dataset_path: str | None = None
    model_revision: str | None = None
    attention_implementation: str = "sdpa"
    max_seq_length: int = 16_384
    learning_rate: float = 1e-4
    num_train_epochs: float = 1.0
    per_device_train_batch_size: int = 1
    gradient_accumulation_steps: int = 8
    warmup_ratio: float = 0.03
    weight_decay: float = 0.0
    max_grad_norm: float = 1.0
    scheduler: str = "cosine"
    seed: int = 17
    bf16: bool = True
    gradient_checkpointing: bool = True
    eval_steps: int = 7
    logging_steps: int = 1
    save_steps: int = 7
    max_steps: int = -1
    wandb_project: str | None = None
    wandb_group: str | None = None

    @classmethod
    def from_yaml(
        cls,
        path: str | Path,
        *,
        dataset_dir: str | None = None,
        condition: str | None = None,
        output_dir: str | None = None,
        smoke: bool = False,
    ) -> TrainConfig:
        """Resolve the public nested recipe or a compact flat test configuration."""
        import yaml

        raw = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        if not isinstance(raw, Mapping):
            raise ValueError("training config must be a YAML mapping")
        if "model" not in raw and "training" not in raw:
            flat = dict(raw)
            if dataset_dir is not None:
                flat["dataset_dir"] = dataset_dir
            if condition is not None:
                flat["condition"] = condition
            if output_dir is not None:
                flat["output_dir"] = output_dir
            if smoke:
                flat["max_steps"] = 1
            return cls(**flat)

        model = raw.get("model")
        training = raw.get("training")
        wandb = raw.get("wandb", {})
        if not isinstance(model, Mapping) or not isinstance(training, Mapping):
            raise ValueError("nested config requires model and training mappings")
        if condition not in CONDITIONS:
            raise ValueError(f"condition must be one of: {', '.join(CONDITIONS)}")
        if not dataset_dir or not output_dir:
            raise ValueError("nested config requires --dataset-dir and --output-dir")
        rank = training.get("rank")
        if rank != 16:
            raise ValueError(f"this recipe is fixed to LoRA rank 16, got {rank!r}")
        configured_conditions = raw.get("conditions", CONDITIONS)
        if condition not in configured_conditions:
            raise ValueError(f"condition {condition!r} is not enabled by the config")
        return cls(
            model_name_or_path=str(model["id"]),
            model_revision=str(model.get("revision")) if model.get("revision") else None,
            attention_implementation=str(model.get("attention_implementation", "sdpa")),
            dataset_dir=dataset_dir,
            output_dir=output_dir,
            condition=condition,
            max_seq_length=int(training.get("max_sequence_tokens", 16_384)),
            learning_rate=float(training.get("learning_rate", 1e-4)),
            num_train_epochs=float(training.get("epochs", 1.0)),
            per_device_train_batch_size=int(training.get("microbatch_size", 1)),
            gradient_accumulation_steps=int(training.get("gradient_accumulation_steps", 8)),
            warmup_ratio=float(training.get("warmup_ratio", 0.03)),
            weight_decay=float(training.get("weight_decay", 0.0)),
            max_grad_norm=float(training.get("max_grad_norm", 1.0)),
            scheduler=str(training.get("scheduler", "cosine")),
            seed=int(training.get("seed", 17)),
            bf16=str(training.get("precision", "bf16")) == "bf16",
            gradient_checkpointing=bool(training.get("gradient_checkpointing", True)),
            max_steps=1 if smoke else -1,
            wandb_project=str(wandb.get("project")) if wandb.get("project") else None,
            wandb_group=str(wandb.get("group")) if wandb.get("group") else None,
        )


class PretokenizedCollator:
    """Pad already-tokenized examples while preserving assistant-only labels."""

    def __init__(self, pad_token_id: int, label_pad_token_id: int = -100) -> None:
        self.pad_token_id = pad_token_id
        self.label_pad_token_id = label_pad_token_id

    def __call__(self, examples: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
        import torch

        validate_dataset_records(examples)
        width = max(len(example["input_ids"]) for example in examples)
        rows: dict[str, list[list[int]]] = {"input_ids": [], "attention_mask": [], "labels": []}
        for example in examples:
            length = len(example["input_ids"])
            padding = width - length
            rows["input_ids"].append(list(example["input_ids"]) + [self.pad_token_id] * padding)
            rows["attention_mask"].append(
                list(example.get("attention_mask", [1] * length)) + [0] * padding
            )
            rows["labels"].append(list(example["labels"]) + [self.label_pad_token_id] * padding)
        return {name: torch.tensor(value, dtype=torch.long) for name, value in rows.items()}


def validate_dataset_records(
    records: Iterable[Mapping[str, Any]],
    expected_condition: str | None = None,
    max_sequence_length: int | None = None,
) -> int:
    """Validate token shapes, assistant supervision, arm identity, and length."""
    count = 0
    for index, record in enumerate(records):
        count += 1
        missing = {"input_ids", "labels"} - set(record)
        if missing:
            raise ValueError(f"row {index} missing fields: {', '.join(sorted(missing))}")
        input_ids = record["input_ids"]
        labels = record["labels"]
        attention = record.get("attention_mask", [1] * len(input_ids))
        if not all(isinstance(value, int) for value in input_ids):
            raise ValueError(f"row {index} input_ids must be integers")
        if not input_ids or len(labels) != len(input_ids) or len(attention) != len(input_ids):
            raise ValueError(f"row {index} token and mask lengths do not match")
        if max_sequence_length is not None and len(input_ids) > max_sequence_length:
            raise ValueError(
                f"row {index} has {len(input_ids)} tokens, exceeding max_sequence_length="
                f"{max_sequence_length}; rebuild the corpus rather than truncating tool events"
            )
        if any(value not in (0, 1) for value in attention):
            raise ValueError(f"row {index} attention_mask must contain only 0 or 1")
        if not any(label != -100 for label in labels):
            raise ValueError(f"row {index} has no supervised tokens")
        for position, (mask, label) in enumerate(zip(attention, labels, strict=True)):
            if mask == 0 and label != -100:
                raise ValueError(f"row {index} labels an attention-masked token at {position}")
        if expected_condition is not None and record.get("condition") != expected_condition:
            raise ValueError(
                f"row {index} condition {record.get('condition')!r} does not match "
                f"{expected_condition!r}"
            )
    if count == 0:
        raise ValueError("training dataset is empty")
    return count


def parse_qwen_tool_calls(text: str) -> list[dict[str, Any]]:
    """Parse Qwen ``<tool_call>`` JSON blocks into validated calls."""
    calls: list[dict[str, Any]] = []
    cursor = 0
    opening, closing = "<tool_call>", "</tool_call>"
    while True:
        start = text.find(opening, cursor)
        if start < 0:
            break
        end = text.find(closing, start + len(opening))
        if end < 0:
            raise ValueError("unterminated Qwen tool-call block")
        payload = text[start + len(opening) : end].strip()
        try:
            call = json.loads(payload)
        except json.JSONDecodeError as error:
            raise ValueError(f"invalid Qwen tool-call JSON: {error.msg}") from error
        if not isinstance(call, dict) or not isinstance(call.get("name"), str):
            raise ValueError("Qwen tool call must be an object with a string name")
        arguments = call.get("arguments", {})
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except json.JSONDecodeError as error:
                raise ValueError("Qwen tool-call arguments contain invalid JSON") from error
        if not isinstance(arguments, dict):
            raise ValueError("Qwen tool-call arguments must be an object")
        calls.append({"name": call["name"], "arguments": arguments})
        cursor = end + len(closing)
    return calls


def _supported_kwargs(callable_object: Any, values: dict[str, Any]) -> dict[str, Any]:
    parameters = inspect.signature(callable_object).parameters
    return {key: value for key, value in values.items() if key in parameters}


def _load_splits(config: TrainConfig) -> tuple[Any, Any | None]:
    from datasets import load_dataset

    if config.dataset_path:
        train = load_dataset("json", data_files=config.dataset_path, split="train")
        return train, None
    if not config.dataset_dir:
        raise ValueError("dataset_dir or dataset_path is required")
    condition_dir = Path(config.dataset_dir) / config.condition
    train_path = condition_dir / "train.parquet"
    validation_path = condition_dir / "validation.parquet"
    if not train_path.is_file() or not validation_path.is_file():
        raise FileNotFoundError(f"missing train/validation Parquet under {condition_dir}")
    dataset = load_dataset(
        "parquet", data_files={"train": str(train_path), "validation": str(validation_path)}
    )
    return dataset["train"], dataset["validation"]


def train(config: TrainConfig) -> dict[str, Any]:
    """Run the pinned assistant-only rank-16 LoRA recipe and save the final adapter."""
    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments

    output = Path(config.output_dir)
    if output.exists() and any(output.iterdir()):
        raise FileExistsError(f"refusing to overwrite non-empty output directory: {output}")
    output.mkdir(parents=True, exist_ok=True)
    train_dataset, validation_dataset = _load_splits(config)
    validate_dataset_records(train_dataset, config.condition, config.max_seq_length)
    if validation_dataset is not None:
        validate_dataset_records(validation_dataset, config.condition, config.max_seq_length)

    tokenizer = AutoTokenizer.from_pretrained(
        config.model_name_or_path, revision=config.model_revision
    )
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(
        config.model_name_or_path,
        revision=config.model_revision,
        torch_dtype=torch.bfloat16 if config.bf16 else None,
        attn_implementation=config.attention_implementation,
    )
    model = get_peft_model(
        model,
        LoraConfig(
            r=16,
            lora_alpha=32,
            lora_dropout=0.05,
            bias="none",
            task_type="CAUSAL_LM",
            target_modules=list(TARGET_MODULES),
        ),
    )
    report_to = ["wandb"] if config.wandb_project and os.getenv("WANDB_API_KEY") else []
    if report_to:
        os.environ.setdefault("WANDB_PROJECT", config.wandb_project or "")
        if config.wandb_group:
            os.environ.setdefault("WANDB_RUN_GROUP", config.wandb_group)
    argument_values = {
        "output_dir": str(output / "trainer"),
        "learning_rate": config.learning_rate,
        "lr_scheduler_type": config.scheduler,
        "num_train_epochs": config.num_train_epochs,
        "max_steps": config.max_steps,
        "per_device_train_batch_size": config.per_device_train_batch_size,
        "per_device_eval_batch_size": config.per_device_train_batch_size,
        "gradient_accumulation_steps": config.gradient_accumulation_steps,
        "warmup_ratio": config.warmup_ratio,
        "weight_decay": config.weight_decay,
        "max_grad_norm": config.max_grad_norm,
        "logging_steps": config.logging_steps,
        "save_steps": config.save_steps,
        "eval_steps": config.eval_steps,
        "eval_strategy": "steps" if validation_dataset is not None else "no",
        "evaluation_strategy": "steps" if validation_dataset is not None else "no",
        "save_strategy": "steps",
        "seed": config.seed,
        "bf16": config.bf16,
        "gradient_checkpointing": config.gradient_checkpointing,
        "report_to": report_to,
        "remove_unused_columns": False,
    }
    arguments = TrainingArguments(**_supported_kwargs(TrainingArguments.__init__, argument_values))
    trainer = Trainer(
        model=model,
        args=arguments,
        train_dataset=train_dataset,
        eval_dataset=validation_dataset,
        data_collator=PretokenizedCollator(tokenizer.pad_token_id),
    )
    result = trainer.train()
    final_adapter = output / "final_adapter"
    trainer.save_model(final_adapter)
    tokenizer.save_pretrained(final_adapter)
    metrics = {"condition": config.condition, "final_adapter": str(final_adapter), **result.metrics}
    (output / "training_metrics.json").write_text(
        json.dumps(metrics, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return metrics


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, help="nested YAML recipe")
    parser.add_argument(
        "--dataset-dir", required=True, help="directory containing condition splits"
    )
    parser.add_argument("--condition", choices=CONDITIONS, required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--smoke", action="store_true", help="run one optimizer step")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    config = TrainConfig.from_yaml(
        args.config,
        dataset_dir=args.dataset_dir,
        condition=args.condition,
        output_dir=args.output_dir,
        smoke=args.smoke,
    )
    print(json.dumps(train(config), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
