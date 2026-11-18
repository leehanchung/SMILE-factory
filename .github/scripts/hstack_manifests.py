#!/usr/bin/env python3
"""Validate and version-stamp the hstack plugin manifests.

hstack ships one payload to three platforms, each with its own manifest.
Every manifest must agree on the plugin name and version. The publish job
also uses this script to set the patch version, so installed copies see
each publish as an update.

Usage:
  hstack_manifests.py check   <hstack_dir>
  hstack_manifests.py version <hstack_dir>            # print current version
  hstack_manifests.py next    <src_dir> <mirror_dir>  # print next version to publish
  hstack_manifests.py stamp   <hstack_dir> <version>
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

NAME = "hstack"
VERSIONED = [
    ".claude-plugin/marketplace.json",
    ".cursor-plugin/plugin.json",
    "plugins/hstack/.claude-plugin/plugin.json",
    "plugins/hstack/.codex-plugin/plugin.json",
]
UNVERSIONED = [".agents/plugins/marketplace.json"]
VERSION_RE = re.compile(r'("version"\s*:\s*")(\d+\.\d+\.\d+)(")')
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def fail(msg: str) -> None:
    print(f"::error::{msg}")
    sys.exit(1)


def versions(root: Path) -> dict[str, str]:
    out = {}
    for rel in VERSIONED:
        found = VERSION_RE.findall((root / rel).read_text())
        if len(found) != 1:
            fail(f"{rel}: expected exactly one semver \"version\" field, found {len(found)}")
        out[rel] = found[0][1]
    return out


def check(root: Path) -> None:
    docs = {}
    for rel in VERSIONED + UNVERSIONED:
        try:
            docs[rel] = json.loads((root / rel).read_text())
        except (OSError, json.JSONDecodeError) as e:
            fail(f"{rel}: {e}")

    names = {
        ".cursor-plugin/plugin.json": docs[".cursor-plugin/plugin.json"]["name"],
        "plugins/hstack/.claude-plugin/plugin.json": docs["plugins/hstack/.claude-plugin/plugin.json"]["name"],
        "plugins/hstack/.codex-plugin/plugin.json": docs["plugins/hstack/.codex-plugin/plugin.json"]["name"],
    }
    for rel in (".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"):
        entries = [p["name"] for p in docs[rel].get("plugins", [])]
        if entries != [NAME]:
            fail(f"{rel}: plugins must be exactly [{NAME!r}], got {entries}")
    for rel, name in names.items():
        if name != NAME:
            fail(f"{rel}: name is {name!r}, expected {NAME!r}")

    vs = versions(root)
    if len(set(vs.values())) != 1:
        fail("manifest versions disagree: " + ", ".join(f"{k}={v}" for k, v in vs.items()))

    skills = root / "plugins/hstack/skills"
    for skill in sorted(p for p in skills.iterdir() if p.is_dir()):
        md = skill / "SKILL.md"
        if not md.is_file():
            fail(f"{skill.relative_to(root)}: missing SKILL.md")
        m = re.search(r"^name:\s*(\S+)\s*$", md.read_text(), re.M)
        if not m or m.group(1) != skill.name:
            fail(f"{md.relative_to(root)}: frontmatter name must be {skill.name!r}")
    print(f"ok: {NAME} {next(iter(vs.values()))}, {sum(1 for p in skills.iterdir() if p.is_dir())} skills")


def current(root: Path) -> str:
    return next(iter(versions(root).values()))


def next_version(src: Path, mirror: Path) -> str:
    s = tuple(map(int, current(src).split(".")))
    try:
        m = tuple(map(int, current(mirror).split(".")))
    except (OSError, SystemExit):
        return current(src)
    if s[:2] > m[:2]:  # MAJOR/MINOR bumped in the monorepo
        return f"{s[0]}.{s[1]}.0"
    return f"{m[0]}.{m[1]}.{m[2] + 1}"


def stamp(root: Path, version: str) -> None:
    if not SEMVER.match(version):
        fail(f"not a semver: {version}")
    for rel in VERSIONED:
        p = root / rel
        p.write_text(VERSION_RE.sub(rf"\g<1>{version}\g<3>", p.read_text(), count=1))


def main(argv: list[str]) -> None:
    cmd, *args = argv
    if cmd == "check":
        check(Path(args[0]))
    elif cmd == "version":
        print(current(Path(args[0])))
    elif cmd == "next":
        print(next_version(Path(args[0]), Path(args[1])))
    elif cmd == "stamp":
        stamp(Path(args[0]), args[1])
    else:
        fail(f"unknown command {cmd}")


if __name__ == "__main__":
    main(sys.argv[1:])
