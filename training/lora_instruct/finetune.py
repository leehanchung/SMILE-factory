import os
import sys
import warnings
from typing import List, Optional

import fire
import torch
from datasets import load_dataset
from dotenv import load_dotenv
from peft import (
    LoraConfig,
    get_peft_model,
    prepare_model_for_kbit_training,
    set_peft_model_state_dict,
)
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    DataCollatorForSeq2Seq,
    EarlyStoppingCallback,
    Trainer,
    TrainingArguments,
)
from transformers.tokenization_utils_base import logger as tokenization_logger

from utils.monitoring import MonitorCallback
from utils.prompter import Prompter

load_dotenv()
warnings.filterwarnings(
    "ignore",
    message=".*GPTNeoXTokenizerFast.*",
    category=UserWarning,
    module="transformers.tokenization_utils_base",
)
tokenization_logger.setLevel("ERROR")


class TokenizerHelper:
    def __init__(
        self, prompter, tokenizer, train_on_inputs, cutoff_len, add_eos_token=True
    ):
        self.prompter = prompter
        self.tokenizer = tokenizer
        self.train_on_inputs = train_on_inputs
        self.add_eos_token = add_eos_token
        self.cutoff_len = cutoff_len

    def tokenize(self, prompt):
        result = self.tokenizer(
            prompt,
            truncation=True,
            max_length=self.cutoff_len,
            padding=False,
            return_tensors=None,
        )
        if (
            result["input_ids"][-1] != self.tokenizer.eos_token_id
            and len(result["input_ids"]) < self.cutoff_len
            and self.add_eos_token
        ):
            result["input_ids"].append(self.tokenizer.eos_token_id)
            result["attention_mask"].append(1)
        result["labels"] = result["input_ids"].copy()
        return result

    def generate_and_tokenize_prompt(self, data_point):
        full_prompt = self.prompter.generate_prompt(
            data_point["instruction"],
            data_point["input"],
            data_point["output"],
        )
        tokenized_full_prompt = self.tokenize(full_prompt)

        if not self.train_on_inputs:
            user_prompt = self.prompter.generate_prompt(
                data_point["instruction"], data_point["input"]
            )
            tokenized_user_prompt = self.tokenize(user_prompt)
            user_prompt_len = len(tokenized_user_prompt["input_ids"])

            if self.add_eos_token:
                user_prompt_len -= 1

            tokenized_full_prompt["labels"] = [
                -100
            ] * user_prompt_len + tokenized_full_prompt["input_ids"][user_prompt_len:]
        return tokenized_full_prompt


def train(
    # model/data params
    base_model: str = "",  # the only required argument
    data_path: str = "yahma/alpaca-cleaned",
    output_dir: str = "./lora-alpaca",
    # training hyperparams
    batch_size: int = 128,
    micro_batch_size: int = 4,
    num_epochs: int = 3,
    max_steps: int = -1,  # >0 caps total optimizer steps (handy for smoke tests)
    learning_rate: float = 3e-4,
    cutoff_len: int = 256,
    val_set_size: int = 2000,
    # precision / memory
    bits: int = 0,  # 0 = bf16 (no quant), 4 = QLoRA nf4, 8 = int8
    bf16: bool = True,
    gradient_checkpointing: bool = True,
    use_compile: bool = False,  # torch.compile — off by default (flaky with PEFT/DDP)
    # lora hyperparams
    lora_r: int = 8,
    lora_alpha: int = 16,
    lora_dropout: float = 0.05,
    # None -> "all-linear" (PEFT auto-targets every linear layer, arch-agnostic)
    lora_target_modules: Optional[List[str]] = None,
    train_on_inputs: bool = True,  # if False, masks out inputs in loss
    add_eos_token: bool = True,
    group_by_length: bool = False,  # deprecated/no-op: removed from transformers 5 TrainingArguments
    resume_from_checkpoint: Optional[str] = None,  # checkpoint or final adapter
    prompt_template_name: str = "alpaca",  # Prompt template to use, default Alpaca
    # logging / monitoring
    logging_steps: int = 10,
    eval_steps: int = 200,
    save_steps: int = 200,
    seed: int = 42,
    wandb_project: str = "",
    wandb_run_name: str = "",
    eval_samples: int = 0,  # >0: generate from N held-out prompts each eval
    eval_sample_new_tokens: int = 128,
    early_stopping_patience: int = 0,  # >0: stop after N evals w/o eval_loss improvement
    # security: only enable for base models whose repo code you have reviewed/trust
    # (runs arbitrary Python from the model repo, e.g. MPT-style custom architectures)
    trust_remote_code: bool = False,
):
    assert base_model, (
        "Please specify a --base_model, e.g. --base_model='Qwen/Qwen2.5-1.5B'"
    )
    assert bits in (0, 4, 8), "--bits must be one of 0 (bf16), 4 (nf4), 8 (int8)"

    # ---- distributed setup (torchrun sets RANK/LOCAL_RANK/WORLD_SIZE) ----
    world_size = int(os.environ.get("WORLD_SIZE", 1))
    local_rank = int(os.environ.get("LOCAL_RANK", 0))
    ddp = world_size != 1
    is_main = local_rank == 0
    # On DDP every rank holds a full copy of the model pinned to its own GPU.
    device_map = {"": local_rank} if ddp else "auto"
    # batch_size is the global effective batch; split the grad-accum across ranks.
    gradient_accumulation_steps = batch_size // micro_batch_size
    if ddp:
        gradient_accumulation_steps = max(1, gradient_accumulation_steps // world_size)

    use_wandb = bool(wandb_project)
    if use_wandb and is_main:
        os.environ["WANDB_PROJECT"] = wandb_project

    if is_main:
        print(
            f"\nLoRA fine-tuning with params:\n"
            f"  base_model: {base_model}\n"
            f"  data_path: {data_path}\n"
            f"  output_dir: {output_dir}\n"
            f"  world_size: {world_size} (ddp={ddp})\n"
            f"  batch_size: {batch_size} | micro: {micro_batch_size} | "
            f"grad_accum: {gradient_accumulation_steps}\n"
            f"  bits: {bits} | bf16: {bf16} | grad_ckpt: {gradient_checkpointing}\n"
            f"  lora: r={lora_r} alpha={lora_alpha} dropout={lora_dropout} "
            f"targets={lora_target_modules or 'all-linear'}\n"
            f"  epochs: {num_epochs} | lr: {learning_rate} | cutoff: {cutoff_len}\n"
        )

    prompter = Prompter(prompt_template_name)

    # ---- tokenizer ----
    tokenizer = AutoTokenizer.from_pretrained(
        base_model, trust_remote_code=trust_remote_code
    )
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    tokenizer.padding_side = "right"  # right pad for causal-LM training

    # ---- model ----
    quantization_config = None
    if bits == 4:
        quantization_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )
    elif bits == 8:
        quantization_config = BitsAndBytesConfig(load_in_8bit=True)

    model = AutoModelForCausalLM.from_pretrained(
        base_model,
        quantization_config=quantization_config,
        dtype=torch.bfloat16 if bits == 0 else None,
        device_map=device_map,
        trust_remote_code=trust_remote_code,
    )

    if quantization_config is not None:
        model = prepare_model_for_kbit_training(
            model, use_gradient_checkpointing=gradient_checkpointing
        )
    elif gradient_checkpointing:
        model.gradient_checkpointing_enable(
            gradient_checkpointing_kwargs={"use_reentrant": False}
        )
        model.enable_input_require_grads()

    lora_config = LoraConfig(
        r=lora_r,
        lora_alpha=lora_alpha,
        target_modules=lora_target_modules or "all-linear",
        lora_dropout=lora_dropout,
        bias="none",
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora_config)
    model.config.use_cache = False
    print(
        f"[rank {local_rank}/{world_size}] model params on {next(model.parameters()).device}",
        flush=True,
    )
    if is_main:
        model.print_trainable_parameters()

    # ---- data ----
    if data_path.endswith(".json") or data_path.endswith(".jsonl"):
        data = load_dataset("json", data_files=data_path)
    else:
        data = load_dataset(data_path)

    if resume_from_checkpoint:
        checkpoint_name = os.path.join(
            resume_from_checkpoint, "adapter_model.safetensors"
        )
        if not os.path.exists(checkpoint_name):
            checkpoint_name = os.path.join(resume_from_checkpoint, "adapter_model.bin")
            resume_from_checkpoint = False  # let Trainer skip its own state load
        if os.path.exists(checkpoint_name):
            print(f"Restarting from {checkpoint_name}")
            from safetensors.torch import load_file

            adapters_weights = (
                load_file(checkpoint_name)
                if checkpoint_name.endswith(".safetensors")
                else torch.load(checkpoint_name, weights_only=True)
            )
            set_peft_model_state_dict(model, adapters_weights)
        else:
            print(f"Checkpoint {checkpoint_name} not found")

    tokenizer_helper = TokenizerHelper(
        prompter, tokenizer, train_on_inputs, cutoff_len, add_eos_token
    )
    remove_cols = data["train"].column_names
    sample_rows = []  # raw held-out prompts for the sample-generation monitor
    if val_set_size > 0:
        train_val = data["train"].train_test_split(
            test_size=val_set_size, shuffle=True, seed=seed
        )
        if eval_samples > 0:
            n = min(eval_samples, len(train_val["test"]))
            sample_rows = [train_val["test"][i] for i in range(n)]
        train_data = (
            train_val["train"]
            .shuffle()
            .map(
                tokenizer_helper.generate_and_tokenize_prompt,
                remove_columns=remove_cols,
            )
        )
        val_data = (
            train_val["test"]
            .shuffle()
            .map(
                tokenizer_helper.generate_and_tokenize_prompt,
                remove_columns=remove_cols,
            )
        )
    else:
        train_data = (
            data["train"]
            .shuffle()
            .map(
                tokenizer_helper.generate_and_tokenize_prompt,
                remove_columns=remove_cols,
            )
        )
        val_data = None

    callbacks = [
        MonitorCallback(
            prompter=prompter,
            tokenizer=tokenizer,
            sample_rows=sample_rows,
            sample_new_tokens=eval_sample_new_tokens,
            is_main=is_main,
        )
    ]
    if early_stopping_patience > 0 and val_set_size > 0:
        callbacks.append(
            EarlyStoppingCallback(early_stopping_patience=early_stopping_patience)
        )

    trainer = Trainer(
        model=model,
        train_dataset=train_data,
        eval_dataset=val_data,
        processing_class=tokenizer,
        callbacks=callbacks,
        args=TrainingArguments(
            per_device_train_batch_size=micro_batch_size,
            gradient_accumulation_steps=gradient_accumulation_steps,
            warmup_steps=100,
            num_train_epochs=num_epochs,
            max_steps=max_steps,
            learning_rate=learning_rate,
            bf16=bf16,
            logging_steps=logging_steps,
            optim="adamw_torch",
            eval_strategy="steps" if val_set_size > 0 else "no",
            save_strategy="steps",
            eval_steps=eval_steps if val_set_size > 0 else None,
            save_steps=save_steps,
            output_dir=output_dir,
            save_total_limit=3,
            load_best_model_at_end=val_set_size > 0,
            metric_for_best_model="eval_loss",
            greater_is_better=False,
            ddp_find_unused_parameters=False if ddp else None,
            report_to="wandb" if use_wandb else "none",
            run_name=wandb_run_name or None,
            seed=seed,
        ),
        data_collator=DataCollatorForSeq2Seq(
            tokenizer, pad_to_multiple_of=8, return_tensors="pt", padding=True
        ),
    )

    if use_compile and torch.__version__ >= "2" and sys.platform != "win32":
        model = torch.compile(model)

    trainer.train(resume_from_checkpoint=resume_from_checkpoint)

    model.save_pretrained(output_dir)
    if is_main:
        tokenizer.save_pretrained(output_dir)
        print("\nDone. LoRA adapter saved to", output_dir)


if __name__ == "__main__":
    fire.Fire(train)
