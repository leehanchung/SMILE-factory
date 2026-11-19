"""Dependency injection for database, Redis, orchestrator, and other services."""

import asyncio
import os
from typing import AsyncGenerator

import redis.asyncio as aioredis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from src.orchestrator import BaseOrchestrator, create_orchestrator

READINESS_TIMEOUT_SECONDS = 2.0


def normalize_database_url(url: str) -> str:
    """Point a bare PostgreSQL URL at the asyncpg driver.

    ``create_async_engine`` needs an async dialect, but Helm and most tooling
    emit ``postgresql://`` (or ``postgres://``). URLs that already name a
    driver (``postgresql+asyncpg://``, ``sqlite+aiosqlite://``, ...) pass
    through unchanged.
    """
    for prefix in ("postgresql://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql+asyncpg://" + url[len(prefix) :]
    return url


# Global instances
_db_engine = None
_session_factory = None
_redis_client = None
_orchestrator: BaseOrchestrator | None = None


async def init_deps(
    database_url: str | None = None,
    redis_url: str | None = None,
) -> None:
    """Initialize all dependencies. Call once at app startup."""
    global _db_engine, _session_factory, _redis_client, _orchestrator

    database_url = database_url or os.getenv(
        "DATABASE_URL", "postgresql+asyncpg://postgres:changeme@localhost/managed_agents"
    )
    redis_url = redis_url or os.getenv("REDIS_URL", "redis://localhost:6379")

    _db_engine = create_async_engine(
        normalize_database_url(database_url), echo=False, pool_size=20, max_overflow=10
    )
    _session_factory = async_sessionmaker(_db_engine, class_=AsyncSession, expire_on_commit=False)
    _redis_client = aioredis.from_url(redis_url)

    # Create orchestrator from environment config
    backend = os.getenv("ORCHESTRATOR_BACKEND", "k8s")
    _orchestrator = create_orchestrator(
        backend=backend,
        namespace=os.getenv("SESSION_NAMESPACE", "managed-agents-sessions"),
        redis_url=redis_url,
        worker_addresses=(
            os.getenv("ORCHESTRATOR_WORKER_ADDRESSES", "").split(",")
            if os.getenv("ORCHESTRATOR_WORKER_ADDRESSES")
            else None
        ),
        discovery_mode=os.getenv("ORCHESTRATOR_DISCOVERY_MODE", "k8s"),
    )


async def _ping_postgres() -> None:
    async with _db_engine.connect() as conn:
        await conn.execute(text("SELECT 1"))


async def _ping_redis() -> None:
    await _redis_client.ping()


async def check_deps(timeout: float = READINESS_TIMEOUT_SECONDS) -> dict[str, str]:
    """Probe PostgreSQL and Redis; return ``{name: error}`` for each one that failed."""
    if _db_engine is None or _redis_client is None:
        return {"deps": "not initialized"}
    checks = {"postgres": _ping_postgres, "redis": _ping_redis}
    results = await asyncio.gather(
        *(asyncio.wait_for(check(), timeout) for check in checks.values()),
        return_exceptions=True,
    )
    failures: dict[str, str] = {}
    for name, result in zip(checks, results):
        if isinstance(result, BaseException):
            failures[name] = (
                "timeout" if isinstance(result, asyncio.TimeoutError) else type(result).__name__
            )
    return failures


async def close_deps() -> None:
    """Close all dependencies. Call at app shutdown."""
    global _db_engine, _redis_client, _orchestrator

    if _orchestrator:
        await _orchestrator.close()

    if _redis_client:
        await _redis_client.close()

    if _db_engine:
        await _db_engine.dispose()


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Dependency for database sessions in route handlers."""
    if _session_factory is None:
        raise RuntimeError("Dependencies not initialized. Call init_deps() at startup.")

    async with _session_factory() as session:
        yield session


async def get_redis():
    """Dependency for Redis connection in route handlers."""
    if _redis_client is None:
        raise RuntimeError("Dependencies not initialized. Call init_deps() at startup.")
    return _redis_client


async def get_orchestrator() -> BaseOrchestrator:
    """Dependency for session orchestrator in route handlers."""
    if _orchestrator is None:
        raise RuntimeError("Dependencies not initialized. Call init_deps() at startup.")
    return _orchestrator
