"""Binned Murphy components for binary forecasts or known event probabilities."""

import numpy as np


def decompose(probabilities, event_rates, bins=10):
    """Return components for forecasts replaced by bin means, plus raw-score residual.

    event_rates may be binary labels or known Bernoulli probabilities. The latter
    yields conditional expected scores, not a finite-label calibration estimate.
    """
    p, q = np.asarray(probabilities, dtype=float), np.asarray(event_rates, dtype=float)
    if p.ndim != 1 or q.shape != p.shape or not len(p):
        raise ValueError("Use equally sized nonempty vectors.")
    if type(bins) is not int or bins < 1:
        raise ValueError("bins must be a positive integer.")
    if not (np.isfinite(p).all() and np.isfinite(q).all()):
        raise ValueError("Values must be finite.")
    if not (((p >= 0) & (p <= 1)).all() and ((q >= 0) & (q <= 1)).all()):
        raise ValueError("Values must lie in [0, 1].")
    ids = np.minimum((p * bins).astype(int), bins - 1)
    mean_rate = q.mean()
    uncertainty = mean_rate * (1 - mean_rate)
    reliability = resolution = 0.0
    grouped_p = np.empty_like(p)
    for b in np.unique(ids):
        mask = ids == b
        weight = mask.mean()
        pb, qb = p[mask].mean(), q[mask].mean()
        grouped_p[mask] = pb
        reliability += weight * (pb - qb) ** 2
        resolution += weight * (qb - mean_rate) ** 2
    raw_brier = np.mean(q * (1 - q) + (p - q) ** 2)
    grouped_brier = np.mean(q * (1 - q) + (grouped_p - q) ** 2)
    return {
        "bins": bins,
        "n": len(p),
        "event_rate": float(mean_rate),
        "uncertainty": float(uncertainty),
        "reliability": float(reliability),
        "resolution": float(resolution),
        "normalized_reliability": float(reliability / uncertainty) if uncertainty else None,
        "raw_brier": float(raw_brier),
        "grouped_brier": float(grouped_brier),
        "binning_residual": float(raw_brier - grouped_brier),
    }
