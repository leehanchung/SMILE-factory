"""SSRF guard for model-chosen URLs (the `/visit` tool).

The URL passed to `/visit` is picked by the LLM, so it is attacker-influenced
(prompt injection via a fetched page can steer it). Everything that fetches a
URL on the model's behalf MUST go through `validate_url` / `safe_fetch`:

- only ``http`` / ``https``; no ``user:pass@`` userinfo;
- the host is resolved with ``socket.getaddrinfo`` and EVERY resolved address
  must be public — private, loopback, link-local, reserved, multicast,
  unspecified, shared (CGNAT) and cloud-metadata addresses are rejected;
- redirects are never followed automatically: each hop is re-validated, up to
  ``MAX_REDIRECTS``;
- timeouts and a response-size cap bound the fetch.

Residual risk: httpx re-resolves the host when connecting, so a DNS-rebinding
attacker with a very short TTL could swap the address between validation and
connect. Deploy behind an egress firewall that blocks RFC1918/metadata ranges
for defence in depth.

Escape hatch: ``SEARCH_SERVER_URL_ALLOWLIST`` (comma-separated hostnames)
skips the IP check for exactly those hosts — e.g. an internal docs mirror.
Scheme/userinfo checks still apply.
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
import socket
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

import httpx

ALLOWED_SCHEMES = frozenset({"http", "https"})
MAX_URL_LENGTH = 2048
MAX_REDIRECTS = 5
MAX_RESPONSE_BYTES = 5 * 1024 * 1024
DEFAULT_TIMEOUT = httpx.Timeout(10.0, connect=5.0)

# Explicit cloud metadata endpoints (most are already link-local / private, but
# list them so the intent is obvious and survives changes to `ipaddress`).
METADATA_IPS = frozenset(
    ipaddress.ip_address(a)
    for a in (
        "169.254.169.254",  # AWS / GCP / Azure / OpenStack
        "fd00:ec2::254",  # AWS IMDS IPv6
        "100.100.100.200",  # Alibaba Cloud
    )
)

_ALLOWLIST_ENV = "SEARCH_SERVER_URL_ALLOWLIST"


class UnsafeURLError(ValueError):
    """The URL is not safe to fetch on the model's behalf."""


def _allowlisted_hosts() -> frozenset[str]:
    raw = os.environ.get(_ALLOWLIST_ENV, "")
    return frozenset(h.strip().lower().rstrip(".") for h in raw.split(",") if h.strip())


def is_blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """True if `ip` must never be fetched (non-public or metadata)."""
    if isinstance(ip, ipaddress.IPv6Address):
        # ::ffff:127.0.0.1 and friends: judge the embedded IPv4 address.
        mapped = ip.ipv4_mapped or ip.sixtofour
        if mapped is not None and is_blocked_ip(mapped):
            return True
        if ip.teredo is not None and any(is_blocked_ip(a) for a in ip.teredo):
            return True
    return (
        ip in METADATA_IPS
        or ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
        or not ip.is_global  # catches shared/CGNAT 100.64/10, benchmarking, etc.
    )


def check_url_syntax(url: str) -> tuple[str, int | None]:
    """Cheap, network-free checks. Returns (hostname, port)."""
    if len(url) > MAX_URL_LENGTH:
        raise UnsafeURLError("URL too long")
    try:
        parts = urlsplit(url)
        port = parts.port  # raises ValueError on a malformed port
    except ValueError as e:
        raise UnsafeURLError(f"malformed URL: {e}") from None
    if parts.scheme.lower() not in ALLOWED_SCHEMES:
        raise UnsafeURLError("only http and https URLs are allowed")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise UnsafeURLError("URLs with credentials are not allowed")
    host = parts.hostname
    if not host:
        raise UnsafeURLError("URL has no host")
    return host.rstrip("."), port


def validate_url(url: str) -> str:
    """Raise `UnsafeURLError` unless `url` is safe to fetch. Returns `url`.

    Performs a blocking DNS lookup; call via `asyncio.to_thread` from async code.
    """
    host, port = check_url_syntax(url)
    if host.lower() in _allowlisted_hosts():
        return url
    try:
        infos = socket.getaddrinfo(host, port or 0, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError) as e:
        raise UnsafeURLError(f"cannot resolve host: {e}") from None
    if not infos:
        raise UnsafeURLError("host resolved to no addresses")
    for info in infos:
        addr = info[4][0].split("%", 1)[0]  # strip IPv6 zone id
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            raise UnsafeURLError("host resolved to an unparseable address") from None
        if is_blocked_ip(ip):
            raise UnsafeURLError("URL resolves to a non-public address")
    return url


@dataclass
class FetchResult:
    url: str  # final URL after redirects
    status_code: int
    headers: httpx.Headers
    content: bytes


async def safe_fetch(
    url: str,
    *,
    client: httpx.AsyncClient | None = None,
    max_redirects: int = MAX_REDIRECTS,
    max_bytes: int = MAX_RESPONSE_BYTES,
    timeout: httpx.Timeout = DEFAULT_TIMEOUT,
) -> FetchResult:
    """GET `url`, validating the URL and every redirect hop; cap body size."""
    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(follow_redirects=False, timeout=timeout, trust_env=False)
    try:
        current = url
        for _ in range(max_redirects + 1):
            await asyncio.to_thread(validate_url, current)
            async with client.stream("GET", current, follow_redirects=False) as resp:
                if resp.is_redirect:
                    location = resp.headers.get("location")
                    if not location:
                        raise UnsafeURLError("redirect without Location header")
                    current = urljoin(current, location)
                    continue
                declared = resp.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > max_bytes:
                    raise UnsafeURLError("response too large")
                body = bytearray()
                async for chunk in resp.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > max_bytes:
                        raise UnsafeURLError("response too large")
                return FetchResult(
                    url=current,
                    status_code=resp.status_code,
                    headers=resp.headers,
                    content=bytes(body),
                )
        raise UnsafeURLError("too many redirects")
    finally:
        if owns_client:
            await client.aclose()
