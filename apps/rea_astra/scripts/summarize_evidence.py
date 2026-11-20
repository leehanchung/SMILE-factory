#!/usr/bin/env python3
"""Create a small reviewable ledger without changing complete REA Evidence."""

import argparse
import hashlib
import json
from pathlib import Path


def summarize(path):
    data = json.loads(path.read_text())
    if "details" in data and "partial_observation" in data["details"]:
        records = [data["details"]["partial_observation"]]
        status = data["code"]
    else:
        records = data.get("records", [data])
        status = "returned"
    result = []
    for record in records:
        normalized = record.get("normalized_result", {})
        semantic = normalized.get("semantic_graph", {})
        result.append(
            {
                "evidence_id": record["evidence_id"],
                "operation": record["operation"],
                "status": status,
                "artifact_sha256": normalized.get("root_artifact_sha256"),
                "source_selection": normalized.get("source_selection"),
                "statistics": normalized.get("statistics"),
                "electron_summary": normalized.get("summary"),
                "application_coverage": normalized.get("graph", {}).get("coverage"),
                "semantic_coverage": {k: v for k, v in semantic.get("coverage", {}).items() if k != "families"},
                "semantic_unknown_count": len(semantic.get("unknowns", [])),
                "limitations": record.get("limitations", []),
            }
        )
    return {"source_file": path.name, "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "records": result}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    args.output.write_text(json.dumps([summarize(p) for p in args.inputs], indent=2) + "\n")
    print(args.output)
