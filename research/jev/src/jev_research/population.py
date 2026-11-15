"""Offline, source-preserving populations and exploratory-pilot split audits.

A row position in a particular source-table version identifies a *source record*,
not necessarily a distinct customer. Identical features, even with identical
outcomes, are insufficient evidence that records are duplicate exports. The
historical feature-filtered population is exposed only as a sensitivity mask.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
from itertools import combinations
from pathlib import Path
from zipfile import ZipFile

import numpy as np
import pandas as pd
from sklearn.model_selection import GroupShuffleSplit

DATASETS = ("south-german-credit", "bank-marketing", "online-shoppers")
PARTITIONS = ("development", "calibration", "final_test")


def feature_groups(features: pd.DataFrame) -> pd.Series:
    """Group exact supplied-feature profiles; this is not a customer identifier."""
    hashes = pd.util.hash_pandas_object(features, index=False)
    return hashes.map(lambda value: f"features-{int(value):016x}").rename("feature_group")


def legacy_filtered_mask(features: pd.DataFrame, outcomes: pd.Series) -> pd.Series:
    """Reproduce the pilot's exclusion rule, solely for sensitivity analysis."""
    if not features.index.equals(outcomes.index):
        raise ValueError("Features and outcomes must have identical ordered row indices")
    groups = feature_groups(features)
    conflicts = pd.DataFrame({"group": groups, "y": outcomes}).groupby("group").y.nunique()
    return (~groups.duplicated() & ~groups.isin(conflicts[conflicts > 1].index)).rename(
        "legacy_retained"
    )


def deduplicate_source_exports(
    records: pd.DataFrame, identity: str = "source_record_id"
) -> pd.DataFrame:
    """Collapse repeated exports only when source identity and all values agree.

    Callers must establish provenance-based identities first. Distinct source IDs
    remain separate observations even if every feature and outcome is identical.
    Conflicting exports for the same identity fail rather than silently choosing.
    """
    if identity not in records or records[identity].isna().any():
        raise ValueError("A nonmissing source identity is required for every export")
    repeated = records[records[identity].duplicated(keep=False)]
    for _, group in repeated.groupby(identity, sort=False):
        if len(group.drop_duplicates()) != 1:
            raise ValueError("Conflicting exports share a source identity")
    return records.drop_duplicates(subset=identity, keep="first").copy()


def load_population(root: Path | str, slug: str):
    """Load every archived source row, applying the pilot's feature transforms.

    Returns ``(X, y, feature_groups, metadata)``. No rows are automatically
    removed. No network or model calls occur. Each frame retains zero-based
    source row positions so cached pilot predictions can be joined exactly.
    """
    if slug not in DATASETS:
        raise ValueError(f"Unknown dataset: {slug}")
    path = Path(root) / "data" / "uci" / f"{slug}.zip"
    with ZipFile(path) as archive:
        if slug == "south-german-credit":
            member = "SouthGermanCredit.asc"
            table = archive.read(member)
            features = pd.read_csv(io.BytesIO(table), sep=r"\s+")
            outcomes = (features.pop("kredit") == 0).astype(int)
            book = archive.read("codetable.txt").decode("latin1")
            for raw, name, body in re.findall(r"\$`(\w+) = ([^`]+)`([^$]*)", book):
                if raw not in features:
                    continue
                mapping = {
                    int(key): value.strip()
                    for key, value in re.findall(r"^\s*(\d+)\s*:\s*(.+)$", body, re.M)
                }
                if mapping:
                    if not set(features[raw]).issubset(mapping):
                        raise ValueError(f"Unmapped values in {raw}")
                    features[raw] = features[raw].map(mapping)
                features.rename(columns={raw: name}, inplace=True)
            features.rename(
                columns={
                    "duration": "credit_duration_months",
                    "amount": "transformed_credit_amount_DM",
                    "age": "age_years",
                    "installment_rate": "installment_percent_disposable_income",
                },
                inplace=True,
            )
            excluded = []
            target, positive_label = "kredit", 0
        elif slug == "bank-marketing":
            member = "bank-additional/bank-additional-full.csv"
            with ZipFile(io.BytesIO(archive.read("bank-additional.zip"))) as inner:
                table = inner.read(member)
            features = pd.read_csv(io.BytesIO(table), sep=";")
            outcomes = (features.pop("y") == "yes").astype(int)
            features.drop(columns=["duration"], inplace=True)
            excluded = ["duration"]
            target, positive_label = "y", "yes"
        else:
            member = "online_shoppers_intention.csv"
            table = archive.read(member)
            features = pd.read_csv(io.BytesIO(table))
            outcomes = features.pop("Revenue").astype(int)
            features.drop(columns=["PageValues"], inplace=True)
            for column in ["OperatingSystems", "Browser", "Region", "TrafficType"]:
                features[column] = features[column].map(lambda value: f"category_{value}")
            excluded = ["PageValues"]
            target, positive_label = "Revenue", True
    if features.isna().any().any() or outcomes.isna().any():
        raise ValueError("Unexpected missing source values; declare handling before evaluation")
    if not outcomes.isin([0, 1]).all():
        raise ValueError("Source outcomes must be binary")
    features.index.name = "row_id"
    outcomes.index.name = "row_id"
    outcomes.name = "y"
    groups = feature_groups(features)
    metadata = {
        "dataset": slug,
        "source_member": member,
        "source_rows": len(features),
        "source_table_sha256": hashlib.sha256(table).hexdigest(),
        "archive_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "excluded_features": excluded,
        "source_target": target,
        "source_positive_label": positive_label,
        "source_identity": "dataset + source_table_sha256 + zero-based source row position",
        "customer_id_available": False,
        "grouping_proxy": "exact supplied-feature hash after leakage-feature exclusions",
        "grouping_limitations": (
            "Feature equality does not prove duplicate exports or common customers; distinct "
            "profiles may belong to one customer. Source-row independence is unverified."
        ),
        "temporal": slug == "bank-marketing",
        "temporal_order": (
            "source row order; documented chronological archive order, no exact date/customer ID"
            if slug == "bank-marketing"
            else "No verified record chronology; month alone is not a timestamp"
        ),
        "population_policy": "Preserve every source row, including conflicting outcomes",
    }
    return features, outcomes, groups, metadata


def prospective_split(
    outcomes: pd.Series,
    groups: pd.Series,
    *,
    temporal_order: pd.Series | None = None,
    fractions: tuple[float, float, float] = (0.6, 0.2, 0.2),
    seed: int = 78,
):
    """Assign prospective roles without selecting on outcomes or model performance.

    For non-temporal data, all rows of a grouping unit remain in one partition.
    Temporal data keep source chronology; group crossings are disclosed rather
    than reordering time or deleting observations. Such crossings require a
    customer-level protocol decision when actual customer identifiers exist.
    Using this helper on inspected pilot data never creates untouched data.
    """
    if not outcomes.index.is_unique or not outcomes.index.equals(groups.index):
        raise ValueError("Outcomes and groups require identical unique row indices")
    if outcomes.isna().any() or not outcomes.isin([0, 1]).all() or groups.isna().any():
        raise ValueError("Require binary outcomes and nonmissing grouping units")
    weights = np.asarray(fractions, dtype=float)
    if weights.shape != (3,) or np.any(weights <= 0) or not np.isclose(weights.sum(), 1):
        raise ValueError("Three positive split fractions must sum to one")
    assignments = pd.Series(index=outcomes.index, dtype="object", name="partition")
    if temporal_order is not None:
        if not outcomes.index.equals(temporal_order.index) or temporal_order.isna().any():
            raise ValueError("Temporal ordering requires one nonmissing value per source row")
        order = temporal_order.sort_values(kind="stable").index
        first, second = int(len(order) * weights[0]), int(len(order) * weights[:2].sum())
        positions = [order[:first], order[first:second], order[second:]]
        method = "chronological contiguous source-order split"
    else:
        if groups.nunique() < 3:
            raise ValueError("At least three grouping units are required")
        index = np.arange(len(outcomes))
        first = GroupShuffleSplit(n_splits=1, train_size=weights[0], random_state=seed)
        development, remainder = next(first.split(index, groups=groups.to_numpy()))
        second = GroupShuffleSplit(
            n_splits=1,
            train_size=weights[1] / weights[1:].sum(),
            random_state=seed + 1,
        )
        calibration, final = next(second.split(remainder, groups=groups.iloc[remainder].to_numpy()))
        positions = [
            outcomes.index[development],
            outcomes.index[remainder[calibration]],
            outcomes.index[remainder[final]],
        ]
        method = "group-disjoint random split; no outcome-stratification selection"
    if any(len(part) == 0 for part in positions):
        raise ValueError("Each partition must contain source records")
    for name, indices in zip(PARTITIONS, positions, strict=True):
        assignments.loc[indices] = name
    grouped = pd.DataFrame({"group": groups, "partition": assignments})
    crossings = int((grouped.groupby("group").partition.nunique() > 1).sum())
    metadata = {
        "method": method,
        "seed": seed,
        "fractions": list(fractions),
        "groups_crossing_partitions": crossings,
        "requires_group_crossing_review": bool(crossings),
        "partitions": {
            name: {
                "source_records": int((assignments == name).sum()),
                "events": int(outcomes[assignments == name].sum()),
                "groups": int(groups[assignments == name].nunique()),
            }
            for name in PARTITIONS
        },
        "confirmation_status": "Assignments alone do not establish uninspected or new data",
    }
    return assignments, metadata


def _audit_split(slug, features, outcomes, groups, split):
    """Audit both full allocation pools and the actually scored pilot samples."""
    result = []
    for scope, keys in [
        ("allocation_pools", ("train_ids", "calibration_pool_ids", "test_pool_ids")),
        ("scored_samples", ("train_ids", "calibration_ids", "test_ids")),
    ]:
        partitions = dict(zip(PARTITIONS, [split[key] for key in keys], strict=True))
        for name, ids in partitions.items():
            valid = [row for row in ids if row in features.index]
            result.append(
                {
                    "dataset": slug,
                    "scope": scope,
                    "check": "partition_counts",
                    "partition": name,
                    "other_partition": "",
                    "source_records": len(ids),
                    "events": int(outcomes.loc[valid].sum()),
                    "duplicate_source_ids": len(ids) - len(set(ids)),
                    "unknown_source_ids": len(ids) - len(valid),
                    "source_order_min": min(valid) if valid else np.nan,
                    "source_order_max": max(valid) if valid else np.nan,
                }
            )
        for (first, left), (second, right) in combinations(partitions.items(), 2):
            valid_left = set(left) & set(features.index)
            valid_right = set(right) & set(features.index)
            chronological = max(left) < min(right) if left and right else False
            result.append(
                {
                    "dataset": slug,
                    "scope": scope,
                    "check": "partition_overlap",
                    "partition": first,
                    "other_partition": second,
                    "source_id_overlap": len(set(left) & set(right)),
                    "feature_group_overlap": len(
                        set(groups.loc[sorted(valid_left)]) & set(groups.loc[sorted(valid_right)])
                    ),
                    "chronology_required": slug == "bank-marketing",
                    "chronological_order_pass": chronological if slug == "bank-marketing" else None,
                }
            )
    for sample, pool in [
        ("calibration_ids", "calibration_pool_ids"),
        ("test_ids", "test_pool_ids"),
    ]:
        result.append(
            {
                "dataset": slug,
                "scope": "scored_samples",
                "check": "sample_within_declared_pool",
                "partition": "calibration" if sample.startswith("calibration") else "final_test",
                "other_partition": "",
                "out_of_pool_source_ids": len(set(split[sample]) - set(split[pool])),
            }
        )
    return result


def audit_population(root: Path | str, source_run: Path | str) -> dict[str, pd.DataFrame]:
    """Audit immutable cached inputs; return tables without writing any artifacts.

    Coverage is population inclusion, distinct from endpoint success and validity
    coverage. Missing predictions for historically excluded rows cannot be filled
    by copying probabilities from another feature-identical source observation.
    """
    root, source_run = Path(root), Path(source_run)
    requests = json.loads((source_run / "requests.json").read_text())
    responses = [
        json.loads(path.read_text()) for path in sorted((source_run / "responses").glob("*.json"))
    ]
    baseline = pd.read_csv(source_run / "baseline_predictions.csv")
    population_rows, mappings, split_rows, coverage_rows = [], [], [], []
    for slug in DATASETS:
        features, outcomes, groups, meta = load_population(root, slug)
        retained = legacy_filtered_mask(features, outcomes)
        counts = groups.value_counts()
        cardinality = pd.DataFrame({"group": groups, "y": outcomes}).groupby("group").y.nunique()
        conflicts = set(cardinality[cardinality > 1].index)
        split = json.loads((source_run / f"{slug}-split.json").read_text())
        source_hash = meta["source_table_sha256"]
        request_rows = [job["case"] for job in requests if job["experiment"] == slug]
        cached = [row for row in responses if row.get("experiment") == slug]
        request_ids = {int(row["row_id"]) for row in request_rows}
        cached_ids = {int(row["row_id"]) for row in cached}
        population_rows.append(
            {
                "dataset": slug,
                "source_records": len(features),
                "source_events": int(outcomes.sum()),
                "source_positive_rate": float(outcomes.mean()),
                "feature_groups": groups.nunique(),
                "repeated_feature_groups": int((counts > 1).sum()),
                "rows_in_repeated_feature_groups": int(groups.isin(counts[counts > 1].index).sum()),
                "feature_repeat_excess_rows": len(features) - groups.nunique(),
                "conflicting_feature_groups": len(conflicts),
                "rows_in_conflicting_feature_groups": int(groups.isin(conflicts).sum()),
                "proven_duplicate_exports": 0,
                "legacy_retained_rows": int(retained.sum()),
                "legacy_excluded_rows": int((~retained).sum()),
                "legacy_retained_events": int(outcomes[retained].sum()),
                "legacy_excluded_events": int(outcomes[~retained].sum()),
                "legacy_retained_positive_rate": float(outcomes[retained].mean()),
                "matches_saved_retained_count": int(retained.sum()) == split["retained_rows"],
                "matches_saved_archive_hash": meta["archive_sha256"] == split["archive_sha256"],
                "customer_id_available": False,
                "independence_verified": False,
                "grouping_proxy": meta["grouping_proxy"],
                "source_table_sha256": source_hash,
                "excluded_features": ",".join(meta["excluded_features"]),
            }
        )
        mapping = pd.DataFrame(
            {
                "dataset": slug,
                "row_id": features.index,
                "source_record_id": [f"{slug}:{source_hash}:{row}" for row in features.index],
                "feature_group": groups.to_numpy(),
                "y": outcomes.to_numpy(),
                "legacy_retained": retained.to_numpy(),
                "conflicting_outcomes_group": groups.isin(conflicts).to_numpy(),
                "cached_request": features.index.isin(request_ids),
                "cached_response": features.index.isin(cached_ids),
                "historical_partition": "excluded_by_legacy_filter",
            }
        ).set_index("row_id", drop=False)
        for name, key in [
            ("development", "train_ids"),
            ("calibration_pool_unqueried", "calibration_pool_ids"),
            ("test_pool_unqueried", "test_pool_ids"),
            ("calibration", "calibration_ids"),
            ("final_test_exploratory", "test_ids"),
        ]:
            mapping.loc[split[key], "historical_partition"] = name
        mappings.append(mapping.reset_index(drop=True))
        split_rows.extend(_audit_split(slug, features, outcomes, groups, split))
        for name, mask in [
            ("all_source_records", pd.Series(True, index=features.index)),
            ("legacy_filtered_sensitivity", retained),
            ("legacy_excluded", ~retained),
        ]:
            eligible = set(features.index[mask])
            n = len(eligible)
            coverage_rows.append(
                {
                    "dataset": slug,
                    "population": name,
                    "eligible_source_records": n,
                    "requested_source_records": len(eligible & request_ids),
                    "cached_source_records": len(eligible & cached_ids),
                    "request_calls": sum(int(row["row_id"]) in eligible for row in request_rows),
                    "response_calls": sum(int(row["row_id"]) in eligible for row in cached),
                    "source_population_coverage": len(eligible & cached_ids) / n if n else np.nan,
                    "missing_source_records": len(eligible - cached_ids),
                    "all_source_population_evaluable": bool(n and eligible.issubset(cached_ids)),
                }
            )
        for part, key in [("calibration", "calibration_ids"), ("test", "test_ids")]:
            ids = set(split[key])
            response_subset = [row for row in cached if row["partition"] == part]
            part_ids = {int(row["row_id"]) for row in response_subset}
            base = baseline[(baseline.dataset == slug) & (baseline.partition == part)]
            base_ids = set(base.row_id.astype(int))
            coverage_rows.append(
                {
                    "dataset": slug,
                    "population": f"historical_{part}_sample",
                    "eligible_source_records": len(ids),
                    "requested_source_records": len(ids & request_ids),
                    "cached_source_records": len(ids & part_ids),
                    "response_calls": len(response_subset),
                    "source_population_coverage": len(ids & part_ids) / len(ids),
                    "missing_source_records": len(ids - part_ids),
                    "unexpected_cached_source_records": len(part_ids - ids),
                    "duplicate_cached_source_records": len(response_subset) - len(part_ids),
                    "baseline_matched_source_records": len(ids & part_ids & base_ids),
                    "cached_label_mismatches": sum(
                        int(row["y"]) != int(outcomes.loc[int(row["row_id"])])
                        for row in response_subset
                        if int(row["row_id"]) in outcomes.index
                    ),
                    "baseline_label_mismatches": sum(
                        int(row.y) != int(outcomes.loc[int(row.row_id)])
                        for row in base.itertuples()
                        if int(row.row_id) in outcomes.index
                    ),
                    "all_source_population_evaluable": ids.issubset(part_ids),
                }
            )
    return {
        "population_summary": pd.DataFrame(population_rows),
        "row_groups": pd.concat(mappings, ignore_index=True),
        "split_audit": pd.DataFrame(split_rows),
        "prediction_coverage": pd.DataFrame(coverage_rows),
    }
