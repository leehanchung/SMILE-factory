"""Fresh synthetic + held-out UCI pilot. No prior prediction cache is reused."""

import argparse
import hashlib
import io
import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from pathlib import Path
from zipfile import ZipFile

import numpy as np
import pandas as pd
from catboost import CatBoostClassifier
from sklearn.compose import ColumnTransformer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

from jev_research.jev_api import _request, configuration, parse_response, payload_for
from jev_research.monte_carlo import dice_scenarios, scenarios
from jev_research.population import load_population, prospective_split

ROOT = Path(__file__).resolve().parents[1]
SEED = 78


def _load_uci_filtered_sensitivity(slug):
    path = ROOT / "data/uci" / f"{slug}.zip"
    with ZipFile(path) as z:
        if slug == "south-german-credit":
            df = pd.read_csv(io.BytesIO(z.read("SouthGermanCredit.asc")), sep=r"\s+")
            y = (df.pop("kredit") == 0).astype(int)
            book = z.read("codetable.txt").decode("latin1")
            for raw, name, body in re.findall(r"\$`(\w+) = ([^`]+)`([^$]*)", book):
                if raw not in df:
                    continue
                mapping = {
                    int(k): v.strip() for k, v in re.findall(r"^\s*(\d+)\s*:\s*(.+)$", body, re.M)
                }
                if mapping:
                    assert set(df[raw]).issubset(mapping)
                    df[raw] = df[raw].map(mapping)
                df.rename(columns={raw: name}, inplace=True)
            df.rename(
                columns={
                    "duration": "credit_duration_months",
                    "amount": "transformed_credit_amount_DM",
                    "age": "age_years",
                    "installment_rate": "installment_percent_disposable_income",
                },
                inplace=True,
            )
            event = "The credit contract was not complied with (bad credit)."
            opposite = "The credit contract was complied with (good credit)."
            context = (
                "Historical South German credit record (1973–1975). Credit amount is "
                "transformed; do not treat it as an exact monetary amount."
            )
            dropped = []
        elif slug == "bank-marketing":
            with ZipFile(io.BytesIO(z.read("bank-additional.zip"))) as inner:
                df = pd.read_csv(
                    io.BytesIO(inner.read("bank-additional/bank-additional-full.csv")), sep=";"
                )
            y = (df.pop("y") == "yes").astype(int)
            df.drop(columns=["duration"], inplace=True)
            dropped = ["duration"]
            event = "The client subscribed to a term deposit."
            opposite = "The client did not subscribe to a term deposit."
            context = (
                "Portuguese bank marketing record. Predict subscription using information "
                "available before the final call. pdays=999 means no previous contact; "
                "campaign includes the planned current contact. Economic indicators "
                "describe the contact period."
            )
        else:
            df = pd.read_csv(io.BytesIO(z.read("online_shoppers_intention.csv")))
            y = df.pop("Revenue").astype(int)
            df.drop(columns=["PageValues"], inplace=True)
            dropped = ["PageValues"]
            for c in ["OperatingSystems", "Browser", "Region", "TrafficType"]:
                df[c] = df[c].map(lambda x: f"category_{x}")
            event = "The session ended in a purchase."
            opposite = "The session did not end in a purchase."
            context = (
                "Online shopping session summary. Durations are seconds; bounce and exit "
                "rates are proportions. Category IDs are nominal. This is retrospective "
                "session classification, not an early-session forecast."
            )
    assert not df.isna().any().any()
    hashes = pd.util.hash_pandas_object(df, index=False)
    # Retain first feature occurrence, removing repeated and conflicting copies
    # before splitting. This makes the pilot population explicitly deduplicated.
    conflicts = pd.DataFrame({"g": hashes, "y": y}).groupby("g").y.nunique()
    bad = set(conflicts[conflicts > 1].index)
    keep = ~hashes.duplicated() & ~hashes.isin(bad)
    raw_n = len(df)
    df, y = df.loc[keep], y.loc[keep]
    ids = df.index.to_numpy()
    if slug == "bank-marketing":
        a, b = int(len(ids) * 0.6), int(len(ids) * 0.8)
        train, cal_pool, test_pool = ids[:a], ids[a:b], ids[b:]
        split = "chronological 60/20/20 after duplicate removal"
    else:
        train, remainder = train_test_split(
            ids, test_size=0.4, stratify=y.loc[ids], random_state=SEED
        )
        cal_pool, test_pool = train_test_split(
            remainder, test_size=0.5, stratify=y.loc[remainder], random_state=SEED
        )
        split = "stratified 60/20/20 after duplicate removal"
    rng = np.random.default_rng(SEED)
    cal = np.sort(rng.choice(cal_pool, 120, replace=False))
    test = np.sort(rng.choice(test_pool, 200, replace=False))
    assert not (set(train) & set(cal) or set(train) & set(test) or set(cal) & set(test))
    assert y.loc[cal].nunique() == y.loc[test].nunique() == 2
    meta = {
        "dataset": slug,
        "raw_rows": raw_n,
        "retained_rows": len(df),
        "removed_duplicate_or_conflicting_rows": raw_n - len(df),
        "conflicting_feature_groups": len(bad),
        "excluded_features": dropped,
        "split": split,
        "train_ids": train.tolist(),
        "calibration_ids": cal.tolist(),
        "test_ids": test.tolist(),
        "calibration_pool_ids": cal_pool.tolist(),
        "test_pool_ids": test_pool.tolist(),
        "training_positive_rate": float(y.loc[train].mean()),
        "calibration_positive_rate": float(y.loc[cal].mean()),
        "test_positive_rate": float(y.loc[test].mean()),
        "archive_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }
    return df, y, train, cal, test, meta, event, opposite, context


def load_uci(slug, *, filtered_sensitivity=False):
    """Prepare source-preserving roles; legacy filtering requires explicit opt-in.

    This is preparation only. Running this script's live inference entrypoint
    requires a separately authorized next run and is not part of the cache audit.
    The split helper does not make already-inspected records confirmatory.
    """
    if filtered_sensitivity:
        result = _load_uci_filtered_sensitivity(slug)
        result[5]["population_policy"] = "historical feature-filtered sensitivity only"
        result[5]["confirmation_status"] = "exploratory pilot population"
        return result
    X, y, groups, metadata = load_population(ROOT, slug)
    temporal_order = pd.Series(X.index, index=X.index) if slug == "bank-marketing" else None
    assignment, split_meta = prospective_split(y, groups, temporal_order=temporal_order, seed=SEED)
    train = assignment.index[assignment == "development"].to_numpy()
    cal_pool = assignment.index[assignment == "calibration"].to_numpy()
    test_pool = assignment.index[assignment == "final_test"].to_numpy()
    if len(cal_pool) < 120 or len(test_pool) < 200:
        raise ValueError("Population too small for the declared 120/200 sampled pilot roles")
    rng = np.random.default_rng(SEED)
    cal = np.sort(rng.choice(cal_pool, 120, replace=False))
    test = np.sort(rng.choice(test_pool, 200, replace=False))
    descriptions = {
        "south-german-credit": (
            "The credit contract was not complied with (bad credit).",
            "The credit contract was complied with (good credit).",
            "Historical South German credit record (1973–1975). Credit amount is "
            "transformed; do not treat it as an exact monetary amount.",
        ),
        "bank-marketing": (
            "The client subscribed to a term deposit.",
            "The client did not subscribe to a term deposit.",
            "Portuguese bank marketing record. Predict subscription using information "
            "available before the final call. pdays=999 means no previous contact; "
            "campaign includes the planned current contact. Economic indicators "
            "describe the contact period.",
        ),
        "online-shoppers": (
            "The session ended in a purchase.",
            "The session did not end in a purchase.",
            "Online shopping session summary. Durations are seconds; bounce and exit "
            "rates are proportions. Category IDs are nominal. This is retrospective "
            "session classification, not an early-session forecast.",
        ),
    }
    conflict_groups = pd.DataFrame({"g": groups, "y": y}).groupby("g").y.nunique()
    metadata.update(
        raw_rows=len(X),
        retained_rows=len(X),
        removed_duplicate_or_conflicting_rows=0,
        conflicting_feature_groups=int((conflict_groups > 1).sum()),
        split=split_meta["method"],
        split_audit=split_meta,
        train_ids=train.tolist(),
        calibration_ids=cal.tolist(),
        test_ids=test.tolist(),
        calibration_pool_ids=cal_pool.tolist(),
        test_pool_ids=test_pool.tolist(),
        training_positive_rate=float(y.loc[train].mean()),
        calibration_positive_rate=float(y.loc[cal].mean()),
        test_positive_rate=float(y.loc[test].mean()),
    )
    event, opposite, context = descriptions[slug]
    return X, y, train, cal, test, metadata, event, opposite, context


def prepare(run):
    model = configuration(ROOT)["model"]
    jobs = []
    for c in scenarios():
        jobs.append({"experiment": "synthetic", "case": c, "payload": payload_for(c, model)})
    for c in dice_scenarios():
        jobs.append({"experiment": "two-dice", "case": c, "payload": payload_for(c, model)})
    baseline = []
    for slug in ["south-german-credit", "bank-marketing", "online-shoppers"]:
        X, y, train, cal, test, meta, event, opposite, context = load_uci(slug)
        (run / f"{slug}-split.json").write_text(json.dumps(meta, indent=2))
        cat = X.select_dtypes(include=["object", "bool"]).columns.tolist()
        numeric = [c for c in X if c not in cat]
        X = X.copy()
        for c in cat:
            X[c] = X[c].astype(str)
        prep = ColumnTransformer(
            [
                ("numeric", StandardScaler(), numeric),
                ("categorical", OneHotEncoder(handle_unknown="ignore"), cat),
            ]
        )
        logistic = make_pipeline(prep, LogisticRegression(C=1, max_iter=3000, random_state=SEED))
        logistic.fit(X.loc[train], y.loc[train])
        boost = CatBoostClassifier(
            iterations=300,
            depth=6,
            learning_rate=0.05,
            loss_function="Logloss",
            random_seed=SEED,
            verbose=False,
            allow_writing_files=False,
            thread_count=4,
        )
        boost.fit(X.loc[train], y.loc[train], cat_features=cat)
        for part, ids in [("calibration", cal), ("test", test)]:
            lr = logistic.predict_proba(X.loc[ids])[:, 1]
            cb = boost.predict_proba(X.loc[ids])[:, 1]
            for j, rid in enumerate(ids):
                case = {
                    "scenario_id": f"{slug}-{rid}",
                    "family": slug,
                    "track": "real-data",
                    "row_id": int(rid),
                    "partition": part,
                    "y": int(y.loc[rid]),
                    "state": context
                    + "\nFeatures: "
                    + json.dumps(X.loc[rid].to_dict(), default=lambda v: v.item(), sort_keys=True),
                    "event": event,
                    "opposite": opposite,
                    "true_key": "positive",
                    "false_key": "negative",
                }
                payload = payload_for(case, model)
                payload["questions"]["choice"]["instructions"] = (
                    "Which of these recorded outcomes applies to this case? Estimate "
                    "probabilities from the supplied features."
                )
                jobs.append({"experiment": slug, "case": case, "payload": payload})
                baseline.append(
                    {
                        "dataset": slug,
                        "row_id": int(rid),
                        "partition": part,
                        "y": int(y.loc[rid]),
                        "constant": float(y.loc[train].mean()),
                        "logistic_regression": float(lr[j]),
                        "catboost": float(cb[j]),
                    }
                )
        print(f"Prepared {slug}: train={len(train)}, calibration=120, test=200", flush=True)
    pd.DataFrame(baseline).to_csv(run / "baseline_predictions.csv", index=False)
    (run / "requests.json").write_text(json.dumps(jobs, indent=2))
    (run / "manifest.json").write_text(
        json.dumps(
            {
                "seed": SEED,
                "model": model,
                "started_utc": datetime.now(UTC).isoformat(),
                "fresh_requests": len(jobs),
                "previous_scores_reused": False,
                "synthetic_trials": 2000,
                "synthetic_repetitions": 500,
                "uci_calibration_per_dataset": 120,
                "uci_test_per_dataset": 200,
                "baseline_hyperparameters": {
                    "logistic_C": 1,
                    "catboost_iterations": 300,
                    "catboost_depth": 6,
                    "catboost_learning_rate": 0.05,
                },
                "concurrent_requests": 4,
            },
            indent=2,
        )
    )
    return jobs


def query(run, jobs):
    (run / "responses").mkdir()

    def one(index, job):
        scores = parse_response(
            _request(ROOT, job["payload"]),
            job["payload"]["model"],
            job["case"]["true_key"],
            job["case"]["false_key"],
        )
        record = {
            **job["case"],
            **scores,
            "experiment": job["experiment"],
            "model": job["payload"]["model"],
            "request_sha256": hashlib.sha256(
                json.dumps(job["payload"], sort_keys=True).encode()
            ).hexdigest(),
            "timestamp_utc": datetime.now(UTC).isoformat(),
        }
        (run / "responses" / f"{index:04d}.json").write_text(json.dumps(record, indent=2))
        return index

    failures = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(one, i, j): i for i, j in enumerate(jobs)}
        for done, f in enumerate(as_completed(futures), 1):
            try:
                f.result()
            except Exception as exc:
                # Only class name is persisted; never raw third-party error content.
                failures.append({"request_index": futures[f], "error_type": type(exc).__name__})
            if done % 40 == 0 or done == len(jobs):
                print(f"Completed {done}/{len(jobs)}; failures={len(failures)}", flush=True)
    (run / "failures.json").write_text(json.dumps(failures, indent=2))
    if failures:
        raise RuntimeError(f"{len(failures)} requests failed; successful results retained.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    run = ROOT / args.run_dir
    run.mkdir(parents=True, exist_ok=False)
    jobs = prepare(run)
    if not args.prepare_only:
        query(run, jobs)
