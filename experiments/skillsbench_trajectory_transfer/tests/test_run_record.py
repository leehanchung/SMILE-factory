from __future__ import annotations

import json
from pathlib import Path

RUN = Path(__file__).resolve().parents[1] / "runs" / "exp_01ky0ztpc9eqn9g67e30pjt5k9"


def load_json(relative: str) -> dict[str, object]:
    return json.loads((RUN / relative).read_text(encoding="utf-8"))


def test_recorded_headline_metrics_and_power() -> None:
    final = load_json("metrics/final_metrics.json")
    bfcl = final["bfcl"]
    assert bfcl["n"] == 2190
    assert bfcl["base"]["correct"] == 1386
    assert bfcl["no_skill"]["correct"] == 1360
    assert bfcl["with_skill"]["correct"] == 1341
    assert bfcl["deltas"]["with_minus_no_skill"] == -0.0086757991
    assert bfcl["paired_bootstrap_95"]["with_minus_no_skill"] == [
        -0.0191780822,
        0.001826484,
    ]
    assert final["ifeval_prompt_strict"]["n"] == 541
    assert final["mmlu_fixed500"]["n"] == 500
    assert final["tool_restraint"]["n_pairs"] == 120
    assert set(final["tool_restraint"]["unnecessary_tool_call_rate"].values()) == {0.0}
    assert final["training_power"]["matched_train_rows_per_arm"] == 238
    assert final["training_power"]["supervised_tokens_per_arm"] == 604737
    assert final["training_power"]["seed_count"] == 1
    assert final["toolathlon"]["status"] == "unavailable"


def test_normalized_rows_preserve_three_arms_per_task() -> None:
    rows = [
        json.loads(line)
        for line in (RUN / "data/normalized_paired_rows.jsonl").read_text().splitlines()
        if line
    ]
    assert len(rows) == 10413
    keys = {(row["benchmark"], row["task_id"]) for row in rows}
    assert len(keys) == 3471
    assert {row["checkpoint"] for row in rows} == {"base", "no_skill", "with_skill"}


def test_external_manifest_and_report_are_complete() -> None:
    artifact_manifest = load_json("artifacts/manifest.json")
    objects = [item for group in artifact_manifest["groups"].values() for item in group["objects"]]
    assert len(objects) == 15
    assert sum(item["size_bytes"] for item in objects[2:13]) == 218511542
    assert all(item["ref"].startswith("artifact://") for item in objects)
    assert all(item["etag"] and item["provider_version"] for item in objects)

    report = (RUN / "report/index.html").read_text(encoding="utf-8")
    assert "No positive short-horizon transfer detected" in report
    assert "Toolathlon: unavailable, not failed" in report
