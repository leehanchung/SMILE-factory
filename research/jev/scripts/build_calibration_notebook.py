"""Apply bounded statistical amendments to the original notebook's 50-cell layout."""
# ruff: noqa: E501

import copy
import subprocess
import sys
from pathlib import Path

import nbformat as nbf

ROOT = Path(__file__).resolve().parents[1]
PILOT = ROOT / "runs/revised-exploratory-v1/04_jev_calibration_report.pilot.ipynb"


def build():
    original = nbf.read(PILOT, as_version=4)
    notebook = copy.deepcopy(original)

    def replace(index, old, new):
        assert old in notebook.cells[index].source, (index, old)
        notebook.cells[index].source = notebook.cells[index].source.replace(old, new)

    def code(index, source):
        assert notebook.cells[index].cell_type == "code"
        notebook.cells[index].source = source.strip() + "\n"

    def append(index, source):
        notebook.cells[index].source += "\n\n" + source.strip() + "\n"

    replace(
        0,
        "## Abstract",
        "**Exploratory pilot, reanalyzed from cached predictions.** The original tables and figures retain the historical filtered population and correction. Revised diagnostics and uncertainty appear alongside them below; none is independent confirmation.\n\n## Abstract",
    )
    replace(
        1,
        "All scores are evaluated as event probabilities.",
        "The main report evaluates known-probability recovery against exact probabilities and real-event forecasts against observed outcomes. The separate answer-confidence diagnostic compares confidence in the chosen answer with correctness; event probabilities are never scored against answer correctness.",
    )
    replace(
        1,
        "Synthetic probabilities are known exactly; real-data probabilities are unknown, so actual binary labels supply the evaluation outcomes.",
        "Synthetic probabilities are known exactly; real-data probabilities are unknown, so actual binary labels supply the evaluation outcomes. The 85 synthetic prompt cases represent 50 event definitions and 24 conservative generating groups; the 960 real records have unverified customer independence. Each request appears once in this cache; Monte Carlo repetitions add no model evaluations.",
    )
    replace(
        1,
        "Repeated feature rows were reduced",
        "In the historical pilot, repeated feature rows were reduced",
    )
    replace(
        1,
        "This changes the evaluation population and is documented below.",
        "This changes the evaluation population; the historical results remain a sensitivity analysis. The revised source loader preserves separate observations, including identical features with conflicting outcomes; only proven duplicate exports may be collapsed.",
    )
    replace(
        1, "Corrections fit logistic regression", "Historical corrections fit logistic regression"
    )
    replace(
        1,
        "Bank temporal dependence and unavailable customer IDs limit interval interpretation.",
        "Bank temporal dependence and unavailable customer IDs limit interval interpretation. Revised comparisons add raw, intercept-only, and regularized intercept-plus-slope arms with fixed settings selected without test tuning. They distinguish fixed-calibrator intervals from independently resampled calibration/refit and test intervals; grouping and temporal assumptions are stated below.",
    )
    replace(
        2,
        "The cells below acquire the source data, inspect it, generate scenarios, train baselines, and query Jev. Each full execution creates its own output directory and sends 1,045 requests. Seed 78 fixes the sampled records and simulated outcomes.",
        "The cells below inspect saved source data, regenerate the scenarios, and read cached baseline predictions and Jev responses. The historical execution sent 1,045 requests; this revision makes no API calls and writes derived outputs to a new directory. Seed 78 identifies the original sampled records and simulated outcomes.",
    )
    replace(5, "before any model is queried", "for the original scenarios")
    replace(
        8,
        "Feature duplicates are removed; groups with conflicting labels are excluded.",
        "The historical pilot removed feature duplicates and conflicting-label groups; the revised audit preserves these observations and treats the filtered pilot as a sensitivity analysis. Source IDs distinguish observations; feature hashes are grouping proxies, not proof of duplicate exports or shared customers.",
    )
    append(
        11,
        "This revision reads those saved baseline predictions and request bodies; it does not retrain models or send requests.",
    )
    replace(
        14,
        "Calibration fits an intercept and slope on 120 reserved labels, then scores 200 untouched test records.",
        "The historical correction fits an intercept and slope on 120 reserved labels, then scores 200 separate pilot test records whose results have already been inspected.",
    )
    append(
        14,
        "Revised results prioritize probability MAE and excess expected Brier for exact probabilities. Proper scores, calibration diagnostics, discrimination, and coverage remain separate. An oracle has zero recovery error and expected Brier `mean(q*(1-q))`; the controls below also test constant and rank-preserving overconfident predictors. Revised intervals include paired Choice-versus-Noul comparisons and both fixed-calibrator and calibration-refit uncertainty.",
    )
    append(
        27,
        "The figure preserves the pilot point estimates. Probability-recovery errors and revised paired intervals accompany the summary table above; the normalized penalty is retained only for continuity.",
    )
    append(
        30,
        "The accompanying diagnostics report bin counts and group/block uncertainty, with predeclared equal-width/equal-mass 5/10/20-bin sensitivities. Tied predictions are not split; sparse bins and a single generating group cannot support precise intervals. Bootstrap intervals do not eliminate ECE estimation bias.",
    )

    code(
        3,
        """import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path

import matplotlib.pyplot as plt
import nbformat
import numpy as np
import pandas as pd
from IPython.display import Image, Markdown, display
from scipy import stats
from scipy.special import xlogy

from jev_research.evaluation import evaluate_predictions
from jev_research.population import load_population
from jev_research.revised_analysis import load_cached_run

ROOT = next(p for p in [Path.cwd(), *Path.cwd().parents] if (p / "scripts/uv.sh").exists())
SEED = 78
SOURCE = ROOT / "runs/04-jev-calibration-20260920T074937231226Z"
REVISION = ROOT / "runs/revised-exploratory-v1"
PILOT_NOTEBOOK = REVISION / "04_jev_calibration_report.pilot.ipynb"
RUN = ROOT / "runs" / ("04-jev-calibration-revised-" + datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ"))
RUN.mkdir(parents=True, exist_ok=False)
print("Cached pilot:", SOURCE.relative_to(ROOT))
print("Derived experiment files:", RUN.relative_to(ROOT), "— no API calls")""",
    )
    replace(4, "DATA.mkdir(parents=True, exist_ok=True)\n", "")
    replace(
        4,
        """    if not archive.exists():
        response = requests.get(source["url"], timeout=120)
        response.raise_for_status()
        assert hashlib.sha256(response.content).hexdigest() == source["sha256"]
        archive.write_bytes(response.content)""",
        """    if not archive.exists():
        raise FileNotFoundError(f"Cached source archive required: {archive}")""",
    )
    code(
        9,
        """def load_uci(slug):
    # Preserve every source observation; reuse the declared pilot split without reshuffling.
    X, y, groups, source_meta = load_population(ROOT, slug)
    meta = json.loads((SOURCE / f"{slug}-split.json").read_text())
    assert source_meta["archive_sha256"] == meta["archive_sha256"]
    train, cal, test = [np.asarray(meta[key]) for key in
                       ["train_ids", "calibration_ids", "test_ids"]]
    assert not (set(train) & set(cal) or set(train) & set(test) or set(cal) & set(test))
    if slug == "bank-marketing":
        assert max(train) < min(cal) and max(cal) < min(test)
    return X, y, train, cal, test, meta""",
    )
    replace(10, '"retained_rows": len(X)', '"audited_source_rows": len(X)')
    replace(
        10,
        '"removed_rows": meta["removed_duplicate_or_conflicting_rows"]',
        '"historically_excluded_rows": meta["removed_duplicate_or_conflicting_rows"]',
    )
    append(
        10,
        """display(pd.read_csv(REVISION / "population_summary.csv")[[
    "dataset", "source_records", "legacy_retained_rows", "legacy_excluded_rows",
    "conflicting_feature_groups", "rows_in_conflicting_feature_groups",
    "customer_id_available"]])""",
    )
    code(
        12,
        """jobs = json.loads((SOURCE / "requests.json").read_text())
baseline = pd.read_csv(SOURCE / "baseline_predictions.csv")
assert len(jobs) == 1045
display(pd.DataFrame(jobs).groupby("experiment").size().rename("historical requests"))
display(jobs[0]["payload"])""",
    )
    code(
        13,
        """records, validation, request_coverage = load_cached_run(SOURCE)
display(request_coverage)
display({"valid_probability_rows": int(validation.all_probabilities_valid.sum()),
         "normalized_choice_rows": int(validation.choice_normalized.sum()),
         "noul_complement_incoherence_gt_1e_5": int((validation.noul_complement_gap > 1e-5).sum())})
# Complement disagreement is diagnosed, not silently normalized or excluded.
display(pd.read_csv(REVISION / "dice_coherence.csv"))
records.to_csv(RUN / "all_predictions.csv", index=False)
validation.to_csv(RUN / "validation_checks.csv", index=False)""",
    )
    code(
        17,
        """METHODS = ["Choice", "Noul", "Choice corrected", "Noul corrected",
           "Logistic regression", "CatBoost", "Constant"]

def scores(p, target, *, target_kind="real_event"):
    return evaluate_predictions(p, target, target_kind=target_kind)

q_control = np.array([.1, .3, .5, .7, .9])
oracle = scores(q_control, q_control, target_kind="known_probability")
assert oracle["probability_mae"] == oracle["excess_expected_brier"] == 0
assert np.isclose(oracle["expected_brier"], np.mean(q_control*(1-q_control)))
display(pd.read_csv(REVISION / "controlled_predictors.csv")[[
    "predictor", "target_kind", "brier", "probability_mae",
    "excess_expected_brier", "ece10", "auroc"]])""",
    )
    code(
        18,
        """# Preserve the original results as a filtered-population sensitivity analysis.
metrics = pd.read_csv(SOURCE / "uci_metrics.csv")
test_frames = [pd.read_csv(SOURCE / f"{slug}-test-predictions.csv") for slug in SOURCES]
for frame in test_frames:
    slug = frame.dataset.iloc[0]
    _, y, _, _, _, _ = datasets[slug]
    assert np.array_equal(frame.y.to_numpy(), y.loc[frame.row_id].to_numpy())
revised_metrics = pd.read_csv(REVISION / "metrics.csv")
paired = pd.read_csv(REVISION / "paired_comparisons.csv")
calibration_bins = pd.read_csv(REVISION / "reliability_bins.csv")
ece_sensitivity = pd.read_csv(REVISION / "ece_sensitivity.csv")
# New corrections and their uncertainty were fit only on the saved calibration records.
# Numerical fitting uses eps=1e-6; slope correction uses identity-centered ridge lambda=1.
# All arms/settings were fixed for the exploratory reanalysis, without test tuning.
calibration = pd.read_csv(REVISION / "calibrator_fits.csv")""",
    )
    code(
        19,
        """# Historical conditional outcome simulations; no additional model evaluations.
detail = pd.read_csv(SOURCE / "synthetic_scenario_metrics.csv")
synth_summary = pd.read_csv(SOURCE / "synthetic_summary.csv")
reliability = pd.read_csv(SOURCE / "synthetic_reliability.csv")
dice_summary = pd.read_csv(SOURCE / "dice_summary.csv")
# Exact-q probability MAE/excess expected Brier and grouped uncertainty are shown below.""",
    )
    # Preserve the original point-score functions and figures; avoid shadowing revised bin data.
    replace(
        20,
        "unified_metrics, calibration_bins = compare_experiments(records, test_frames)",
        "unified_metrics, pilot_calibration_bins = compare_experiments(records, test_frames)",
    )
    replace(
        20,
        'calibration_bins.to_csv(RUN / "unified_calibration_bins.csv", index=False)',
        'pilot_calibration_bins.to_csv(RUN / "unified_calibration_bins.csv", index=False)',
    )
    replace(
        21,
        "calibration_figure(calibration_bins, RUN)",
        "calibration_figure(pilot_calibration_bins, RUN)",
    )
    # Report prose is retained verbatim from the executed pilot, with only local corrections.
    code(
        22,
        """pilot_notebook = nbformat.read(PILOT_NOTEBOOK, as_version=4)
pilot_sections = []
for cell in pilot_notebook.cells:
    for output in cell.get("outputs", []):
        text = output.get("data", {}).get("text/markdown")
        if text is not None:
            pilot_sections.append(text if isinstance(text, str) else "".join(text))""",
    )
    code(
        23,
        """report_cells = nbformat.v4.new_notebook(cells=[
    nbformat.v4.new_markdown_cell(text) for text in pilot_sections])
for cell in report_cells.cells:
    if cell.source.startswith("## 4. Discussion"):
        cell.source = cell.source.replace(
            "A duplicate-preserving grouped-split sensitivity check remains needed.",
            "The revised population audit preserves repeated observations and conflicting outcomes, "
            "but full-population Jev evaluation requires predictions absent from this cache.")
        cell.source += (
            "\\n\\nRevised group/block intervals accompany the original pilot estimates. Feature hashes "
            "are proxies with unknown customer independence; Bank uses 10 adjacent sampled records "
            "per block (5/20 sensitivity), assuming local dependence and independent calibration/test "
            "resampling. They do not repair temporal shift. Related synthetic prompts/questions stay "
            "in the same generating group; one dice process cannot supply a population interval. "
            "Refit intervals include calibration-sample uncertainty, while fixed-fit intervals do not; "
            "both condition on baseline training and prompts. Bootstrap does not eliminate ECE bias. "
            "The [methodological audit](../methodology-audit.md) distinguishes checked findings from "
            "assumptions. The separate [frozen-protocol draft](../confirmatory-protocol.md) specifies "
            "comparisons, effect sizes, tolerances, exclusions, sample sizes/rare-event gates, untouched "
            "temporal/domain cohorts and templates, and support/contradict/inconclusive criteria. "
            "Its acquisition/model lock and new data are still required; reshuffling this pilot is "
            "not independent confirmation.")
    elif cell.source.startswith("## Appendix: individual experiments"):
        cell.source += (
            "\\n\\nThe original tables and plots below retain the historical correction and iid, "
            "fixed-fit intervals. Additional tables in the same sections report the revised arms "
            "and group/block uncertainty. All real-data scores concern the filtered sensitivity "
            "sample; excluded observations have no cached predictions.")""",
    )
    append(
        25,
        """display(Markdown("**Revised probability-recovery errors and paired uncertainty** (95% intervals; dice has one generating configuration, so its generalization interval is unavailable)."))
display(revised_metrics[revised_metrics.target_kind.eq("known_probability")][[
    "condition", "method", "probability_mae", "probability_mae_low", "probability_mae_high",
    "excess_expected_brier", "excess_expected_brier_low", "excess_expected_brier_high"]])
display(paired[paired.comparison.eq("Noul - Choice") &
               paired.metric.isin(["brier", "excess_expected_brier"]) &
               ~paired.uncertainty.isin(["fixed_predictors_block_5", "fixed_predictors_block_20"])][[
    "condition", "metric", "difference", "ci_low", "ci_high", "uncertainty"]])""",
    )
    append(
        29,
        """display(Markdown("**Revised bin diagnostics.** Ties remain together; ECE intervals re-bin each draw. Bin intervals retain original membership and resample groups/blocks. Blank intervals are unavailable. Full width/mass × 5/10/20 tables are retained in the revised artifacts."))
raw_bins = calibration_bins[calibration_bins.target_kind.eq("real_event") &
    calibration_bins.method.isin(["Choice", "Noul"]) &
    calibration_bins.strategy.eq("equal_width") & calibration_bins.requested_bins.eq(10)]
display(raw_bins[["condition", "method", "bin", "n", "n_groups", "mean_prediction",
                  "mean_target", "group_rate_low", "group_rate_high"]])
display(ece_sensitivity[ece_sensitivity.target_kind.eq("real_event") &
                        ece_sensitivity.method.isin(["Choice", "Noul"])][[
    "condition", "method", "strategy", "requested_bins", "occupied_bins", "ece", "ece_low", "ece_high"]])""",
    )
    for index, slug in [
        (40, "south-german-credit"),
        (43, "bank-marketing"),
        (46, "online-shoppers"),
    ]:
        append(
            index,
            f"""display(Markdown("**Revised matched-record results.** Brier/log loss measure probability quality; ECE diagnoses calibration; AUROC/AP measure discrimination; coverage is reported separately. `legacy correction` retains the original fit. New arms are intercept-only and regularized intercept-plus-slope."))
display(revised_metrics[revised_metrics.condition.eq({slug!r})][[
    "method", "brier", "brier_low", "brier_high", "log_loss", "ece10", "auroc", "average_precision", "coverage"]])
display(paired[paired.condition.eq({slug!r}) & paired.comparison.str.contains("intercept")][[
    "comparison", "uncertainty", "difference", "ci_low", "ci_high", "n_fit_failures"]])
display(Markdown("**Derived answer-confidence diagnostic.** Fix the chosen binary answer at p ≥ .5, use confidence max(p,1−p), and score against correctness. Its Brier equals event Brier algebraically; it is not separate confidence-elicitation evidence."))
display(revised_metrics[revised_metrics.target_kind.eq("answer_confidence") &
                        revised_metrics.condition.str.startswith({slug!r})][[
    "method", "answer_accuracy", "brier", "log_loss", "ece10", "coverage"]])""",
        )
    for index in [34, 38, 41, 44, 47]:
        replace(index, "RUN /", "SOURCE /")
    append(
        49,
        """display(Markdown(f"Revised statistics and their full audit: `{REVISION.relative_to(ROOT)}`. This execution's derived figures and EDA: `{RUN.relative_to(ROOT)}`. Historical artifacts remain unchanged; no paid inference ran."))
display(pd.Series(json.loads((REVISION / "evidence_counts.json").read_text()), name="Count / interpretation"))
revision_manifest = json.loads((REVISION / "analysis_manifest.json").read_text())
assert all(hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == sha
           for path, sha in revision_manifest["historical_sha256"].items())
(RUN / "revision_manifest.json").write_text(json.dumps({
    "pilot_source": str(SOURCE.relative_to(ROOT)),
    "statistical_revision": str(REVISION.relative_to(ROOT)),
    "notebook_layout": "original 50 cells and original section order",
    "new_api_calls": 0,
    "historical_files_verified": len(revision_manifest["historical_sha256"]),
}, indent=2) + "\\n")""",
    )

    assert len(notebook.cells) == len(original.cells) == 50
    assert [c.cell_type for c in notebook.cells] == [c.cell_type for c in original.cells]
    assert [c.id for c in notebook.cells] == [c.id for c in original.cells]
    for cell in notebook.cells:
        if cell.cell_type == "code":
            cell.outputs = []
            cell.execution_count = None
            # Original prose/data literals deliberately retain their long source lines.
            cell.source = "# ruff: noqa: E501\n" + cell.source
    nbf.validate(notebook)
    path = ROOT / "notebooks/04_jev_calibration_report.ipynb"
    nbf.write(notebook, path)
    for args in [["check", "--fix", str(path)], ["format", str(path)]]:
        subprocess.run([sys.executable, "-m", "ruff", *args], check=True)
    return path


if __name__ == "__main__":
    print(build())
