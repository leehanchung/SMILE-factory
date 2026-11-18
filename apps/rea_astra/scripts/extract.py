#!/usr/bin/env python3
"""Inventory an Electron ASAR and extract app-owned files without executing them."""

import argparse
import hashlib
import json
import plistlib
import struct
from pathlib import Path, PurePosixPath


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_asar(path):
    data = path.read_bytes()
    if len(data) < 16:
        raise ValueError("Truncated ASAR prefix")
    size, header_size, pickle_size, json_size = struct.unpack_from("<4I", data)
    if size != 4 or header_size < 8 or pickle_size + 4 != header_size:
        raise ValueError("Invalid ASAR header")
    base = 8 + header_size
    if json_size > header_size - 8 or base > len(data):
        raise ValueError("ASAR header exceeds archive")
    header = json.loads(data[16:16 + json_size])
    entries = []

    def visit(files, parent=PurePosixPath()):
        for name, node in files.items():
            if not name or name in (".", "..") or "/" in name or "\\" in name:
                raise ValueError(f"Unsafe ASAR member: {name!r}")
            relative = parent / name
            if "files" in node:
                visit(node["files"], relative)
                continue
            item = {"path": str(relative)}
            if "link" in node or node.get("unpacked"):
                item.update(kind="link" if "link" in node else "unpacked", extracted=False)
                entries.append(item)
                continue
            offset, length = int(node["offset"]), node["size"]
            if offset < 0 or not isinstance(length, int) or length < 0 or base + offset + length > len(data):
                raise ValueError(f"ASAR member outside archive: {relative}")
            content = data[base + offset:base + offset + length]
            digest = sha256(content)
            integrity = node.get("integrity")
            if integrity and (integrity.get("algorithm") != "SHA256" or integrity.get("hash") != digest):
                raise ValueError(f"ASAR integrity mismatch: {relative}")
            item.update(kind="file", size=length, offset=offset,
                        sha256=digest, integrity_verified=bool(integrity))
            entries.append(item)

    visit(header["files"])
    return data, base, entries


def extract(app, output):
    if output.exists():
        raise ValueError(f"Output must be a new directory: {output}")
    archive = app / "Contents/Resources/app.asar"
    data, base, entries = read_asar(archive)
    with (app / "Contents/Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    output.mkdir(parents=True)
    sources = output / "app"
    for item in entries:
        owned = not item["path"].startswith("node_modules/")
        item["extracted"] = owned and item["kind"] == "file"
        if item["extracted"]:
            target = sources / item["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            start = base + item["offset"]
            target.write_bytes(data[start:start + item["size"]])
    manifest = {
        "schema_version": 1,
        "source": str(archive),
        "sha256": sha256(data),
        "bytes": len(data),
        "bundle_id": info.get("CFBundleIdentifier"),
        "version": info.get("CFBundleShortVersionString"),
        "files": entries,
        "scope": "Full member inventory; app-owned packed files extracted; dependencies, links and unpacked files not extracted",
    }
    (output / "inventory.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({k: v for k, v in manifest.items() if k != "files"}, indent=2))
    print(f"Inventoried {len(entries)} members; extracted {sum(e['extracted'] for e in entries)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, default=Path("/Applications/Silico.app"))
    parser.add_argument("--output", type=Path, default=Path("extracted"))
    args = parser.parse_args()
    extract(args.app.resolve(), args.output.absolute())
