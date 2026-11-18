import yaml, json, pathlib
root = pathlib.Path("/home/workdir/artifacts/xiaomi-yu7")
m = yaml.safe_load((root / "xiaomi-yu7.pptd").read_text())
pages = []
for rel in m["pages"]:
    p = yaml.safe_load((root / rel).read_text())
    p["pagePath"] = rel
    pages.append(p)
print(json.dumps({**m, "version": "v2", "pages": pages}, ensure_ascii=False))
