#!/usr/bin/env bash
# Verify the open-kimi-ppt skill works from this checkout.
#
#   ./tests/selftest.sh          # Node-only + Python unit tests (fast, no browser)
#   ./tests/selftest.sh --full   # also exercises the browser export and image QA
#
# Requires Node.js 18+. Python paths are skipped when python3 is unavailable.
# --full additionally needs a Chromium-based browser; agent-browser self-installs.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FIXTURE="$SKILL_DIR/tests/fixtures/minimal"
FULL=0
[[ "${1:-}" == "--full" ]] && FULL=1

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; exit 1; }

echo "skill: $SKILL_DIR"

echo "[1] bundled assets"
[[ -f "$SKILL_DIR/editor/index.html" ]] || fail "editor mirror missing"
[[ -f "$SKILL_DIR/editor/neo-ppt/assets/pptd_wasm_bg-DPPWdROu.wasm" ]] || fail "patched WASM missing"
[[ -f "$SKILL_DIR/references/pptd.md" ]] || fail "references/pptd.md missing"
pass "editor mirror, WASM, and references are present"

echo "[2] node-only PPTX export (no Python, no browser)"
node --version >/dev/null 2>&1 || fail "Node.js is required"
node "$SKILL_DIR/scripts/local-export/export-pptd.mjs" "$FIXTURE" \
  -o "$WORK/node.pptx" --no-sign --transition fade >/dev/null
[[ -s "$WORK/node.pptx" ]] || fail "no PPTX produced"
pass "wrote $(wc -c <"$WORK/node.pptx" | tr -d ' ') bytes"

echo "[3] editor server"
node "$SKILL_DIR/scripts/serve.mjs" --port 55231 >"$WORK/serve.log" 2>&1 &
SERVE_PID=$!
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:55231/ || true)"
  [[ "$code" == "200" ]] && break
  sleep 0.2
done
kill "$SERVE_PID" 2>/dev/null || true
wait "$SERVE_PID" 2>/dev/null || true
[[ "${code:-}" == "200" ]] || fail "serve.mjs did not answer on 127.0.0.1:55231"
pass "serve.mjs serves the bundled editor"

if ! command -v python3 >/dev/null 2>&1; then
  echo "[4] python3 not found — skipping Python checks"
  echo "PASS (node-only)"
  exit 0
fi

echo "[4] python unit tests"
python3 -m unittest discover -s "$SKILL_DIR/tests" -p 'test_*.py' >"$WORK/unit.log" 2>&1 \
  || { cat "$WORK/unit.log"; fail "unit tests failed"; }
pass "$(grep -Eo 'Ran [0-9]+ tests' "$WORK/unit.log" | tail -1)"

echo "[5] python WASM export + verification"
python3 "$SKILL_DIR/scripts/export_pptx.py" "$FIXTURE" --output "$WORK/py.pptx" >"$WORK/py.json" 2>&1 \
  || { cat "$WORK/py.json"; fail "python export failed"; }
python3 - "$WORK/py.pptx" <<'PY'
import re, sys, zipfile
path = sys.argv[1]
with zipfile.ZipFile(path) as z:
    assert z.testzip() is None, "corrupt zip"
    slides = [n for n in z.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", n)]
    assert slides, "no slides"
    for name in slides:
        xml = z.read(name).decode("utf-8")
        end = xml.find("</p:cSld>")
        pos = xml.find("<p:transition")
        assert pos > end, f"{name}: transition is not at slide root"
        assert "<p:fade" in xml, f"{name}: missing fade"
print(f"  ok   {len(slides)} slide(s), root-level fade on each")
PY

if [[ "$FULL" == "0" ]]; then
  echo "PASS (browser paths skipped; rerun with --full)"
  exit 0
fi

echo "[6] browser PPTX export"
python3 "$SKILL_DIR/scripts/export_pptx.py" "$FIXTURE" \
  --output "$WORK/browser.pptx" --browser >"$WORK/browser.json" 2>&1 \
  || { cat "$WORK/browser.json"; fail "browser export failed"; }
pass "wrote $(wc -c <"$WORK/browser.pptx" | tr -d ' ') bytes"

echo "[7] image QA"
python3 "$SKILL_DIR/scripts/export_images.py" "$FIXTURE" \
  --output "$WORK/qa" >"$WORK/qa.json" 2>&1 \
  || { cat "$WORK/qa.json"; fail "image QA failed"; }
[[ -s "$WORK/qa/overview.jpg" ]] || fail "no overview image"
pass "stitched overview.jpg ($(ls "$WORK/qa/pages" | wc -l | tr -d ' ') page image(s))"

echo "PASS (full)"
