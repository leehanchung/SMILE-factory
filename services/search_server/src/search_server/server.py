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
- Request bodies over ``MAX_REQUEST_BYTES`` are refused (413), and bodies not
  fully received within ``REQUEST_BODY_TIMEOUT`` seconds get 408, by an ASGI
  middleware before routing, auth or JSON parsing.
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
    validate_url_async,
)

MAX_QUERY_LENGTH = 2048
MAX_TOP_K = 100
MAX_REQUEST_BYTES = 64 * 1024
# Wall-clock budget for receiving a whole request body. The bearer-token check
# runs only after the body is in, so without this an unauthenticated client
# could trickle (or never finish) a body and hold the connection open.
REQUEST_BODY_TIMEOUT = 10.0

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


class BodySizeLimitMiddleware:
    """Pure-ASGI guard: refuse request bodies over `max_bytes` with 413.

    Runs before routing, auth and FastAPI's body parsing, which would otherwise
    read and JSON-decode an arbitrarily large body before the bearer-token
    dependency or the Pydantic field bounds could reject it. A declared
    ``Content-Length`` over the limit is refused without reading anything; a
    chunked body is buffered only up to the limit, then replayed to the app.
    The whole body must arrive within `body_timeout` seconds or the request gets
    408, so a slow or stalled upload cannot hold a task open before auth runs.
    """

    def __init__(self, app, max_bytes: int, body_timeout: float = REQUEST_BODY_TIMEOUT) -> None:
        self.app = app
        self.max_bytes = max_bytes
        self.body_timeout = body_timeout

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        for name, value in scope.get("headers", []):
            if name == b"content-length":
                try:
                    declared = int(value)
                except ValueError:
                    await self._reject(send, 400, b"invalid Content-Length")
                    return
                if declared > self.max_bytes:
                    await self._reject(send, 413, b"request body too large")
                    return
        body = bytearray()
        try:
            async with asyncio.timeout(self.body_timeout):
                while True:
                    message = await receive()
                    if message["type"] != "http.request":  # client disconnected
                        return
                    body.extend(message.get("body", b""))
                    if len(body) > self.max_bytes:
                        await self._reject(send, 413, b"request body too large")
                        return
                    if not message.get("more_body", False):
                        break
        except TimeoutError:
            await self._reject(send, 408, b"request body not received in time")
            return
        replayed = False

        async def replay():
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, replay, send)

    @staticmethod
    async def _reject(send, status_code: int, detail: bytes) -> None:
        payload = b'{"detail":"' + detail + b'"}'
        await send(
            {
                "type": "http.response.start",
                "status": status_code,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(payload)).encode()),
                    (b"connection", b"close"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": payload})


app = FastAPI(title="search-server")
# Every request body is tiny JSON (query/url <= 2048 chars); 64 KiB is ample.
app.add_middleware(BodySizeLimitMiddleware, max_bytes=MAX_REQUEST_BYTES)
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
        await validate_url_async(req.url)
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
