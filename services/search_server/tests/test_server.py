from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from search_server.server import MAX_REQUEST_BYTES, app


@pytest.fixture
def client():
    # Stubs raise NotImplementedError -> 500; reaching it means validation passed.
    return TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize("path", ["/search", "/retrieve"])
@pytest.mark.parametrize(
    "body",
    [
        {"query": "", "top_k": 10},
        {"query": "x" * 2049},
        {"query": "ok", "top_k": 0},
        {"query": "ok", "top_k": 101},
        {"query": "ok", "top_k": -5},
        {"top_k": 10},
    ],
)
def test_query_bounds_rejected(client, path, body):
    assert client.post(path, json=body).status_code == 422


@pytest.mark.parametrize("path", ["/search", "/retrieve"])
@pytest.mark.parametrize(
    "body", [{"query": "q"}, {"query": "q", "top_k": 1}, {"query": "x" * 2048, "top_k": 100}]
)
def test_query_bounds_accepted(client, path, body):
    # dr_agent contract: {"query","top_k"} with default top_k=10.
    assert client.post(path, json=body).status_code == 500


@pytest.mark.parametrize(
    "url",
    ["file:///etc/passwd", "ftp://public.example/", "http://u:p@public.example/", ""],
)
def test_visit_bad_syntax_422(client, url):
    assert client.post("/visit", json={"url": url}).status_code == 422


def test_visit_url_too_long_422(client):
    url = "http://public.example/" + "a" * 2048
    assert client.post("/visit", json={"url": url}).status_code == 422


@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254/latest/meta-data/",
        "http://internal.example/",
        "http://127.0.0.1:8000/health",
        "http://[::1]/",
        "http://nxdomain.example/",
    ],
)
def test_visit_unsafe_target_400(client, url):
    assert client.post("/visit", json={"url": url}).status_code == 400


def test_visit_public_reaches_handler(client):
    assert client.post("/visit", json={"url": "https://public.example/"}).status_code == 500


def test_no_token_means_no_auth(client):
    assert client.post("/search", json={"query": "q"}).status_code == 500


@pytest.mark.parametrize("path", ["/search", "/retrieve", "/visit"])
@pytest.mark.parametrize(
    "header",
    [None, "Bearer wrong", "Basic s3cret", "s3cret", "Bearer "],
)
def test_token_required_when_set(client, monkeypatch, path, header):
    monkeypatch.setenv("SEARCH_SERVER_TOKEN", "s3cret")
    headers = {"Authorization": header} if header is not None else {}
    body = {"url": "https://public.example/"} if path == "/visit" else {"query": "q"}
    r = client.post(path, json=body, headers=headers)
    assert r.status_code == 401
    assert r.headers["www-authenticate"] == "Bearer"


@pytest.mark.parametrize("path", ["/search", "/retrieve", "/visit"])
def test_token_accepted(client, monkeypatch, path):
    monkeypatch.setenv("SEARCH_SERVER_TOKEN", "s3cret")
    body = {"url": "https://public.example/"} if path == "/visit" else {"query": "q"}
    r = client.post(path, json=body, headers={"Authorization": "Bearer s3cret"})
    assert r.status_code == 500  # past auth + validation, into the stub


def test_health_never_needs_token(client, monkeypatch):
    monkeypatch.setenv("SEARCH_SERVER_TOKEN", "s3cret")
    assert client.get("/health").json() == {"status": "ok"}


def test_oversized_declared_body_rejected_before_auth(client, monkeypatch):
    monkeypatch.setenv("SEARCH_SERVER_TOKEN", "s3cret")
    big = b'{"query":"' + b"x" * (MAX_REQUEST_BYTES + 1) + b'"}'
    r = client.post("/search", content=big, headers={"content-type": "application/json"})
    assert r.status_code == 413  # not 401: refused before the token dependency


def test_oversized_chunked_body_rejected(client):
    def gen():
        for _ in range(MAX_REQUEST_BYTES // 1024 + 2):
            yield b"x" * 1024

    r = client.post("/search", content=gen(), headers={"content-type": "application/json"})
    assert r.status_code == 413


def test_small_chunked_body_still_reaches_handler(client):
    def gen():
        yield b'{"query":'
        yield b'"q"}'

    r = client.post("/search", content=gen(), headers={"content-type": "application/json"})
    assert r.status_code == 500  # stub reached


async def _run_middleware(receive_messages, delay: float, timeout: float = 0.2):
    """Drive BodySizeLimitMiddleware with a receive() that sleeps `delay` per call."""
    import asyncio

    from search_server.server import BodySizeLimitMiddleware

    reached = []

    async def app(scope, receive, send):
        reached.append(await receive())

    msgs = iter(receive_messages)

    async def receive():
        await asyncio.sleep(delay)
        return next(msgs)

    sent = []

    async def send(message):
        sent.append(message)

    mw = BodySizeLimitMiddleware(app, max_bytes=1024, body_timeout=timeout)
    await mw({"type": "http", "headers": []}, receive, send)
    return reached, sent


async def test_stalled_body_gets_408():
    # Never completes: more_body stays True and each chunk trickles in.
    msgs = [{"type": "http.request", "body": b"x", "more_body": True}] * 1000
    reached, sent = await _run_middleware(msgs, delay=0.05)
    assert not reached
    assert sent[0]["status"] == 408


async def test_prompt_body_passes_deadline():
    msgs = [
        {"type": "http.request", "body": b"ab", "more_body": True},
        {"type": "http.request", "body": b"cd", "more_body": False},
    ]
    reached, sent = await _run_middleware(msgs, delay=0.0)
    assert reached == [{"type": "http.request", "body": b"abcd", "more_body": False}]
    assert not sent
