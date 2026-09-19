"""Small Jev HTTP adapter: secrets stay in .env; responses are allowlisted."""

import hashlib
import json
import math
import re
import time
from datetime import UTC, datetime
from pathlib import Path

import requests
from dotenv import dotenv_values

ENDPOINT = "https://api.typesafe.ai/v1/systemone"


class BenchmarkError(RuntimeError):
    """A sanitized error safe to display in notebook output."""


def configuration(root: Path) -> dict:
    """Return non-secret settings only; never expose the dotenv mapping."""
    values = dotenv_values(root / ".env", interpolate=False)
    model = values.get("JEV_MODEL") or "jev-1.13.0"
    if not re.fullmatch(r"jev-\d+\.\d+\.\d+", model):
        raise BenchmarkError("JEV_MODEL must be a versioned ID, for example jev-1.13.0.")
    return {"model": model, "key_present": bool(values.get("TYPESAFE_API_KEY", "").strip())}


def _request(root: Path, payload: dict) -> dict:
    values = dotenv_values(root / ".env", interpolate=False)
    key = (values.get("TYPESAFE_API_KEY") or "").strip()
    if not key:
        raise BenchmarkError("Add TYPESAFE_API_KEY to the local .env; do not paste it in a cell.")
    if (root / ".env").stat().st_mode & 0o077:
        raise BenchmarkError("Set .env permissions to owner-only (chmod 600 .env).")
    # No retries, redirects, proxy inheritance, raw response logging, or saved headers.
    # A timeout may already have incurred a charge; retry explicitly after inspection.
    failure = None
    data = None
    try:
        with requests.Session() as session:
            session.trust_env = False
            with session.post(
                ENDPOINT,
                headers={"Authorization": f"Bearer {key}"},
                json=payload,
                timeout=(10, 60),
                allow_redirects=False,
            ) as response:
                if response.status_code != 200:
                    failure = f"Jev returned HTTP {int(response.status_code)}; body withheld."
                else:
                    data = response.json()
    except (requests.RequestException, ValueError):
        failure = "Jev transport or JSON error; request details withheld."
    key = None
    values = None
    if failure:
        raise BenchmarkError(failure) from None
    return data


def _probability(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError
    value = float(value)
    if not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError
    return value


def parse_response(data: dict, model: str, true_key: str, false_key: str) -> dict:
    """Save only validated numeric fields; never serialize arbitrary API content."""
    try:
        if data["model"] != model:
            raise ValueError
        answers = data["answers"]
        choice = answers["choice"]
        if choice["type"] != "choice" or answers["event"]["type"] != "noul":
            raise ValueError
        if answers["complement"]["type"] != "noul":
            raise ValueError
        probabilities = choice["probabilities"]
        if set(probabilities) != {true_key, false_key}:
            raise ValueError
        p = _probability(probabilities[true_key])
        other = _probability(probabilities[false_key])
        if not math.isclose(p + other, 1, abs_tol=1e-5):
            raise ValueError
        tokens = data["usage"]["input_tokens"]
        if type(tokens) is not int or tokens < 0:
            raise ValueError
        return {
            "choice_p": p,
            "choice_other_p": other,
            "noul_p": _probability(answers["event"]["noul"]),
            "complement_p": _probability(answers["complement"]["noul"]),
            "input_tokens": tokens,
        }
    except (KeyError, TypeError, ValueError):
        raise BenchmarkError(
            "Unexpected Jev response schema/probabilities/model; body withheld."
        ) from None


def payload_for(case: dict, model: str) -> dict:
    return {
        "state": case["state"],
        "model": model,
        "questions": {
            "choice": {
                "type": "choice",
                "instructions": "Which of these outcomes will occur on the next random trial?",
                "criteria": {case["true_key"]: case["event"], case["false_key"]: case["opposite"]},
            },
            "event": {"type": "noul", "instructions": case["event"]},
            "complement": {"type": "noul", "instructions": case["opposite"]},
        },
    }


def collect(root: Path, cases: list[dict], *, live: bool = False, max_requests: int = 80) -> list:
    """Resume a versioned score cache. Missing rows require explicit live=True."""
    settings = configuration(root)
    model = settings["model"]
    cache = root / "runs" / "jev-off-the-shelf" / model
    cache.mkdir(parents=True, exist_ok=True)
    rows = []
    sent = 0
    for case in cases:
        payload = payload_for(case, model)
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        path = cache / f"{digest}.json"
        if path.exists():
            row = json.loads(path.read_text())
            if row["request_sha256"] != digest or row["model"] != model:
                raise BenchmarkError("Cache metadata mismatch; inspect the local cache.")
            rows.append(row)
            continue
        if not live:
            continue
        if sent >= max_requests:
            raise BenchmarkError("Request cap reached; completed requests are cached.")
        sent += 1
        started = time.perf_counter()
        data = _request(root, payload)
        scores = parse_response(data, model, case["true_key"], case["false_key"])
        row = {
            **case,
            **scores,
            "model": model,
            "request_sha256": digest,
            "timestamp_utc": datetime.now(UTC).isoformat(),
            "latency_seconds": time.perf_counter() - started,
        }
        # Only synthetic input and allowlisted fields, never raw response or credentials.
        path.write_text(json.dumps(row, indent=2, allow_nan=False) + "\n")
        rows.append(row)
        time.sleep(0.1)
    return rows
