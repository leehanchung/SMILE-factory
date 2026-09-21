"""Stable evaluation launchers and metadata-only artifact verification."""

from __future__ import annotations

import argparse
import json
import subprocess
import urllib.request
from pathlib import Path
from typing import Any, Mapping, Sequence


def run_subprocess(
    command: Sequence[str], *, timeout: float | None = None
) -> subprocess.CompletedProcess[str]:
    """Run an evaluation command without a shell and raise on failure."""
    if not command:
        raise ValueError("evaluation command must not be empty")
    return subprocess.run(
        list(command), check=True, text=True, capture_output=True, timeout=timeout
    )


def request_json(
    url: str,
    payload: Mapping[str, Any] | None = None,
    *,
    headers: Mapping[str, str] | None = None,
    timeout: float = 30.0,
) -> Any:
    """Issue a JSON HTTP request using only the standard library."""
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request_headers = {"Accept": "application/json", **dict(headers or {})}
    if body is not None:
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        url, data=body, headers=request_headers, method="POST" if body else "GET"
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
        return json.loads(response.read().decode("utf-8"))


def endpoint_smoke(
    endpoint: str,
    *,
    model: str,
    prompt: str = "Reply with OK.",
    api_key: str | None = None,
    timeout: float = 30.0,
) -> Any:
    """Send one OpenAI-compatible chat request to an explicitly supplied endpoint."""
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 8,
        "temperature": 0,
    }
    result = request_json(
        endpoint.rstrip("/") + "/v1/chat/completions", payload, headers=headers, timeout=timeout
    )
    if not isinstance(result, Mapping) or not result.get("choices"):
        raise ValueError("endpoint response has no choices")
    return result


def _objects(document: Any, label: str) -> list[Mapping[str, Any]]:
    """Normalize flat, grouped, and identity-keyed metadata documents."""
    if isinstance(document, list):
        objects = document
    elif isinstance(document, Mapping) and isinstance(document.get("objects"), list):
        objects = document["objects"]
    elif isinstance(document, Mapping) and isinstance(document.get("artifacts"), list):
        objects = document["artifacts"]
    elif isinstance(document, Mapping) and isinstance(document.get("groups"), Mapping):
        objects = []
        for group in document["groups"].values():
            if isinstance(group, Mapping) and isinstance(group.get("objects"), list):
                objects.extend(group["objects"])
    elif isinstance(document, Mapping) and isinstance(document.get("objects"), Mapping):
        objects = [
            {"ref": identity, **metadata}
            for identity, metadata in document["objects"].items()
            if isinstance(identity, str) and isinstance(metadata, Mapping)
        ]
    else:
        objects = None
    if not isinstance(objects, list) or not all(isinstance(item, Mapping) for item in objects):
        raise ValueError(f"{label} must contain object metadata")
    return objects


def _identity(item: Mapping[str, Any]) -> str:
    for key in ("ref", "uri", "path", "key", "name"):
        value = item.get(key)
        if isinstance(value, str) and value:
            return value
    raise ValueError("artifact object lacks an identity field (ref/uri/path/key/name)")


def _versions(item: Mapping[str, Any]) -> dict[str, Any]:
    versions = {
        key: item[key]
        for key in ("etag", "version", "version_id", "provider_version", "checksum", "sha256")
        if item.get(key) not in (None, "")
    }
    if not versions:
        raise ValueError("artifact metadata lacks etag/version")
    return versions


def verify_artifacts(manifest_path: str | Path, snapshot_path: str | Path) -> dict[str, Any]:
    """Compare every manifest object with a previously verified metadata snapshot.

    This function intentionally performs no object reads or network requests.  The snapshot is
    the authority for existence, byte size, and provider version metadata.
    """
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    snapshot = json.loads(Path(snapshot_path).read_text(encoding="utf-8"))
    manifest_objects = _objects(manifest, "manifest")
    snapshot_objects = _objects(snapshot, "snapshot")
    indexed: dict[str, Mapping[str, Any]] = {}
    for item in snapshot_objects:
        identity = _identity(item)
        if identity in indexed:
            raise ValueError(f"duplicate snapshot metadata for {identity}")
        indexed[identity] = item

    errors: list[str] = []
    seen: set[str] = set()
    for expected in manifest_objects:
        identity = _identity(expected)
        if identity in seen:
            errors.append(f"duplicate manifest object: {identity}")
            continue
        seen.add(identity)
        actual = indexed.get(identity)
        if actual is None:
            errors.append(f"missing verified metadata: {identity}")
            continue
        if actual.get("existence", actual.get("exists")) is not True:
            errors.append(f"artifact does not have existence=true: {identity}")
        expected_size = expected.get("size", expected.get("size_bytes"))
        actual_size = actual.get("size", actual.get("size_bytes"))
        if expected_size is None or actual_size is None:
            errors.append(f"missing size metadata: {identity}")
        elif expected_size != actual_size:
            errors.append(f"stale size metadata: {identity}")
        try:
            expected_versions = _versions(expected)
            actual_versions = _versions(actual)
        except ValueError:
            errors.append(f"missing etag/version metadata: {identity}")
        else:
            for key, expected_value in expected_versions.items():
                if key not in actual_versions:
                    errors.append(f"missing {key} metadata: {identity}")
                elif str(expected_value) != str(actual_versions[key]):
                    errors.append(f"stale {key} metadata: {identity}")
    if errors:
        raise ValueError("artifact verification failed: " + "; ".join(errors))
    return {"verified": len(manifest_objects), "status": "ok"}


def evaluate_tool_restraint(path: str | Path) -> dict[str, Any]:
    """Score JSONL cases where ``should_call_tool`` is compared with observed tool calls."""
    total = correct = 0
    for line_number, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        expected = row.get("should_call_tool")
        if not isinstance(expected, bool):
            raise ValueError(f"line {line_number} lacks boolean should_call_tool")
        if "called_tool" in row:
            observed = bool(row["called_tool"])
        else:
            observed = bool(row.get("tool_calls"))
        total += 1
        correct += observed == expected
    if total == 0:
        raise ValueError("tool-restraint input is empty")
    return {"correct": correct, "total": total, "accuracy": correct / total}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="subcommand", required=True)

    smoke = subparsers.add_parser("endpoint-smoke", help="probe an OpenAI-compatible endpoint")
    smoke.add_argument("--endpoint", required=True)
    smoke.add_argument("--model", required=True)
    smoke.add_argument("--prompt", default="Reply with OK.")
    smoke.add_argument("--api-key")
    smoke.add_argument("--timeout", type=float, default=30.0)

    restraint = subparsers.add_parser("tool-restraint", help="score a tool-restraint JSONL file")
    restraint.add_argument("input")
    for name in ("bfcl", "lm-eval", "toolathlon"):
        command = subparsers.add_parser(name, help=f"launch {name} through an explicit command")
        command.add_argument("command", nargs=argparse.REMAINDER)
        command.add_argument("--timeout", type=float)

    artifacts = subparsers.add_parser("artifacts", help="verify an artifact metadata snapshot")
    artifacts.add_argument("--manifest", required=True)
    artifacts.add_argument("--snapshot", required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.subcommand == "endpoint-smoke":
        output = endpoint_smoke(
            args.endpoint,
            model=args.model,
            prompt=args.prompt,
            api_key=args.api_key,
            timeout=args.timeout,
        )
    elif args.subcommand == "tool-restraint":
        output = evaluate_tool_restraint(args.input)
    elif args.subcommand == "artifacts":
        output = verify_artifacts(args.manifest, args.snapshot)
    else:
        result = run_subprocess(args.command, timeout=args.timeout)
        output = {"returncode": result.returncode, "stdout": result.stdout, "stderr": result.stderr}
    print(json.dumps(output, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
