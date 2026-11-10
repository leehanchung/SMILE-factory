import numpy as np
import pandas as pd
import pytest

from jev_research.unified_report import CONDITIONS, compare_experiments, comparison_table


def fixture_inputs():
    rows = []
    for family, experiment, tracks in [
        ("bernoulli", "synthetic", ["explicit"]),
        ("two_dice", "two-dice", ["explicit", "parameters"]),
        ("normal", "synthetic", ["explicit", "parameters"]),
    ]:
        for track in tracks:
            for q in [0.1, 0.5, 0.9]:
                rows.append(
                    dict(
                        family=family,
                        experiment=experiment,
                        track=track,
                        q=q,
                        choice_p=0.5,
                        noul_p=q,
                    )
                )
    frames = []
    for dataset in ["south-german-credit", "bank-marketing", "online-shoppers"]:
        frame = pd.DataFrame(
            {"dataset": dataset, "y": [0, 0, 1], "Choice": [0.1, 0.8, 0.6], "Noul": [0.2, 0.3, 0.7]}
        )
        for method in [
            "Choice corrected",
            "Noul corrected",
            "Logistic regression",
            "CatBoost",
            "Constant",
        ]:
            frame[method] = 1 / 3
        frames.append(frame)
    return pd.DataFrame(rows), frames


def test_all_conditions_share_metrics_but_keep_reference_semantics():
    records, tests = fixture_inputs()
    summary, curves = compare_experiments(records, tests)
    table = comparison_table(summary)
    assert table["Experiment / input"].tolist() == CONDITIONS
    assert len(summary) == 5 * 2 + 3 * 7
    known = summary[summary.reference == "Known probability"]
    oracle = known[known.method == "Noul"]
    assert np.allclose(oracle.ece10, 0)
    assert np.allclose(oracle.normalized_reliability, 0)
    # Exact probability forecasts still incur irreducible outcome loss.
    assert np.allclose(oracle.brier, np.mean(np.array([0.1, 0.5, 0.9]) * np.array([0.9, 0.5, 0.1])))
    row = summary[(summary.condition == "South German Credit") & (summary.method == "Choice")].iloc[
        0
    ]
    assert row.brier == pytest.approx(np.mean((tests[0].Choice - tests[0].y) ** 2))
    for (condition, method), group in curves.groupby(["condition", "method"]):
        measured = summary[(summary.condition == condition) & (summary.method == method)].iloc[0]
        assert group.n.sum() == measured.n
        assert np.average(abs(group.forecast - group.target), weights=group.n) == pytest.approx(
            measured.ece10
        )
    assert not known.method.str.contains("corrected").any()
