"""Audit exact, lexical, and tool-definition overlap between task manifests."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from collections import Counter
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

TOKEN_RE = re.compile(r"\w+", re.UNICODE)


def instruction(row: dict[str, Any]) -> str:
    value = row.get("task_instruction", row.get("prompt"))
    if not isinstance(value, str):
        raise ValueError(
            f"Task {row.get('task_id', '<unknown>')} has no string instruction or prompt"
        )
    return value


def normalize_text(text: str) -> str:
    return re.sub(r"\s+", " ", text.casefold()).strip()


def normalized_exact_hash(text: str) -> str:
    return hashlib.sha256(normalize_text(text).encode()).hexdigest()


def tokens(text: str) -> list[str]:
    return TOKEN_RE.findall(text.casefold())


def ngrams(items: Sequence[str], n: int = 5) -> set[tuple[str, ...]]:
    return {tuple(items[index : index + n]) for index in range(max(0, len(items) - n + 1))}


def jaccard(left: set[Any], right: set[Any]) -> float:
    union = left | right
    return len(left & right) / len(union) if union else 0.0


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def tool_signatures(row: dict[str, Any]) -> tuple[set[str], set[str]]:
    names: set[str] = set()
    schemas: set[str] = set()
    raw_tools = row.get("tools") or []
    if not isinstance(raw_tools, list):
        raise ValueError(f"Task {row.get('task_id', '<unknown>')} tools must be a list")
    for raw in raw_tools:
        if not isinstance(raw, dict):
            continue
        tool = raw.get("function") if isinstance(raw.get("function"), dict) else raw
        name = tool.get("name")
        if isinstance(name, str):
            names.add(name.casefold())
        schema = next(
            (tool[key] for key in ("parameters", "input_schema", "schema") if key in tool), None
        )
        if isinstance(schema, (dict, list)):
            schemas.add(canonical_json(schema))
    return names, schemas


def bm25_scores(documents: list[list[str]], query: list[str]) -> list[float]:
    if not documents:
        return []
    count = len(documents)
    average_length = sum(map(len, documents)) / count
    document_frequency = Counter(term for document in documents for term in set(document))
    scores = []
    for document in documents:
        frequencies = Counter(document)
        score = 0.0
        for term, query_frequency in Counter(query).items():
            frequency = frequencies.get(term, 0)
            if not frequency:
                continue
            df = document_frequency[term]
            inverse_frequency = math.log(1 + (count - df + 0.5) / (df + 0.5))
            length_norm = (
                1.0 if average_length == 0 else 0.25 + 0.75 * len(document) / average_length
            )
            score += (
                query_frequency
                * inverse_frequency
                * frequency
                * 2.5
                / (frequency + 1.5 * length_norm)
            )
        scores.append(score)
    return scores


def _best(task_ids: list[str], scores: list[float]) -> tuple[float, list[str]]:
    if not scores:
        return 0.0, []
    maximum = max(scores)
    return maximum, [
        task_id
        for task_id, score in zip(task_ids, scores, strict=True)
        if math.isclose(score, maximum, rel_tol=1e-12, abs_tol=1e-12)
    ]


def audit_rows(
    train_rows: list[dict[str, Any]], eval_rows: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    if not train_rows:
        raise ValueError("Train manifest is empty")
    train_ids = [str(row["task_id"]) for row in train_rows]
    texts = [instruction(row) for row in train_rows]
    hashes = [normalized_exact_hash(text) for text in texts]
    token_lists = [tokens(text) for text in texts]
    gram_sets = [ngrams(value) for value in token_lists]
    tools = [tool_signatures(row) for row in train_rows]
    output = []
    for row in eval_rows:
        text = instruction(row)
        digest = normalized_exact_hash(text)
        query = tokens(text)
        query_grams = ngrams(query)
        names, schemas = tool_signatures(row)
        gram_score, gram_ids = _best(
            train_ids, [jaccard(query_grams, value) for value in gram_sets]
        )
        bm25_score, bm25_ids = _best(train_ids, bm25_scores(token_lists, query))
        name_count, name_ids = _best(train_ids, [float(len(names & value[0])) for value in tools])
        name_jaccard, name_jaccard_ids = _best(
            train_ids, [jaccard(names, value[0]) for value in tools]
        )
        schema_count, schema_ids = _best(
            train_ids, [float(len(schemas & value[1])) for value in tools]
        )
        output.append(
            {
                "task_id": str(row["task_id"]),
                "normalized_exact_hash": digest,
                "normalized_exact_match_train_task_ids": [
                    task_id
                    for task_id, value in zip(train_ids, hashes, strict=True)
                    if value == digest
                ],
                "max_token_5gram_jaccard": gram_score,
                "token_5gram_jaccard_train_task_ids": gram_ids,
                "max_bm25_score": bm25_score,
                "bm25_train_task_ids": bm25_ids,
                "max_exact_tool_name_overlap": int(name_count),
                "exact_tool_name_overlap_train_task_ids": name_ids,
                "max_tool_name_jaccard": name_jaccard,
                "tool_name_jaccard_train_task_ids": name_jaccard_ids,
                "max_canonical_json_schema_exact_overlap": int(schema_count),
                "canonical_json_schema_exact_overlap_train_task_ids": schema_ids,
            }
        )
    return output


def quantiles(values: Iterable[float]) -> dict[str, float]:
    ordered = sorted(values)
    labels = (
        ("min", 0),
        ("p25", 0.25),
        ("p50", 0.5),
        ("p75", 0.75),
        ("p90", 0.9),
        ("p95", 0.95),
        ("max", 1),
    )
    if not ordered:
        return {label: 0.0 for label, _ in labels}

    def percentile(fraction: float) -> float:
        position = fraction * (len(ordered) - 1)
        lower, upper = math.floor(position), math.ceil(position)
        return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)

    return {label: percentile(fraction) for label, fraction in labels}


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    fields = (
        "max_token_5gram_jaccard",
        "max_bm25_score",
        "max_exact_tool_name_overlap",
        "max_tool_name_jaccard",
        "max_canonical_json_schema_exact_overlap",
    )
    return {
        "eval_task_count": len(rows),
        "normalized_exact_match_count": sum(
            bool(row["normalized_exact_match_train_task_ids"]) for row in rows
        ),
        "token_5gram_exact_match_count": sum(row["max_token_5gram_jaccard"] == 1 for row in rows),
        "tool_name_overlap_count": sum(row["max_exact_tool_name_overlap"] > 0 for row in rows),
        "canonical_json_schema_exact_overlap_count": sum(
            row["max_canonical_json_schema_exact_overlap"] > 0 for row in rows
        ),
        "quantiles": {field: quantiles(float(row[field]) for row in rows) for field in fields},
    }


def read_jsonl(path: str | Path) -> list[dict[str, Any]]:
    with Path(path).open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--train-manifest", required=True)
    parser.add_argument("--eval-manifest", required=True)
    parser.add_argument("--output-jsonl", required=True)
    parser.add_argument("--summary-json", required=True)
    args = parser.parse_args(argv)
    audited = audit_rows(read_jsonl(args.train_manifest), read_jsonl(args.eval_manifest))
    output, summary = Path(args.output_jsonl), Path(args.summary_json)
    output.parent.mkdir(parents=True, exist_ok=True)
    summary.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("".join(canonical_json(row) + "\n" for row in audited), encoding="utf-8")
    summary.write_text(
        json.dumps(summarize(audited), indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
