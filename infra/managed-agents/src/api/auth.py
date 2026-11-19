"""API-key authentication for the control-plane API.

Keys come from ``MANAGED_AGENTS_API_KEYS`` (comma-separated). Clients send one
of them as ``x-api-key: <key>`` or ``Authorization: Bearer <key>``.

Fails closed: with no keys configured every protected request is rejected and
the app refuses to start, unless ``MANAGED_AGENTS_INSECURE_DEV=1`` is set
(local development only).
"""

import hmac
import logging
import os

from fastapi import Header, HTTPException, status

logger = logging.getLogger(__name__)

API_KEYS_ENV = "MANAGED_AGENTS_API_KEYS"
INSECURE_DEV_ENV = "MANAGED_AGENTS_INSECURE_DEV"


def _insecure_dev_mode() -> bool:
    return os.getenv(INSECURE_DEV_ENV, "").strip().lower() in {"1", "true", "yes"}


def configured_api_keys() -> list[bytes]:
    """Return the configured API keys (read per call so rotation needs no code change)."""
    return [k.strip().encode() for k in os.getenv(API_KEYS_ENV, "").split(",") if k.strip()]


def check_auth_configured() -> None:
    """Raise at startup if no API keys are configured and dev mode is not on."""
    if configured_api_keys():
        return
    if _insecure_dev_mode():
        logger.warning(
            "%s is unset and %s=1: the /v1 API is UNAUTHENTICATED. "
            "Never run like this outside local development.",
            API_KEYS_ENV,
            INSECURE_DEV_ENV,
        )
        return
    raise RuntimeError(
        f"{API_KEYS_ENV} is not set. Configure at least one API key, or set "
        f"{INSECURE_DEV_ENV}=1 for local development."
    )


def _key_matches(presented: str, keys: list[bytes]) -> bool:
    candidate = presented.encode()
    matched = False
    # Compare against every key (no early exit) so timing doesn't reveal which matched.
    for key in keys:
        matched |= hmac.compare_digest(candidate, key)
    return matched


async def require_api_key(
    x_api_key: str | None = Header(default=None),
    authorization: str | None = Header(default=None),
) -> None:
    """FastAPI dependency guarding every /v1 resource router."""
    keys = configured_api_keys()
    if not keys:
        if _insecure_dev_mode():
            return
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="API authentication is not configured",
        )

    presented = x_api_key
    if not presented and authorization:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() == "bearer":
            presented = token.strip()

    if not presented or not _key_matches(presented, keys):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing API key",
            headers={"WWW-Authenticate": "Bearer"},
        )
