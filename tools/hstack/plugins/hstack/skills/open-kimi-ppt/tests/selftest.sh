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
# Dexie/KaTeX chunks were rebuilt from patched npm releases (see ATTRIBUTION.md);
# fail if a re-vendor brings back the versions with known advisories.
ASSETS="$SKILL_DIR/editor/neo-ppt/assets"
grep -q 'Dexie.js 3.2.7' "$ASSETS/dexie-HNSdyusO.js" && grep -q 'Dexie.js 3.2.7' "$ASSETS/dexie-legacy-MWmb6YS4.js" \
  || fail "Dexie chunk is not the patched 3.2.7 build (CVE-2022-21189)"
grep -q 'KaTeX 0.18.11' "$ASSETS/katex-BotMgawn.js" && grep -q 'KaTeX 0.18.11' "$ASSETS/katex-legacy-COlBCYAe.js" \
  || fail "KaTeX chunk is not the patched 0.18.11 build (GHSA-238p-pmpm-9mq7)"
pass "Dexie 3.2.7 and KaTeX 0.18.11 chunks"
# The Rust/WASM modules were triaged for advisories by content (ATTRIBUTION.md
# item 15); a different binary needs that triage redone before it ships.
sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
[[ "$(sha256_of "$ASSETS/pptd_wasm_bg-DPPWdROu.wasm")" == "f62500af4546ab379b458d405c2c6b18d659a1a18a4299baba03ccb4dc08e746" ]] \
  || fail "pptd_wasm binary changed; redo the advisory triage in ATTRIBUTION.md item 15"
[[ "$(sha256_of "$ASSETS/index_bg-Blvrv-U2.wasm")" == "22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70" ]] \
  || fail "resvg WASM binary changed; redo the advisory triage in ATTRIBUTION.md item 15"
pass "WASM binaries match the triaged builds"

echo "[1b] RUSTSEC-2026-0194 input guard"
node --input-type=module -e "
const m = await import('$SKILL_DIR/scripts/local-export/export-pptd.mjs');
const attrs = Array.from({ length: m.MAX_ATTRS_PER_TAG + 1 }, (_, i) => 'a' + i + '=1').join(' ');
if (m.findOversizedTag({ html: '<p class=x>ok</p>' })) process.exit(1);
if (!m.findOversizedTag({ s: [{ html: '<span ' + attrs + '>x</span>' }] })) process.exit(2);
// a quoted '>' must not end the tag scan early
if (!m.findOversizedTag({ html: '<span title=\">\" ' + attrs + '>x</span>' })) process.exit(3);
if (!m.findOversizedTag({ html: \"<span title='a>b' \" + attrs + '>x</span>' })) process.exit(4);
// text '<' is not a tag; a tag at the cap passes
if (m.findOversizedTag({ html: 'a < b ' + attrs })) process.exit(5);
const atCap = Array.from({ length: m.MAX_ATTRS_PER_TAG }, (_, i) => 'a' + i + '=\"x y>\"').join(' ');
if (m.findOversizedTag({ html: '<span ' + atCap + '>x</span>' })) process.exit(6);
// any XML NameStartChar opens a tag, not just ASCII letters
for (const name of ['_x', ':x', '\u00e9', '\u540d', '\u{10400}', '1x', '-x', '.x']) {
  if (!m.findOversizedTag({ html: '<' + name + ' ' + attrs + '>x</' + name + '>' })) process.exit(7);
}
// '< b ... >' is a tag to quick-xml; closing tags, comments and PIs are not
if (!m.findOversizedTag({ html: 'a < b ' + attrs + '> c' })) process.exit(10);
for (const p of ['!--', '/', '?pi']) if (m.findOversizedTag({ html: '<' + p + ' ' + attrs + '>' })) process.exit(11);
// self-referential values (YAML anchors) terminate
const loop = []; loop.push(loop); const cyc = { loop }; cyc.self = cyc;
if (m.findOversizedTag(cyc)) process.exit(8);
loop.push('<span ' + attrs + '>x</span>');
if (!m.findOversizedTag(cyc)) process.exit(9);
" || fail "oversized-attribute guard broken"
pass "rich-text attribute cap enforced"

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
