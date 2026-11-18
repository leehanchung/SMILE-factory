"""FastAPI tool service.

Contract consumed by dr_agent.tools:
    POST /search   {"query": str, "top_k": int}  -> {"results": [{"id","title","snippet","url"}]}
    POST /visit    {"url": str}                   -> {"content": str}
    POST /retrieve {"query": str, "top_k": int}   -> {"passages": [{"id","contents"}]}

The backend (BM25 / dense / web) is selected via config.yaml; swapping it must not
require any change in the agent or the trainer.

Security:
- Optional shared secret: when ``SEARCH_SERVER_TOKEN`` is set, every endpoint
  except ``/health`` requires ``Authorization: Bearer <token>``.
- ``/visit`` URLs are model-chosen; they are SSRF-checked (``url_guard``) before
  any fetch, and the implementation must fetch via ``url_guard.safe_fetch``.
"""

from __future__ import annotations

import asyncio
import hmac
import os

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field, field_validator

from search_server.url_guard import (
    MAX_URL_LENGTH,
    UnsafeURLError,
    check_url_syntax,
    validate_url,
)

MAX_QUERY_LENGTH = 2048
MAX_TOP_K = 100

TOKEN_ENV = "SEARCH_SERVER_TOKEN"


def require_token(authorization: str | None = Header(default=None)) -> None:
    """Enforce `Authorization: Bearer <SEARCH_SERVER_TOKEN>` when the env var is set."""
    expected = os.environ.get(TOKEN_ENV)
    if not expected:
        return  # auth disabled; loopback bind is the protection
    scheme, _, supplied = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(
        supplied.strip().encode(), expected.encode()
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )


app = FastAPI(title="search-server")
api = APIRouter(dependencies=[Depends(require_token)])


class SearchRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=MAX_QUERY_LENGTH)
    top_k: int = Field(10, ge=1, le=MAX_TOP_K)


class VisitRequest(BaseModel):
    url: str = Field(..., min_length=1, max_length=MAX_URL_LENGTH)

    @field_validator("url")
    @classmethod
    def _url_syntax(cls, v: str) -> str:
        # Network-free checks (scheme, userinfo, host) -> 422. DNS/IP checks run
        # in the handler (blocking lookup kept off the event loop) -> 400.
        try:
            check_url_syntax(v)
        except UnsafeURLError as e:
            raise ValueError(str(e)) from None
        return v


@app.get("/health")
async def health() -> dict:
    return {"status": "ok"}


@api.post("/search")
async def search(req: SearchRequest) -> dict:
    # TODO: dispatch to the configured backend (BM25 / dense / web).
    raise NotImplementedError


@api.post("/retrieve")
async def retrieve(req: SearchRequest) -> dict:
    # TODO: corpus passage retrieval (the RL-reproducible path; see QUEST FAISS).
    raise NotImplementedError


@api.post("/visit")
async def visit(req: VisitRequest) -> dict:
    try:
        await asyncio.to_thread(validate_url, req.url)
    except UnsafeURLError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from None
    # TODO: fetch via `url_guard.safe_fetch(req.url)` (re-validates redirects,
    # caps size/time) and clean the page to markdown/text. Never use a bare
    # httpx/requests call with follow_redirects here.
    raise NotImplementedError


app.include_router(api)


def main() -> None:
    import uvicorn

    # Loopback by default. Set SEARCH_SERVER_HOST=0.0.0.0 explicitly (e.g. inside a
    # container on a private network) to expose it, and set SEARCH_SERVER_TOKEN.
    host = os.environ.get("SEARCH_SERVER_HOST", "127.0.0.1")
    port = int(os.environ.get("SEARCH_SERVER_PORT", "8000"))
    uvicorn.run(app, host=host, port=port)
