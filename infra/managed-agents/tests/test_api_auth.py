"""Control-plane API key auth."""

import pytest
from fastapi.testclient import TestClient

from src.api import auth, main
from src.api.main import create_app


async def _no_failures():
    return {}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv(auth.INSECURE_DEV_ENV, raising=False)
    monkeypatch.setenv(auth.API_KEYS_ENV, "key-one, key-two")
    # Readiness probes PostgreSQL/Redis; report them healthy so only auth is tested.
    monkeypatch.setattr(main, "check_deps", _no_failures)
    # No lifespan: route-level auth is under test, not DB/Redis startup.
    return TestClient(create_app())


def test_health_endpoints_are_open(client):
    for path in ("/health", "/health/live", "/health/ready", "/v1/health"):
        assert client.get(path).status_code == 200, path


@pytest.mark.parametrize("path", ["/v1/agents", "/v1/environments", "/v1/sessions"])
def test_v1_routes_reject_missing_key(client, path):
    resp = client.get(path)
    assert resp.status_code == 401
    assert resp.headers["www-authenticate"] == "Bearer"


def test_v1_routes_reject_wrong_key(client):
    assert client.get("/v1/agents", headers={"x-api-key": "nope"}).status_code == 401
    assert (
        client.get("/v1/agents", headers={"Authorization": "Bearer nope"}).status_code == 401
    )
    # A valid key under the wrong scheme is not accepted.
    assert (
        client.get("/v1/agents", headers={"Authorization": "Basic key-one"}).status_code == 401
    )


@pytest.mark.parametrize(
    "headers",
    [
        {"x-api-key": "key-one"},
        {"x-api-key": "key-two"},
        {"Authorization": "Bearer key-two"},
    ],
)
async def test_require_api_key_accepts_valid_keys(monkeypatch, headers):
    monkeypatch.setenv(auth.API_KEYS_ENV, "key-one,key-two")
    await auth.require_api_key(
        x_api_key=headers.get("x-api-key"), authorization=headers.get("Authorization")
    )


def test_fails_closed_without_keys(monkeypatch):
    monkeypatch.delenv(auth.API_KEYS_ENV, raising=False)
    monkeypatch.delenv(auth.INSECURE_DEV_ENV, raising=False)
    with pytest.raises(RuntimeError):
        auth.check_auth_configured()
    resp = TestClient(create_app()).get("/v1/agents", headers={"x-api-key": "anything"})
    assert resp.status_code == 503


def test_insecure_dev_opt_out(monkeypatch):
    monkeypatch.delenv(auth.API_KEYS_ENV, raising=False)
    monkeypatch.setenv(auth.INSECURE_DEV_ENV, "1")
    auth.check_auth_configured()  # does not raise


async def test_insecure_dev_dependency_allows(monkeypatch):
    monkeypatch.delenv(auth.API_KEYS_ENV, raising=False)
    monkeypatch.setenv(auth.INSECURE_DEV_ENV, "1")
    await auth.require_api_key(x_api_key=None, authorization=None)
