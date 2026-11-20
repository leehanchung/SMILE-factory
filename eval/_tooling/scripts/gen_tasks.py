#!/usr/bin/env python3
"""Generate BenchFlow task directories for SimpleQA and HotpotQA.

Each benchmark question becomes one self-contained BenchFlow task dir:

    tasks/<benchmark>/<benchmark>-<NNNN>/
      task.md                 frontmatter + prompt (answer -> /app/answer.txt)
      environment/Dockerfile  minimal ubuntu + python3 (verifier needs it)
      verifier/test.sh        reads /app/answer.txt, scores, writes reward.txt
      verifier/score.py       normalized scorer (SimpleQA match / HotpotQA EM+F1)
      verifier/gold.json      ground truth (kept out of the agent's /app sandbox)

The agent (pi) is told to write ONLY its final answer to /app/answer.txt; the
verifier reads that file and emits a reward in [0,1] to /logs/verifier/reward.txt.

Usage:
    uv run --with "datasets==5.2.0" python gen_tasks.py --benchmark simpleqa --n 50
    uv run --with "datasets==5.2.0" python gen_tasks.py --benchmark hotpotqa --n 50
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import shutil
import stat
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent       # eval/_tooling/scripts
EVAL_ROOT = HERE.parents[1]                   # eval/  (benchmarks live directly under it)

# SimpleQA source. An optional local copy of the CSV in the benchmark dir
# (gitignored) lets gen read it offline; when absent, gen downloads the upstream
# snapshot at the URL below.
SIMPLEQA_CSV_URL = (
    "https://openaipublic.blob.core.windows.net/simple-evals/simple_qa_test_set.csv"
)
SIMPLEQA_CSV_LOCAL = EVAL_ROOT / "benchmarks" / "simpleqa" / "simple_qa_test_set.csv"
# SHA-256 of the upstream CSV (2,012,910 bytes, Last-Modified 2024-10-30). Both the
# download and a local copy are verified against it; a mismatch aborts generation
# rather than silently building tasks from tampered/changed gold answers. If OpenAI
# intentionally republishes the file, re-hash it and update this constant.
SIMPLEQA_CSV_SHA256 = "feee3f7e7db3617e94e8fcf1977b756ec420ef8568f4e0fcbbe0e92e9d5fc032"

# HotpotQA: pin the HF dataset to an exact commit so regenerated tasks are
# reproducible and can't change underneath us (hotpotqa/hotpot_qa @ 2025-08-11).
HOTPOTQA_REPO = "hotpotqa/hotpot_qa"
HOTPOTQA_REVISION = "1908d6afbbead072334abe2965f91bd2709910ab"

# Base image for every generated task container, pinned to the multi-arch index
# digest of ubuntu:24.04 (Docker Hub, 2026-11-16). Bump tag+digest together.
BASE_IMAGE = (
    "ubuntu:24.04@sha256:73b999393d07f2bf65a40373778a44dc9a6d54ad7718d29247d8ff9413c4d6a8"
)

# ---------------------------------------------------------------------------
# Static task assets (identical across every task of a benchmark).
# ---------------------------------------------------------------------------

DOCKERFILE = f"""\
FROM {BASE_IMAGE}
RUN apt-get update -qq \\
 && apt-get install -y -qq python3 ca-certificates \\
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN mkdir -p /logs/verifier /logs/agent /logs/artifacts
"""

TEST_SH = """\
#!/bin/bash
# BenchFlow verifier: score the agent's answer against verifier/gold.json.
# Primary answer source is /app/answer.txt; if the agent never wrote it (e.g. a
# base model that narrates instead of tool-calling), fall back to its final
# transcript message in /logs/agent/acp_trajectory.jsonl. Writes a float reward
# in [0,1] to /logs/verifier/reward.txt.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p /logs/verifier
python3 "$HERE/score.py" \\
    "$HERE/gold.json" \\
    /app/answer.txt \\
    "${BENCHFLOW_AGENT_LOG_DIR:-/logs/agent}/acp_trajectory.jsonl" \\
    > /logs/verifier/reward.txt
cat /logs/verifier/reward.txt >&2
exit 0
"""

# Self-contained scorer: normalized match (SimpleQA) + SQuAD EM/F1 (HotpotQA).
SCORE_PY = '''\
"""Normalized QA scorer. Prints a single float reward in [0,1] to stdout."""
import json
import re
import string
import sys


def normalize(s: str) -> str:
    s = s.lower()
    s = "".join(ch for ch in s if ch not in set(string.punctuation))
    s = re.sub(r"\\b(a|an|the)\\b", " ", s)
    return " ".join(s.split())


def f1(pred: str, gold: str) -> float:
    p, g = normalize(pred).split(), normalize(gold).split()
    if not p or not g:
        return float(p == g)
    common = {}
    for t in p:
        if t in g:
            common[t] = min(p.count(t), g.count(t))
    num_same = sum(common.values())
    if num_same == 0:
        return 0.0
    precision = num_same / len(p)
    recall = num_same / len(g)
    return 2 * precision * recall / (precision + recall)


def first_line(text: str) -> str:
    for line in text.splitlines():
        line = line.strip()
        if line:
            return line
    return text.strip()


def final_text_from_trajectory(path: str) -> str:
    """Extract the agent's last assistant text from an ACP trajectory JSONL.

    Tolerant of schema variation: collects text under any assistant-role
    message/event and returns the last non-empty one.
    """
    try:
        lines = open(path).read().strip().splitlines()
    except OSError:
        return ""
    last = ""
    banner = "pi v"
    for line in lines:
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(ev, dict):
            continue
        text = ""
        # Schema A: BenchFlow ACP trajectory -> {"type":"agent_message","text":..}
        if ev.get("type") == "agent_message":
            text = ev.get("text", "")
            if text.strip().startswith(banner):  # skip pi's startup banner
                text = ""
        else:
            # Schema B: role/content message events
            msg = ev.get("message", ev)
            if isinstance(msg, dict) and msg.get("role") == "assistant":
                content = msg.get("content", "")
                if isinstance(content, str):
                    text = content
                elif isinstance(content, list):
                    text = " ".join(
                        c.get("text", "")
                        for c in content
                        if isinstance(c, dict) and c.get("type", "text") == "text"
                    )
        if text.strip():
            last = text.strip()
    return last


def main() -> None:
    gold = json.loads(open(sys.argv[1]).read())
    raw = ""
    try:
        raw = open(sys.argv[2]).read().strip()
    except OSError:
        raw = ""
    # Fall back to the agent transcript when no answer.txt was written.
    if not raw and len(sys.argv) > 3:
        raw = final_text_from_trajectory(sys.argv[3])
    pred = first_line(raw)
    answer = gold["answer"]
    benchmark = gold.get("benchmark", "simpleqa")
    if benchmark == "hotpotqa":
        # SQuAD-style: max over (EM, F1) is reported as F1; we reward F1.
        score = f1(pred, answer)
    else:
        # SimpleQA: short-form factual. Reward 1.0 when the normalized gold
        # answer appears in (or equals) the normalized prediction.
        np, na = normalize(pred), normalize(answer)
        score = 1.0 if (np == na or na in np) else 0.0
    print(f"{score:.4f}")


if __name__ == "__main__":
    main()
'''

PROMPT_TEMPLATE = """\
# {title}

## prompt

Answer the following question as accurately as possible.

Question: {question}

Write ONLY your final answer — no explanation, no reasoning — to the file
`/app/answer.txt`. The answer should be a short factual phrase. Overwrite the
file if it already exists.
"""

TASK_FRONTMATTER = """\
---
schema_version: "1.3"
metadata:
  author_name: "benchflow_pi"
  difficulty: medium
  category: capability
  tags: ["qa", "{benchmark}"]
agent:
  timeout_sec: 300
verifier:
  timeout_sec: 60
environment:
  cpus: 1
  memory_mb: 2048
---
"""


def _write_task(task_dir: Path, *, benchmark: str, question: str, answer: str, name: str) -> None:
    if task_dir.exists():
        shutil.rmtree(task_dir)
    (task_dir / "environment").mkdir(parents=True)
    (task_dir / "verifier").mkdir(parents=True)

    (task_dir / "task.md").write_text(
        TASK_FRONTMATTER.format(benchmark=benchmark)
        + PROMPT_TEMPLATE.format(title=name, question=question)
    )
    (task_dir / "environment" / "Dockerfile").write_text(DOCKERFILE)

    test_sh = task_dir / "verifier" / "test.sh"
    test_sh.write_text(TEST_SH)
    test_sh.chmod(test_sh.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    (task_dir / "verifier" / "score.py").write_text(SCORE_PY)
    (task_dir / "verifier" / "gold.json").write_text(
        json.dumps({"answer": answer, "benchmark": benchmark})
    )


def gen_simpleqa(n: int) -> list[tuple[str, str]]:
    if SIMPLEQA_CSV_LOCAL.exists():
        data, source = SIMPLEQA_CSV_LOCAL.read_bytes(), str(SIMPLEQA_CSV_LOCAL)
    else:  # vendored copy missing — fetch the upstream snapshot
        with urllib.request.urlopen(SIMPLEQA_CSV_URL, timeout=60) as resp:  # noqa: S310 (fixed https URL)
            data, source = resp.read(), SIMPLEQA_CSV_URL
    digest = hashlib.sha256(data).hexdigest()
    if digest != SIMPLEQA_CSV_SHA256:
        raise SystemExit(
            f"SimpleQA CSV checksum mismatch for {source}:\n"
            f"  expected sha256 {SIMPLEQA_CSV_SHA256}\n"
            f"  got      sha256 {digest}\n"
            "Refusing to generate tasks from an unverified dataset."
        )
    text = data.decode("utf-8")
    rows = list(csv.DictReader(io.StringIO(text)))
    out = []
    for row in rows[:n]:
        out.append((row["problem"].strip(), row["answer"].strip()))
    return out


def gen_hotpotqa(n: int) -> list[tuple[str, str]]:
    from datasets import load_dataset

    ds = load_dataset(
        HOTPOTQA_REPO, "distractor", split="validation", revision=HOTPOTQA_REVISION
    )
    out = []
    for row in ds.select(range(min(n, len(ds)))):
        out.append((row["question"].strip(), row["answer"].strip()))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--benchmark", required=True, choices=["simpleqa", "hotpotqa"])
    ap.add_argument("--n", type=int, default=50)
    ap.add_argument("--out", type=Path, default=EVAL_ROOT,
                    help="eval root; tasks are written to <out>/benchmarks/<benchmark>/tasks/")
    args = ap.parse_args()

    pairs = gen_simpleqa(args.n) if args.benchmark == "simpleqa" else gen_hotpotqa(args.n)

    bench_root = args.out / "benchmarks" / args.benchmark / "tasks"
    bench_root.mkdir(parents=True, exist_ok=True)
    for i, (question, answer) in enumerate(pairs):
        name = f"{args.benchmark}-{i:04d}"
        _write_task(
            bench_root / name,
            benchmark=args.benchmark,
            question=question,
            answer=answer,
            name=name,
        )
    print(f"Wrote {len(pairs)} {args.benchmark} tasks to {bench_root}")


if __name__ == "__main__":
    main()
