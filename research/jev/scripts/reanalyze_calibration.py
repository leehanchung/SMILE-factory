"""Offline notebook-04 reanalysis, writing only a new result directory."""

import argparse
from pathlib import Path

from jev_research.revised_analysis import run_analysis

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="New directory, never the historical run directory",
    )
    parser.add_argument("--bootstrap", type=int, default=1000)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    print(run_analysis(root, args.output, n_boot=args.bootstrap))
