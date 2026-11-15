"""Self-contained experiment descriptions and synthetic evidence for report 04."""
# ruff: noqa: E501
# Markdown paragraphs and tables intentionally retain their source lines.

import json

import matplotlib.pyplot as plt
import nbformat
import numpy as np
import pandas as pd


def _table(frame):
    def cell(value):
        return f"{value:.5f}" if isinstance(value, (float, np.floating)) else str(value)

    return "\n".join(
        [
            "| " + " | ".join(frame.columns) + " |",
            "| " + " | ".join(["---"] * len(frame.columns)) + " |",
            *[
                "| " + " | ".join(cell(v) for v in row) + " |"
                for row in frame.itertuples(index=False, name=None)
            ],
        ]
    )


def extend_report(notebook, run):
    """Add measured evidence from this run, never values copied from earlier reports."""
    frame = pd.read_csv(run / "all_predictions.csv")
    coin = frame[frame.family == "bernoulli"].sort_values("q").copy()
    dice = frame[frame.family == "two_dice"].sort_values(["track", "sum"]).copy()
    other = frame[(frame.experiment == "synthetic") & (frame.family != "bernoulli")].copy()
    assert len(coin) == 15 and len(dice) == 22 and len(other) == 48
    design = """### Tasks and observed outcomes

**Choice** returns probabilities for two mutually exclusive answers. **Noul** returns a probability-like score for one statement. We ask both about the same event and also ask Noul about its opposite. All scores are evaluated as event probabilities.

| Experiment | Input | Target event | Requests |
|---|---|---|---:|
| Binary probability tests | 15 stated coin probabilities + 48 threshold questions from eight distributions | Heads, or a draw at/below a threshold | 63 |
| Two dice | Two independent fair six-sided dice, with or without the exact sum probability | The next roll has a specified sum from 2 to 12 | 22 |
| South German Credit | 20 decoded credit-record features | Contract not complied with (`kredit=0`) | 320 |
| Bank Marketing | 19 features; completed-call duration excluded | Deposit subscription (`y=yes`) | 320 |
| Online Shoppers | 16 features; transaction-related PageValues excluded | Session ends in purchase (`Revenue=True`) | 320 |

**Binary probability tests combine 15 coin-toss cases and 48 distribution-threshold cases.** Both produce an event indicator: 1 if the event happens, otherwise 0. If its chance is `q`, this is a Bernoulli trial—the same outcome model as a coin with heads probability `q`. For example, a uniform draw from 0 to 1 being at most 0.1 has the same binary outcome distribution as a coin with a 10% heads probability. The Monte Carlo simulation therefore uses the same binary sampling and Brier formula for both.

We retain three conditions within this experiment: coins with stated probabilities, thresholds with stated probabilities, and thresholds with only the distribution described. The last condition also tests whether Jev can derive the event probability. A pooled result would mix that task with probability copying and give 48 threshold cases more weight than 15 coin cases. Different event probabilities also change unavoidable Brier loss, so subgroup comparisons retain that context. Pooling calibration bins can cancel opposite errors. The summary keeps these conditions adjacent and separate. Dice remain a separate experiment because the 11 sums share each simulated roll and must jointly account for all outcomes.

Each request contains three questions, giving **1,045 requests and 3,135 question scores**. For each real dataset, 120 records fit probability corrections and a separate 200 evaluate them. Synthetic probabilities are known exactly; real-data probabilities are unknown, so actual binary labels supply the evaluation outcomes.

**Question format** identifies what Jev is told: `explicit` supplies the exact event probability; `parameters` supplies the generating process only. The stored column `track` uses these labels. Coins use only the explicit format. Dice use both formats for each of 11 sums. The other distributions use both formats for each of 24 threshold events.

| Data field | Meaning |
|---|---|
| `q` | Known probability of the synthetic event; not available for real records |
| `choice_p` | Choice probability assigned to the event |
| `noul_p` | Noul score assigned to that same event |
| `complement_p` | Separate Noul score for the opposite event; not computed as `1 − noul_p` |
| `y` | Observed real-data outcome: 1 when the target event occurred, otherwise 0 |

**Brier score** is the mean squared gap between a probability and its binary outcome. For a known event probability `q` and forecast `p`, expected Brier loss is `q(1−q) + (p−q)²`. The **oracle** predicts `q` and incurs only the first term: unavoidable randomness. Probability MAE is mean absolute error, `mean(|p−q|)`. ECE10 is Expected Calibration Error: the weighted mean absolute gap between forecast and event-rate averages in ten probability groups. Lower values are better for these errors. The normalized calibration penalty uses squared group gaps divided by the overall event rate times its complement; it is not ECE.

"""
    notebook.cells[1].source = notebook.cells[1].source.replace(
        "## 2. Experimental design\n\n", "## 2. Experimental design\n\n" + design
    )
    records = []
    for label, sub in [("Coin toss", coin), ("Two dice", dice), ("Other distributions", other)]:
        for question_format, group in sub.groupby("track", sort=False):
            q = group.q.to_numpy()
            for name, field in [("Choice", "choice_p"), ("Noul", "noul_p")]:
                p = group[field].to_numpy()
                records.append(
                    {
                        "Experiment": label,
                        "Question format": question_format,
                        "Interface": name,
                        "Cases": len(group),
                        "Probability MAE": abs(p - q).mean(),
                        "Expected Brier": np.mean(q * (1 - q) + (p - q) ** 2),
                        "Oracle Brier": np.mean(q * (1 - q)),
                    }
                )
    summary = pd.DataFrame(records)
    summary.to_csv(run / "synthetic_task_summary.csv", index=False)
    from jev_research.unified_report import (
        calibration_figure,
        compare_experiments,
        comparison_figure,
        comparison_table,
        study_text,
    )

    metrics = pd.read_csv(run / "uci_metrics.csv")
    tests = [
        pd.read_csv(run / f"{slug}-test-predictions.csv")
        for slug in ["south-german-credit", "bank-marketing", "online-shoppers"]
    ]
    combined, curves = compare_experiments(frame, tests)
    combined.to_csv(run / "unified_metrics.csv", index=False)
    curves.to_csv(run / "unified_calibration_bins.csv", index=False)
    comparison_figure(combined, run)
    calibration_figure(curves, run)
    _, findings, discussion = study_text(combined, frame, metrics)
    for cell in notebook.cells:
        if cell.cell_type != "markdown":
            continue
        if cell.source.startswith("### 3.2"):
            cell.source = (
                "### 3.2 Summary comparisons\n\n"
                + summary_description()
                + "\n\n"
                + _table(comparison_table(combined))
            )
        elif cell.source.startswith("## 3. Results"):
            cell.source = findings
        elif cell.source.startswith("## 4."):
            cell.source = discussion
    # Paired plots use this run's outputs and preserve scenario identity.
    fig, ax = plt.subplots(figsize=(8, 5))
    ax.plot(coin.q, coin.q, "k--", label="True probability")
    ax.plot(coin.q, coin.choice_p, "o-", label="Choice", color="#0072B2")
    ax.plot(coin.q, coin.noul_p, "x-", label="Noul", color="#D55E00")
    ax.set(
        xlabel="True probability of heads",
        ylabel="Predicted probability of heads",
        xlim=(0, 1),
        ylim=(0, 1),
    )
    ax.legend()
    fig.tight_layout()
    fig.savefig(run / "coin_predictions.png", dpi=160)
    plt.close(fig)
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.5), sharey=True)
    for ax, fmt in zip(axes, ["explicit", "parameters"], strict=True):
        sub = dice[dice.track == fmt].sort_values("sum")
        ax.plot(sub["sum"], sub.q, "ko-", label="True probability")
        ax.plot(sub["sum"], sub.choice_p, "o--", label="Choice", color="#0072B2")
        ax.plot(sub["sum"], sub.noul_p, "x-.", label="Noul", color="#D55E00")
        ax.set(
            title="Probability supplied" if fmt == "explicit" else "Dice description only",
            xlabel="Sum of two dice",
            xticks=range(2, 13),
            ylim=(0, max(0.25, dice[["choice_p", "noul_p"]].max().max() * 1.15)),
        )
        ax.legend()
    axes[0].set_ylabel("Probability")
    fig.tight_layout()
    fig.savefig(run / "dice_predictions.png", dpi=160)
    plt.close(fig)
    jobs = json.loads((run / "requests.json").read_text())

    def example(case_id):
        job = next(j for j in jobs if j["case"]["scenario_id"] == case_id)
        row = frame[frame.scenario_id == case_id].iloc[0]
        result = {"choice_p": row.choice_p, "noul_p": row.noul_p, "complement_p": row.complement_p}
        return (
            "**Exact request body:**\n\n```json\n"
            + json.dumps(job["payload"], indent=2)
            + "\n```\n\n**Recorded output fields** (selected from the response; not its full raw body):\n\n```json\n"
            + json.dumps(result, indent=2)
            + "\n```"
        )

    coin_table = coin[["q", "choice_p", "noul_p", "complement_p"]].copy()
    dice_table = dice[["track", "sum", "q", "choice_p", "noul_p", "complement_p"]].copy()
    dice_table["sum"] = dice_table["sum"].astype(int)
    additions = [
        nbformat.v4.new_markdown_cell(
            """### Appendix A. Binary probability tests

#### Coin-toss variant

We described independent coin tosses with heads probabilities 0, .01, .05, .10, .20, .40, .49, .50, .51, .60, .80, .90, .95, .99, and 1. Choice selected heads versus tails; Noul separately scored heads and tails. The target was the next outcome, not which outcome was most likely. Each probability generated one request with three questions.

**All 15 recorded cases:**

"""
            + _table(coin_table)
        ),
        nbformat.v4.new_code_cell("display(Image(filename=str(RUN / 'coin_predictions.png')))"),
        nbformat.v4.new_markdown_cell(
            "**Figure A1. Coin probability recovery.** The diagonal is exact recovery; points show Jev predictions for each stated heads probability.\n\n"
            + example(coin.loc[np.isclose(coin.q, 0.6), "scenario_id"].iloc[0])
        ),
        nbformat.v4.new_markdown_cell(
            """### Appendix B. Two-dice experiment

We specified two independent fair dice, each numbered 1–6. Their 36 equally likely ordered outcomes give counts **1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1** for sums 2–12. For example, sum 7 has six outcomes and probability 1/6; sums 2 and 12 each have probability 1/36.

For each sum, Choice predicted “equals this sum” versus “does not equal this sum.” Noul scored those same two events separately. We tested both a dice-description-only prompt and a prompt also stating the exact probability: 11 sums × 2 formats = 22 requests. These are binary event forecasts, not an 11-class softmax distribution.

The Monte Carlo check drew 500 multinomial count vectors, each representing 2,000 dice-pair rolls, with seed 78. The same draws scored all sum questions, preserving their mutual exclusivity. Per-sum binary Brier losses were averaged equally across the 11 events.

**All 22 recorded cases:**

"""
            + _table(dice_table)
        ),
        nbformat.v4.new_code_cell("display(Image(filename=str(RUN / 'dice_predictions.png')))"),
        nbformat.v4.new_markdown_cell(
            "**Figure B1. Dice-sum probability recovery.** The black curve is the exact sum distribution. Colored curves show separate Jev event scores; they need not sum to one.\n\n"
            + example(dice[(dice.track == "parameters") & (dice["sum"] == 7)].scenario_id.iloc[0])
        ),
    ]
    idx = next(
        i
        for i, c in enumerate(notebook.cells)
        if c.cell_type == "markdown" and c.source.startswith("## Appendix:")
    )
    notebook.cells[idx + 1 : idx + 1] = additions
    family = next(
        c
        for c in notebook.cells
        if c.cell_type == "markdown" and c.source.startswith("### Original synthetic families")
    )
    family.source = family.source.replace(
        "### Original synthetic families", "#### Distribution-threshold variants"
    )
    family.source += (
        """\n\nThe remaining tasks use Uniform(0,1), Normal(0,1), Exponential(rate=1), Poisson(mean=2), Binomial(n=10,p=.3), Student-t(df=3), Lognormal(log-location=0,log-scale=1), and an equal mixture of Normal(−2,1) and Normal(2,1). Normal parameters here are mean and standard deviation. Each asks whether the draw is at or below a threshold, with and without the exact probability supplied. The table below records every threshold and returned event score.\n\n"""
        + _table(other[["family", "track", "event", "q", "choice_p", "noul_p", "complement_p"]])
    )
    # Add source identity and target definition to each real-data appendix.
    descriptions = {
        "south-german-credit": "[South German Credit, UCI 522](https://archive.ics.uci.edu/dataset/522/south+german+credit): 1,000 historical credit records, 20 predictors. Positive means a contract was not complied with (`kredit=0`). The corrected codebook was decoded into feature descriptions. Bad credits were oversampled to 30%; this is not a lending-population prevalence.",
        "bank-marketing": "[Bank Marketing, UCI 222](https://archive.ics.uci.edu/dataset/222/bank+marketing): `bank-additional-full.csv`, 41,188 records. Positive means term-deposit subscription. We removed completed-call duration, leaving 19 predictors. Chronological splitting and filtering change the event rate across partitions.",
        "online-shoppers": "[Online Shoppers, UCI 468](https://archive.ics.uci.edu/dataset/468/online+shoppers+purchasing+intention+dataset): 12,330 sessions. Positive means a purchase (`Revenue=True`). Removing PageValues leaves 16 predictors. This tests retrospective session classification, not early-session forecasting.",
    }
    for c in notebook.cells:
        if c.cell_type == "markdown":
            for name, description in descriptions.items():
                prefix = "### " + name + "\n\n"
                if c.source.startswith(prefix):
                    c.source = c.source.replace(prefix, prefix + description + "\n\n", 1)
    artifacts = next(
        c
        for c in notebook.cells
        if c.cell_type == "markdown" and c.source.startswith("### Artifacts and provenance")
    )
    artifacts.source += f"\n\nExperiment files are saved in `{run}`. The coin and dice tables above contain every synthetic case for those experiments. `all_predictions.csv` contains all 1,045 records; `synthetic_task_summary.csv` contains the separate task summaries."

    dice_metrics = next(
        c
        for c in notebook.cells
        if c.cell_type == "markdown" and c.source.startswith("### Two dice\n")
    )
    dice_appendix = next(
        c
        for c in notebook.cells
        if c.cell_type == "markdown" and c.source.startswith("### Appendix B.")
    )
    dice_appendix.source += (
        "\n\n**Dice score summary:**\n\n" + dice_metrics.source.split("\n\n", 1)[1]
    )
    notebook.cells.remove(dice_metrics)
    notebook.cells.remove(family)
    dice_index = notebook.cells.index(dice_appendix)
    notebook.cells.insert(dice_index, family)


def summary_description():
    return (
        "The first three rows are variants of one binary-probability experiment: coins, thresholds with probabilities supplied, and thresholds with distributions described. All eight conditions appear in the same order in this table and both figures. Choice and Noul are raw model outputs. "
        "Brier loss measures squared forecast error; ECE measures grouped calibration gaps using ten fixed-width probability bins. Lower is better for both. **pp** means percentage points. "
        "For known probabilities, Brier is the exact expected loss `mean(q(1−q) + (p−q)²)` and ECE compares grouped forecasts with known `q`. "
        "For observed outcomes, the same formulas use binary labels `y`, so Brier reduces to `mean((p−y)²)`. Cases count scenarios in the first five rows and test records in the last three. "
        "Compare methods within a row; event rates and task difficulty differ, so no grand average is reported. "
        "Recalibration and supervised baselines require training labels and were fitted only for UCI data; their results remain in the experiment appendices."
    )


def calibration_summary(run):
    from jev_research.unified_report import compare_experiments, study_text

    records = pd.read_csv(run / "all_predictions.csv")
    metrics = pd.read_csv(run / "uci_metrics.csv")
    tests = [
        pd.read_csv(run / f"{slug}-test-predictions.csv")
        for slug in ["south-german-credit", "bank-marketing", "online-shoppers"]
    ]
    summary, _ = compare_experiments(records, tests)
    abstract, _, discussion = study_text(summary, records, metrics)
    return abstract, discussion
