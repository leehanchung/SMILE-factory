#!/usr/bin/env python3
"""Run the installed REA CLI on the extracted shell, preserving every result."""

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rea", default=os.environ.get("REA", shutil.which("rea")))
    parser.add_argument(
        "--include-renderer",
        action="store_true",
        help="May exceed REA's per-source time budget; partial evidence is retained",
    )
    args = parser.parse_args()
    if not args.rea:
        parser.error("Provide --rea /absolute/path/to/rea (or REA environment variable). See docs/method.md.")
    launcher = Path(args.rea).absolute()
    extracted = ROOT / "extracted/app"
    if not (extracted / "package.json").is_file():
        parser.error("Run make extract first")
    output = ROOT / "evidence" / datetime.now(UTC).strftime("run-%Y%m%dT%H%M%S%fZ")
    output.mkdir(parents=True)
    paths = ["package.json", "out/main/index.js", "out/preload/index.js", "out/preload/lab.js"]
    if args.include_renderer:
        paths += ["out/renderer/index.html"]
        paths += [str(p.relative_to(extracted)) for p in sorted((extracted / "out/renderer/assets").glob("*.js"))]
    command = [str(launcher), "analyze-javascript-application", str(extracted)]
    for path in paths:
        command += ["--source-path", path]
    command += ["--detail", "summary", "--evidence_output", str(output / "bundle.json"), "--format", "json"]
    with (
        tempfile.TemporaryDirectory(prefix="rea-astra-cli-") as working,
        (output / "result.json").open("w") as result,
        (output / "progress.jsonl").open("w") as progress,
    ):
        completed = subprocess.run(command, cwd=working, stdout=result, stderr=progress, check=False)
    (output / "run.json").write_text(
        json.dumps({"command": command, "exit_code": completed.returncode}, indent=2) + "\n"
    )
    print(f"REA exit {completed.returncode}; saved complete output to {output}")
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
