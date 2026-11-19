#!/usr/bin/env python3
"""Build the recovered hosted UI from exact, locally retained public assets."""

import hashlib
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Presentation-only substitutions in the recovered login component. The
# existing auth_required:false branch and provider implementation stay intact.
LOGIN_TEXT = {
    "Welcome to Silico": "REA Astra · local research",
    "Sign in with GitHub to continue.": "Open this local workspace. Research runs use your configured Codex CLI; no GitHub login is needed.",
    "Sign in with GitHub": "Open local workspace",
    "By signing in, I agree to the": "Original product references:",
    "and confirm that I have read Goodfire's": "and",
    ". I understand that Goodfire may send me marketing emails, which I can unsubscribe from at any time.": ". Opening this local workspace does not create an account or subscribe you to email.",
    "If my organization has a separate written agreement with Goodfire governing its use of any Goodfire product or service, that agreement applies instead.": "Files and research history are stored by this local app. Model requests use the Codex CLI provider configured on this computer.",
}

SHARE_TEXT = {
    "Anyone with the link": "Local URL",
    "Anyone at ${e.trim()}": "Local workspace",
    "Anyone at your organization": "Local workspace",
    "Org members can open this ${t}": "Available inside this local workspace",
    "Anyone can open this ${t} on the web": "Open this ${t} through its local URL on this computer",
    "Anyone with the link can view": "Available through its local URL on this computer",
    "Anyone with the link can view the ": "Open the local ",
    "public page": "published local page",
    "Org members can view": "Available inside this local workspace",
    "Org members see your current work in ": "Current local work appears in ",
}


def patch_presentation(source):
    """Patch literal UI copy only; return the exact substitutions for audit."""
    applied = []
    for original, replacement in {**LOGIN_TEXT, **SHARE_TEXT}.items():
        literal = "`" + original + "`"
        count = source.count(literal)
        if count:
            source = source.replace(literal, "`" + replacement + "`")
            applied.append({"original": original, "replacement": replacement, "count": count})
    return source, applied


def build(root=ROOT):
    source = root / "evidence/hosted-static"
    target = root / "hosted-preview"
    if not (source / "entry.html").is_file():
        raise SystemExit("Hosted artifacts missing; see docs/hosted-frontend.md")
    target.mkdir(exist_ok=True)
    for directory in ("assets", "fonts"):
        if (source / directory).is_dir():
            shutil.copytree(source / directory, target / directory, dirs_exist_ok=True)
    for name in ("favicon.ico", "goodfire-icon.png", "og-image.png"):
        if (source / name).is_file():
            shutil.copy2(source / name, target / name)
    patched_assets = {}
    for path in (target / "assets").glob("*.js"):
        original = path.read_text()
        patched, changes = patch_presentation(original)
        if changes:
            path.write_text(patched)
            patched_assets[str(path.relative_to(target))] = changes
    html = (source / "entry.html").read_text()
    # Local UI uses bundled fonts; do not contact font/telemetry services on load.
    html = re.sub(r'<link\b[^>]*href="https?://[^\"]*"[^>]*>', "", html)
    # The hosted share launcher targets the installed production app. Local
    # publications must stay inside this independently implemented local service.
    html = re.sub(r'<script id="silico-share-handoff">[\s\S]*?</script>', "", html)
    html = html.replace("<title>Silico</title>", "<title>Silico · REA Astra local</title>")
    # Hide the original GitHub glyph on this one local entry button.
    html = html.replace("</head>", '<style>[data-testid="auth-github-login"] svg{display:none}</style></head>')
    (target / "index.html").write_text(html)
    manifest = []
    for path in sorted(target.rglob("*")):
        if path.is_file() and path.name != "build-manifest.json":
            relative = str(path.relative_to(target))
            original = source / ("entry.html" if relative == "index.html" else relative)
            row = {
                "path": relative,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "bytes": path.stat().st_size,
            }
            if original.is_file():
                row["source_sha256"] = hashlib.sha256(original.read_bytes()).hexdigest()
            if relative in patched_assets:
                row["presentation_patches"] = patched_assets[relative]
            manifest.append(row)
    (target / "build-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Built {len(manifest)} recovered UI files in {target}")


if __name__ == "__main__":
    build()
