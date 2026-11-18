# Attribution

This skill is vendored from [jinwyp/open-ppt-skill](https://github.com/jinwyp/open-ppt-skill)
(upstream of the `open-kimi-ppt-skill` npm package), which is MIT licensed.

- Upstream version: `1.3.0`
- Upstream commit: `07eeaadcb04c32c9adb107eb5c8608e6be4e1008` (2026-08-07)
- Upstream paths vendored: `skills/open-kimi-ppt/` and `editor/`

## Why it is fully vendored

The `open-kimi-ppt-skill` npm package was **unpublished from the registry on
2026-08-07**, so `npx open-kimi-ppt-skill install` / `serve` now fail with a 404.
Upstream's install flow, the offline editor mirror, and the manual editor all
depended on it. Vendoring the editor (~20 MB) and replacing the `serve` entry
point with a self-contained script removes that dependency entirely: this skill
needs Node.js 18+ and nothing else for its default deliverable.

Run `./tests/selftest.sh` (add `--full` for the browser paths) to verify a checkout.

## Local modifications

Layout and metadata:

1. `reference/` renamed to `references/` (hstack convention); all internal path
   references updated.
2. `allowed-tools` added to the `SKILL.md` frontmatter (required by the Codex manifest).
3. Hardcoded `~/.agents/skills/open-kimi-ppt/scripts/...` command paths replaced with
   `"$SKILL_DIR"/scripts/...`, since the plugin installs outside `~/.agents/skills`.
4. `editor/` vendored from the upstream package root into the skill directory. Both
   `resolve_editor_root()` (Python) and `resolve_local_wasm()` already probe
   `<skill>/editor/`, so the mirror and the patched WASM writer resolve with no
   configuration.

Dependency removal:

5. `scripts/serve.mjs` added — a self-contained port of upstream's
   `lib/editor-server.js` plus a CLI, replacing `npx open-kimi-ppt-skill serve`.
   Honors `OPEN_KIMI_PPT_EDITOR`, supports `--port` / `--open`.
6. `resolveDefaultWasmPath()` in `scripts/local-export/export-pptd.mjs` gained a
   `<skill>/editor/neo-ppt/assets/` candidate, so the Node writer finds the WASM
   without a `--wasm` flag and without a duplicated copy of the binary.
7. `ensure_module()` added to `scripts/export_pptx.py`, replacing three separate
   `pip install --user` call sites (PyYAML, Pillow, websocket-client). It tries uv,
   then `pip --user`, then `pip --break-system-packages` (PEP 668 hosts), then a
   private venv under `~/.cache/open-kimi-ppt/py`, and refreshes `sys.path` after
   each attempt. **Upstream's version could not succeed on a first run**: `site.py`
   only records site-packages directories that existed at interpreter start, so the
   freshly installed package stayed unimportable and the script died.
8. PEP 723 inline script metadata added to both Python entry points, so
   `uv run scripts/export_pptx.py ...` resolves dependencies with no system changes.

Bug fixes:

9. `download_via_click()` added to `scripts/export_pptx.py` and used by both the
   `--browser` export and image QA. Upstream clicked the download button and then
   polled `~/Downloads` for a new file; headless Chrome does not reliably persist
   downloads there, so **both browser paths timed out on every run**. The helper
   uses `agent-browser download <sel> <path>` (CDP-captured, written where asked)
   and falls back to the old click-and-poll for older agent-browser builds.
10. `EDITOR_MISSING_HINT` no longer points at the unpublished npm package.

Additions:

11. `tests/selftest.sh` — verifies bundled assets, the Node-only export, the editor
    server, the 21 upstream unit tests, and PPTX structure; `--full` also runs the
    browser export and image QA.
12. `SKILL.md` step0 rewritten to describe the real dependency tiers (Node required,
    Python and Chromium optional) and to state that `npx open-kimi-ppt-skill` is dead.
    Step5.6 now leads with the Node-only export command.

Everything else — the `SKILL.md` body, `references/`, the rest of `scripts/`,
`tests/test_*.py`, and `editor/` — is upstream as-is.

## Upstream license

```
MIT License

Copyright (c) 2026 Binaryify Zhuang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
