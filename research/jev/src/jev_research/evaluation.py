"""Target-specific probability evaluation for the exploratory calibration audit.

The three targets are intentionally explicit. ``real_event`` takes an event
indicator y, never correctness of an argmax label. ``answer_confidence`` takes
correctness of the answer actually chosen and the confidence assigned to that
answer. ``known_probability`` takes exact q and integrates over Y | q; outcome
simulations are unnecessary for its probability-recovery estimands.

Bootstrap intervals describe sampling variation under the supplied row/group/
moving-block assumptions. They do not remove finite-sample ECE bias. No function
in this module selects methods, regularization, bins, or prompts on test data.
"""

from dataclasses import dataclass
from typing import Literal

import numpy as np
from scipy.optimize import minimize
from scipy.special import expit, logit, xlog1py, xlogy
from scipy.stats import norm
from sklearn.metrics import average_precision_score, roc_auc_score

TargetKind = Literal["known_probability", "real_event", "answer_confidence"]
TARGET_KINDS = {"known_probability", "real_event", "answer_confidence"}
BIN_SPECIFICATIONS = tuple(
    (strategy, n_bins) for strategy in ("equal_width", "equal_mass") for n_bins in (5, 10, 20)
)
CALIBRATOR_LOGIT_EPS = 1e-6


def _vector(values, name):
    result = np.asarray(values, dtype=float)
    if result.ndim != 1:
        raise ValueError(f"{name} must be a one-dimensional array")
    return result


def valid_probability_mask(p):
    """True for finite [0, 1] probabilities; never silently clip input scores."""
    p = _vector(p, "probabilities")
    return np.isfinite(p) & (p >= 0) & (p <= 1)


def validate_probabilities(p, *, normalized=False, atol=1e-6):
    """Validate probabilities, optionally requiring each categorical row sum 1.

    Missing/invalid predictions raise here. Evaluation functions instead expose
    them as failures in the denominator and score only valid predictions.
    Independent Bernoulli event probabilities need not normalize across events.
    """
    p = np.asarray(p, dtype=float)
    if p.ndim not in (1, 2) or not np.all(np.isfinite(p) & (p >= 0) & (p <= 1)):
        raise ValueError("probabilities must be finite and within [0, 1]")
    if normalized and not np.all(np.isclose(p.sum(axis=-1), 1, atol=atol, rtol=0)):
        raise ValueError("categorical probabilities must sum to one")
    return p


def align_probabilities(probabilities, labels, expected_labels, *, normalized=True):
    """Validate labels and return categorical columns in a declared label order."""
    labels, expected_labels = list(labels), list(expected_labels)
    if len(set(labels)) != len(labels) or len(set(expected_labels)) != len(expected_labels):
        raise ValueError("labels must be unique")
    if set(labels) != set(expected_labels):
        raise ValueError("prediction labels do not match the declared label set")
    p = validate_probabilities(probabilities, normalized=normalized)
    if p.shape[-1] != len(labels):
        raise ValueError("probability columns and labels have different lengths")
    return p[..., [labels.index(label) for label in expected_labels]]


def complement_diagnostic(p_event, p_complement, *, tolerance=1e-6):
    """Diagnose separately requested complements without excluding an event score.

    An independently elicited Noul complement is a coherence diagnostic. A
    categorical distribution, in contrast, must pass normalization validation.
    """
    a, b = _vector(p_event, "p_event"), _vector(p_complement, "p_complement")
    if len(a) != len(b):
        raise ValueError("complement arrays must have equal lengths")
    valid = valid_probability_mask(a) & valid_probability_mask(b)
    errors = np.abs(a[valid] + b[valid] - 1)
    return {
        "n_pairs": len(a),
        "n_valid_pairs": int(valid.sum()),
        "n_incoherent": int((errors > tolerance).sum()),
        "mean_absolute_complement_error": float(errors.mean()) if len(errors) else np.nan,
        "max_absolute_complement_error": float(errors.max()) if len(errors) else np.nan,
        "tolerance": tolerance,
    }


def chosen_answer_targets(confidence, chosen_labels, gold_labels):
    """Construct answer-confidence inputs explicitly from the chosen answer.

    Confidence must already refer to the chosen answer. This function never
    changes an event probability into chosen-answer confidence implicitly.
    """
    confidence = _vector(confidence, "confidence")
    chosen, gold = np.asarray(chosen_labels), np.asarray(gold_labels)
    if chosen.ndim != 1 or gold.ndim != 1 or len(confidence) != len(chosen):
        raise ValueError("confidence and label vectors must have equal lengths")
    if len(chosen) != len(gold):
        raise ValueError("chosen and gold label vectors must have equal lengths")
    if any(
        label is None or (isinstance(label, float) and np.isnan(label))
        for label in [*chosen, *gold]
    ):
        raise ValueError("missing chosen or gold labels")
    return confidence, (chosen == gold).astype(float)


def _inputs(p, target, target_kind):
    if target_kind not in TARGET_KINDS:
        raise ValueError(f"target_kind must be one of {sorted(TARGET_KINDS)}")
    p, target = _vector(p, "probabilities"), _vector(target, "target")
    if len(p) != len(target):
        raise ValueError("probabilities and targets must have equal lengths")
    if not valid_probability_mask(target).all():
        raise ValueError("targets must be finite and within [0, 1]")
    if target_kind != "known_probability" and not np.isin(target, [0, 1]).all():
        raise ValueError("observed event/correctness targets must be binary 0 or 1")
    return p, target, valid_probability_mask(p)


def _losses(p, target, target_kind):
    # xlogy(0, 0)=0: correct deterministic predictions score zero, impossible
    # outcomes retain true infinite log loss. No evaluator clipping is applied.
    with np.errstate(divide="ignore", invalid="ignore"):
        log_loss = -xlogy(target, p) - xlog1py(1 - target, -p)
    excess = (p - target) ** 2
    irreducible = target * (1 - target) if target_kind == "known_probability" else 0
    return excess + irreducible, log_loss


def _bin_ids(p, n_bins, strategy):
    if not isinstance(n_bins, int) or n_bins < 1:
        raise ValueError("n_bins must be a positive integer")
    if strategy == "equal_width":
        edges = np.linspace(0, 1, n_bins + 1)
        # Preserve the historical ECE10 rule. Searching floating-point edges
        # would incorrectly put .3 below np.linspace's .30000000000000004.
        ids = np.minimum((p * n_bins).astype(int), n_bins - 1)
    elif strategy == "equal_mass":
        # Observed quantile edges, deduplicated, keep every tied prediction in
        # one bin. Occupied bins can be fewer than requested, even just one.
        inner = np.quantile(p, np.arange(1, n_bins) / n_bins) if len(p) else []
        edges = np.unique(np.r_[0.0, inner, 1.0])
    else:
        raise ValueError("strategy must be equal_width or equal_mass")
    if strategy == "equal_mass":
        ids = np.searchsorted(edges[1:-1], p, side="right")
    return ids, edges


def reliability_bins(p, target, *, n_bins=10, strategy="equal_width", target_kind="real_event"):
    """Return all bins, including empty bins, with declared tie handling.

    Observed-rate Wilson intervals are descriptive and assume independent
    Bernoulli rows; use a group/block bootstrap for dependent records. Exact q
    has no outcome sampling uncertainty, so its binomial interval is undefined.
    """
    p, target, valid = _inputs(p, target, target_kind)
    p, target = p[valid], target[valid]
    ids, edges = _bin_ids(p, n_bins, strategy)
    z = norm.ppf(0.975)
    rows = []
    for b in range(len(edges) - 1):
        in_bin = ids == b
        n = int(in_bin.sum())
        forecast = float(p[in_bin].mean()) if n else np.nan
        rate = float(target[in_bin].mean()) if n else np.nan
        lo, hi = np.nan, np.nan
        if n and target_kind != "known_probability":
            denominator = 1 + z**2 / n
            center = (rate + z**2 / (2 * n)) / denominator
            radius = z * np.sqrt(rate * (1 - rate) / n + z**2 / (4 * n**2)) / denominator
            lo, hi = max(0.0, center - radius), min(1.0, center + radius)
        rows.append(
            {
                "bin": b,
                "strategy": strategy,
                "requested_bins": n_bins,
                "realized_bins": len(edges) - 1,
                "occupied_bins": len(np.unique(ids)),
                "lower": float(edges[b]),
                "upper": float(edges[b + 1]),
                "n": n,
                "mean_prediction": forecast,
                "mean_target": rate,
                "gap": forecast - rate,
                "rate_ci_low": lo,
                "rate_ci_high": hi,
                "rate_interval_method": (
                    "none_exact_q" if target_kind == "known_probability" else "wilson_iid_rows"
                ),
                "ties": "identical_predictions_never_split",
            }
        )
    return rows


def calibration_sensitivity(p, target, *, target_kind="real_event"):
    """Predeclared width/mass x 5/10/20-bin diagnostics; no best-bin selection."""
    rows = []
    for strategy, n_bins in BIN_SPECIFICATIONS:
        bins = reliability_bins(
            p, target, n_bins=n_bins, strategy=strategy, target_kind=target_kind
        )
        nonempty = [b for b in bins if b["n"]]
        n = sum(b["n"] for b in nonempty)
        ece = sum(b["n"] * abs(b["gap"]) for b in nonempty) / n if n else np.nan
        rows.append(
            {
                "strategy": strategy,
                "n_bins": n_bins,
                "occupied_bins": len(nonempty),
                "n": n,
                "ece": ece,
            }
        )
    return rows


def evaluate_predictions(p, target, *, target_kind="real_event", n_requested=None):
    """Score the explicit target and expose missing/invalid prediction coverage.

    Keep missing predictions as NaN rows whenever possible. ``n_requested`` can
    additionally account for absent cache rows, but those failures cannot enter
    resampling without a record-level request manifest. Coverage is separate
    from loss: failed predictions are never assigned an invented probability.
    """
    p, target, valid = _inputs(p, target, target_kind)
    n_requested = len(p) if n_requested is None else n_requested
    if not isinstance(n_requested, (int, np.integer)) or n_requested < len(p):
        raise ValueError("n_requested must be an integer at least the number of records")
    result = {
        "target_kind": target_kind,
        "n_requested": int(n_requested),
        "n_records": len(p),
        "n_valid": int(valid.sum()),
        "n_missing": int(np.isnan(p).sum()) + n_requested - len(p),
        "n_invalid": int((~valid & ~np.isnan(p)).sum()),
        "coverage": float(valid.sum() / n_requested) if n_requested else np.nan,
        "brier": np.nan,
        "log_loss": np.nan,
        "ece10": np.nan,
        "auroc": np.nan,
        "average_precision": np.nan,
        "mean_prediction": np.nan,
        "mean_target": np.nan,
        "signed_error": np.nan,
        "n_infinite_log_loss": 0,
    }
    if target_kind == "known_probability":
        result.update(
            probability_mae=np.nan,
            excess_expected_brier=np.nan,
            irreducible_brier=np.nan,
            expected_brier=np.nan,
            expected_log_loss=np.nan,
        )
    elif target_kind == "real_event":
        result["threshold_accuracy"] = np.nan
    else:
        result["answer_accuracy"] = np.nan
    if not valid.any():
        return result
    p, target = p[valid], target[valid]
    brier, log_loss = _losses(p, target, target_kind)
    bins = reliability_bins(p, target, target_kind=target_kind)
    result.update(
        brier=float(brier.mean()),
        log_loss=float(log_loss.mean()),
        ece10=sum(b["n"] * abs(b["gap"]) for b in bins if b["n"]) / len(p),
        mean_prediction=float(p.mean()),
        mean_target=float(target.mean()),
        signed_error=float(np.mean(p - target)),
        n_infinite_log_loss=int(np.isinf(log_loss).sum()),
    )
    if target_kind == "known_probability":
        result.update(
            probability_mae=float(np.abs(p - target).mean()),
            excess_expected_brier=float(np.mean((p - target) ** 2)),
            irreducible_brier=float(np.mean(target * (1 - target))),
            expected_brier=float(brier.mean()),
            expected_log_loss=float(log_loss.mean()),
        )
    else:
        if len(np.unique(target)) == 2:
            result["auroc"] = float(roc_auc_score(target, p))
            result["average_precision"] = float(average_precision_score(target, p))
        if target_kind == "real_event":
            result["threshold_accuracy"] = float(((p >= 0.5) == target).mean())
        else:
            result["answer_accuracy"] = float(target.mean())
    return result


def _group_members(groups, n):
    groups = np.asarray(groups, dtype=object)
    if groups.ndim != 1 or len(groups) != n:
        raise ValueError("groups must have one nonmissing identifier per record")
    members = {}
    for i, group in enumerate(groups):
        if group is None or (isinstance(group, float) and np.isnan(group)):
            raise ValueError("groups cannot be missing")
        members.setdefault(group, []).append(i)
    return [np.array(indices, dtype=int) for indices in members.values()]


def bootstrap_indices(n, rng, *, groups=None, block_length=None):
    """Draw one row, whole-group, or noncircular moving-block bootstrap sample.

    Whole-group sampling draws G groups with replacement and keeps all members;
    unequal group sizes thus give variable row counts. Moving blocks require
    chronologically ordered input and assume local stationarity at the chosen
    block length. They do not repair temporal/domain shift or identify repeated
    customers. Group and block strategies are mutually exclusive.
    """
    if not isinstance(n, (int, np.integer)) or n < 1:
        raise ValueError("n must be a positive integer")
    if groups is not None and block_length is not None:
        raise ValueError("choose either groups or moving blocks")
    if groups is not None:
        members = _group_members(groups, n)
        return np.concatenate([members[i] for i in rng.integers(0, len(members), len(members))])
    if block_length is not None:
        if not isinstance(block_length, (int, np.integer)) or not 1 <= block_length <= n:
            raise ValueError("block_length must be an integer in [1, n]")
        starts = rng.integers(0, n - block_length + 1, int(np.ceil(n / block_length)))
        return np.concatenate([np.arange(s, s + block_length) for s in starts])[:n]
    return rng.integers(0, n, n)


def _resampling_units(n, groups=None, block_length=None):
    if groups is not None and block_length is not None:
        raise ValueError("choose either groups or moving blocks")
    if groups is not None:
        return len(_group_members(groups, n))
    if block_length is not None:
        if not isinstance(block_length, (int, np.integer)) or not 1 <= block_length <= n:
            raise ValueError("block_length must be an integer in [1, n]")
        return n // block_length
    return n


def percentile_interval(samples, *, confidence=0.95):
    """Empirical percentile interval with explicit undefined/infinite handling.

    Order-statistic quantiles avoid interpolating ``inf - inf``. Undefined NaN
    replicates (e.g. one-class AUROC or inf-minus-inf) are excluded and counted;
    an infinite loss remains infinite, never silently discarded as a failure.
    """
    if not 0 < confidence < 1:
        raise ValueError("confidence must lie strictly between 0 and 1")
    values = np.asarray(samples, dtype=float)
    values = values[~np.isnan(values)]
    lo, hi = np.nan, np.nan
    if len(values):
        lo, hi = np.quantile(
            values, [(1 - confidence) / 2, (1 + confidence) / 2], method="inverted_cdf"
        )
    return {"ci_low": float(lo), "ci_high": float(hi), "n_boot_valid": len(values)}


def _score(p, target, target_kind, metric):
    if (
        metric
        in {"expected_brier", "expected_log_loss", "probability_mae", "excess_expected_brier"}
        and target_kind != "known_probability"
    ):
        raise ValueError(f"{metric} requires known_probability targets")
    valid = valid_probability_mask(p)
    p, target = p[valid], target[valid]
    if not len(p):
        return np.nan
    if metric in ("brier", "expected_brier", "log_loss", "expected_log_loss"):
        return float(_losses(p, target, target_kind)[int("log_loss" in metric)].mean())
    if metric == "probability_mae":
        return float(np.abs(p - target).mean())
    if metric == "excess_expected_brier":
        return float(np.mean((p - target) ** 2))
    return evaluate_predictions(p, target, target_kind=target_kind)[metric]


def bootstrap_comparison(
    p_a,
    p_b,
    target,
    *,
    target_kind="real_event",
    metric="brier",
    groups=None,
    block_length=None,
    n_boot=1000,
    seed=20260922,
):
    """Paired A-minus-B interval on jointly valid predictions only.

    Resample the full eligible manifest before masking, retaining group/time
    structure of failures. Both methods use exactly the same sampled records.
    The estimand is conditional on joint success; coverage is reported apart.
    """
    a, target, va = _inputs(p_a, target, target_kind)
    b, _, vb = _inputs(p_b, target, target_kind)
    valid = va & vb
    a, b = np.where(valid, a, np.nan), np.where(valid, b, np.nan)
    with np.errstate(invalid="ignore"):
        point = _score(a, target, target_kind, metric) - _score(b, target, target_kind, metric)
    units = _resampling_units(len(a), groups, block_length)
    matched_units = (
        _resampling_units(int(valid.sum()), np.asarray(groups, dtype=object)[valid])
        if groups is not None
        else min(units, int(valid.sum()))
    )
    rng = np.random.default_rng(seed)
    samples = []
    if matched_units >= 2:
        for _ in range(n_boot):
            idx = bootstrap_indices(len(a), rng, groups=groups, block_length=block_length)
            with np.errstate(invalid="ignore"):
                samples.append(
                    _score(a[idx], target[idx], target_kind, metric)
                    - _score(b[idx], target[idx], target_kind, metric)
                )
    return {
        "difference": point,
        "direction": "A_minus_B",
        "metric": metric,
        "n_matched": int(valid.sum()),
        "n_requested": len(a),
        "paired_coverage": float(valid.mean()) if len(a) else np.nan,
        "resampling_units": units,
        "matched_resampling_units": matched_units,
        "n_boot": n_boot,
        "uncertainty": "fixed_predictions",
        **percentile_interval(samples),
    }


@dataclass(frozen=True)
class Calibrator:
    """Logistic recalibrator, fit exclusively on a designated calibration set."""

    method: str
    intercept: float
    slope: float
    l2: float
    n_fit: int
    converged: bool
    hit_boundary: bool = False
    n_positive: int = 0
    n_negative: int = 0

    def predict(self, p):
        p = _vector(p, "probabilities")
        if self.method == "raw":
            return p.copy()
        valid = valid_probability_mask(p)
        result = np.full_like(p, np.nan)
        logits = logit(np.clip(p[valid], CALIBRATOR_LOGIT_EPS, 1 - CALIBRATOR_LOGIT_EPS))
        result[valid] = expit(self.intercept + self.slope * logits)
        return result


def fit_calibrator(p, y, *, method="intercept_slope", l2=1.0):
    """Fit raw, intercept-only, or regularized intercept-plus-slope correction.

    Intercept-only minimizes sum Bernoulli NLL with slope fixed to 1.
    Intercept+slope minimizes sum NLL + l2/2 * (a**2 + (b-1)**2), shrinking
    toward identity. Settings are fixed a priori, not chosen by this function.
    Numerical safeguards: logits clip to [1e-6, 1-1e-6], a is in [-20,20],
    and slope b in [0,10]. Nonnegative slope cannot reverse rankings. Boundary
    and convergence flags expose degenerate fits, especially rare-event data.
    Raw scoring uses original probabilities, without evaluator clipping.
    """
    p, y, valid = _inputs(p, y, "real_event")
    if method not in {"raw", "intercept", "intercept_slope"}:
        raise ValueError("unknown recalibration method")
    if not np.isfinite(l2) or l2 < 0:
        raise ValueError("l2 must be finite and nonnegative")
    if not valid.any():
        raise ValueError("calibration requires at least one valid prediction")
    p, y = p[valid], y[valid]
    label_counts = {"n_positive": int(y.sum()), "n_negative": int((1 - y).sum())}
    if method == "raw":
        return Calibrator(method, 0.0, 1.0, 0.0, len(p), True, **label_counts)
    logits = logit(np.clip(p, CALIBRATOR_LOGIT_EPS, 1 - CALIBRATOR_LOGIT_EPS))

    def objective(theta):
        a, b = theta[0], theta[1] if method == "intercept_slope" else 1.0
        z = a + b * logits
        residual = expit(z) - y
        loss = np.sum(np.logaddexp(0, z) - y * z)
        gradient = [residual.sum()]
        if method == "intercept_slope":
            loss += l2 / 2 * (a**2 + (b - 1) ** 2)
            gradient = [gradient[0] + l2 * a, np.dot(residual, logits) + l2 * (b - 1)]
        return float(loss), np.asarray(gradient)

    bounds = [(-20.0, 20.0)] + ([(0.0, 10.0)] if method == "intercept_slope" else [])
    initial = [0.0, 1.0] if method == "intercept_slope" else [0.0]
    solution = minimize(objective, initial, jac=True, bounds=bounds, method="L-BFGS-B")
    a, b = solution.x[0], solution.x[1] if method == "intercept_slope" else 1.0
    boundary = any(
        np.isclose(value, lo) or np.isclose(value, hi)
        for value, (lo, hi) in zip(solution.x, bounds, strict=True)
    )
    return Calibrator(
        method, float(a), float(b), l2, len(p), bool(solution.success), boundary, **label_counts
    )


def transform_calibrator(calibrator, p):
    """Functional alias for callers that store the fitted calibrator separately."""
    return calibrator.predict(p)


def bootstrap_calibration_comparison(
    calibration_p,
    calibration_y,
    test_p,
    test_y,
    *,
    method="intercept_slope",
    l2=1.0,
    metric="brier",
    refit=False,
    calibration_groups=None,
    test_groups=None,
    calibration_block_length=None,
    test_block_length=None,
    n_boot=1000,
    seed=20260922,
):
    """Corrected-minus-raw uncertainty conditional on or refitting calibrators.

    ``refit=False`` holds the fitted calibrator fixed and resamples test data.
    ``refit=True`` independently resamples calibration and test data, refitting
    on each calibration draw. This assumes the two populations are independent
    at the sampling unit, and no groups overlap their split. It does not include
    model fitting, prompt selection, or API-call variability. Callers must
    establish split disjointness from manifests before invoking this function.
    """
    cp, cy, cal_valid = _inputs(calibration_p, calibration_y, "real_event")
    tp, ty, valid = _inputs(test_p, test_y, "real_event")
    calibrator = fit_calibrator(cp, cy, method=method, l2=l2)
    with np.errstate(invalid="ignore"):
        point = (
            _score(calibrator.predict(tp), ty, "real_event", metric)
            - _score(tp, ty, "real_event", metric)
            if calibrator.converged
            else np.nan
        )
    test_units = _resampling_units(len(tp), test_groups, test_block_length)
    cal_units = _resampling_units(len(cp), calibration_groups, calibration_block_length)
    matched_test_units = (
        _resampling_units(int(valid.sum()), np.asarray(test_groups, dtype=object)[valid])
        if test_groups is not None
        else min(test_units, int(valid.sum()))
    )
    matched_cal_units = (
        _resampling_units(
            int(cal_valid.sum()), np.asarray(calibration_groups, dtype=object)[cal_valid]
        )
        if calibration_groups is not None
        else min(cal_units, int(cal_valid.sum()))
    )
    rng = np.random.default_rng(seed)
    samples, fit_failures, boundary_refits, one_class_refits = [], 0, 0, 0
    if calibrator.converged and matched_test_units >= 2 and (not refit or matched_cal_units >= 2):
        for _ in range(n_boot):
            fit = calibrator
            if refit:
                ci = bootstrap_indices(
                    len(cp), rng, groups=calibration_groups, block_length=calibration_block_length
                )
                try:
                    fit = fit_calibrator(cp[ci], cy[ci], method=method, l2=l2)
                except ValueError:
                    fit_failures += 1
                    continue
                boundary_refits += int(fit.hit_boundary)
                one_class_refits += int(fit.n_positive == 0 or fit.n_negative == 0)
                if not fit.converged:
                    fit_failures += 1
                    continue
            ti = bootstrap_indices(len(tp), rng, groups=test_groups, block_length=test_block_length)
            with np.errstate(invalid="ignore"):
                samples.append(
                    _score(fit.predict(tp[ti]), ty[ti], "real_event", metric)
                    - _score(tp[ti], ty[ti], "real_event", metric)
                )
    return {
        "difference": point,
        "direction": "corrected_minus_raw",
        "metric": metric,
        "method": method,
        "n_matched": int(valid.sum()),
        "n_requested": len(tp),
        "paired_coverage": float(valid.mean()) if len(tp) else np.nan,
        "calibration_resampling_units": cal_units,
        "test_resampling_units": test_units,
        "matched_calibration_resampling_units": matched_cal_units,
        "matched_test_resampling_units": matched_test_units,
        "n_boot": n_boot,
        "n_fit_failures": fit_failures,
        "n_boundary_refits": boundary_refits,
        "n_one_class_refits": one_class_refits,
        "original_fit_converged": calibrator.converged,
        "original_fit_hit_boundary": calibrator.hit_boundary,
        "original_fit_one_class": calibrator.n_positive == 0 or calibrator.n_negative == 0,
        "uncertainty": "refit_calibrator_and_test" if refit else "fixed_calibrator_test_only",
        **percentile_interval(samples),
    }
