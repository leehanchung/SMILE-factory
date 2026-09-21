from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from skillsbench_trajectory_transfer.corpus import (
    ASSISTANT_TOKEN_BIN_EDGES,
    CONTEXT_TOKEN_BIN_EDGES,
    MATCHING_FIELDS,
    TOOL_TURN_BIN_EDGES,
    assign_task_splits,
    fixed_bin,
    mask_to_budget,
    parse_trajectory_records,
    remove_skill_leakage,
    scan_retained_skill_text,
    select_matched_rows,
    tokenize_with_assistant_mask,
    validate_assistant_token_mask,
)


def record(path: str, request: dict[str, Any], response: dict[str, Any]) -> dict[str, Any]:
    return {
        "request": {"method": "POST", "path": path, "body": request},
        "response": {"body": response},
    }


@pytest.mark.parametrize(
    ("records", "adapter", "tool_text"),
    [
        (
            [
                record(
                    "/v1/chat/completions",
                    {
                        "messages": [
                            {"role": "system", "content": "secret"},
                            {"role": "user", "content": "Solve"},
                            {
                                "role": "assistant",
                                "reasoning_content": "private",
                                "content": "<think>also private</think>",
                                "tool_calls": [
                                    {
                                        "id": "c1",
                                        "function": {
                                            "name": "terminal",
                                            "arguments": '{"command":"pwd"}',
                                        },
                                    }
                                ],
                            },
                            {"role": "tool", "tool_call_id": "c1", "content": "/tmp"},
                        ]
                    },
                    {"choices": [{"message": {"role": "assistant", "content": "Done"}}]},
                )
            ],
            "openai_chat_completions",
            "/tmp",
        ),
        (
            [
                record(
                    "/model/x/converse",
                    {
                        "messages": [
                            {"role": "user", "content": [{"text": "Solve"}]},
                            {
                                "role": "assistant",
                                "content": [
                                    {"reasoningContent": {"reasoningText": {"text": "private"}}},
                                    {
                                        "toolUse": {
                                            "toolUseId": "c1",
                                            "name": "terminal",
                                            "input": {"command": "pwd"},
                                        }
                                    },
                                ],
                            },
                            {
                                "role": "user",
                                "content": [
                                    {
                                        "toolResult": {
                                            "toolUseId": "c1",
                                            "content": [{"text": "/tmp"}],
                                        }
                                    }
                                ],
                            },
                        ]
                    },
                    {"output": {"message": {"role": "assistant", "content": [{"text": "Done"}]}}},
                )
            ],
            "bedrock_converse",
            "/tmp",
        ),
        (
            [
                record(
                    "/v1/models/x:generateContent",
                    {
                        "contents": [
                            {"role": "user", "parts": [{"text": "Solve"}]},
                            {
                                "role": "model",
                                "parts": [
                                    {"thought": True, "text": "private"},
                                    {
                                        "functionCall": {
                                            "name": "terminal",
                                            "args": {"command": "pwd"},
                                        }
                                    },
                                ],
                            },
                            {
                                "role": "user",
                                "parts": [
                                    {
                                        "functionResponse": {
                                            "name": "terminal",
                                            "response": {"text": "/tmp"},
                                        }
                                    }
                                ],
                            },
                        ]
                    },
                    {"candidates": [{"content": {"role": "model", "parts": [{"text": "Done"}]}}]},
                )
            ],
            "gemini_generate_content",
            "/tmp",
        ),
    ],
)
def test_provider_normalization_strips_hidden_content(records, adapter, tool_text) -> None:
    messages, _tools, actual_adapter, audit = parse_trajectory_records(records)
    assert actual_adapter == adapter
    assert [message["role"] for message in messages] == ["user", "assistant", "tool", "assistant"]
    assert tool_text in str(messages)
    assert "private" not in str(messages)
    assert audit["history_compaction_suspected"] is False


def test_skill_redaction_keeps_surrounding_assistant_action() -> None:
    quote = "Documented secret procedure has a stable repeated operational instruction. " * 5
    chunk = " ".join(quote.casefold().split())[:160]
    messages = [
        {"role": "user", "content": "Solve this.\nRead /root/skills/demo/SKILL.md"},
        {
            "role": "assistant",
            "content": "I will read guidance and calculate.",
            "tool_calls": [
                {
                    "id": "read",
                    "type": "function",
                    "function": {
                        "name": "terminal",
                        "arguments": '{"command":"cat /root/skills/demo/SKILL.md"}',
                    },
                },
                {
                    "id": "act",
                    "type": "function",
                    "function": {
                        "name": "calculate",
                        "arguments": json.dumps({"note": quote, "value": 7}),
                    },
                },
            ],
        },
        {"role": "tool", "tool_call_id": "read", "content": quote},
        {"role": "tool", "tool_call_id": "act", "content": "49"},
        {"role": "assistant", "content": quote + " Final answer: 49."},
    ]
    cleaned, audit = remove_skill_leakage(messages, [chunk])
    assert scan_retained_skill_text(cleaned, [chunk]) == {
        "path_reference_hits": 0,
        "known_skill_document_chunk_hits": 0,
    }
    assert cleaned[1]["tool_calls"][0]["id"] == "act"
    assert cleaned[2]["tool_call_id"] == "act"
    assert "Final answer: 49." in cleaned[-1]["content"]
    assert audit["removed_tool_calls"] == audit["removed_tool_messages"] == 1


def test_task_splits_are_deterministic_and_grouped() -> None:
    metadata = {
        f"task-{index}": {"domain": "docs", "difficulty": "medium", "task_instruction": "x"}
        for index in range(10)
    }
    fractions = {"train": 0.7, "validation": 0.15, "audit": 0.15}
    first = assign_task_splits(metadata, 17, fractions)
    assert first == assign_task_splits(metadata, 17, fractions)
    assert set(first.values()) == {"train", "validation", "audit"}
    assert set(first) == set(metadata)


def matched_fixture() -> list[dict[str, Any]]:
    rows = []
    for condition, losses in {"no_skill_success": [4, 6], "with_skill_success": [7, 8]}.items():
        for index, loss in enumerate(losses):
            rows.append(
                {
                    "split": "train",
                    "domain": "docs",
                    "difficulty": "medium",
                    "source_model": "model",
                    "harness": "openhands",
                    "tool_turn_count_bin": fixed_bin(2, TOOL_TURN_BIN_EDGES),
                    "total_context_token_bin": fixed_bin(100, CONTEXT_TOKEN_BIN_EDGES),
                    "assistant_loss_token_bin": fixed_bin(loss, ASSISTANT_TOKEN_BIN_EDGES),
                    "condition": condition,
                    "source_path": f"{condition}-{index}",
                    "segment_index": 0,
                    "labels": list(range(loss)),
                    "loss_tokens": loss,
                }
            )
    return rows


def test_fixed_matching_key_and_pairwise_budget_are_deterministic() -> None:
    assert MATCHING_FIELDS == (
        "split",
        "domain",
        "difficulty",
        "source_model",
        "harness",
        "tool_turn_count_bin",
        "total_context_token_bin",
        "assistant_loss_token_bin",
    )
    first, summary = select_matched_rows(matched_fixture(), seed=17, max_train_loss_tokens=9)
    second, _ = select_matched_rows(matched_fixture(), seed=17, max_train_loss_tokens=9)
    assert first == second
    without = first["train:no_skill_success"]
    with_skill = first["train:with_skill_success"]
    assert [row["loss_tokens"] for row in without] == [row["loss_tokens"] for row in with_skill]
    assert sum(row["loss_tokens"] for row in without) == 9
    assert summary["splits"]["train"]["pairwise_equal_supervision"] is True


def test_budget_mask_never_creates_zero_supervision() -> None:
    with pytest.raises(ValueError):
        mask_to_budget([{"labels": [1]}, {"labels": [2]}], 1)


class CharacterTokenizer:
    def apply_chat_template(self, conversation, *, tokenize, **_kwargs):
        text = "".join(
            f"<|im_start|>{message['role']}\n{message['content']}<|im_end|>\n"
            for message in conversation
        )
        return [ord(character) for character in text] if tokenize else text

    def __call__(self, text, **_kwargs):
        return {
            "input_ids": [ord(character) for character in text],
            "offset_mapping": [(index, index + 1) for index in range(len(text))],
        }


def test_assistant_only_mask_and_validation() -> None:
    messages = [
        {"role": "user", "content": "question"},
        {"role": "assistant", "content": "answer"},
    ]
    ids, labels, _ = tokenize_with_assistant_mask(CharacterTokenizer(), messages, [])
    rendered = CharacterTokenizer().apply_chat_template(messages, tokenize=False)
    answer_start = rendered.index("answer")
    question_start = rendered.index("question")
    assert labels[answer_start] == ids[answer_start]
    assert labels[question_start] == -100
    validate_assistant_token_mask(ids, labels)
    with pytest.raises(ValueError):
        validate_assistant_token_mask([1], [2])


def test_help_is_side_effect_free_without_transformers(tmp_path: Path) -> None:
    command = [sys.executable, "-m", "skillsbench_trajectory_transfer.corpus", "--help"]
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
    result = subprocess.run(
        command, cwd=tmp_path, env=environment, text=True, capture_output=True, check=False
    )
    assert result.returncode == 0
    assert "--input-jsonl" in result.stdout
    assert list(tmp_path.iterdir()) == []
