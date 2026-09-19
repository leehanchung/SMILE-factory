"""Known-probability scenarios and conditional Monte Carlo diagnostics."""

import numpy as np
import pandas as pd
from scipy import stats
from scipy.special import xlogy


def scenarios() -> list[dict]:
    cases = []

    def add(family, track, state, event, opposite, q, true_key="event", false_key="not_event"):
        cases.append(
            dict(
                scenario_id=f"{family}-{track}-{len(cases):03d}",
                family=family,
                track=track,
                state=state,
                event=event,
                opposite=opposite,
                q=float(q),
                true_key=true_key,
                false_key=false_key,
            )
        )

    for p in [0, 0.01, 0.05, 0.1, 0.2, 0.4, 0.49, 0.5, 0.51, 0.6, 0.8, 0.9, 0.95, 0.99, 1]:
        add(
            "bernoulli",
            "explicit",
            f"A coin comes up heads {100 * p:g}% of the time and tails {100 * (1 - p):g}% "
            "of the time. Flips are independent. The next flip has not happened.",
            "The next coin flip comes up heads.",
            "The next coin flip comes up tails.",
            p,
            "heads",
            "tails",
        )
    families = [
        ("uniform", stats.uniform(0, 1), [0.1, 0.5, 0.9], "Uniform(0, 1)"),
        ("normal", stats.norm(0, 1), [-1, 0, 1], "Normal with mean 0 and standard deviation 1"),
        ("exponential", stats.expon(scale=1), [0.1, 0.7, 3], "Exponential with rate 1"),
        ("poisson", stats.poisson(2), [0, 2, 5], "Poisson with mean 2"),
        (
            "binomial",
            stats.binom(10, 0.3),
            [0, 3, 7],
            "Binomial with 10 trials and success probability 0.3",
        ),
        (
            "student_t",
            stats.t(3),
            [-2, 0, 2],
            "Student-t with 3 degrees of freedom, location 0 and scale 1",
        ),
        (
            "lognormal",
            stats.lognorm(s=1, scale=1),
            [0.2, 1, 5],
            "Lognormal with log-location 0 and log-scale 1",
        ),
    ]
    for family, distribution, thresholds, description in families:
        for threshold in thresholds:
            q = distribution.cdf(threshold)
            state = f"X is a fresh random draw from {description}. The draw has not happened."
            event = f"The next draw X is less than or equal to {threshold:g}."
            opposite = f"The next draw X is greater than {threshold:g}."
            add(family, "parameters", state, event, opposite, q)
            add(
                family,
                "explicit",
                state + f" The probability that X <= {threshold:g} is {q:.12g}.",
                event,
                opposite,
                q,
            )
    for threshold in [-2, 0, 2]:
        q = 0.5 * stats.norm(-2, 1).cdf(threshold) + 0.5 * stats.norm(2, 1).cdf(threshold)
        state = (
            "Choose one of two normal components with equal probability, then draw X. "
            "Their means are -2 and 2; both standard deviations are 1. The draw has not happened."
        )
        event = f"The next draw X is less than or equal to {threshold}."
        opposite = f"The next draw X is greater than {threshold}."
        add("normal_mixture", "parameters", state, event, opposite, q)
        add(
            "normal_mixture",
            "explicit",
            state + f" P(X <= {threshold}) = {q:.12g}.",
            event,
            opposite,
            q,
        )
    return cases


def evaluate(rows: list[dict], *, trials: int = 2000, repetitions: int = 500, seed: int = 42):
    """MC ranges are conditional on the fixed scenarios and cached predictions."""
    if not rows:
        return pd.DataFrame(), pd.DataFrame(), pd.DataFrame()
    if trials < 1 or repetitions < 2:
        raise ValueError("Use positive trials and at least two repetitions.")
    frame = pd.DataFrame(rows)
    q = frame.q.to_numpy(float)
    rng = np.random.default_rng(seed)
    counts = rng.binomial(trials, q, size=(repetitions, len(q)))
    details, summaries, reliability = [], [], []
    for primitive in ["choice", "noul"]:
        p = frame[f"{primitive}_p"].to_numpy(float)
        if not (np.isfinite(p).all() and ((0 <= p) & (p <= 1)).all()):
            raise ValueError("Probabilities must be finite and in [0, 1].")
        # xlogy(0, 0)=0; genuinely impossible predictions incur infinite log loss.
        expected_nll = -xlogy(q, p) - xlogy(1 - q, 1 - p)
        expected_brier = (p - q) ** 2 + q * (1 - q)
        observed_rates = counts / trials
        sampled_nll = -xlogy(observed_rates, p) - xlogy(1 - observed_rates, 1 - p)
        sampled_brier = observed_rates * (1 - p) ** 2 + (1 - observed_rates) * p**2
        eps = 1e-12
        clipped = np.clip(p, eps, 1 - eps)
        detail = frame[["scenario_id", "family", "track", "q"]].copy()
        detail["primitive"] = primitive
        detail["p"] = p
        detail["absolute_probability_error"] = abs(p - q)
        detail["expected_brier"] = expected_brier
        detail["expected_nll"] = expected_nll
        detail["clipped_expected_nll_eps_1e12"] = -xlogy(q, clipped) - xlogy(1 - q, 1 - clipped)
        detail["oracle_expected_brier"] = q * (1 - q)
        detail["oracle_expected_nll"] = -xlogy(q, q) - xlogy(1 - q, 1 - q)
        detail["mc_mean_event_rate"] = observed_rates.mean(axis=0)
        details.append(detail)
        for track in frame.track.unique():
            mask = (frame.track == track).to_numpy()
            replicate_brier = sampled_brier[:, mask].mean(axis=1)
            summaries.append(
                {
                    "primitive": primitive,
                    "track": track,
                    "scenarios": int(mask.sum()),
                    "probability_mae": float(abs(p[mask] - q[mask]).mean()),
                    "expected_brier": float(expected_brier[mask].mean()),
                    "expected_nll": float(expected_nll[mask].mean()),
                    "infinite_nll_scenarios": int(np.isinf(expected_nll[mask]).sum()),
                    "mc_brier_mean": float(replicate_brier.mean()),
                    "mc_brier_mean_se": float(replicate_brier.std(ddof=1) / np.sqrt(repetitions)),
                    "mc_brier_p025": float(np.quantile(replicate_brier, 0.025)),
                    "mc_brier_p975": float(np.quantile(replicate_brier, 0.975)),
                    "mc_nll_mean": float(sampled_nll[:, mask].mean()),
                }
            )
            bins = np.minimum((p * 10).astype(int), 9)
            oracle_ece = 0.0
            mc_ece = np.zeros(repetitions)
            for bin_id in range(10):
                selected = mask & (bins == bin_id)
                if not selected.any():
                    continue
                rates = observed_rates[:, selected].mean(axis=1)
                weight = selected.sum() / mask.sum()
                oracle_ece += weight * abs(p[selected].mean() - q[selected].mean())
                mc_ece += weight * abs(p[selected].mean() - rates)
                reliability.append(
                    {
                        "primitive": primitive,
                        "track": track,
                        "bin": bin_id,
                        "scenarios": int(selected.sum()),
                        "mean_prediction": float(p[selected].mean()),
                        "oracle_event_rate": float(q[selected].mean()),
                        "mc_event_rate": float(rates.mean()),
                        "mc_p025": float(np.quantile(rates, 0.025)),
                        "mc_p975": float(np.quantile(rates, 0.975)),
                    }
                )
            summaries[-1]["oracle_binned_ece_10"] = float(oracle_ece)
            summaries[-1]["mc_ece_mean_10"] = float(mc_ece.mean())
    return pd.concat(details, ignore_index=True), pd.DataFrame(summaries), pd.DataFrame(reliability)
