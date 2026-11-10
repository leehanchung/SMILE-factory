"""Tests cover preserved uncertainty, provenance, and split independence units."""

import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from jev_research.population import (
    DATASETS,
    audit_population,
    deduplicate_source_exports,
    feature_groups,
    legacy_filtered_mask,
    load_population,
    prospective_split,
)

ROOT = Path(__file__).resolve().parents[1]
RUN = ROOT / "runs/04-jev-calibration-20260920T074937231226Z"


def test_identical_features_conflicting_outcomes_are_kept_and_grouped():
    features = pd.DataFrame({"feature": [1, 1, 1, 2]})
    y = pd.Series([0, 1, 0, 1])
    groups = feature_groups(features)
    assert groups.iloc[0] == groups.iloc[1] == groups.iloc[2]
    assert len(features) == len(groups) == 4
    assert legacy_filtered_mask(features, y).tolist() == [False, False, False, True]


def test_only_proven_source_identity_allows_export_deduplication():
    observations = pd.DataFrame(
        {"source_record_id": ["a", "a", "b", "c"], "feature": [1] * 4, "y": [0, 0, 0, 1]}
    )
    result = deduplicate_source_exports(observations)
    assert result.source_record_id.tolist() == ["a", "b", "c"]
    assert result.y.tolist() == [0, 0, 1]
    conflicting_exports = observations.copy()
    conflicting_exports.loc[1, "y"] = 1
    with pytest.raises(ValueError, match="Conflicting exports"):
        deduplicate_source_exports(conflicting_exports)
    with pytest.raises(ValueError, match="source identity"):
        deduplicate_source_exports(observations.drop(columns="source_record_id"))


def test_group_splits_keep_paraphrase_or_customer_units_disjoint():
    y = pd.Series([0, 1] * 30)
    groups = pd.Series(np.repeat(np.arange(20), 3))
    assignment, meta = prospective_split(y, groups)
    assert assignment.notna().all()
    assert set(assignment) == {"development", "calibration", "final_test"}
    assert meta["groups_crossing_partitions"] == 0
    assert pd.DataFrame({"g": groups, "part": assignment}).groupby("g").part.nunique().max() == 1
    flipped, _ = prospective_split(1 - y, groups)
    pd.testing.assert_series_equal(assignment, flipped)
    assert sum(part["source_records"] for part in meta["partitions"].values()) == len(y)


def test_temporal_split_preserves_order_and_reports_crossing_groups():
    y = pd.Series([0, 1] * 5)
    groups = pd.Series(["same-customer"] * 10)
    order = pd.Series(np.arange(10)[::-1])
    assignment, meta = prospective_split(y, groups, temporal_order=order)
    assert assignment.loc[[9, 8, 7, 6, 5, 4]].eq("development").all()
    assert assignment.loc[[3, 2]].eq("calibration").all()
    assert assignment.loc[[1, 0]].eq("final_test").all()
    assert meta["groups_crossing_partitions"] == 1
    assert meta["requires_group_crossing_review"]
    assert sum(part["events"] for part in meta["partitions"].values()) == y.sum()


def test_split_fails_on_missing_alignment_or_invalid_roles():
    y = pd.Series([0, 1, 0, 1])
    groups = pd.Series([0, 1, 2, 3])
    with pytest.raises(ValueError, match="row indices"):
        prospective_split(y, groups.iloc[::-1])
    with pytest.raises(ValueError, match="fractions"):
        prospective_split(y, groups, fractions=(0.5, 0.5, 0.5))
    with pytest.raises(ValueError, match="nonmissing"):
        prospective_split(y, pd.Series([0, 1, None, 3]))


@pytest.mark.parametrize("slug", DATASETS)
def test_cached_source_population_and_pilot_features_match(slug):
    features, y, groups, meta = load_population(ROOT, slug)
    split = json.loads((RUN / f"{slug}-split.json").read_text())
    assert len(features) == split["raw_rows"]
    assert len(groups) == len(y) == len(features)
    assert meta["archive_sha256"] == split["archive_sha256"]
    assert legacy_filtered_mask(features, y).sum() == split["retained_rows"]
    assert not set(meta["excluded_features"]) & set(features.columns)
    requests = json.loads((RUN / "requests.json").read_text())
    for request in requests:
        if request["experiment"] != slug:
            continue
        case = request["case"]
        row_id = case["row_id"]
        expected = features.loc[row_id].copy()
        for column in features.select_dtypes(include=["object", "bool"]).columns:
            expected[column] = str(expected[column])
        assert json.loads(case["state"].split("\nFeatures: ", 1)[1]) == expected.to_dict()
        assert case["y"] == y.loc[row_id]


def test_audit_reports_missing_excluded_population_and_matched_pilot():
    tables = audit_population(ROOT, RUN)
    population = tables["population_summary"].set_index("dataset")
    assert population.loc["bank-marketing", "rows_in_conflicting_feature_groups"] == 542
    assert population.loc["bank-marketing", "legacy_excluded_rows"] == 2258
    assert population.proven_duplicate_exports.eq(0).all()
    assert population.matches_saved_retained_count.all()
    rows = tables["row_groups"]
    assert rows.source_record_id.is_unique
    excluded = rows[~rows.legacy_retained]
    assert not excluded.cached_response.any()
    coverage = tables["prediction_coverage"]
    tests = coverage[coverage.population == "historical_test_sample"]
    assert tests.baseline_matched_source_records.eq(200).all()
    assert tests.cached_label_mismatches.eq(0).all()
    overlaps = tables["split_audit"].query("check == 'partition_overlap'")
    assert overlaps.source_id_overlap.eq(0).all()
    assert overlaps.feature_group_overlap.eq(0).all()
    assert overlaps.loc[overlaps.dataset == "bank-marketing", "chronological_order_pass"].all()


def test_live_preparation_defaults_to_preserved_bank_population_and_legacy_opt_in():
    spec = importlib.util.spec_from_file_location(
        "fresh", ROOT / "scripts/run_fresh_experiments.py"
    )
    fresh = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fresh)
    features, y, train, cal, test, meta, *_ = fresh.load_uci("bank-marketing")
    assert len(features) == 41188
    assert meta["removed_duplicate_or_conflicting_rows"] == 0
    assert meta["conflicting_feature_groups"] == 237
    assert max(train) < min(cal) < min(test)
    assert len(cal) == 120 and len(test) == 200
    assert len(y) == len(features)
    legacy = fresh.load_uci("bank-marketing", filtered_sensitivity=True)
    original = json.loads((RUN / "bank-marketing-split.json").read_text())
    assert len(legacy[0]) == original["retained_rows"]
    for index, key in [(2, "train_ids"), (3, "calibration_ids"), (4, "test_ids")]:
        assert legacy[index].tolist() == original[key]
    assert "sensitivity" in legacy[5]["population_policy"]
