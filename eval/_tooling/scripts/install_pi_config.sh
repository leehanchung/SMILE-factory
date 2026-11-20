#!/bin/bash
# Install our engine provider config as ~/.pi/agent/models.json (pi reads it
# from there). If ENGINE_URL is set (the Makefile derives it from ENGINE_HOST /
# ENGINE_PORT unless overridden), point the provider's baseUrl at it; if
# ENGINE_API_KEY is set (the engine requires auth), swap it in for the committed
# placeholder key. The file is written 0600 via an atomic
# replace, so a pre-existing world-readable copy never ends up holding the key.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$HOME/.pi/agent"

python3 - "$HERE/../pi/models.json" "$HOME/.pi/agent/models.json" <<'PY'
import json, os, sys, tempfile

src, dest = sys.argv[1], sys.argv[2]
with open(src) as f:
    cfg = json.load(f)
provider = cfg["providers"]["sglang"]
url = os.environ.get("ENGINE_URL")
if url:
    provider["baseUrl"] = url.rstrip("/")
key = os.environ.get("ENGINE_API_KEY")
if key:
    provider["apiKey"] = key
# mkstemp creates the file 0600; os.replace swaps it in atomically, so the
# destination never keeps an older, looser mode.
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(dest), prefix=".models.", suffix=".json")
try:
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, dest)
except BaseException:
    os.remove(tmp)
    raise
PY
