"""Profile selected local UCI archives without sending records to an API."""

import hashlib
import io
import json
from pathlib import Path
from zipfile import ZipFile

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "uci"
profiles = []
for slug, member, target, positive in [
    ("south-german-credit", "SouthGermanCredit.asc", "kredit", 0),
    ("bank-marketing", "bank-additional/bank-additional-full.csv", "y", "yes"),
    ("online-shoppers", "online_shoppers_intention.csv", "Revenue", True),
]:
    archive = DATA / f"{slug}.zip"
    with ZipFile(archive) as z:
        if slug == "bank-marketing":
            with ZipFile(io.BytesIO(z.read("bank-additional.zip"))) as inner:
                content = inner.read(member)
        else:
            content = z.read(member)
    sep = r"\s+" if slug == "south-german-credit" else ";" if slug == "bank-marketing" else ","
    frame = pd.read_csv(io.BytesIO(content), sep=sep)
    features = frame.drop(columns=[target])
    profiles.append(
        {
            "dataset": slug,
            "source_member": member,
            "rows": len(frame),
            "features": len(features.columns),
            "target": target,
            "positive_label": positive,
            "positive_count": int((frame[target] == positive).sum()),
            "positive_rate": float((frame[target] == positive).mean()),
            "null_cells": int(frame.isna().sum().sum()),
            "duplicate_feature_rows": int(features.duplicated().sum()),
            "archive_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
            "table_sha256": hashlib.sha256(content).hexdigest(),
        }
    )
(DATA / "profile.json").write_text(json.dumps(profiles, indent=2) + "\n")
print(
    pd.DataFrame(profiles)[
        ["dataset", "rows", "features", "positive_count", "positive_rate", "duplicate_feature_rows"]
    ].to_string(index=False)
)
