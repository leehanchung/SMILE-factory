#!/usr/bin/env python3
"""Build an offline preview from recovered local renderer assets and our adapter.

No npm installation, target execution, or network access. Re-run after web edits.
The original app remains untouched; generated preview/ is local and Git-ignored.
"""

import argparse
from pathlib import Path
import re
import shutil


PROJECT = Path(__file__).resolve().parent.parent


def build(project=PROJECT):
    renderer = project / "extracted/app/out/renderer"
    bridge = project / "web/bridge.js"
    workspace = project / "web/workspace"
    if not (renderer / "index.html").is_file():
        raise SystemExit("Missing extracted renderer. Run make extract first.")
    required = [bridge, *(workspace / name for name in ("index.html", "app.js", "style.css", "model.js"))]
    missing = [str(path.relative_to(project)) for path in required if not path.is_file()]
    if missing:
        raise SystemExit("Missing preview sources: " + ", ".join(missing))
    preview = project / "preview"
    # Rebuild only our known generated subtrees; do not recursively delete a caller path.
    shell = preview / "shell"
    shell.mkdir(parents=True, exist_ok=True)
    shutil.copytree(renderer / "assets", shell / "assets", dirs_exist_ok=True)
    html = (renderer / "index.html").read_text()
    # Match the one declared CSP rather than loosening the installed application's CSP.
    html, count = re.subn(
        r'(http-equiv="Content-Security-Policy"\s+content=")[^"]*(")',
        r"\1default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'\2",
        html,
    )
    if count != 1:
        raise SystemExit("Expected exactly one renderer CSP; refusing an ambiguous preview build.")
    html = html.replace('<script type="module"', '<script type="module" src="/bridge.js"></script>\n    <script type="module"', 1)
    (shell / "index.html").write_text(html)
    shutil.copy2(bridge, preview / "bridge.js")
    shutil.copytree(workspace, preview / "workspace", dirs_exist_ok=True)
    (preview / "index.html").write_text(
        '<!doctype html><html lang="en"><meta charset="utf-8">'
        '<meta http-equiv="refresh" content="0;url=/workspace/">'
        '<title>REA Astra offline preview</title>'
        '<a href="/workspace/">Open workspace reconstruction</a> · '
        '<a href="/shell/">Open recovered desktop shell</a></html>\n'
    )
    print(f"Built {preview}\nServe with: python3 scripts/serve.py --port 8743")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    build()
