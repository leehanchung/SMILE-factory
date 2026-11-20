from __future__ import annotations

import json

from skillsbench_trajectory_transfer.report import TRANSFER_CONCLUSION, build_report, main


def test_report_preserves_outcome_exact_metrics_and_provenance(tmp_path):
    run_dir = tmp_path / "run-17"
    (run_dir / "metrics").mkdir(parents=True)
    (run_dir / "provenance").mkdir()
    metrics = {
        "outcome": "inconclusive",
        "BFCL": 0.123456789,
        "IFEval": 0.875,
        "MMLU": 0.625,
        "restraint": 1.0,
    }
    (run_dir / "metrics" / "panel.json").write_text(json.dumps(metrics), encoding="utf-8")
    (run_dir / "provenance" / "run.json").write_text(
        json.dumps({"model": "toy/model", "seed": 17}), encoding="utf-8"
    )
    output = tmp_path / "report" / "index.html"
    assert build_report(run_dir, output) == output
    rendered = output.read_text(encoding="utf-8")
    assert "Outcome: inconclusive" in rendered
    assert TRANSFER_CONCLUSION in rendered
    for value in ("0.123456789", "0.875", "0.625", "1.0"):
        assert value in rendered
    assert "toy/model" in rendered


def test_report_is_deterministic_and_cli_accepts_required_flags(tmp_path):
    run_dir = tmp_path / "empty-run"
    run_dir.mkdir()
    first = tmp_path / "one.html"
    second = tmp_path / "two.html"
    build_report(run_dir, first)
    assert main(["--run-dir", str(run_dir), "--output", str(second)]) == 0
    assert first.read_bytes() == second.read_bytes()
    assert b"Outcome: inconclusive" in first.read_bytes()
