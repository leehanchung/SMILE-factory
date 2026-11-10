from __future__ import annotations

import json

from skillsbench_trajectory_transfer.overlap import audit_rows, main, normalize_text, summarize


def test_exact_normalization_and_hash_match() -> None:
    assert normalize_text("  Open\nTHE File! ") == "open the file!"
    result = audit_rows(
        [{"task_id": "train", "prompt": "Open THE File!", "tools": []}],
        [{"task_id": "eval", "task_instruction": " open\n the file! ", "tools": []}],
    )[0]
    assert result["normalized_exact_match_train_task_ids"] == ["train"]
    assert result["max_token_5gram_jaccard"] == 0.0
    assert summarize([result])["normalized_exact_match_count"] == 1


def test_lexical_and_canonical_tool_overlap() -> None:
    schema = {"type": "object", "properties": {"path": {"type": "string"}}}
    result = audit_rows(
        [
            {
                "task_id": "near",
                "prompt": "alpha beta gamma delta epsilon zeta",
                "tools": [{"function": {"name": "Read", "parameters": schema}}],
            },
            {"task_id": "far", "prompt": "one two three four five six", "tools": []},
        ],
        [
            {
                "task_id": "eval",
                "prompt": "alpha beta gamma delta epsilon changed",
                "tools": [
                    {
                        "name": "read",
                        "input_schema": {
                            "properties": {"path": {"type": "string"}},
                            "type": "object",
                        },
                    }
                ],
            }
        ],
    )[0]
    assert result["token_5gram_jaccard_train_task_ids"] == ["near"]
    assert result["bm25_train_task_ids"] == ["near"]
    assert result["exact_tool_name_overlap_train_task_ids"] == ["near"]
    assert result["canonical_json_schema_exact_overlap_train_task_ids"] == ["near"]


def test_cli_outputs(tmp_path) -> None:
    train, evaluated = tmp_path / "train.jsonl", tmp_path / "eval.jsonl"
    output, summary = tmp_path / "out.jsonl", tmp_path / "summary.json"
    train.write_text('{"task_id":"t","prompt":"a b c d e","tools":[]}\n')
    evaluated.write_text('{"task_id":"e","prompt":"a b c d e","tools":[]}\n')
    assert (
        main(
            [
                "--train-manifest",
                str(train),
                "--eval-manifest",
                str(evaluated),
                "--output-jsonl",
                str(output),
                "--summary-json",
                str(summary),
            ]
        )
        == 0
    )
    assert len(output.read_text().splitlines()) == 1
    assert json.loads(summary.read_text())["token_5gram_exact_match_count"] == 1
