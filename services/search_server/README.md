# search-server

The tool/search HTTP service for the deep-research agent. It exists so that:

- **heavy retrieval deps** (BM25, faiss, sentence-transformers) are isolated from
  `libs/dr_agent` and from the trainer — no faiss-vs-vllm dependency hell;
- the agent reaches tools over **one stable contract**, so backends (BM25 ↔ dense
  ↔ live web) are swappable without touching the agent or the RL loop;
- RL rollouts can hit a **self-hosted, reproducible** index instead of a
  rate-limited live API (the QUEST/Search-R1 pattern).

## Contract

```
POST /search   {"query","top_k"}  -> {"results":[{"id","title","snippet","url"}]}
POST /retrieve {"query","top_k"}  -> {"passages":[{"id","contents"}]}
POST /visit    {"url"}            -> {"content"}
GET  /health                     -> {"status":"ok"}
```

## Run

```bash
make build-index CORPUS=corpus.jsonl OUT=./index   # one-time, for bm25/dense
make serve                                         # serves on :8000
```

Consumed by `dr_agent.tools` (set `AgentConfig.tool_server_url`).

## Security

- Binds `127.0.0.1` by default; override with `SEARCH_SERVER_HOST`.
- Optional shared secret: set `SEARCH_SERVER_TOKEN` and every endpoint except
  `/health` requires `Authorization: Bearer <token>` (constant-time compare).
  Unset = no auth (rely on the loopback bind). Always set it when exposing the
  service beyond loopback; clients must then send the header.
- `/visit` is SSRF-guarded (`src/search_server/url_guard.py`): http/https only,
  no credentials in the URL, and the host must resolve only to public IPs
  (private, loopback, link-local, CGNAT, reserved, multicast and cloud-metadata
  addresses are rejected with 400). `safe_fetch` re-validates every redirect hop
  (max 5) and caps time and response size. `SEARCH_SERVER_URL_ALLOWLIST`
  (comma-separated hostnames) exempts specific internal hosts. Residual risk:
  DNS rebinding between check and connect; pair with an egress firewall.
- Request bounds: `query` 1–2048 chars, `top_k` 1–100 (default 10), `url` ≤ 2048
  chars; violations return 422.

> Why `services/` and not `infra/`: `infra/` is for deployment/infrastructure;
> this is a runtime application service.
