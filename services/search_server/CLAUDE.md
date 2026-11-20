# CLAUDE.md — search-server

The tool/search HTTP service. Keep it behind a stable contract so the agent and
trainer never depend on the backend implementation.

## Commands

- `make serve` — run on :8000
- `make build-index CORPUS=... OUT=...` — build a retrieval index
- `make check` / `make test`

## Conventions

- **Heavy retrieval deps live ONLY here** (bm25/faiss/sentence-transformers).
  Never add them to `libs/dr_agent`.
- **Don't change the contract lightly** — `/search`, `/retrieve`, `/visit` are
  consumed by `dr_agent.tools`; a breaking change ripples to training and eval.
- **Secrets via env vars** (`SERPER_API_KEY`, `JINA_API_KEY`); never commit keys.
- **Security env vars**: `SEARCH_SERVER_HOST` (default `127.0.0.1`);
  `SEARCH_SERVER_TOKEN` (optional — when set, all endpoints except `/health`
  require `Authorization: Bearer <token>`; set it whenever you bind non-loopback);
  `SEARCH_SERVER_URL_ALLOWLIST` (optional comma-separated hostnames exempt from
  the `/visit` private-IP check).
- **`/visit` URLs are model-chosen = untrusted.** Every outbound fetch MUST go
  through `search_server.url_guard.safe_fetch` (http/https only, no userinfo,
  public IPs only incl. cloud metadata block, per-hop redirect re-validation,
  timeout + size cap). Never call httpx with `follow_redirects=True` on them.
- **Input bounds**: `query` 1–2048 chars, `top_k` 1–100, `url` ≤ 2048 chars.
- Prefer a **self-hosted index** for RL reproducibility; reserve the live-web
  backend for eval/serving where freshness matters.
