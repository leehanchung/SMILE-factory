"""DATABASE_URL normalization and the dependency-aware readiness probe."""

import asyncio

import pytest
from fastapi.testclient import TestClient

from src.api import auth, deps, main


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("postgresql://u:p@h:5432/db", "postgresql+asyncpg://u:p@h:5432/db"),
        ("postgres://u:p@h/db", "postgresql+asyncpg://u:p@h/db"),
        ("postgresql+asyncpg://u:p@h/db", "postgresql+asyncpg://u:p@h/db"),
        ("postgresql+psycopg://u:p@h/db", "postgresql+psycopg://u:p@h/db"),
        ("sqlite+aiosqlite:///x.db", "sqlite+aiosqlite:///x.db"),
    ],
)
def test_normalize_database_url(url, expected):
    assert deps.normalize_database_url(url) == expected


class _Conn:
    def __init__(self, fail):
        self.fail = fail

    async def __aenter__(self):
        if self.fail == "error":
            raise ConnectionRefusedError("down")
        if self.fail == "hang":
            await asyncio.sleep(10)
        return self

    async def __aexit__(self, *exc):
        return False

    async def execute(self, _stmt):
        return None


class _Engine:
    def __init__(self, fail=None):
        self.fail = fail

    def connect(self):
        return _Conn(self.fail)


class _Redis:
    def __init__(self, fail=None):
        self.fail = fail

    async def ping(self):
        if self.fail:
            raise ConnectionError("down")
        return True


@pytest.fixture
def wire(monkeypatch):
    def _wire(engine, redis):
        monkeypatch.setattr(deps, "_db_engine", engine)
        monkeypatch.setattr(deps, "_redis_client", redis)

    return _wire


def test_check_deps_all_healthy(wire):
    wire(_Engine(), _Redis())
    assert asyncio.run(deps.check_deps()) == {}


def test_check_deps_reports_each_failure(wire):
    wire(_Engine("error"), _Redis("error"))
    assert asyncio.run(deps.check_deps()) == {
        "postgres": "ConnectionRefusedError",
        "redis": "ConnectionError",
    }


def test_check_deps_times_out(wire):
    wire(_Engine("hang"), _Redis())
    assert asyncio.run(deps.check_deps(timeout=0.05)) == {"postgres": "timeout"}


def test_check_deps_uninitialized(wire):
    wire(None, None)
    assert asyncio.run(deps.check_deps()) == {"deps": "not initialized"}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv(auth.INSECURE_DEV_ENV, raising=False)
    monkeypatch.setenv(auth.API_KEYS_ENV, "key-one")
    return TestClient(main.create_app())


def test_readiness_503_when_a_dependency_is_down(client, wire):
    wire(_Engine(), _Redis("error"))
    resp = client.get("/health/ready")
    assert resp.status_code == 503
    assert resp.json() == {"status": "unavailable", "failed": {"redis": "ConnectionError"}}


def test_readiness_200_when_dependencies_answer(client, wire):
    wire(_Engine(), _Redis())
    assert client.get("/health/ready").status_code == 200


def test_liveness_does_not_touch_dependencies(client, wire):
    wire(None, None)
    assert client.get("/health/live").status_code == 200
