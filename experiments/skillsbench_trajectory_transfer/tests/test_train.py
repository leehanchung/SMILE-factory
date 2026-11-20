from __future__ import annotations

import sys
from types import SimpleNamespace

import pytest

from skillsbench_trajectory_transfer.train import (
    PretokenizedCollator,
    TrainConfig,
    parse_qwen_tool_calls,
    validate_dataset_records,
)


def test_config_yaml_and_dataset_validation(tmp_path):
    config_path = tmp_path / "train.yaml"
    config_path.write_text(
        "model_name_or_path: qwen-toy\ndataset_path: toy.jsonl\noutput_dir: out\ncondition: matched\n",
        encoding="utf-8",
    )
    config = TrainConfig.from_yaml(config_path)
    assert config.model_name_or_path == "qwen-toy"
    assert config.condition == "matched"
    rows = [
        {
            "input_ids": [1, 2],
            "attention_mask": [1, 1],
            "labels": [-100, 2],
            "condition": "matched",
        }
    ]
    assert validate_dataset_records(rows, config.condition) == 1
    with pytest.raises(ValueError, match="attention-masked"):
        validate_dataset_records([{"input_ids": [1], "attention_mask": [0], "labels": [1]}])
    with pytest.raises(ValueError, match="exceeding max_sequence_length=1"):
        validate_dataset_records(rows, "matched", max_sequence_length=1)
    assert validate_dataset_records(rows, "matched", max_sequence_length=2) == 1


def test_pretokenized_collator_pads_without_tokenizer(monkeypatch):
    class FakeTensor(list):
        pass

    monkeypatch.setitem(
        sys.modules,
        "torch",
        SimpleNamespace(long="long", tensor=lambda value, dtype: FakeTensor(value)),
    )
    collator = PretokenizedCollator(pad_token_id=0)
    batch = collator(
        [
            {"input_ids": [3, 4], "labels": [-100, 4]},
            {"input_ids": [5], "labels": [5]},
        ]
    )
    assert batch["input_ids"] == [[3, 4], [5, 0]]
    assert batch["attention_mask"] == [[1, 1], [1, 0]]
    assert batch["labels"] == [[-100, 4], [5, -100]]


def test_qwen_tool_call_parser():
    text = (
        'before<tool_call>{"name":"search","arguments":{"q":"toy"}}</tool_call>'
        'after<tool_call>{"name":"open","arguments":"{\\"id\\": 3}"}</tool_call>'
    )
    assert parse_qwen_tool_calls(text) == [
        {"name": "search", "arguments": {"q": "toy"}},
        {"name": "open", "arguments": {"id": 3}},
    ]
