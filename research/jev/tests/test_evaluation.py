"""Controlled predictors and resampling checks for target-specific evaluation."""

import numpy as np
import pytest
from scipy.special import expit, logit

from jev_research.evaluation import (
    align_probabilities,
    bootstrap_calibration_comparison,
    bootstrap_comparison,
    bootstrap_indices,
    calibration_sensitivity,
    chosen_answer_targets,
    complement_diagnostic,
    evaluate_predictions,
    fit_calibrator,
    percentile_interval,
    reliability_bins,
    validate_probabilities,
)


def test_oracle_exact_probabilities_have_zero_recovery_error_but_nonzero_expected_loss():
    q = np.array([0.0, 0.1, 0.3, 0.5, 0.9, 1.0])
    scores = evaluate_predictions(q, q, target_kind="known_probability")
    assert scores["probability_mae"] == 0
    assert scores["excess_expected_brier"] == 0
    assert scores["ece10"] == 0
    assert scores["expected_brier"] == pytest.approx(np.mean(q * (1 - q)))
    assert scores["brier"] == scores["expected_brier"]
    assert scores["expected_brier"] > 0
    assert np.isnan(scores["auroc"])
    assert "threshold_accuracy" not in scores


def test_expected_brier_equals_analytic_outcome_average_and_excess_decomposition():
    q = np.linspace(0, 1, 31)
    p = np.linspace(0.15, 0.95, 31)
    scores = evaluate_predictions(p, q, target_kind="known_probability")
    exact = np.mean(q * (1 - p) ** 2 + (1 - q) * p**2)
    assert scores["expected_brier"] == pytest.approx(exact)
    assert scores["expected_brier"] == pytest.approx(
        scores["irreducible_brier"] + scores["excess_expected_brier"]
    )
    assert scores["expected_log_loss"] == pytest.approx(
        -np.mean(q * np.log(p) + (1 - q) * np.log1p(-p))
    )


def test_constant_base_rate_is_calibrated_despite_no_discrimination():
    y = np.r_[np.zeros(75), np.ones(25)]
    scores = evaluate_predictions(np.full(100, 0.25), y, target_kind="real_event")
    assert scores["ece10"] == 0
    assert scores["auroc"] == 0.5
    assert scores["average_precision"] == 0.25
    assert scores["brier"] == 0.25 * 0.75
    assert scores["threshold_accuracy"] == 0.75
    assert scores["coverage"] == 1


def test_overconfidence_preserves_rank_discrimination_but_worsens_probability_quality():
    q = np.array([0.1, 0.3, 0.7, 0.9])
    overconfident = expit(3 * logit(q))
    assert np.array_equal(np.argsort(q), np.argsort(overconfident))
    oracle = evaluate_predictions(q, q, target_kind="known_probability")
    distorted = evaluate_predictions(overconfident, q, target_kind="known_probability")
    assert distorted["probability_mae"] > oracle["probability_mae"]
    assert distorted["expected_brier"] > oracle["expected_brier"]
    assert distorted["expected_log_loss"] > oracle["expected_log_loss"]
    y = np.concatenate([np.r_[np.ones(round(100 * v)), np.zeros(round(100 * (1 - v)))] for v in q])
    raw = evaluate_predictions(np.repeat(q, 100), y)
    transformed = evaluate_predictions(np.repeat(overconfident, 100), y)
    assert raw["ece10"] == pytest.approx(0)
    assert transformed["ece10"] > 0
    assert transformed["auroc"] == raw["auroc"]
    assert transformed["average_precision"] == raw["average_precision"]


def test_event_forecasts_use_event_outcomes_and_answer_confidence_uses_correctness():
    p_event = np.array([0.1, 0.9, 0.2, 0.8])
    outcome = np.array([0, 1, 1, 0])
    chosen = (p_event >= 0.5).astype(int)
    confidence, correctness = chosen_answer_targets(
        np.maximum(p_event, 1 - p_event), chosen, outcome
    )
    event = evaluate_predictions(p_event, outcome, target_kind="real_event")
    answer = evaluate_predictions(confidence, correctness, target_kind="answer_confidence")
    assert event["brier"] == pytest.approx(np.mean((p_event - outcome) ** 2))
    assert event["brier"] != pytest.approx(np.mean((p_event - correctness) ** 2))
    assert answer["brier"] == pytest.approx(np.mean((confidence - correctness) ** 2))
    assert answer["answer_accuracy"] == 0.5
    assert "answer_accuracy" not in event
    assert "threshold_accuracy" not in answer


def test_label_alignment_prevents_order_dependent_event_scores():
    source = [[0.8, 0.2], [0.3, 0.7]]
    aligned = align_probabilities(source, ["no", "yes"], ["yes", "no"])
    assert np.allclose(aligned, [[0.2, 0.8], [0.7, 0.3]])
    with pytest.raises(ValueError, match="declared label set"):
        align_probabilities(source, ["no", "yes"], ["negative", "positive"])
    with pytest.raises(ValueError, match="unique"):
        align_probabilities(source, ["yes", "yes"], ["yes", "no"])
    with pytest.raises(ValueError, match="sum to one"):
        align_probabilities([[0.8, 0.8]], ["no", "yes"], ["yes", "no"])


def test_complements_are_coherence_diagnostics_not_automatic_binary_exclusions():
    diagnostic = complement_diagnostic([0.2, 0.8, np.nan], [0.8, 0.4, 0.5])
    assert diagnostic["n_pairs"] == 3
    assert diagnostic["n_valid_pairs"] == 2
    assert diagnostic["n_incoherent"] == 1
    assert diagnostic["max_absolute_complement_error"] == pytest.approx(0.2)
    # Independently requested probabilities can still be evaluated separately.
    scores = evaluate_predictions([0.2, 0.8], [0, 1])
    assert scores["n_valid"] == 2
    with pytest.raises(ValueError, match="sum to one"):
        validate_probabilities([0.8, 0.4], normalized=True)
    assert np.allclose(validate_probabilities([0.8, 0.4], normalized=False), [0.8, 0.4])


def test_failure_coverage_is_separate_and_invalid_probabilities_are_not_clipped():
    scores = evaluate_predictions([0.1, np.nan, np.inf, -0.1, 1.1], [0, 1, 1, 0, 1], n_requested=7)
    assert scores["n_records"] == 5
    assert scores["n_requested"] == 7
    assert scores["n_valid"] == 1
    assert scores["n_missing"] == 3
    assert scores["n_invalid"] == 3
    assert scores["coverage"] == 1 / 7
    assert scores["brier"] == pytest.approx(0.01)
    assert scores["signed_error"] == pytest.approx(0.1)
    assert np.isnan(evaluate_predictions([None], [0])["brier"])
    with pytest.raises(ValueError, match="at least"):
        evaluate_predictions([0.1, 0.2], [0, 1], n_requested=1)


@pytest.mark.parametrize("target", [[np.nan], [np.inf], [-1], [2]])
def test_invalid_targets_raise_instead_of_silently_changing_population(target):
    with pytest.raises(ValueError, match="targets must be finite"):
        evaluate_predictions([0.5], target)


def test_observed_targets_must_be_binary_and_kind_cannot_be_implicit_typo():
    with pytest.raises(ValueError, match="binary"):
        evaluate_predictions([0.5], [0.3], target_kind="real_event")
    with pytest.raises(ValueError, match="target_kind"):
        evaluate_predictions([0.5], [0], target_kind="correctnes")
    with pytest.raises(ValueError, match="equal lengths"):
        evaluate_predictions([0.5], [0, 1])


def test_true_log_loss_keeps_impossible_events_infinite_and_deterministic_oracle_zero():
    assert evaluate_predictions([0, 1], [0, 1])["log_loss"] == 0
    assert evaluate_predictions([0, 1], [1, 0])["log_loss"] == np.inf
    assert evaluate_predictions([0, 1], [1, 0])["n_infinite_log_loss"] == 2
    assert evaluate_predictions([0], [0.3], target_kind="known_probability")["log_loss"] == np.inf
    interval = percentile_interval([1, np.inf, np.inf, np.nan])
    assert interval["ci_low"] == 1
    assert interval["ci_high"] == np.inf
    assert interval["n_boot_valid"] == 3


@pytest.mark.parametrize("strategy", ["equal_width", "equal_mass"])
@pytest.mark.parametrize("n_bins", [5, 10, 20])
def test_bins_conserve_records_keep_ties_together_and_include_endpoints(strategy, n_bins):
    p = np.r_[0, np.full(41, 0.5), np.full(9, 0.75), 1]
    bins = reliability_bins(p, p, target_kind="known_probability", strategy=strategy, n_bins=n_bins)
    assert sum(b["n"] for b in bins) == len(p)
    assert sum(b["n"] * abs(b["gap"]) for b in bins if b["n"]) == 0
    # All 41 predictions tied at .5 must enter the same bin.
    assert max(b["n"] for b in bins) >= 41
    assert all(np.isnan(b["rate_ci_low"]) for b in bins)
    assert all(b["ties"] == "identical_predictions_never_split" for b in bins)


def test_constant_equal_mass_prediction_reports_one_occupied_bin():
    bins = reliability_bins([0.5] * 100, [0] * 50 + [1] * 50, strategy="equal_mass", n_bins=20)
    populated = [b for b in bins if b["n"]]
    assert len(populated) == 1
    assert populated[0]["n"] == 100
    assert populated[0]["rate_ci_low"] < 0.5 < populated[0]["rate_ci_high"]
    assert populated[0]["occupied_bins"] == 1
    assert populated[0]["requested_bins"] == 20
    assert populated[0]["rate_interval_method"] == "wilson_iid_rows"


def test_equal_width_decimal_boundaries_retain_historical_floor_bin_rule():
    scores = evaluate_predictions([0.29, 0.3], [0, 1])
    assert scores["ece10"] == pytest.approx(0.495)
    bins = reliability_bins([0.29, 0.3], [0, 1])
    assert bins[2]["n"] == bins[3]["n"] == 1


def test_predeclared_calibration_sensitivity_returns_all_six_settings():
    rows = calibration_sensitivity([0.1, 0.1, 0.9, 0.9], [0, 1, 0, 1])
    assert {(r["strategy"], r["n_bins"]) for r in rows} == {
        (strategy, n) for strategy in ["equal_width", "equal_mass"] for n in [5, 10, 20]
    }
    assert all(r["n"] == 4 for r in rows)


def test_group_bootstrap_preserves_whole_scenarios_and_their_paraphrases():
    groups = ["a", "a", "b", "c", "c", "c"]
    indices = bootstrap_indices(6, np.random.default_rng(3), groups=groups)
    counts = np.bincount(indices, minlength=6)
    assert counts[0] == counts[1]
    assert counts[3] == counts[4] == counts[5]
    assert counts[0] + counts[2] + counts[3] == 3
    with pytest.raises(ValueError, match="either groups or moving blocks"):
        bootstrap_indices(6, np.random.default_rng(1), groups=groups, block_length=2)


def test_moving_block_bootstrap_preserves_local_order():
    indices = bootstrap_indices(12, np.random.default_rng(5), block_length=3)
    assert len(indices) == 12
    for block in indices.reshape(-1, 3):
        assert np.array_equal(np.diff(block), [1, 1])
    assert indices.min() >= 0 and indices.max() < 12


def test_paired_comparison_matches_records_before_scoring_and_resamples_in_pairs():
    a, b, y = [0.1, 0.7, np.nan, 1.1], [0.2, np.nan, 0.4, 0.3], [0, 1, 0, 1]
    result = bootstrap_comparison(a, b, y, n_boot=50)
    assert result["n_matched"] == 1
    assert result["paired_coverage"] == 0.25
    assert result["difference"] == pytest.approx(0.1**2 - 0.2**2)
    assert np.isnan(result["ci_low"])
    same = bootstrap_comparison([0.1, 0.9], [0.1, 0.9], [0, 1], n_boot=50)
    assert same["difference"] == same["ci_low"] == same["ci_high"] == 0


def test_a_single_scenario_never_produces_spurious_precision_from_paraphrase_count():
    result = bootstrap_comparison(
        [0.2] * 100, [0.1] * 100, [0] * 100, groups=["same"] * 100, n_boot=50
    )
    assert result["resampling_units"] == 1
    assert result["n_boot_valid"] == 0
    assert np.isnan(result["ci_low"])
    missing_groups = bootstrap_comparison(
        [0.2, 0.2, np.nan], [0.1, 0.1, 0.2], [0, 1, 1], groups=["a", "a", "b"]
    )
    assert missing_groups["matched_resampling_units"] == 1
    assert np.isnan(missing_groups["ci_low"])


def test_intercept_correction_matches_calibration_rate_without_changing_rank():
    fitted = fit_calibrator([0.2] * 10, [1] * 7 + [0] * 3, method="intercept")
    assert fitted.converged
    assert fitted.slope == 1
    assert fitted.predict([0.2])[0] == pytest.approx(0.7, abs=1e-6)
    assert np.all(np.diff(fitted.predict([0.1, 0.3, 0.7, 0.9])) > 0)
    assert fitted.n_fit == 10


def test_regularization_is_centered_on_identity_and_slope_cannot_reverse_rank():
    # Strong identity regularization preserves raw probabilities, not slope 0.
    fitted = fit_calibrator([0.1, 0.3, 0.7, 0.9], [1, 1, 0, 0], l2=1e8)
    assert fitted.slope == pytest.approx(1, abs=1e-6)
    assert fitted.intercept == pytest.approx(0, abs=1e-6)
    ordinary = fit_calibrator([0.1, 0.3, 0.7, 0.9], [1, 1, 0, 0], l2=1)
    assert ordinary.slope >= 0
    assert np.all(np.diff(ordinary.predict([0.1, 0.3, 0.7, 0.9])) >= 0)
    assert ordinary.slope < fitted.slope


def test_calibration_fit_only_uses_calibration_labels_and_propagates_missing_predictions():
    fitted = fit_calibrator([0.2, 0.4, 0.6, 0.8], [0, 0, 1, 1], method="intercept_slope")
    predictions = fitted.predict([0, 1, np.nan, -0.1, np.inf])
    assert np.isfinite(predictions[:2]).all()
    assert np.isnan(predictions[2:]).all()
    raw = fit_calibrator([0, 1], [0, 1], method="raw")
    assert np.array_equal(raw.predict([0, 1]), [0, 1])
    assert raw.intercept == 0 and raw.slope == 1
    with pytest.raises(ValueError, match="at least one valid"):
        fit_calibrator([np.nan], [1])


def test_refitting_calibration_data_captures_uncertainty_hidden_by_fixed_calibrator():
    p_cal, y_cal = [0.5] * 20, [0] * 10 + [1] * 10
    p_test, y_test = [0.5] * 40, [0] * 20 + [1] * 20
    fixed = bootstrap_calibration_comparison(
        p_cal, y_cal, p_test, y_test, method="intercept", n_boot=100, seed=9
    )
    refit = bootstrap_calibration_comparison(
        p_cal, y_cal, p_test, y_test, method="intercept", n_boot=100, seed=9, refit=True
    )
    assert fixed["uncertainty"] == "fixed_calibrator_test_only"
    assert refit["uncertainty"] == "refit_calibrator_and_test"
    assert fixed["difference"] == refit["difference"] == 0
    assert fixed["ci_low"] == fixed["ci_high"] == 0
    assert refit["ci_high"] - refit["ci_low"] > 0.01
    assert refit["n_boot_valid"] == 100
    assert refit["n_fit_failures"] == 0
    assert refit["original_fit_converged"]
    assert not refit["original_fit_one_class"]


def test_rare_event_resampling_reports_one_class_fits_instead_of_hiding_them():
    result = bootstrap_calibration_comparison(
        [0.2] * 4,
        [0, 0, 0, 1],
        [0.2, 0.8],
        [0, 1],
        refit=True,
        method="intercept",
        n_boot=100,
    )
    assert result["n_one_class_refits"] > 0
    assert result["n_boot_valid"] == 100
    assert result["n_fit_failures"] == 0
    assert not result["original_fit_one_class"]


def test_refit_interval_withheld_when_calibration_has_one_independent_group():
    result = bootstrap_calibration_comparison(
        [0.5, 0.5],
        [0, 1],
        [0.2, 0.8],
        [0, 1],
        calibration_groups=["same", "same"],
        refit=True,
        n_boot=10,
    )
    assert result["calibration_resampling_units"] == 1
    assert result["n_boot_valid"] == 0
    assert np.isnan(result["ci_low"])
