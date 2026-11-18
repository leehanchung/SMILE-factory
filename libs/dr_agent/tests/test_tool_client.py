"""make_tool_client attaches the search_server bearer token."""

import asyncio

from dr_agent.tools import make_tool_client


def _headers(*args, **kwargs):
    client = make_tool_client(*args, **kwargs)
    try:
        return dict(client.headers)
    finally:
        asyncio.run(client.aclose())


def test_no_token_sends_no_auth(monkeypatch):
    monkeypatch.delenv("SEARCH_SERVER_TOKEN", raising=False)
    assert "authorization" not in _headers()


def test_env_token(monkeypatch):
    monkeypatch.setenv("SEARCH_SERVER_TOKEN", "s3cret")
    assert _headers()["authorization"] == "Bearer s3cret"


def test_explicit_token_wins_and_keeps_headers(monkeypatch):
    monkeypatch.setenv("SEARCH_SERVER_TOKEN", "env")
    headers = _headers("explicit", headers={"x-extra": "1"})
    assert headers["authorization"] == "Bearer explicit"
    assert headers["x-extra"] == "1"
