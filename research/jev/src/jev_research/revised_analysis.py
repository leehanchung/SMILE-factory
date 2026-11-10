"""Cache-only exploratory reanalysis; never imports the HTTP/inference runner."""
# ruff: noqa: E501

import hashlib
import json
from dataclasses import asdict
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.special import expit, logit, xlogy

from jev_research.evaluation import (
    bootstrap_calibration_comparison,
    bootstrap_comparison,
    bootstrap_indices,
    evaluate_predictions,
    fit_calibrator,
    reliability_bins,
)
from jev_research.population import audit_population, load_population

DATASETS = ["south-german-credit", "bank-marketing", "online-shoppers"]
SOURCE_RUN = "04-jev-calibration-20260920T074937231226Z"
SEED = 220926


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_cached_run(source):
    """Left join the request roster; missing responses remain in the denominator.

    A response is tied to its complete payload hash and local target metadata.
    Categorical normalization is required; independent Noul complements are audited.
    """
    source = Path(source)
    manifest = json.loads((source / "manifest.json").read_text())
    jobs = json.loads((source / "requests.json").read_text())
    responses = [json.loads(p.read_text()) for p in sorted((source / "responses").glob("*.json"))]
    by_hash = {}
    for response in responses:
        key = response["request_sha256"]
        if key in by_hash:
            raise ValueError("Duplicate response export for the same request; resolve explicitly.")
        by_hash[key] = response
    rows, checks, seen = [], [], set()
    for job in jobs:
        payload, case = job["payload"], job["case"]
        key = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        if key in seen:
            raise ValueError(
                "Repeated request payload needs a call-level identity, not silent dedup."
            )
        seen.add(key)
        criteria = payload["questions"]["choice"]["criteria"]
        if (
            set(criteria) != {case["true_key"], case["false_key"]}
            or criteria[case["true_key"]] != case["event"]
            or criteria[case["false_key"]] != case["opposite"]
            or payload["questions"]["event"]["instructions"] != case["event"]
            or payload["questions"]["complement"]["instructions"] != case["opposite"]
        ):
            raise ValueError("Positive label/event/complement alignment mismatch.")
        response = by_hash.get(key)
        row = {**case, "experiment": job["experiment"], "request_sha256": key}
        for field in ["choice_p", "choice_other_p", "noul_p", "complement_p"]:
            row[field] = np.nan if response is None else response.get(field, np.nan)
        if response is not None:
            for field in [
                "scenario_id",
                "true_key",
                "false_key",
                "event",
                "opposite",
                "partition",
                "row_id",
                "y",
                "q",
            ]:
                if field in case and response.get(field) != case[field]:
                    raise ValueError(f"Cached {field} differs from request metadata.")
            if response["model"] != payload["model"]:
                raise ValueError("Cached model does not match request.")
        probabilities = np.array(
            [row[f] for f in ["choice_p", "choice_other_p", "noul_p", "complement_p"]], float
        )
        finite_bounds = np.isfinite(probabilities) & (probabilities >= 0) & (probabilities <= 1)
        normalized = bool(
            finite_bounds[:2].all() and np.isclose(probabilities[:2].sum(), 1, rtol=0, atol=1e-5)
        )
        checks.append(
            {
                "scenario_id": case["scenario_id"],
                "experiment": job["experiment"],
                "response_present": response is not None,
                "all_probabilities_valid": bool(finite_bounds.all()),
                "choice_normalized": normalized,
                "noul_complement_gap": (
                    abs(probabilities[2:].sum() - 1) if finite_bounds[2:].all() else np.nan
                ),
            }
        )
        if response is not None and not normalized:
            row["choice_p"] = np.nan  # required schema failure, retained in coverage denominator
        rows.append(row)
    if set(by_hash) - seen or len(jobs) != manifest["fresh_requests"]:
        raise ValueError("Request/response inventory does not match manifest.")
    failures = json.loads((source / "failures.json").read_text())
    coverage = {
        "requested_calls": len(jobs),
        "saved_responses": len(responses),
        "missing_responses": len(jobs) - len(responses),
        "failure_log_entries": len(failures),
        "repeated_payload_calls": 0,
        "new_api_calls": 0,
        "full_raw_response_validation": "unavailable; saved selected fields only",
    }
    return pd.DataFrame(rows), pd.DataFrame(checks), coverage


def synthetic_identity(frame):
    frame = frame.copy()
    frame["underlying_event"] = frame.family + ":" + frame.event + ":" + frame.q.astype(str)
    frame["uncertainty_group"] = [
        f"coin:{q}" if family == "bernoulli" else family
        for family, q in zip(frame.family, frame.q, strict=True)
    ]
    frame["condition"] = (
        frame.family.where(frame.family.isin(["bernoulli", "two_dice"]), "thresholds")
        + "/"
        + frame.track
    )
    return frame


def percentile(values):
    values = np.asarray(values, float)
    values = values[~np.isnan(values)]
    if not len(values):
        return np.nan, np.nan
    # Observed order statistics avoid inf-inf interpolation for honest infinite log loss.
    return tuple(np.quantile(values, [0.025, 0.975], method="inverted_cdf"))


def _bin_membership(p, strategy, n_bins, edges=None):
    if strategy == "equal_width":
        return np.minimum((p * n_bins).astype(int), n_bins - 1)
    return np.searchsorted(edges[1:-1], p, side="right")


def metric_intervals(p, y, kind, groups, block_length, n_boot):
    """Resample the full request roster before masking failed predictions."""
    p, y, groups = np.asarray(p, float), np.asarray(y, float), np.asarray(groups)
    valid = np.isfinite(p) & (p >= 0) & (p <= 1)
    names = ["brier", "log_loss", "ece10", "signed_error"]
    if kind == "known_probability":
        names += ["probability_mae", "excess_expected_brier"]
    samples = {name: [] for name in names}
    enough = valid.sum() >= 2 and (
        len(p) // block_length >= 2 if block_length else len(np.unique(groups[valid])) >= 2
    )
    rng = np.random.default_rng(SEED)
    if enough:
        for _ in range(n_boot):
            idx = bootstrap_indices(
                len(p),
                rng,
                groups=groups if block_length is None else None,
                block_length=block_length,
            )
            idx = idx[valid[idx]]
            if not len(idx):
                continue
            pp, yy = p[idx], y[idx]
            loss = (pp - yy) ** 2 + (yy * (1 - yy) if kind == "known_probability" else 0)
            samples["brier"].append(loss.mean())
            samples["signed_error"].append((pp - yy).mean())
            samples["log_loss"].append((-xlogy(yy, pp) - xlogy(1 - yy, 1 - pp)).mean())
            bid = _bin_membership(pp, "equal_width", 10)
            samples["ece10"].append(abs(np.bincount(bid, weights=pp - yy)).sum() / len(idx))
            if kind == "known_probability":
                samples["probability_mae"].append(abs(pp - yy).mean())
                samples["excess_expected_brier"].append(((pp - yy) ** 2).mean())
    result = {
        f"{name}_{tail}": value
        for name, draws in samples.items()
        for tail, value in zip(["low", "high"], percentile(draws), strict=True)
    }
    result["n_metric_boot_valid"] = len(samples["brier"])
    return result


def bin_diagnostics(p, y, kind, groups, block_length, n_boot):
    """Fixed-bin group/block uncertainty and re-binned ECE sensitivity.

    Empty bins are retained. Each draw samples the complete request roster,
    then removes invalid scores; failures never compress the temporal sequence.
    """
    p, y, groups = np.asarray(p, float), np.asarray(y, float), np.asarray(groups)
    valid = np.isfinite(p) & (p >= 0) & (p <= 1)
    rows, sensitivity = [], []
    enough = valid.sum() >= 2 and (
        len(p) // block_length >= 2 if block_length else len(np.unique(groups[valid])) >= 2
    )
    rng = np.random.default_rng(SEED)
    draws = []
    if enough:
        for _ in range(n_boot):
            idx = bootstrap_indices(
                len(p),
                rng,
                groups=groups if block_length is None else None,
                block_length=block_length,
            )
            draws.append(idx[valid[idx]])
    for strategy in ["equal_width", "equal_mass"]:
        for n_bins in [5, 10, 20]:
            bins = reliability_bins(p, y, n_bins=n_bins, strategy=strategy, target_kind=kind)
            edges = np.array([bins[0]["lower"]] + [b["upper"] for b in bins])
            original_ids = np.full(len(p), -1)
            original_ids[valid] = _bin_membership(p[valid], strategy, n_bins, edges)
            ece_draws = []
            for idx in draws:
                if not len(idx):
                    continue
                boot_edges = (
                    None
                    if strategy == "equal_width"
                    else np.unique(np.r_[0, np.quantile(p[idx], np.arange(1, n_bins) / n_bins), 1])
                )
                ids = _bin_membership(p[idx], strategy, n_bins, boot_edges)
                ece_draws.append(abs(np.bincount(ids, weights=p[idx] - y[idx])).sum() / len(idx))
            lo, hi = percentile(ece_draws)
            sensitivity.append(
                {
                    "strategy": strategy,
                    "requested_bins": n_bins,
                    "occupied_bins": sum(b["n"] > 0 for b in bins),
                    "n": int(valid.sum()),
                    "ece": (
                        sum(b["n"] * abs(b["gap"]) for b in bins if b["n"]) / valid.sum()
                        if valid.any()
                        else np.nan
                    ),
                    "ece_low": lo,
                    "ece_high": hi,
                    "n_boot_valid": len(ece_draws),
                }
            )
            for b in bins:
                member = original_ids == b["bin"]
                rates, gaps = [], []
                for idx in draws:
                    take = idx[member[idx]]
                    if len(take):
                        rates.append(y[take].mean())
                        gaps.append((p[take] - y[take]).mean())
                bin_units = (
                    len(np.unique(np.flatnonzero(member) // block_length))
                    if block_length
                    else len(np.unique(groups[member]))
                )
                low, high = percentile(rates) if bin_units >= 2 else (np.nan, np.nan)
                glow, ghigh = percentile(gaps) if bin_units >= 2 else (np.nan, np.nan)
                rows.append(
                    {
                        **b,
                        "group_rate_low": low,
                        "group_rate_high": high,
                        "group_gap_low": glow,
                        "group_gap_high": ghigh,
                        "nonempty_bootstrap_draws": len(rates),
                        "n_groups": len(np.unique(groups[member])),
                        "bin_resampling_units": bin_units,
                    }
                )
    return rows, sensitivity


def markdown_table(frame):
    def cell(v):
        return f"{v:.5g}" if isinstance(v, (float, np.floating)) else str(v)

    return "\n".join(
        [
            "| " + " | ".join(frame.columns) + " |",
            "| " + " | ".join(["---"] * len(frame.columns)) + " |",
        ]
        + [
            "| " + " | ".join(cell(v) for v in row) + " |"
            for row in frame.itertuples(index=False, name=None)
        ]
    )


def run_analysis(root, output, *, n_boot=1000):
    root, output = Path(root).resolve(), Path(output).resolve()
    source = root / "runs" / SOURCE_RUN
    if output == source or source in output.parents or output == root / "runs":
        raise ValueError("Revised output must be separate from historical artifacts.")
    output.mkdir(parents=True, exist_ok=True)
    allowed_existing = {"historical_sha256.json", "04_jev_calibration_report.pilot.ipynb"}
    if any(p.name not in allowed_existing for p in output.iterdir()):
        raise FileExistsError(
            "Analysis already exists. Use a new directory; never overwrite results."
        )
    if n_boot < 20:
        raise ValueError("At least 20 resamples required; published analysis uses 1000.")
    source_hashes = {str(p.relative_to(root)): digest(p) for p in source.rglob("*") if p.is_file()}
    records, checks, coverage = load_cached_run(source)
    records.to_csv(output / "cached_records.csv", index=False)
    checks.to_csv(output / "validation_checks.csv", index=False)
    audit = audit_population(root, source)
    for name, frame in audit.items():
        frame.to_csv(output / f"{name}.csv", index=False)
    baseline = pd.read_csv(source / "baseline_predictions.csv")
    summaries, bin_rows, sensitivities, pairs, fits, scored_records = [], [], [], [], [], []

    def score_panel(condition, preds, target, kind, groups, block_length=None):
        for method, p in preds.items():
            result = evaluate_predictions(p, target, target_kind=kind)
            result.update(metric_intervals(p, target, kind, groups, block_length, n_boot))
            meta = {
                "condition": condition,
                "method": method,
                "target_kind": kind,
                "population": (
                    "fixed_synthetic_grid"
                    if kind == "known_probability"
                    else "historical_filtered_sensitivity"
                ),
                "uncertainty": (
                    "moving_block_10_sampled_records" if block_length else "group_bootstrap"
                ),
                "resampling_groups": len(np.unique(groups)),
            }
            summaries.append({**meta, **result})
            bins, sens = bin_diagnostics(p, target, kind, groups, block_length, n_boot)
            bin_rows.extend({**meta, **b} for b in bins)
            sensitivities.extend({**meta, **b} for b in sens)

    synth = synthetic_identity(records[records.experiment.isin(["synthetic", "two-dice"])])
    synth.to_csv(output / "synthetic_scenario_map.csv", index=False)
    dice_coherence = []
    for track, frame in synth[synth.family.eq("two_dice")].groupby("track"):
        for interface, column in [("Choice", "choice_p"), ("Noul", "noul_p")]:
            total = frame[column].sum(min_count=len(frame))
            dice_coherence.append(
                {
                    "track": track,
                    "interface": interface,
                    "separate_binary_questions": len(frame),
                    "probability_sum": total,
                    "sum_minus_one": total - 1,
                    "normalization_required_for_binary_scoring": False,
                }
            )
    pd.DataFrame(dice_coherence).to_csv(output / "dice_coherence.csv", index=False)
    for condition, frame in synth.groupby("condition", sort=True):
        pred = {"Choice": frame.choice_p.to_numpy(), "Noul": frame.noul_p.to_numpy()}
        score_panel(
            condition,
            pred,
            frame.q.to_numpy(),
            "known_probability",
            frame.uncertainty_group.to_numpy(),
        )
        for metric in ["probability_mae", "excess_expected_brier", "brier", "log_loss"]:
            result = bootstrap_comparison(
                pred["Noul"],
                pred["Choice"],
                frame.q.to_numpy(),
                target_kind="known_probability",
                metric=metric,
                groups=frame.uncertainty_group.to_numpy(),
                n_boot=n_boot,
                seed=SEED,
            )
            pairs.append(
                {
                    **result,
                    "condition": condition,
                    "comparison": "Noul - Choice",
                    "uncertainty": "fixed_predictions_group_bootstrap",
                }
            )

    for slug in DATASETS:
        _, y, groups, source_meta = load_population(root, slug)
        split = json.loads((source / f"{slug}-split.json").read_text())
        if source_meta["archive_sha256"] != split["archive_sha256"]:
            raise ValueError("Source archive differs from the pilot archive.")
        train_ids, cal_ids, test_ids = [
            set(split[k]) for k in ["train_ids", "calibration_ids", "test_ids"]
        ]
        if train_ids & cal_ids or train_ids & test_ids or cal_ids & test_ids:
            raise ValueError("Development/calibration/test overlap.")
        raw = records[records.experiment.eq(slug)].copy()
        raw["row_id"] = raw.row_id.astype(int)
        if not np.array_equal(raw.y.to_numpy(), y.loc[raw.row_id].to_numpy()):
            raise ValueError("Source outcome label alignment failed.")
        joined = baseline[baseline.dataset.eq(slug)].merge(
            raw[["row_id", "partition", "y", "choice_p", "noul_p"]],
            on=["row_id", "partition", "y"],
            how="outer",
            validate="one_to_one",
            indicator=True,
        )
        if not joined["_merge"].eq("both").all():
            raise ValueError("Baseline/model record alignment failed.")
        cal = joined[joined.partition.eq("calibration")].sort_values("row_id")
        test = joined[joined.partition.eq("test")].sort_values("row_id")
        if set(cal.row_id) != cal_ids or set(test.row_id) != test_ids:
            raise ValueError("Scored records differ from declared split IDs.")
        cg, tg = groups.loc[cal.row_id].to_numpy(), groups.loc[test.row_id].to_numpy()
        if set(cg) & set(tg):
            raise ValueError("Calibration/test proxy groups overlap; independent refit invalid.")
        cy, ty = cal.y.to_numpy(), test.y.to_numpy()
        block = 10 if slug == "bank-marketing" else None
        preds = {
            "Choice": test.choice_p.to_numpy(),
            "Noul": test.noul_p.to_numpy(),
            "Constant": test.constant.to_numpy(),
            "Logistic regression": test.logistic_regression.to_numpy(),
            "CatBoost": test.catboost.to_numpy(),
        }
        legacy = pd.read_csv(source / f"{slug}-test-predictions.csv").set_index("row_id")
        for interface, field in [("Choice", "choice_p"), ("Noul", "noul_p")]:
            preds[interface + " legacy correction"] = legacy.loc[
                test.row_id, interface + " corrected"
            ].to_numpy()
            for method in ["intercept", "intercept_slope"]:
                fit = fit_calibrator(cal[field].to_numpy(), cy, method=method, l2=1.0)
                if not fit.converged:
                    raise ValueError("Calibration optimizer failed; do not score failed fit.")
                name = interface + " " + method
                preds[name] = fit.predict(test[field].to_numpy())
                fits.append(
                    {
                        "dataset": slug,
                        "interface": interface,
                        **asdict(fit),
                        "n_calibration": len(cal),
                        "calibration_positives": int(cy.sum()),
                        "setting_selection": "fixed before reanalysis; no final-test tuning",
                    }
                )
                for refit in [False, True]:
                    result = bootstrap_calibration_comparison(
                        cal[field].to_numpy(),
                        cy,
                        test[field].to_numpy(),
                        ty,
                        method=method,
                        l2=1.0,
                        refit=refit,
                        calibration_groups=cg if block is None else None,
                        test_groups=tg if block is None else None,
                        calibration_block_length=block,
                        test_block_length=block,
                        n_boot=n_boot,
                        seed=SEED,
                    )
                    pairs.append(
                        {
                            **result,
                            "condition": slug,
                            "comparison": name + " - " + interface,
                            "uncertainty": (
                                "refit_calibration_independent_test"
                                if refit
                                else "fixed_calibrator"
                            ),
                        }
                    )
        score_panel(slug, preds, ty, "real_event", tg, block)
        for name, pred in preds.items():
            for rid, target, p in zip(test.row_id, ty, pred, strict=True):
                scored_records.append(
                    {
                        "dataset": slug,
                        "row_id": rid,
                        "method": name,
                        "target_kind": "real_event",
                        "y": target,
                        "p": p,
                    }
                )
        for bl in [5, 10, 20] if block else [None]:
            for metric in ["brier", "log_loss", "ece10"]:
                result = bootstrap_comparison(
                    preds["Noul"],
                    preds["Choice"],
                    ty,
                    target_kind="real_event",
                    metric=metric,
                    groups=tg if bl is None else None,
                    block_length=bl,
                    n_boot=n_boot,
                    seed=SEED,
                )
                pairs.append(
                    {
                        **result,
                        "condition": slug,
                        "comparison": "Noul - Choice",
                        "uncertainty": f"fixed_predictors_block_{bl}"
                        if bl
                        else "fixed_predictors_group_bootstrap",
                    }
                )
        for interface in ["Choice", "Noul"]:
            p = preds[interface]
            confidence = np.maximum(p, 1 - p)
            correctness = ((p >= 0.5).astype(int) == ty).astype(int)
            score_panel(
                slug + "/derived-answer/" + interface,
                {interface: confidence},
                correctness,
                "answer_confidence",
                tg,
                block,
            )

    outputs = {
        "metrics": summaries,
        "reliability_bins": bin_rows,
        "ece_sensitivity": sensitivities,
        "paired_comparisons": pairs,
        "calibrator_fits": fits,
        "matched_test_predictions": scored_records,
    }
    for name, rows in outputs.items():
        pd.DataFrame(rows).to_csv(output / f"{name}.csv", index=False)
    # Independent controlled predictors, no API calls or Monte Carlo evidence inflation.
    q = np.array([0.1, 0.3, 0.5, 0.7, 0.9])
    control = []
    for name, p in [
        ("Oracle", q),
        ("Constant base rate", np.repeat(q.mean(), len(q))),
        ("Overconfident rank-preserving", expit(3 * logit(q))),
    ]:
        control.append(
            {"predictor": name, **evaluate_predictions(p, q, target_kind="known_probability")}
        )
    control.append(
        {
            "predictor": "Constant observed balanced (AUROC=.5)",
            **evaluate_predictions(
                np.full(100, 0.5), np.tile([0, 1], 50), target_kind="real_event"
            ),
        }
    )
    pd.DataFrame(control).to_csv(output / "controlled_predictors.csv", index=False)
    evidence = {
        "independent_customer_count": "unknown; customer IDs unavailable",
        "distinct_source_records_with_predictions": int(
            (records.row_id.notna() & checks.response_present).sum()
        ),
        "real_calibration_records": int(records.partition.eq("calibration").sum()),
        "real_exploratory_test_records": int(records.partition.eq("test").sum()),
        "synthetic_event_definitions": synth.underlying_event.nunique(),
        "synthetic_generating_configurations": synth.uncertainty_group.nunique(),
        "synthetic_prompt_variants": len(synth),
        "repeated_api_calls_per_identical_prompt": 0,
        "question_outputs_per_successful_api_call": 3,
        "historical_mc_repetitions": 500,
        "historical_mc_trials_per_repetition": 2000,
        "additional_model_evaluations_from_mc": 0,
        **coverage,
    }
    (output / "evidence_counts.json").write_text(json.dumps(evidence, indent=2) + "\n")
    if any(digest(root / path) != sha for path, sha in source_hashes.items()):
        raise RuntimeError("Historical input changed during analysis.")
    metadata = {
        "status": "exploratory; all source results already inspected",
        "source": str(source),
        "n_bootstrap": n_boot,
        "seed": SEED,
        "historical_sha256": source_hashes,
        "settings": {
            "bin_strategies": ["equal_width", "equal_mass"],
            "bin_counts": [5, 10, 20],
            "bank_block_length": 10,
            "bank_block_sensitivity": [5, 10, 20],
            "calibrator_l2": 1.0,
            "calibrator_selection": "none; fixed settings",
        },
        "full_population_model_results": "unavailable without additional predictions",
        "new_inference_calls": 0,
        "code_sha256": {
            str(p.relative_to(root)): digest(p)
            for p in [
                root / "src/jev_research/revised_analysis.py",
                root / "src/jev_research/evaluation.py",
                root / "src/jev_research/population.py",
            ]
        },
    }
    (output / "analysis_manifest.json").write_text(json.dumps(metadata, indent=2) + "\n")
    for document in ["confirmatory-protocol.md", "methodology-audit.md"]:
        (output / document).write_bytes((root / document).read_bytes())
    (output / "protocol_sha256.txt").write_text(digest(root / "confirmatory-protocol.md") + "\n")
    write_summary(output)
    return output


def write_summary(output):
    metrics = pd.read_csv(output / "metrics.csv")
    paired = pd.read_csv(output / "paired_comparisons.csv")
    text = "# Revised exploratory calibration results\n\n"
    text += (
        "All scores reuse already-inspected predictions. No paid inference was launched. "
        "The original notebook is preserved alongside historical artifact checksums. "
        "Real-data results describe the historical filtered population only; the full-population "
        "audit is not a replacement evaluation. No reshuffle is independent confirmation.\n\n"
    )
    text += "## Known-probability recovery\n\n" + markdown_table(
        metrics[metrics.target_kind.eq("known_probability")][
            [
                "condition",
                "method",
                "n_valid",
                "resampling_groups",
                "probability_mae",
                "probability_mae_low",
                "probability_mae_high",
                "excess_expected_brier",
                "brier",
            ]
        ]
    )
    text += (
        "\n\nBrier here is exact expected outcome Brier, including q(1-q). "
        "Probability MAE and excess expected Brier isolate recovery error. "
        "Intervals resample generating configurations; dice has one configuration and "
        "therefore no estimable population interval. The finite grid point scores are exact.\n\n"
    )
    text += "## Real-event forecasting: matched filtered pilot records\n\n" + markdown_table(
        metrics[metrics.target_kind.eq("real_event")][
            [
                "condition",
                "method",
                "n_valid",
                "coverage",
                "brier",
                "brier_low",
                "brier_high",
                "log_loss",
                "ece10",
                "auroc",
                "average_precision",
            ]
        ]
    )
    text += "\n\n## Paired comparisons\n\n" + markdown_table(paired)
    text += (
        "\n\nNegative deltas favor the first named method. Fixed-calibrator intervals "
        "condition on the fitted correction; refit intervals independently resample calibration "
        "and test partitions and refit on calibration only. Baseline training and model/prompt "
        "uncertainty remain conditional. Bank uses moving blocks of adjacent sampled records "
        "(10 primary; 5/20 sensitivity), which approximate local dependence but cannot recreate "
        "missing customer identities, complete timelines, or dependence across split boundaries. "
        "Other datasets use feature-identity groups as a proxy; different-feature rows may still "
        "share a customer. Synthetic clusters are deliberately conservative.\n\n"
    )
    text += (
        "## Calibration and coverage diagnostics\n\n"
        "`ece_sensitivity.csv` reports predeclared width/mass × 5/10/20 estimates and intervals; "
        "`reliability_bins.csv` includes counts and fixed-bin group/block uncertainty. "
        "Tied predictions stay together. Sparse bins and few groups limit uncertainty estimates. "
        "Bootstrap intervals do not remove ECE estimation bias. "
        "[Roelofs et al.](https://proceedings.mlr.press/v151/roelofs22a.html) and "
        "[Vaicenavicius et al.](https://proceedings.mlr.press/v89/vaicenavicius19a.html) "
        "explain why calibration estimates depend on the estimator and evaluation setting.\n\n"
        "Answer-confidence rows use a frozen binary answer (positive at p ≥ .5), confidence "
        "max(p,1-p), and answer correctness. They are derived diagnostics, not separately "
        "elicited answer-confidence evidence. Event p is never scored against argmax correctness.\n\n"
        "See `validation_checks.csv`, `prediction_coverage.csv`, `evidence_counts.json`, "
        "`population_summary.csv`, and `split_audit.csv` for validation and denominators. "
        "Noul complement coherence and sums across separate dice queries are diagnostic; "
        "binary event scores are not silently normalized. Selected saved response fields "
        "cannot establish validation of unavailable raw responses.\n\n"
        "## New data required\n\n"
        "Full-population predictions, independent customer/source identity, untouched temporal "
        "and domain cohorts, held-out synthetic templates, and a separate frozen answer bank "
        "are still required. See `../../confirmatory-protocol.md` and "
        "`../../methodology-audit.md`.\n"
    )
    (output / "results.md").write_text(text)
