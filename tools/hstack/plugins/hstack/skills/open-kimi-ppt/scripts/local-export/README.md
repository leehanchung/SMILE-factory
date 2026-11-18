# Local patched WASM PPTX exporter

- `export-pptd.mjs` — Node entry (official WASM glue, `--no-sign`)
- Patched WASM **canonical path** (repo / npm package):  
  `editor/neo-ppt/assets/pptd_wasm_bg-DPPWdROu.wasm`  
  Skill install copies it to `scripts/local-export/pptd_wasm_bg.wasm`.
- Used by `../export_pptx.py` as the **default** export path

```bash
# from repo: resolves editor/neo-ppt/assets/… automatically
node export-pptd.mjs /path/to/project -o out.pptx --no-sign

# or pass explicitly
node export-pptd.mjs /path/to/project -o out.pptx --no-sign \
  --wasm ../../../../editor/neo-ppt/assets/pptd_wasm_bg-DPPWdROu.wasm
```
