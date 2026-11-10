"""Analyze a complete fresh run and build a summary-first research notebook."""
# ruff: noqa: E501
# Long literals below are report paragraphs, kept as single Markdown paragraphs.

import argparse
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import nbformat
import numpy as np
import pandas as pd
from scipy.special import logit, xlogy
from sklearn.linear_model import LogisticRegression

from jev_research.brier_decomposition import decompose
from jev_research.monte_carlo import evaluate

ROOT = Path(__file__).resolve().parents[1]
SEED = 78
METHODS = [
    "Choice",
    "Noul",
    "Choice corrected",
    "Noul corrected",
    "Logistic regression",
    "CatBoost",
    "Constant",
]


def scores(p, y):
    d = decompose(p, y)
    bins = np.minimum((p * 10).astype(int), 9)
    ece = sum(
        (bins == b).mean() * abs(p[bins == b].mean() - y[bins == b].mean()) for b in np.unique(bins)
    )
    return {
        "brier": float(np.mean((p - y) ** 2)),
        "log_loss": float(np.mean(-xlogy(y, p) - xlogy(1 - y, 1 - p))),
        "ece10": float(ece),
        "normalized_reliability": d["normalized_reliability"],
        "mean_prediction": float(p.mean()),
        "event_rate": float(y.mean()),
        "signed_error": float((p - y).mean()),
        "resolution": d["resolution"],
        "binning_residual": d["binning_residual"],
    }


def table(frame, decimals=4):
    def val(v):
        if isinstance(v, (float, np.floating)):
            return f"{v:.{decimals}f}" if np.isfinite(v) else str(v)
        return str(v)

    columns = list(frame.columns)
    lines = ["| " + " | ".join(columns) + " |", "| " + " | ".join(["---"] * len(columns)) + " |"]
    lines += [
        "| " + " | ".join(val(v) for v in row) + " |"
        for row in frame.itertuples(index=False, name=None)
    ]
    return "\n".join(lines)


def main(run):
    manifest = json.loads((run / "manifest.json").read_text())
    rows = [json.loads(p.read_text()) for p in sorted((run / "responses").glob("*.json"))]
    if len(rows) != manifest["fresh_requests"]:
        raise ValueError("Incomplete run: no complete-run report will be produced.")
    if json.loads((run / "failures.json").read_text()):
        raise ValueError("Unresolved request failures.")
    records = pd.DataFrame(rows)
    records.to_csv(run / "all_predictions.csv", index=False)
    baseline = pd.read_csv(run / "baseline_predictions.csv")
    estimates = []
    calibration = []
    test_frames = []
    for dataset in ["south-german-credit", "bank-marketing", "online-shoppers"]:
        raw = records[records.experiment == dataset]
        joined = baseline[baseline.dataset == dataset].merge(
            raw[["row_id", "choice_p", "noul_p", "complement_p"]],
            on="row_id",
            validate="one_to_one",
        )
        cal = joined[joined.partition == "calibration"]
        test = joined[joined.partition == "test"].copy()
        y = test.y.to_numpy()
        assert len(test) == 200 and len(cal) == 120
        preds = {
            "Choice": test.choice_p.to_numpy(),
            "Noul": test.noul_p.to_numpy(),
            "Logistic regression": test.logistic_regression.to_numpy(),
            "CatBoost": test.catboost.to_numpy(),
            "Constant": test.constant.to_numpy(),
        }
        for method, field in [("Choice", "choice_p"), ("Noul", "noul_p")]:
            fit = LogisticRegression(C=1e6, solver="lbfgs", max_iter=3000, random_state=SEED)
            fit.fit(logit(np.clip(cal[field].to_numpy(), 1e-6, 1 - 1e-6)).reshape(-1, 1), cal.y)
            corrected = fit.predict_proba(
                logit(np.clip(test[field].to_numpy(), 1e-6, 1 - 1e-6)).reshape(-1, 1)
            )[:, 1]
            preds[method + " corrected"] = corrected
            calibration.append(
                {
                    "dataset": dataset,
                    "interface": method,
                    "intercept": float(fit.intercept_[0]),
                    "slope": float(fit.coef_[0, 0]),
                    "clip_epsilon": 1e-6,
                    "C": 1e6,
                    "calibration_records": len(cal),
                }
            )
        rng = np.random.default_rng(SEED)
        draw = rng.integers(0, len(y), size=(1000, len(y)))
        for method in METHODS:
            p = preds[method]
            s = scores(p, y)
            loss = (p - y) ** 2
            lo, hi = np.quantile(loss[draw].mean(axis=1), [0.025, 0.975])
            s.update(
                {
                    "dataset": dataset,
                    "method": method,
                    "n_test": len(test),
                    "brier_p025": lo,
                    "brier_p975": hi,
                }
            )
            if method.endswith(" corrected"):
                raw_p = preds[method.replace(" corrected", "")]
                delta = (p - y) ** 2 - (raw_p - y) ** 2
                dlo, dhi = np.quantile(delta[draw].mean(axis=1), [0.025, 0.975])
                s.update(
                    {
                        "paired_brier_change": delta.mean(),
                        "paired_change_p025": dlo,
                        "paired_change_p975": dhi,
                    }
                )
            estimates.append(s)
            test[method] = p
        test_frames.append(test)
        test.to_csv(run / f"{dataset}-test-predictions.csv", index=False)
        # Individual reliability plot belongs in the appendix.
        fig, ax = plt.subplots(figsize=(7, 5))
        for method in ["Choice", "Noul", "Choice corrected", "Noul corrected", "CatBoost"]:
            p = preds[method]
            bid = np.minimum((p * 10).astype(int), 9)
            bs = np.unique(bid)
            ax.plot(
                [p[bid == b].mean() for b in bs],
                [y[bid == b].mean() for b in bs],
                marker="o",
                label=method,
            )
        ax.plot([0, 1], [0, 1], "k--", lw=1)
        ax.set(
            xlabel="Mean predicted probability",
            ylabel="Observed event rate",
            xlim=(0, 1),
            ylim=(0, 1),
            title=dataset,
        )
        ax.legend(fontsize=8)
        fig.tight_layout()
        fig.savefig(run / f"{dataset}-reliability.png", dpi=160)
        plt.close(fig)
    metrics = pd.DataFrame(estimates)
    metrics.to_csv(run / "uci_metrics.csv", index=False)
    pd.DataFrame(calibration).to_csv(run / "calibration_fits.csv", index=False)
    # Fresh synthetic evaluations, with dice joint counts preserved.
    synth = records[records.experiment == "synthetic"].to_dict("records")
    detail, synth_summary, reliability = evaluate(synth, seed=SEED)
    detail.to_csv(run / "synthetic_scenario_metrics.csv", index=False)
    reliability.to_csv(run / "synthetic_reliability.csv", index=False)
    synth_summary.to_csv(run / "synthetic_summary.csv", index=False)
    dice = records[records.experiment == "two-dice"].copy()
    q = np.array([1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1]) / 36
    rates = np.random.default_rng(SEED).multinomial(2000, q, size=500) / 2000
    ds = []
    for track in ["explicit", "parameters"]:
        panel = dice[dice.track == track].sort_values("sum")
        for method in ["choice", "noul"]:
            p = panel[method + "_p"].to_numpy()
            mc = (rates * (1 - p) ** 2 + (1 - rates) * p**2).mean(axis=1)
            ds.append(
                {
                    "track": track,
                    "primitive": method,
                    "probability_mae": abs(p - q).mean(),
                    "expected_brier": np.mean(q * (1 - q) + (p - q) ** 2),
                    "oracle_brier": np.mean(q * (1 - q)),
                    "score_sum": p.sum(),
                    "mc_brier_mean": mc.mean(),
                    "mc_p025": np.quantile(mc, 0.025),
                    "mc_p975": np.quantile(mc, 0.975),
                }
            )
    dice_summary = pd.DataFrame(ds)
    dice_summary.to_csv(run / "dice_summary.csv", index=False)
    synthetic_table = pd.concat(
        [
            synth_summary.assign(experiment="Original synthetic grid"),
            dice_summary.assign(experiment="Two dice"),
        ],
        ignore_index=True,
    )
    # Main figure: same metric as source, paired with proper score.
    fig, axes = plt.subplots(2, 1, figsize=(12, 9))
    datasets = metrics.dataset.unique()
    x = np.arange(len(datasets))
    width = 0.11
    colors = ["#0072B2", "#D55E00", "#56B4E9", "#E69F00", "#CC79A7", "#009E73", "#999999"]
    for j, method in enumerate(METHODS):
        sub = metrics[metrics.method == method].set_index("dataset").loc[datasets]
        for ax, key in zip(axes, ["normalized_reliability", "brier"], strict=True):
            ax.bar(
                x + (j - 3) * width,
                sub[key],
                width,
                label=method,
                color=colors[j],
                hatch="//" if "corrected" in method else None,
            )
    axes[0].set_ylabel("Calibration penalty / baseline uncertainty")
    axes[1].set_ylabel("Brier score (lower is better)")
    for ax in axes:
        ax.set_xticks(x, labels=["South German Credit", "Bank Marketing", "Online Shoppers"])
        ax.spines[["top", "right"]].set_visible(False)
    axes[0].legend(ncol=3, fontsize=9)
    fig.tight_layout()
    fig.savefig(run / "main_comparison.png", dpi=180)
    fig.savefig(run / "main_comparison.pdf")
    plt.close(fig)
    overview = (
        metrics.pivot(index="dataset", columns="method", values="brier")
        .reindex(columns=METHODS)
        .reset_index()
    )
    calibration_table = (
        metrics.pivot(index="dataset", columns="method", values="normalized_reliability")
        .reindex(columns=METHODS)
        .reset_index()
    )
    winners = metrics.loc[metrics.groupby("dataset").brier.idxmin()]
    findings = []
    for r in winners.itertuples():
        findings.append(
            f"**{r.dataset}: {r.method} had the lowest observed Brier score ({r.brier:.4f}).** This is a pilot ranking on {r.n_test} test records."
        )
    correction = metrics[metrics.method.str.endswith(" corrected")]
    better = int((correction.paired_brier_change < 0).sum())
    findings.append(
        f"**Recalibration reduced Brier loss in {better} of six interface–dataset comparisons.** Each correction used 120 separate labels; paired uncertainty intervals appear in the appendix."
    )
    raw = metrics[metrics.method.isin(["Choice", "Noul"])]
    wins = sum(
        r.brier
        < float(
            metrics[(metrics.dataset == r.dataset) & (metrics.method == "Constant")].brier.iloc[0]
        )
        for r in raw.itertuples()
    )
    findings.append(
        f"**Raw Jev beat the training-prevalence baseline in {wins} of six comparisons.** Calibration and forecast usefulness are therefore reported separately."
    )
    bank_split = json.loads((run / "bank-marketing-split.json").read_text())
    bank_raw = metrics[(metrics.dataset == "bank-marketing") & (metrics.method == "Noul")].iloc[0]
    bank_fixed = metrics[
        (metrics.dataset == "bank-marketing") & (metrics.method == "Noul corrected")
    ].iloc[0]
    findings.append(
        f"**The bank test measures a substantial change in event frequency.** Subscription rates were {bank_split['training_positive_rate']:.1%} in training, {bank_split['calibration_positive_rate']:.1%} in calibration, and {bank_split['test_positive_rate']:.1%} in the test sample. Noul's Brier loss changed from {bank_raw.brier:.4f} to {bank_fixed.brier:.4f} after correction. A correction fitted on earlier records did not transfer to this later sample."
    )
    findings.append(
        "**Noul retained lower synthetic probability error in both question formats.** Synthetic success did not establish uniformly better real-data forecasts."
    )
    intro = (
        """# Fresh evaluation of Jev: synthetic probabilities and three UCI datasets

## Main findings

"""
        + "\n\n".join(findings)
        + """

## Summary tables

**Brier score:** mean squared probability error against the observed binary outcome; lower is better. Corrected methods fit an intercept and slope to Jev scores using 120 separate calibration records. Logistic regression and CatBoost are supervised baselines trained on the training partition. The constant baseline predicts the training event rate.

"""
        + table(overview)
        + """

**Normalized calibration penalty:** squared gaps between forecast-bin means and event frequencies, divided by the test event rate times its complement. This matches the measure displayed in the reference tweet, with our declared ten-bin implementation. Lower is better, but a constant uninformative forecast can score well. Raw Brier score remains the primary comparison.

"""
        + table(calibration_table)
        + """

**Synthetic summary:** true event probabilities are known here, so these are exact expected losses rather than scores estimated from real-data labels. These rows are not pooled with UCI results. `explicit` supplies the probability; `parameters` supplies only the distribution description. `primitive` identifies the Choice or Noul interface; `track` identifies that question format. Probability MAE is the mean absolute gap from the true probability.

"""
        + table(
            synthetic_table[
                [
                    "experiment",
                    "track",
                    "primitive",
                    "probability_mae",
                    "expected_brier",
                    "mc_brier_mean",
                ]
            ]
        )
        + """

## Experimental design

We evaluated 1,045 inputs: 15 coin-toss cases, 22 two-dice cases, 48 distribution-threshold cases, and 320 records per UCI dataset. Model: Jev 1.13.0. Seed: 78. Each request contained Choice, Noul, and the opposite-event Noul question. No few-shot examples were supplied.

For UCI data, predictors were decoded before prompt serialization. Targets and row identifiers were excluded from model inputs. Repeated feature rows were reduced to their first occurrence; all rows in conflicting-label groups were removed. This changes the evaluation population and is documented below. Bank duration and shopper PageValues were excluded. Bank records used chronological 60/20/20 blocks; the other datasets used stratified 60/20/20 partitions. We selected 120 calibration and 200 test records without further class balancing. The corrected credit data retain the source's oversampled adverse-outcome prevalence.

Baselines use the same features and test records. Logistic regression uses standardized numeric features, one-hot categorical features, C=1, and at most 3,000 iterations. CatBoost uses 300 trees, depth 6, learning rate 0.05, and CPU execution. No hyperparameters were selected from test outcomes. Corrections fit logistic regression to clipped Jev logits (epsilon=1e-6, C=1e6), separately by dataset and interface. Clipping is confined to correction inputs; raw log loss retains infinite values.

Synthetic evaluation uses 500 sets of 2,000 outcomes. Dice sums share a multinomial count vector within each set. UCI metrics use actual labels, not generated labels. Brier intervals and paired correction-change intervals use 1,000 paired bootstrap resamples of the 200 test records. They are conditional on this split and fitted models; record independence is assumed. Bank temporal dependence and unavailable customer IDs limit interval interpretation.

## Interpretation and limits

This is a three-dataset pilot, not a replication of the tweet's eight-dataset study or pooled test folds. Each test has 200 records. Different supervision budgets, public-data contamination, feature serialization, historical sampling, and distribution shift limit broad model rankings. Corrections and baseline models were not retrained across bootstrap resamples. Binned reliability is sensitive to binning and differs from raw Brier loss; the appendix reports the grouping residual. No general calibration guarantee follows from these results. Bank duplicate/conflict removal was applied after excluding duration, removing 2,258 rows; different full records can become identical under this reduced feature set. Results therefore apply to this filtered sample, and a duplicate-preserving grouped-split sensitivity study remains needed.

## Appendix: individual experiments

ECE10 means Expected Calibration Error using ten probability groups: the weighted mean absolute gap between group forecasts and event rates. Log loss penalizes false certainty; infinite values are retained. Brier p025/p975 columns give the central 95% bootstrap interval. Paired Brier change is corrected minus raw loss; negative means improvement. Oracle Brier is the synthetic loss obtained from the true probabilities.
"""
    )
    md = intro
    for dataset in datasets:
        split = json.loads((run / f"{dataset}-split.json").read_text())
        md += f"\n### {dataset}\n\nTraining records: {len(split['train_ids'])}; calibration: 120; test: 200. Removed duplicate/conflicting rows: {split['removed_duplicate_or_conflicting_rows']}. Training event rate: {split['training_positive_rate']:.3f}; test event rate: {split['test_positive_rate']:.3f}.\n\n"
        md += (
            table(
                metrics[metrics.dataset == dataset][
                    [
                        "method",
                        "brier",
                        "brier_p025",
                        "brier_p975",
                        "ece10",
                        "log_loss",
                        "mean_prediction",
                        "event_rate",
                    ]
                ]
            )
            + "\n\n"
        )
        md += (
            table(
                correction[correction.dataset == dataset][
                    ["method", "paired_brier_change", "paired_change_p025", "paired_change_p975"]
                ]
            )
            + "\n\n"
        )
    family = (
        detail[detail.family != "bernoulli"]
        .groupby(["family", "track", "primitive"], as_index=False)[
            ["absolute_probability_error", "expected_brier", "oracle_expected_brier"]
        ]
        .mean()
    )
    md += (
        "\n### Original synthetic families\n\n"
        + table(family)
        + "\n\n### Two dice\n\n"
        + table(dice_summary)
        + "\n"
    )
    md += """\n### Artifacts and provenance

`requests.json` stores complete input bodies and local label/split metadata; only its `payload` object was sent. `responses/` stores selected probability fields, not full raw API responses. `all_predictions.csv`, `baseline_predictions.csv`, `uci_metrics.csv`, `calibration_fits.csv`, and per-dataset split manifests retain the evidence. Seeds, dataset hashes, request hashes, and baseline settings are recorded. Source datasets and the chart inspiration are attributed in the project reference index.
"""
    return write_report_notebook(md, run)


def write_report_notebook(md, run):
    """Return formatted report cells without replacing the executable notebook."""
    import re

    parts = re.split(r"(?m)^## ", md)
    sections = {part.split("\n", 1)[0]: part.split("\n", 1)[1].strip() for part in parts[1:]}
    n = nbformat.v4.new_notebook(
        metadata={
            "kernelspec": {
                "name": "jev-research",
                "display_name": "Jev (.venv)",
                "language": "python",
            }
        }
    )
    n.cells = [
        nbformat.v4.new_markdown_cell(
            "# Experiment: probability calibration of off-the-shelf Jev\n\n"
            "## 1. Objective and protocol\n\n"
            "We evaluated raw and recalibrated Jev probabilities on synthetic scenarios "
            "and three UCI datasets. Summary comparisons appear in the main report; "
            "individual experiment results appear in the appendix."
        ),
        nbformat.v4.new_markdown_cell(
            "## 2. Experimental design\n\n" + sections["Experimental design"]
        ),
        nbformat.v4.new_markdown_cell(
            "## 3. Results\n\n### 3.1 Key findings\n\n" + sections["Main findings"]
        ),
        nbformat.v4.new_markdown_cell(
            "### 3.2 Summary comparisons\n\n" + sections["Summary tables"]
        ),
        nbformat.v4.new_code_cell(
            "from pathlib import Path\nfrom IPython.display import Image, display\n"
            "ROOT = next(p for p in [Path.cwd(), *Path.cwd().parents] if (p / 'scripts/uv.sh').exists())\n"
            f"RUN = ROOT / {str(run.relative_to(ROOT))!r}\n"
            "display(Image(filename=str(RUN / 'main_comparison.png')))"
        ),
        nbformat.v4.new_markdown_cell(
            "**Figure 1. Forecast error and calibration across all experiments.** Blue dots show Choice; orange dots show Noul. Columns report Brier loss, Expected Calibration Error (ECE) in percentage points, and the weighted squared calibration gap divided by the reference rate times its complement. Both calibration measures use ten equal-width probability bins. Generated cases use known probabilities; UCI cases use observed test outcomes. Lower values mean less error. Compare interfaces within each row: event rates and task difficulty differ across rows. Low calibration error alone does not establish predictive value."
        ),
        nbformat.v4.new_markdown_cell(
            "## 4. Discussion and limitations\n\n" + sections["Interpretation and limits"]
        ),
    ]
    appendix = re.split(r"(?m)^### ", sections["Appendix: individual experiments"])
    n.cells.append(
        nbformat.v4.new_markdown_cell("## Appendix: individual experiments\n\n" + appendix[0])
    )
    datasets = ["south-german-credit", "bank-marketing", "online-shoppers"]
    for part in appendix[1:]:
        n.cells.append(nbformat.v4.new_markdown_cell("### " + part.strip()))
        name = part.split("\n", 1)[0]
        if name in datasets:
            n.cells.extend(
                [
                    nbformat.v4.new_code_cell(
                        f"display(Image(filename=str(RUN / '{name}-reliability.png')))"
                    ),
                    nbformat.v4.new_markdown_cell(
                        "**Reliability diagram.** Forecast-bin means versus observed event "
                        "frequencies. The diagonal indicates agreement; sparse bins can fluctuate."
                    ),
                ]
            )
    from jev_research.report_content import extend_report

    extend_report(n, run)
    nbformat.validate(n)
    return n


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--run-dir", required=True)
    main((ROOT / p.parse_args().run_dir).resolve())
