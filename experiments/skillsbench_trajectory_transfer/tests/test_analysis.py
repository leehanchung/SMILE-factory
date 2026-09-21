from __future__ import annotations

import json

import pytest

from skillsbench_trajectory_transfer.analysis import (
    analyze,
    compare_results,
    main,
    paired_bootstrap,
    read_jsonl,
    wilson_interval,
)


def fixture_rows():
    scores = {
        "a": {"base": 0, "no_skill": 0, "with_skill": 1},
        "b": {"base": 1, "no_skill": 1, "with_skill": 1},
        "c": {"base": 1, "no_skill": 0, "with_skill": 0},
        "d": {"base": 0, "no_skill": 1},
    }
    rows = []
    for task, arms in scores.items():
        for arm, score in arms.items():
            rows.append(
                {
                    "benchmark": "bfcl:multi_turn_base" if task == "c" else "bfcl:simple_python",
                    "task_id": task,
                    "checkpoint": arm,
                    "score": score,
                    "overlap_score": {"a": 0.9, "b": 0.1, "c": 0.4, "d": 0.2}[task],
                    "exact_accuracy": score,
                    "answer_tokens": {"base": 10, "no_skill": 12, "with_skill": 14}[arm],
                }
            )
    return rows


def test_bootstrap_is_exactly_deterministic_and_wilson() -> None:
    first = paired_bootstrap([-1.0, 0.0, 2.0], 321, 17)
    assert first == paired_bootstrap([-1.0, 0.0, 2.0], 321, 17)
    assert first["delta"] == pytest.approx(1 / 3)
    assert wilson_interval(5, 10) == pytest.approx([0.236593, 0.763407], abs=1e-6)


def test_incomplete_pairs_and_derived_bfcl() -> None:
    result = analyze(fixture_rows(), replicates=50, overlap_exclusions=(0, 1 / 3, 2 / 3))
    overall = {
        item["comparison"]: item for item in result["comparisons"] if item["benchmark"] == "overall"
    }
    assert overall["with_skill-no_skill"]["n_pairs"] == 3
    assert overall["no_skill-base"]["n_pairs"] == 4
    assert [item["group"] for item in result["derived_summaries"]] == [
        "bfcl_overall",
        "bfcl_single",
        "bfcl_multi",
    ]
    sensitivity = [
        item
        for item in result["overlap_sensitivity"]
        if item["comparison"] == "with_skill-no_skill"
    ]
    assert [item["n_pairs"] for item in sensitivity] == [3, 2, 1]


def test_duplicate_rejected(tmp_path) -> None:
    path = tmp_path / "rows.jsonl"
    row = fixture_rows()[0]
    path.write_text(json.dumps(row) + "\n" + json.dumps(row) + "\n")
    with pytest.raises(ValueError, match="Duplicate"):
        read_jsonl(path)


def test_structured_comparison_exact_pass_and_fail() -> None:
    actual = {"accuracy": 0.5, "ci": [0.4, 0.6], "counts": {"correct": 5}}
    assert compare_results(actual, actual)["status"] == "passed"
    report = compare_results(actual, {"accuracy": 0.51, "ci": [0.4, 0.6], "counts": {"correct": 5}})
    assert report["status"] == "failed"
    assert report["mismatches"][0]["path"] == "$recorded.accuracy"


def test_cli_comparison_exit_codes(tmp_path) -> None:
    source, output, csv = tmp_path / "in.jsonl", tmp_path / "out.json", tmp_path / "out.csv"
    source.write_text("".join(json.dumps(row) + "\n" for row in fixture_rows()))
    args = [str(source), "--json", str(output), "--csv", str(csv), "--bootstrap-replicates", "20"]
    assert main(args) == 0
    recorded, reproduction = tmp_path / "recorded.json", tmp_path / "reproduction.json"
    recorded.write_text(output.read_text())
    assert (
        main([*args, "--compare", str(recorded), "--reproduction-output", str(reproduction)]) == 0
    )
    changed = json.loads(recorded.read_text())
    changed["aggregates"][0]["mean_score"] += 0.1
    recorded.write_text(json.dumps(changed))
    assert (
        main([*args, "--compare", str(recorded), "--reproduction-output", str(reproduction)]) == 1
    )
    assert json.loads(reproduction.read_text())["status"] == "failed"
