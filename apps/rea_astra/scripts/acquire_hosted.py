#!/usr/bin/env python3
"""Archive an explicitly selected hosted SPA and its literal static references.

Usage: python3 scripts/acquire_hosted.py https://HOST/workspace/WORKSPACE/new
Output defaults to ignored evidence/hosted-static. No credentials, API requests,
browser profiles, speculative sourcemap URLs, or external assets are used.
The selected entry must be a static SPA shell, not a server-rendered data page.
Every saved artifact receives its SHA-256, byte count and reference provenance.
"""
import argparse
from collections import deque
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.parse import unquote, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

EXTENSIONS = r"(?:js|css|svg|png|jpg|jpeg|ico|webp|gif|woff2?|ttf|otf|map)"
LITERAL = re.compile(r'''["'`]((?:/|\./|assets/|fonts/)[^"'`\s<>?{}]+\.''' + EXTENSIONS + r''')["'`]''')
CSS_URL = re.compile(r'''url\(\s*["']?([^"')\s?{}]+\.''' + EXTENSIONS + r''')["']?\s*\)''')
MAP_URL = re.compile(r"sourceMappingURL=([^\s]+)")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Redirect refused; supply the final operator-selected URL")


class EntryParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.static_entry = False
        self.hydration = False
        self.refs = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "script":
            self.static_entry |= attrs.get("type") == "module" and bool(attrs.get("src"))
            self.hydration |= attrs.get("type") in {"application/json", "application/ld+json"} or attrs.get("id") == "__NEXT_DATA__"
        for key in ("src", "href"):
            value = attrs.get(key, "")
            if re.search(r"\." + EXTENSIONS + r"$", value):
                self.refs.append(value)


def acquire(entry_url, output):
    parsed = urlsplit(entry_url)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Supply a credential-free HTTPS entry URL without query/fragment")
    origin = parsed.scheme + "://" + parsed.netloc
    output.mkdir(parents=True, exist_ok=True)
    opener = build_opener(ProxyHandler({}), NoRedirect())

    def fetch(url):
        with opener.open(Request(url, headers={"User-Agent": "rea-astra-static-analysis/1.0"}), timeout=30) as response:
            data = response.read(30_000_001)
            content_type = response.headers.get("Content-Type", "")
        if len(data) > 30_000_000:
            raise ValueError("Asset exceeds 30 MB limit")
        return data, content_type

    data, content_type = fetch(entry_url)
    entry = EntryParser()
    entry.feed(data.decode("utf-8"))
    if not entry.static_entry or entry.hydration:
        raise ValueError("Entry is not a plain static module shell; no HTML saved")
    (output / "entry.html").write_bytes(data)
    entry_record = {"request_path": parsed.path, "path": "entry.html", "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "content_type": content_type}
    queue = deque([(parsed.path, data.decode("utf-8"), ".html", entry.refs)])
    known, errors = {}, []
    total = len(data)
    while queue:
        parent, source, suffix, extra_refs = queue.popleft()
        refs = extra_refs + [m[1] for m in LITERAL.finditer(source)]
        if suffix == ".css":
            refs += [m[1] for m in CSS_URL.finditer(source)]
        refs += [m[1] for m in MAP_URL.finditer(source)]
        for ref in refs:
            url = urljoin(origin + ("/" if ref.startswith(("assets/", "fonts/")) else parent), ref)
            target = urlsplit(url)
            if target.netloc != parsed.netloc or target.scheme != "https" or target.query or target.fragment:
                continue
            if target.path in known:
                continue
            relative = Path(unquote(target.path).lstrip("/"))
            if any(p in ("..", ".") or p.startswith(".") for p in relative.parts) or "\\" in str(relative):
                raise ValueError("Unsafe asset destination")
            if len(known) >= 500 or total > 150_000_000:
                raise ValueError("Static reference/download bound exceeded")
            try:
                data, content_type = fetch(url)
                if "text/html" in content_type or data.lstrip().lower().startswith((b"<!doctype html", b"<html")):
                    raise ValueError("SPA fallback instead of asset; discarded")
                destination = output / relative
                if not destination.resolve().is_relative_to(output.resolve()):
                    raise ValueError("Asset destination escaped output")
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)
                total += len(data)
                known[target.path] = {"path": str(relative), "request_path": target.path, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "content_type": content_type, "referenced_by": parent}
                if relative.suffix in {".js", ".css", ".map"}:
                    queue.append((target.path, data.decode("utf-8", errors="replace"), relative.suffix, []))
            except Exception as exc:
                errors.append({"reference": ref, "referenced_by": parent, "error": str(exc)})
    (output / "entry-manifest.json").write_text(json.dumps(entry_record, indent=2) + "\n")
    (output / "manifest.json").write_text(json.dumps(list(known.values()), indent=2) + "\n")
    (output / "acquisition-errors.json").write_text(json.dumps(errors, indent=2) + "\n")
    print(json.dumps({"assets": len(known), "bytes": total, "errors": len(errors), "output": str(output)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", help="Exact operator-selected hosted entry URL")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "evidence/hosted-static")
    args = parser.parse_args()
    acquire(args.url, args.output)
