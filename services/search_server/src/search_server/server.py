"""FastAPI tool service.

Contract consumed by dr_agent.tools:
    POST /search   {"query": str, "top_k": int}  -> {"results": [{"id","title","snippet","url"}]}
    POST /visit    {"url": str}                   -> {"content": str}
    POST /retrieve {"query": str, "top_k": int}   -> {"passages": [{"id","contents"}]}

The backend (BM25 / dense / web) is selected via config.yaml; swapping it must not
require any change in the agent or the trainer.
"""

from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="search-server")


class SearchRequest(BaseModel):
    query: str
    top_k: int = 10


class VisitRequest(BaseModel):
    url: str


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/search")
async def search(req: SearchRequest) -> dict:
    # TODO: dispatch to the configured backend (BM25 / dense / web).
    raise NotImplementedError


@app.post("/retrieve")
async def retrieve(req: SearchRequest) -> dict:
    # TODO: corpus passage retrieval (the RL-reproducible path; see QUEST FAISS).
    raise NotImplementedError


@app.post("/visit")
async def visit(req: VisitRequest) -> dict:
    # TODO: fetch + clean a page to markdown/text.
    raise NotImplementedError


def main() -> None:
    import os

    import uvicorn

    # Loopback by default: the service has no auth. Set SEARCH_SERVER_HOST=0.0.0.0
    # explicitly (e.g. inside a container on a private network) to expose it.
    host = os.environ.get("SEARCH_SERVER_HOST", "127.0.0.1")
    port = int(os.environ.get("SEARCH_SERVER_PORT", "8000"))
    uvicorn.run(app, host=host, port=port)
