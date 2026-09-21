"""Build a deterministic, dependency-free HTML report from an immutable run directory."""

from __future__ import annotations

import argparse
import html
import json
from pathlib import Path
from typing import Any, Sequence

TRANSFER_CONCLUSION = (
    "no positive short-horizon BFCL transfer detected; long-horizon Toolathlon transfer unmeasured"
)
ARMS = ("base", "no_skill", "with_skill")
ARM_LABELS = {"base": "Base", "no_skill": "No-skill LoRA", "with_skill": "With-skill LoRA"}


def _read_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected a JSON object in {path}")
    return value


def _all_json(directory: Path) -> dict[str, Any]:
    if not directory.is_dir():
        return {}
    return {
        path.relative_to(directory).as_posix(): _read_json(path)
        for path in sorted(directory.rglob("*.json"))
        if path.is_file()
    }


def _percent(value: float, digits: int = 4) -> str:
    return f"{100 * value:.{digits}f}%"


def _panel_rows(final: dict[str, Any]) -> list[tuple[str, str, str, str]]:
    if not final:
        return []
    rows: list[tuple[str, str, str, str]] = []
    for arm in ARMS:
        rows.append(
            (
                "BFCL v4",
                ARM_LABELS[arm],
                _percent(final["bfcl"][arm]["accuracy"]),
                f"{final['bfcl'][arm]['correct']}/{final['bfcl']['n']}",
            )
        )
    for arm in ARMS:
        rows.append(
            (
                "IFEval strict",
                ARM_LABELS[arm],
                _percent(final["ifeval_prompt_strict"][arm]["accuracy"]),
                f"{final['ifeval_prompt_strict'][arm]['correct']}/{final['ifeval_prompt_strict']['n']}",
            )
        )
    for arm in ARMS:
        rows.append(
            (
                "MMLU-500",
                ARM_LABELS[arm],
                _percent(final["mmlu_fixed500"][arm]["accuracy"], 1),
                f"{final['mmlu_fixed500'][arm]['correct']}/{final['mmlu_fixed500']['n']}",
            )
        )
    for arm in ARMS:
        rate = final["tool_restraint"]["unnecessary_tool_call_rate"][arm]
        rows.append(
            (
                "Unnecessary tool calls",
                ARM_LABELS[arm],
                _percent(rate, 1),
                f"{final['tool_restraint']['n_pairs']} paired prompts",
            )
        )
    return rows


def build_report(run_dir: str | Path, output: str | Path) -> Path:
    """Render exact run metrics and provenance into a standalone HTML document."""
    run_path = Path(run_dir)
    final = _read_json(run_path / "metrics" / "final_metrics.json")
    provenance = _read_json(run_path / "provenance.json")
    provenance_documents = _all_json(run_path / "provenance")
    if provenance:
        provenance_documents["provenance.json"] = provenance
    metric_documents = _all_json(run_path / "metrics")
    outcome = str(provenance.get("outcome", "inconclusive"))
    if outcome.casefold() != "inconclusive":
        outcome = "inconclusive"

    headline = ""
    limitations = ""
    toolathlon = ""
    if final:
        delta = final["bfcl"]["deltas"]["with_minus_no_skill"]
        ci = final["bfcl"]["paired_bootstrap_95"]["with_minus_no_skill"]
        headline = (
            f"With-skill minus no-skill was {_percent(delta)} points on BFCL v4 "
            f"(paired 95% CI [{_percent(ci[0])}, {_percent(ci[1])}]) over "
            f"{final['bfcl']['n']:,} paired items."
        )
        power = final["training_power"]
        limitations = (
            f"One seed; {power['matched_train_rows_per_arm']} matched training rows and "
            f"{power['supervised_tokens_per_arm']:,} supervised tokens per arm "
            f"({_percent(power['cap_utilization'], 4)} of the planned cap)."
        )
        status = final["toolathlon"]
        toolathlon = (
            f"Toolathlon status: {status['status']}. The official service accepted "
            f"{status['accepted_submissions']} of {status['official_admission_attempts']} "
            "admission attempts, so no task reached preprocessing, execution, or verification."
        )

    table_rows = "\n".join(
        "<tr>"
        f"<td>{html.escape(benchmark)}</td><td>{html.escape(arm)}</td>"
        f"<td>{html.escape(score)}</td><td>{html.escape(count)}</td>"
        "</tr>"
        for benchmark, arm, score, count in _panel_rows(final)
    )
    raw_metrics = json.dumps(metric_documents, ensure_ascii=False, indent=2, sort_keys=True)
    raw_provenance = json.dumps(provenance_documents, ensure_ascii=False, indent=2, sort_keys=True)
    title = f"SkillsBench trajectory transfer — {run_path.name}"
    document = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<style>
body{{font:16px/1.55 system-ui,sans-serif;max-width:960px;margin:3rem auto;padding:0 1rem;color:#1d272a}}
header{{border-left:6px solid #c4650d;padding-left:1rem}}.outcome{{font-size:1.5rem;font-weight:700}}
table{{border-collapse:collapse;width:100%}}th,td{{border-bottom:1px solid #d8d4ca;padding:.65rem;text-align:left}}
pre{{background:#f4f1eb;padding:1rem;overflow:auto;font-size:.78rem}}.caveat{{background:#fff4df;padding:1rem}}
</style>
</head>
<body>
<header>
<h1>{html.escape(title)}</h1>
<p class="outcome">Outcome: {html.escape(outcome)}</p>
<p><strong>{html.escape(TRANSFER_CONCLUSION)}</strong></p>
<p>{html.escape(headline)}</p>
</header>
<main>
<h2>Recorded benchmark panel</h2>
<table><thead><tr><th>Benchmark</th><th>Checkpoint</th><th>Score</th><th>Count</th></tr></thead>
<tbody>{table_rows}</tbody></table>
<h2>Interpretation and limits</h2>
<p>{html.escape(toolathlon)}</p>
<p class="caveat">{html.escape(limitations)}</p>
<h2>Metrics source</h2><pre>{html.escape(raw_metrics)}</pre>
<h2>Provenance</h2><pre>{html.escape(raw_provenance)}</pre>
</main>
<footer>Generated deterministically from committed run metrics and provenance.</footer>
</body>
</html>
"""
    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(document, encoding="utf-8")
    return output_path


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--output", required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    build_report(args.run_dir, args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
