"""One comparison protocol across all eight experiment conditions."""
# ruff: noqa: E501

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from jev_research.brier_decomposition import decompose

CONDITIONS = [
    "Coin toss · probability supplied",
    "Threshold events · probability supplied",
    "Threshold events · distribution described",
    "Two dice · probability supplied",
    "Two dice · dice description",
    "South German Credit",
    "Bank Marketing",
    "Online Shoppers",
]

COLORS = {"Choice": "#0072B2", "Noul": "#D55E00"}


def compare_experiments(records, test_frames):
    """Compute the same metrics and bins using q for known events or y for observations."""
    panels = []
    for label, family, track in [
        (CONDITIONS[0], "bernoulli", "explicit"),
        (CONDITIONS[1], "other", "explicit"),
        (CONDITIONS[2], "other", "parameters"),
        (CONDITIONS[3], "two_dice", "explicit"),
        (CONDITIONS[4], "two_dice", "parameters"),
    ]:
        mask = (
            records.family.eq(family)
            if family != "other"
            else records.experiment.eq("synthetic") & records.family.ne("bernoulli")
        )
        frame = records[mask & records.track.eq(track)]
        panels.append(
            (
                label,
                "Known probability",
                frame.q.to_numpy(),
                {"Choice": frame.choice_p.to_numpy(), "Noul": frame.noul_p.to_numpy()},
            )
        )
    for label, slug in zip(
        CONDITIONS[5:], ["south-german-credit", "bank-marketing", "online-shoppers"], strict=True
    ):
        frame = next(t for t in test_frames if t.dataset.iloc[0] == slug)
        panels.append(
            (
                label,
                "Observed outcome",
                frame.y.to_numpy(),
                {
                    method: frame[method].to_numpy()
                    for method in [
                        "Choice",
                        "Noul",
                        "Choice corrected",
                        "Noul corrected",
                        "Logistic regression",
                        "CatBoost",
                        "Constant",
                    ]
                },
            )
        )
    summary, curves = [], []
    for label, reference, target, forecasts in panels:
        for method, prediction in forecasts.items():
            assert len(target) == len(prediction) and len(target) > 0
            bins = np.minimum((prediction * 10).astype(int), 9)
            ece = 0.0
            for b in np.unique(bins):
                keep = bins == b
                forecast, rate = prediction[keep].mean(), target[keep].mean()
                ece += keep.mean() * abs(forecast - rate)
                curves.append(
                    {
                        "condition": label,
                        "reference": reference,
                        "method": method,
                        "bin": int(b),
                        "n": int(keep.sum()),
                        "forecast": forecast,
                        "target": rate,
                    }
                )
            components = decompose(prediction, target)
            summary.append(
                {
                    "condition": label,
                    "reference": reference,
                    "method": method,
                    "n": len(target),
                    "brier": np.mean(target * (1 - target) + (prediction - target) ** 2),
                    "ece10": ece,
                    "normalized_reliability": components["normalized_reliability"],
                    "mean_forecast": prediction.mean(),
                    "reference_rate": target.mean(),
                }
            )
    return pd.DataFrame(summary), pd.DataFrame(curves)


def comparison_table(summary):
    rows = []
    for condition in CONDITIONS:
        group = summary[summary.condition.eq(condition)].set_index("method")
        rows.append(
            {
                "Experiment / input": condition,
                "Cases": int(group.loc["Choice", "n"]),
                "Reference": group.loc["Choice", "reference"],
                "Choice Brier": group.loc["Choice", "brier"],
                "Noul Brier": group.loc["Noul", "brier"],
                "Choice ECE (pp)": 100 * group.loc["Choice", "ece10"],
                "Noul ECE (pp)": 100 * group.loc["Noul", "ece10"],
            }
        )
    return pd.DataFrame(rows)


def comparison_figure(summary, run):
    fig, axes = plt.subplots(1, 3, figsize=(14, 7.5), sharey=True)
    y = np.arange(len(CONDITIONS))
    for method, offset in [("Choice", -0.12), ("Noul", 0.12)]:
        group = summary[summary.method.eq(method)].set_index("condition").loc[CONDITIONS]
        for ax, metric, scale, label in zip(
            axes,
            ["brier", "ece10", "normalized_reliability"],
            [1, 100, 1],
            [
                "Brier score",
                "Calibration gap: ECE (percentage points)",
                "Normalized calibration penalty",
            ],
            strict=True,
        ):
            ax.scatter(scale * group[metric], y + offset, color=COLORS[method], label=method, s=45)
            ax.set(xlabel=label, xlim=(0, None))
            ax.grid(axis="x", alpha=0.2)
            ax.spines[["top", "right"]].set_visible(False)
    axes[0].set_yticks(y, CONDITIONS)
    axes[0].invert_yaxis()
    handles, labels = axes[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="upper center", ncol=2, bbox_to_anchor=(0.65, 0.95))
    fig.suptitle("All experiments · raw Jev scores · lower is better", fontsize=14)
    fig.tight_layout(rect=(0, 0, 1, 0.90))
    fig.savefig(run / "main_comparison.png", dpi=160)
    fig.savefig(run / "main_comparison.pdf")
    plt.close(fig)


def calibration_figure(curves, run):
    fig, axes = plt.subplots(4, 2, figsize=(11, 17), sharex=True, sharey=True)
    for ax, condition in zip(axes.flat, CONDITIONS, strict=True):
        frame = curves[curves.condition.eq(condition)]
        for method in ["Choice", "Noul", "Choice corrected", "Noul corrected"]:
            group = frame[frame.method.eq(method)].sort_values("forecast")
            if group.empty:
                continue
            base = method.split(" corrected")[0]
            ax.plot(
                group.forecast,
                group.target,
                "--" if "corrected" in method else "-",
                color=COLORS[base],
                label=method,
            )
            ax.scatter(
                group.forecast,
                group.target,
                s=12 + group.n / group.n.sum() * 100,
                color=COLORS[base],
                alpha=0.75,
            )
        ax.plot([0, 1], [0, 1], "k:", label="Perfect agreement")
        reference = frame.reference.iloc[0]
        ax.set(
            title=condition + "\n" + reference,
            xlim=(0, 1),
            ylim=(0, 1),
            xlabel="Mean predicted probability",
            ylabel="Mean reference probability / outcome",
        )
        ax.grid(alpha=0.15)
        ax.tick_params(labelbottom=True, labelleft=True)
    handles, labels = axes.flat[-1].get_legend_handles_labels()
    fig.legend(handles, labels, loc="upper center", ncol=3, bbox_to_anchor=(0.5, 1.0))
    fig.tight_layout(rect=(0, 0, 1, 0.965))
    fig.savefig(run / "calibration_overview.png", dpi=160)
    fig.savefig(run / "calibration_overview.pdf")
    plt.close(fig)


def study_text(summary, records, metrics):
    raw = summary[summary.method.isin(["Choice", "Noul"])]
    paired = raw.pivot(index="condition", columns="method", values=["brier", "ece10"])
    brier_wins = int((paired.brier.Noul < paired.brier.Choice).sum())
    ece_wins = int((paired.ece10.Noul < paired.ece10.Choice).sum())
    real = raw[raw.reference.eq("Observed outcome")]
    fair = records[records.family.eq("bernoulli") & np.isclose(records.q, 0.5)].iloc[0]
    coin = raw[raw.condition.eq(CONDITIONS[0])].set_index("method")
    dice = raw[raw.condition.eq(CONDITIONS[4])].set_index("method")
    bank = metrics[
        (metrics.dataset == "bank-marketing") & metrics.method.isin(["Noul", "Noul corrected"])
    ].set_index("method")
    improved = int(
        (metrics.loc[metrics.method.str.endswith(" corrected"), "paired_brier_change"] < 0).sum()
    )
    abstract = (
        "## Abstract\n\nWe evaluated Jev 1.13.0 on a binary-probability experiment (coins and thresholds from eight distribution families), two-dice sums, and three UCI datasets: "
        "85 known-probability cases and 600 held-out records, with 120 separate calibration records per UCI dataset. "
        "One protocol compares Brier loss and calibration across eight task–input conditions; synthetic loss is exact in expectation and real-data loss uses observed outcomes. "
        f"Noul had lower Brier loss in {brier_wins} of eight conditions and numerically lower Expected Calibration Error (ECE; the average gap between grouped predictions and reference rates) in {ece_wins} of eight. "
        f"For a fair coin, Choice predicted {fair.choice_p:.0%} heads and Noul {fair.noul_p:.0%}. "
        f"Raw real-data ECE ranged from {100 * real.ece10.min():.1f} to {100 * real.ece10.max():.1f} percentage points. "
        f"Recalibration reduced the Brier point estimate in {improved} of six real-data comparisons but worsened Bank Marketing Noul from {bank.loc['Noul', 'brier']:.4f} to {bank.loc['Noul corrected', 'brier']:.4f}. "
        "**Jev was not consistently well calibrated: stronger synthetic probability recovery did not establish reliable probabilities on real data.**"
    )
    findings = (
        "## 3. Results\n\n### 3.1 Key findings\n\n"
        f"**Noul had lower Brier loss in {brier_wins}/8 conditions and numerically lower calibration error in {ece_wins}/8.** The credit ECE difference was only 0.01 percentage point; these are descriptive comparisons, not significance claims. Both comparisons use the same eight rows in the summary table and figures; differences in event rates prevent a pooled ranking.\n\n"
        f"**Coins and dice expose probability errors directly.** Coin Brier loss was {coin.loc['Choice', 'brier']:.4f} for Choice and {coin.loc['Noul', 'brier']:.4f} for Noul. "
        f"With only a dice description, it was {dice.loc['Choice', 'brier']:.4f} and {dice.loc['Noul', 'brier']:.4f}, respectively. Supplying the exact dice probabilities reduced both losses. On the other distributions, exact probabilities helped Noul but increased Choice loss: supplied probabilities do not ensure faithful scores.\n\n"
        f"**Real-data calibration remained uneven.** Raw ECE ranged from {100 * real.ece10.min():.1f} to {100 * real.ece10.max():.1f} percentage points. "
        f"Correction reduced the Brier point estimate in {improved}/6 comparisons but worsened Bank Marketing Noul. The paired interval for Bank Choice included no change. Detailed baseline and correction comparisons appear with each experiment in the appendix."
    )
    discussion = (
        "## 4. Discussion and limitations\n\n"
        "**Jev is not consistently well calibrated across this study.** The coin and threshold variants share a known binary event probability and the same scoring rule, so they form one experiment with three prompt conditions. The same progression appears in the table and both figures: Noul better recovers stated and derived probabilities, but real-data performance depends on the task. "
        "Knowing the input probability makes the synthetic cases tests of probability recovery. The UCI cases test inference from features when the true per-record probability is unknown. Together they probe different failure modes of the same claimed output: a usable event probability.\n\n"
        "Brier loss measures overall forecast error; the reliability curves and ECE isolate grouped probability agreement. Good calibration can coexist with little predictive value. On Online Shoppers, corrected forecasts approach the constant baseline; on Bank Marketing, Noul correction worsened on a test sample with a higher event rate. "
        "Calibration should therefore be validated on the intended population and any correction tested on separate, representative records.\n\n"
        "These are fixed synthetic grids and three 200-record test samples, not a general guarantee or a ranking across tasks. Ten-bin estimates are sensitive to sparse groups. Bootstrap intervals condition on the split and fitted models; they do not account for retraining, prompt variation, or unknown repeated customers. Bank time dependence, historical sampling, and public-data contamination limit generalization. "
        "Removing duration created repeated or conflicting Bank feature records; filtering removed 2,258 rows and changed the evaluation population. A duplicate-preserving grouped-split sensitivity check remains needed."
    )
    return abstract, findings, discussion
