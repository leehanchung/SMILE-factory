"""Cache ingestion failures must not masquerade as perfect model performance."""

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest

from jev_research.revised_analysis import (
    bin_diagnostics,
    load_cached_run,
    run_analysis,
    synthetic_identity,
)


def write_cache(tmp_path, *, response=True):
    case = {
        "scenario_id": "case",
        "family": "bernoulli",
        "track": "explicit",
        "event": "heads",
        "opposite": "tails",
        "q": 0.1,
        "true_key": "yes",
        "false_key": "no",
    }
    payload = {
        "model": "jev-1.13.0",
        "questions": {
            "choice": {"criteria": {"yes": "heads", "no": "tails"}},
            "event": {"instructions": "heads"},
            "complement": {"instructions": "tails"},
        },
    }
    sha = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    (tmp_path / "requests.json").write_text(
        json.dumps([{"case": case, "payload": payload, "experiment": "synthetic"}])
    )
    (tmp_path / "manifest.json").write_text(json.dumps({"fresh_requests": 1}))
    (tmp_path / "failures.json").write_text("[]" if response else '[{"error":"timeout"}]')
    (tmp_path / "responses").mkdir()
    if response:
        (tmp_path / "responses/0000.json").write_text(
            json.dumps(
                {
                    **case,
                    "model": payload["model"],
                    "request_sha256": sha,
                    "choice_p": 0.1,
                    "choice_other_p": 0.9,
                    "noul_p": 0.1,
                    "complement_p": 0.8,
                }
            )
        )
    return tmp_path


def test_missing_cache_response_keeps_requested_record_and_failure_denominator(tmp_path):
    rows, checks, coverage = load_cached_run(write_cache(tmp_path, response=False))
    assert len(rows) == 1
    assert rows.choice_p.isna().all()
    assert not checks.response_present.any()
    assert coverage["missing_responses"] == coverage["failure_log_entries"] == 1


def test_independent_complement_incoherence_does_not_delete_valid_event(tmp_path):
    rows, checks, _ = load_cached_run(write_cache(tmp_path))
    assert checks.choice_normalized.all()
    assert checks.noul_complement_gap.iloc[0] == pytest.approx(0.1)
    assert rows.noul_p.iloc[0] == 0.1


def test_cached_target_tampering_is_rejected(tmp_path):
    write_cache(tmp_path)
    path = tmp_path / "responses/0000.json"
    response = json.loads(path.read_text())
    response["q"] = 0.9
    path.write_text(json.dumps(response))
    with pytest.raises(ValueError, match="q differs"):
        load_cached_run(tmp_path)


def test_bin_intervals_do_not_double_count_quantile_boundary_ties():
    p = np.array([0.0, 0.5, 0.5, 1.0])
    y = np.array([0.0, 0.0, 1.0, 1.0])
    bins, sensitivity = bin_diagnostics(p, y, "real_event", np.arange(4), None, 30)
    for strategy in ["equal_width", "equal_mass"]:
        for count in [5, 10, 20]:
            subset = [b for b in bins if b["strategy"] == strategy and b["requested_bins"] == count]
            assert sum(b["n"] for b in subset) == 4
            assert sum(b["n_groups"] for b in subset) == 4
    assert all(np.isfinite(b["ece"]) for b in sensitivity)


def test_reanalysis_refuses_existing_artifact_directory_before_writing(tmp_path):
    original = tmp_path / "results.csv"
    original.write_text("original")
    with pytest.raises(FileExistsError):
        run_analysis(Path(__file__).resolve().parents[1], tmp_path, n_boot=20)
    assert original.read_text() == "original"


def test_synthetic_variants_share_conservative_generating_process_groups():
    root = Path(__file__).resolve().parents[1]
    source = root / "runs/04-jev-calibration-20260920T074937231226Z"
    if not source.exists():
        pytest.skip("Historical cache is not distributed with git")
    rows, _, _ = load_cached_run(source)
    frame = synthetic_identity(rows[rows.experiment.isin(["synthetic", "two-dice"])])
    assert len(frame) == 85
    assert frame.underlying_event.nunique() == 50
    assert frame.uncertainty_group.nunique() == 24
    assert frame[frame.family.eq("two_dice")].uncertainty_group.nunique() == 1


def test_bootstrap_keeps_failure_positions_and_suppresses_single_group_certainty(monkeypatch):
    import jev_research.revised_analysis as analysis

    seen_lengths = []
    original = analysis.bootstrap_indices

    def record_length(n, rng, **kwargs):
        seen_lengths.append(n)
        return original(n, rng, **kwargs)

    monkeypatch.setattr(analysis, "bootstrap_indices", record_length)
    p, y = np.array([0.2, np.nan, 0.8, 0.7]), np.array([0.0, 1.0, 1.0, 0.0])
    analysis.metric_intervals(p, y, "real_event", np.arange(4), 2, 20)
    bin_diagnostics(p, y, "real_event", np.arange(4), 2, 20)
    assert seen_lengths and set(seen_lengths) == {4}
    values = analysis.metric_intervals([0.2, np.nan], [0.0, 1.0], "real_event", [1, 2], None, 20)
    assert np.isnan(values["brier_low"])
    bins, _ = bin_diagnostics([0.2, 0.8], [0.0, 1.0], "real_event", [1, 2], None, 20)
    assert all(np.isnan(b["group_rate_low"]) for b in bins if b["n"] == 1)


def test_ece_boundary_and_bootstrap_definition_match_historical_ece10():
    from jev_research.evaluation import evaluate_predictions
    from jev_research.revised_analysis import metric_intervals

    p, y = [0.29, 0.3], [0.0, 1.0]
    point = evaluate_predictions(p, y)
    assert point["ece10"] == pytest.approx(0.495)
    values = metric_intervals(p, y, "real_event", [0, 1], None, 100)
    assert values["ece10_low"] == pytest.approx(0.29)
    assert values["ece10_high"] == pytest.approx(0.7)
