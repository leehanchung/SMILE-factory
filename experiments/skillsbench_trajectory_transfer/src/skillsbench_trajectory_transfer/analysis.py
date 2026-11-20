"""Deterministic paired analysis and reproduction verification."""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
from collections import defaultdict
from collections.abc import Iterable, Sequence
from pathlib import Path
from statistics import NormalDist, fmean
from typing import Any

CHECKPOINTS = ("base", "no_skill", "with_skill")
COMPARISONS = (
    ("with_skill-no_skill", "with_skill", "no_skill"),
    ("no_skill-base", "no_skill", "base"),
    ("with_skill-base", "with_skill", "base"),
)
PRESERVATION_METRICS = (
    "exact_accuracy",
    "unnecessary_tool_call",
    "answer_tokens",
    "hidden_thinking_tokens",
    "turns",
    "latency",
)
DEFAULT_OVERLAP_EXCLUSIONS = (0.0, 0.1, 0.2, 0.3, 0.4, 0.5)


def read_jsonl(path: str | Path) -> list[dict[str, Any]]:
    rows, seen = [], set()
    required = {"benchmark", "task_id", "checkpoint", "score", "overlap_score"}
    with Path(path).open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"Invalid JSON on line {line_number}: {error.msg}") from error
            missing = required - row.keys()
            if missing:
                raise ValueError(f"Line {line_number} is missing: {', '.join(sorted(missing))}")
            if row["checkpoint"] not in CHECKPOINTS:
                raise ValueError(f"Line {line_number} has unknown checkpoint {row['checkpoint']!r}")
            key = (str(row["benchmark"]), str(row["task_id"]), row["checkpoint"])
            if key in seen:
                raise ValueError(
                    f"Duplicate benchmark/task/checkpoint on line {line_number}: {key}"
                )
            seen.add(key)
            normalized = dict(row)
            normalized["benchmark"], normalized["task_id"] = key[:2]
            for field in ("score", "overlap_score", *PRESERVATION_METRICS):
                if field in normalized and normalized[field] is not None:
                    value = (
                        int(normalized[field])
                        if isinstance(normalized[field], bool)
                        else normalized[field]
                    )
                    if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
                        raise ValueError(
                            f"Line {line_number} field {field!r} must be finite numeric"
                        )
                    normalized[field] = float(value)
            rows.append(normalized)
    if not rows:
        raise ValueError("Input contains no rows")
    return rows


def wilson_interval(successes: int, total: int, confidence: float = 0.95) -> list[float] | None:
    if total == 0:
        return None
    z = NormalDist().inv_cdf(0.5 + confidence / 2)
    p = successes / total
    denominator = 1 + z * z / total
    centre = (p + z * z / (2 * total)) / denominator
    radius = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator
    return [max(0.0, centre - radius), min(1.0, centre + radius)]


def _percentile(values: Sequence[float], probability: float) -> float:
    position = probability * (len(values) - 1)
    lower, upper = math.floor(position), math.ceil(position)
    weight = position - lower
    return values[lower] * (1 - weight) + values[upper] * weight


def paired_bootstrap(
    differences: Sequence[float], replicates: int = 10_000, seed: int = 17, confidence: float = 0.95
) -> dict[str, Any]:
    if not differences:
        return {"n_pairs": 0, "delta": None, "ci": None}
    if replicates < 1:
        raise ValueError("replicates must be positive")
    rng, count = random.Random(seed), len(differences)
    samples = sorted(
        fmean(differences[rng.randrange(count)] for _ in range(count)) for _ in range(replicates)
    )
    alpha = (1 - confidence) / 2
    return {
        "n_pairs": count,
        "delta": fmean(differences),
        "ci": [_percentile(samples, alpha), _percentile(samples, 1 - alpha)],
    }


def _indexed(rows: Iterable[dict[str, Any]]) -> dict[tuple[str, str], dict[str, dict[str, Any]]]:
    result: dict[tuple[str, str], dict[str, dict[str, Any]]] = defaultdict(dict)
    for row in rows:
        result[(row["benchmark"], row["task_id"])][row["checkpoint"]] = row
    return dict(result)


def _paired_values(
    indexed: dict[tuple[str, str], dict[str, dict[str, Any]]],
    high: str,
    low: str,
    metric: str,
    benchmark: str | None = None,
) -> list[tuple[tuple[str, str], float, float]]:
    pairs = []
    for key in sorted(indexed):
        conditions = indexed[key]
        if (
            benchmark is not None
            and key[0] != benchmark
            or high not in conditions
            or low not in conditions
        ):
            continue
        high_value, low_value = conditions[high].get(metric), conditions[low].get(metric)
        if high_value is not None and low_value is not None:
            pairs.append(
                (
                    key,
                    high_value - low_value,
                    max(conditions[high]["overlap_score"], conditions[low]["overlap_score"]),
                )
            )
    return pairs


def _derived_group(
    rows: Sequence[dict[str, Any]], name: str, predicate: Any, confidence: float
) -> dict[str, Any] | None:
    selected = [row for row in rows if predicate(row["benchmark"])]
    if not selected:
        return None
    arms = {}
    for checkpoint in CHECKPOINTS:
        values = [row["score"] for row in selected if row["checkpoint"] == checkpoint]
        correct = round(sum(values))
        arms[checkpoint] = {
            "n": len(values),
            "correct": correct,
            "accuracy": fmean(values),
            "wilson_ci": wilson_interval(correct, len(values), confidence),
        }
    return {"group": name, "arms": arms}


def _derived_bfcl(
    rows: Sequence[dict[str, Any]], replicates: int, seed: int, confidence: float
) -> dict[str, Any]:
    """Return the recorded BFCL overall/single-turn/multi-turn paired summaries."""
    predicates = {
        "overall": lambda benchmark: benchmark.startswith("bfcl:"),
        "single_turn": lambda benchmark: (
            benchmark.startswith("bfcl:") and "multi_turn" not in benchmark
        ),
        "multi_turn": lambda benchmark: benchmark.startswith("bfcl:") and "multi_turn" in benchmark,
    }
    result: dict[str, Any] = {}
    for label, predicate in predicates.items():
        selected = [row for row in rows if predicate(row["benchmark"])]
        indexed = _indexed(selected)
        comparisons: dict[str, Any] = {}
        for name, high, low in COMPARISONS:
            pairs = _paired_values(indexed, high, low, "score")
            comparisons[name] = paired_bootstrap(
                [pair[1] for pair in pairs], replicates, seed, confidence
            )
        result[label] = {"n_tasks": len(indexed), "comparisons": comparisons}
    return result


def analyze(
    rows: Sequence[dict[str, Any]],
    replicates: int = 10_000,
    seed: int = 17,
    confidence: float = 0.95,
    overlap_exclusions: Sequence[float] = DEFAULT_OVERLAP_EXCLUSIONS,
) -> dict[str, Any]:
    if not 0 < confidence < 1:
        raise ValueError("confidence must be between zero and one")
    indexed, benchmarks = _indexed(rows), sorted({row["benchmark"] for row in rows})
    aggregates = []
    for benchmark in ["overall", *benchmarks]:
        for checkpoint in CHECKPOINTS:
            values = [
                row["score"]
                for row in rows
                if row["checkpoint"] == checkpoint
                and (benchmark == "overall" or row["benchmark"] == benchmark)
            ]
            if values:
                binary = all(value in (0.0, 1.0) for value in values)
                aggregates.append(
                    {
                        "benchmark": benchmark,
                        "checkpoint": checkpoint,
                        "n": len(values),
                        "mean_score": fmean(values),
                        "wilson_ci": wilson_interval(round(sum(values)), len(values), confidence)
                        if binary
                        else None,
                    }
                )
    comparisons = []
    for benchmark in ["overall", *benchmarks]:
        for name, high, low in COMPARISONS:
            pairs = _paired_values(
                indexed, high, low, "score", None if benchmark == "overall" else benchmark
            )
            result = paired_bootstrap([pair[1] for pair in pairs], replicates, seed, confidence)
            result.update(benchmark=benchmark, comparison=name)
            comparisons.append(result)
    sensitivity = []
    for name, high, low in COMPARISONS:
        ordered = sorted(
            _paired_values(indexed, high, low, "score"), key=lambda pair: (pair[2], pair[0])
        )
        for exclusion in overlap_exclusions:
            if not 0 <= exclusion < 1:
                raise ValueError("overlap exclusions must be in [0, 1)")
            retained = ordered[: math.ceil(len(ordered) * (1 - exclusion))]
            result = paired_bootstrap([pair[1] for pair in retained], replicates, seed, confidence)
            result.update(
                comparison=name,
                excluded_high_overlap_fraction=exclusion,
                max_retained_overlap=retained[-1][2] if retained else None,
            )
            sensitivity.append(result)
    preservation = []
    for metric in PRESERVATION_METRICS:
        for name, high, low in COMPARISONS:
            pairs = _paired_values(indexed, high, low, metric)
            if pairs:
                result = paired_bootstrap([pair[1] for pair in pairs], replicates, seed, confidence)
                result.update(metric=metric, comparison=name)
                preservation.append(result)
    groups = [
        _derived_group(rows, "bfcl_overall", lambda value: value.startswith("bfcl:"), confidence),
        _derived_group(
            rows,
            "bfcl_single",
            lambda value: value.startswith("bfcl:") and "multi_turn" not in value,
            confidence,
        ),
        _derived_group(
            rows,
            "bfcl_multi",
            lambda value: value.startswith("bfcl:") and "multi_turn" in value,
            confidence,
        ),
        _derived_group(rows, "ifeval", lambda value: "ifeval" in value.casefold(), confidence),
        _derived_group(rows, "mmlu", lambda value: "mmlu" in value.casefold(), confidence),
        _derived_group(
            rows, "restraint", lambda value: "restraint" in value.casefold(), confidence
        ),
    ]
    return {
        "method": {
            "unit": "paired benchmark/task_id",
            "bootstrap_replicates": replicates,
            "bootstrap_seed": seed,
            "confidence_level": confidence,
            "inference": "paired task bootstrap; no mixed-effects model fitted",
        },
        "input": {"rows": len(rows), "unique_tasks": len(indexed)},
        "aggregates": aggregates,
        "comparisons": comparisons,
        "overlap_sensitivity": sensitivity,
        "preservation_deltas": preservation,
        "derived_bfcl": _derived_bfcl(rows, replicates, seed, confidence),
        "derived_summaries": [group for group in groups if group],
    }


def write_csv(result: dict[str, Any], path: str | Path) -> None:
    fields = [
        "section",
        "benchmark",
        "checkpoint",
        "comparison",
        "metric",
        "n",
        "estimate",
        "ci_low",
        "ci_high",
        "excluded_high_overlap_fraction",
        "max_retained_overlap",
    ]
    with Path(path).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for item in result["aggregates"]:
            ci = item["wilson_ci"] or [None, None]
            writer.writerow(
                {
                    "section": "aggregate",
                    "benchmark": item["benchmark"],
                    "checkpoint": item["checkpoint"],
                    "n": item["n"],
                    "estimate": item["mean_score"],
                    "ci_low": ci[0],
                    "ci_high": ci[1],
                }
            )
        for section, key in (
            ("comparison", "comparisons"),
            ("overlap_sensitivity", "overlap_sensitivity"),
            ("preservation_delta", "preservation_deltas"),
        ):
            for item in result[key]:
                ci = item["ci"] or [None, None]
                writer.writerow(
                    {
                        "section": section,
                        "benchmark": item.get("benchmark"),
                        "comparison": item["comparison"],
                        "metric": item.get("metric", "score"),
                        "n": item["n_pairs"],
                        "estimate": item["delta"],
                        "ci_low": ci[0],
                        "ci_high": ci[1],
                        "excluded_high_overlap_fraction": item.get(
                            "excluded_high_overlap_fraction"
                        ),
                        "max_retained_overlap": item.get("max_retained_overlap"),
                    }
                )


def compare_results(actual: Any, recorded: Any, tolerance: float = 1e-10) -> dict[str, Any]:
    """Compare every recorded leaf, allowing new fields in the reproduction."""
    mismatches = []
    compared = 0

    def visit(left: Any, right: Any, path: str) -> None:
        nonlocal compared
        if isinstance(right, dict):
            for key, value in right.items():
                if not isinstance(left, dict) or key not in left:
                    mismatches.append(
                        {"path": f"{path}.{key}", "expected": value, "actual": "<missing>"}
                    )
                else:
                    visit(left[key], value, f"{path}.{key}")
        elif isinstance(right, list):
            if not isinstance(left, list) or len(left) != len(right):
                mismatches.append(
                    {
                        "path": path,
                        "expected_length": len(right),
                        "actual_length": len(left) if isinstance(left, list) else None,
                    }
                )
            else:
                for index, value in enumerate(right):
                    visit(left[index], value, f"{path}[{index}]")
        else:
            compared += 1
            equal = (
                math.isclose(float(left), float(right), rel_tol=0, abs_tol=tolerance)
                if isinstance(left, (int, float)) and isinstance(right, (int, float))
                else left == right
            )
            if not equal:
                mismatches.append({"path": path, "expected": right, "actual": left})

    visit(actual, recorded, "$recorded")
    return {
        "status": "passed" if not mismatches else "failed",
        "tolerance": tolerance,
        "compared_leaf_metrics": compared,
        "mismatches": mismatches,
    }


def _metric(
    name: str, recorded: float | int, reproduced: float | int, tolerance: float
) -> dict[str, Any]:
    exact = isinstance(recorded, int) and isinstance(reproduced, int)
    within = (
        recorded == reproduced
        if exact
        else math.isclose(float(recorded), float(reproduced), rel_tol=0, abs_tol=tolerance)
    )
    return {
        "name": name,
        "recorded": recorded,
        "reproduced": reproduced,
        "tolerance": "exact" if exact else tolerance,
        "within": within,
    }


def headline_reproduction_metrics(
    result: dict[str, Any], recorded: dict[str, Any], tolerance: float
) -> list[dict[str, Any]]:
    """Compare the preregistered headline effects and exact preservation counts."""
    groups = {item["group"]: item["arms"] for item in result["derived_summaries"]}
    metrics: list[dict[str, Any]] = []
    bfcl = recorded["bfcl"]
    for arm in CHECKPOINTS:
        metrics.append(
            _metric(
                f"BFCL {arm} accuracy",
                bfcl[arm]["accuracy"],
                groups["bfcl_overall"][arm]["accuracy"],
                tolerance,
            )
        )
    key_map = {
        "with_skill-no_skill": "with_minus_no_skill",
        "no_skill-base": "no_skill_minus_base",
        "with_skill-base": "with_minus_base",
    }
    for comparison, recorded_key in key_map.items():
        actual = result["derived_bfcl"]["overall"]["comparisons"][comparison]
        metrics.append(
            _metric(
                f"BFCL {comparison} delta",
                bfcl["deltas"][recorded_key],
                actual["delta"],
                tolerance,
            )
        )
        for endpoint, label in enumerate(("CI low", "CI high")):
            metrics.append(
                _metric(
                    f"BFCL {comparison} {label}",
                    bfcl["paired_bootstrap_95"][recorded_key][endpoint],
                    actual["ci"][endpoint],
                    tolerance,
                )
            )
    for group_name, recorded_key in (("ifeval", "ifeval_prompt_strict"), ("mmlu", "mmlu_fixed500")):
        for arm in CHECKPOINTS:
            metrics.append(
                _metric(
                    f"{group_name} {arm} correct",
                    recorded[recorded_key][arm]["correct"],
                    groups[group_name][arm]["correct"],
                    tolerance,
                )
            )
    restraint_rows = groups["restraint"]
    expected_rows = recorded["tool_restraint"]["n_pairs"] * 2
    for arm in CHECKPOINTS:
        metrics.append(
            _metric(
                f"tool restraint {arm} rows",
                expected_rows,
                restraint_rows[arm]["n"],
                tolerance,
            )
        )
    return metrics


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--json-output", "--json", dest="json_output", type=Path, required=True)
    parser.add_argument("--csv-output", "--csv", dest="csv_output", type=Path, required=True)
    parser.add_argument("--bootstrap-replicates", type=int, default=10_000)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--confidence", type=float, default=0.95)
    parser.add_argument("--compare", type=Path)
    parser.add_argument("--headline", type=Path, help="recorded final_metrics.json")
    parser.add_argument("--reproduction-output", type=Path)
    parser.add_argument("--tolerance", type=float, default=1e-10)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    result = analyze(read_jsonl(args.input), args.bootstrap_replicates, args.seed, args.confidence)
    args.json_output.parent.mkdir(parents=True, exist_ok=True)
    args.csv_output.parent.mkdir(parents=True, exist_ok=True)
    args.json_output.write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    write_csv(result, args.csv_output)
    if args.compare:
        full_report = compare_results(
            result, json.loads(args.compare.read_text(encoding="utf-8")), args.tolerance
        )
        metrics = []
        if args.headline:
            metrics = headline_reproduction_metrics(
                result,
                json.loads(args.headline.read_text(encoding="utf-8")),
                args.tolerance,
            )
        report = {
            "status": "passed"
            if full_report["status"] == "passed" and all(item["within"] for item in metrics)
            else "failed",
            "tolerance": args.tolerance,
            "metrics": metrics,
            "full_record_comparison": full_report,
        }
        if args.reproduction_output:
            args.reproduction_output.parent.mkdir(parents=True, exist_ok=True)
            args.reproduction_output.write_text(
                json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
        return int(report["status"] != "passed")
    if args.headline or args.reproduction_output:
        raise ValueError("--headline and --reproduction-output require --compare")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
