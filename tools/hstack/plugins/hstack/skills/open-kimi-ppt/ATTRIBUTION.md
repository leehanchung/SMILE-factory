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
   then `pip --user`, then (e.g. on PEP 668 hosts) a private venv under
   `~/.cache/open-kimi-ppt/py`, and refreshes `sys.path` after
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

Supply-chain hardening:

13. Python requirements carry lower bounds that exclude releases with known
    advisories (`pyyaml>=6.0.2`, `pillow>=13.0`, `websocket-client>=1.9`), both in
    the PEP 723 blocks and in the on-demand installs; `export_images.py` therefore
    needs Python 3.11+. The `pip --break-system-packages` fallback is gone.
    agent-browser is installed as a pinned version (`AGENT_BROWSER_PIN`) into a
    private npm prefix under `~/.cache/open-kimi-ppt/node` instead of
    `npm install -g agent-browser@latest`. `editor/README.md` points at
    `scripts/serve.mjs` instead of `npx serve` / the unpublished package.

14. **Vulnerable JS libraries in the prebuilt editor replaced.** `editor/neo-ppt/` is
    a minified Vite/rolldown build of Kimi's closed-source neo-ppt frontend; upstream
    ships only the build output (no `src/`, `vite.config`, lockfile or `Cargo.toml`
    at the vendored commit), so it cannot be rebuilt. Dexie and KaTeX were emitted as
    their own chunks whose only export is the library's default object under the
    binding `t`, so those chunks were regenerated from the official npm dist files,
    keeping filenames and the export shape (no other chunk was edited):

    | Chunk | Was | Now | Advisory fixed |
    |---|---|---|---|
    | `dexie-HNSdyusO.js`, `dexie-legacy-MWmb6YS4.js` | Dexie 3.0.3 | 3.2.7 (`dist/dexie.mjs` / `dist/dexie.js`) | GHSA-3xgx-r9j4-qw9w / CVE-2022-21189 (prototype pollution) |
    | `katex-BotMgawn.js`, `katex-legacy-COlBCYAe.js`, `katex-Cg8Rrj4S.css` | KaTeX 0.16.45 | 0.18.11 (`dist/katex.mjs` / `dist/katex.js` / `dist/katex.min.css`) | GHSA-238p-pmpm-9mq7 |

    The ESM chunks are the dist module with its `export {...}` line rewritten to
    `export { <default> as t }`; the `-legacy` chunks wrap the UMD build in
    `System.register` (the KaTeX one also injects the CSS, as vite-plugin-legacy did).
    KaTeX font files are byte-identical between 0.16.45 and 0.18.11, so the CSS points
    at the existing hashed font assets (Size3 woff2 stays an inline data URI). The app
    only calls `renderToString` (`output: html` / `mathml`) and checks for
    `katex-error`; its own CSS targets `.katex`, `.katex>math` and `.mfrac`, none of
    which KaTeX 0.18's class prefixing renamed. The app subclasses Dexie and uses
    `version().stores()`, unchanged in 3.2.x; its existing IndexedDB opens as before.
    `tests/selftest.sh` fails if the chunks regress to the old versions.

    **Not fixed — the Rust/WASM modules** (`pptd_wasm_bg-DPPWdROu.wasm`: zip 4.6.1,
    quick-xml 0.38.4, unsafe-libyaml; `index_bg-Blvrv-U2.wasm`: resvg stack with
    bytes 1.6.0, rustybuzz/ttf-parser). No Rust source exists upstream and the
    crates are statically linked, so they cannot be bumped. Exposure is limited:
    the PPTX writer exports only `exportPPTDToPPTXBytes` (it writes archives from the
    user's own deck; the zip advisories, including GHSA-m665-v7pm-7grj, are in the
    archive reader/extraction paths), and the resvg module renders SVG from that same
    deck inside the browser/Node WASM sandbox.

Everything else — the `SKILL.md` body, `references/`, the rest of `scripts/`,
`tests/test_*.py` (apart from the agent-browser install test), and `editor/`
(apart from its README and the chunks listed in item 14) — is upstream as-is.

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
