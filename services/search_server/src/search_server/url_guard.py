"""SSRF guard for model-chosen URLs (the `/visit` tool).

The URL passed to `/visit` is picked by the LLM, so it is attacker-influenced
(prompt injection via a fetched page can steer it). Everything that fetches a
URL on the model's behalf MUST go through `validate_url` / `safe_fetch`:

- only ``http`` / ``https``; no ``user:pass@`` userinfo;
- the hostname is canonicalised to ASCII with the same IDNA encoder HTTPX uses
  (``httpx.URL``), and that canonical URL is both validated and fetched, so the
  checked name and the connected name cannot differ (e.g. ``faß`` vs ``fass``);
- the host is resolved with ``socket.getaddrinfo`` and EVERY resolved address
  must be public — private, loopback, link-local, reserved, multicast,
  unspecified, shared (CGNAT) and cloud-metadata addresses are rejected;
- redirects are never followed automatically: each hop is re-validated, up to
  ``MAX_REDIRECTS``;
- one overall deadline (``DEFAULT_TOTAL_TIMEOUT``) covers DNS, every redirect
  hop and body streaming, on top of HTTPX's per-operation timeouts;
- the body is read raw and gzip/deflate is decoded here with a bounded decoder,
  so neither the wire bytes nor the decoded bytes can exceed ``max_bytes`` (no
  decompression bombs); any other content-encoding is rejected.

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
import zlib
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

import httpx

ALLOWED_SCHEMES = frozenset({"http", "https"})
MAX_URL_LENGTH = 2048
MAX_REDIRECTS = 5
MAX_RESPONSE_BYTES = 5 * 1024 * 1024
DEFAULT_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
# Wall-clock budget for a whole fetch: DNS + every redirect hop + body.
DEFAULT_TOTAL_TIMEOUT = 30.0
# Only encodings we can decode with a hard output bound.
ACCEPT_ENCODING = "gzip, deflate"

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


def _ascii_host(url: str) -> str:
    """The host of `url` exactly as HTTPX will resolve/connect to it.

    HTTPX encodes non-ASCII hosts with the `idna` package (IDNA 2008), which
    differs from the stdlib IDNA 2003 codec `socket.getaddrinfo` would use
    (``faß`` -> ``xn--fa-hia`` vs ``fass``), so never resolve the raw name.
    """
    try:
        host = httpx.URL(url).raw_host.decode("ascii")
    except (httpx.InvalidURL, UnicodeError) as e:
        raise UnsafeURLError(f"invalid hostname: {e}") from None
    host = host.lower().rstrip(".")
    if not host or "%" in host:
        raise UnsafeURLError("invalid hostname")
    return host


def _allowlisted_hosts() -> frozenset[str]:
    raw = os.environ.get(_ALLOWLIST_ENV, "")
    hosts = set()
    for h in raw.split(","):
        h = h.strip().rstrip(".")
        if not h:
            continue
        try:
            hosts.add(_ascii_host(f"http://{h}/"))
        except UnsafeURLError:
            continue
    return frozenset(hosts)


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
    """Cheap, network-free checks. Returns (canonical ASCII hostname, port)."""
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
    if not parts.hostname:
        raise UnsafeURLError("URL has no host")
    return _ascii_host(url), port


def canonical_url(url: str) -> str:
    """`url` with its host in the ASCII (punycode) form HTTPX connects to."""
    check_url_syntax(url)
    return str(httpx.URL(url))


def validate_url(url: str) -> str:
    """Raise `UnsafeURLError` unless `url` is safe to fetch. Returns `url`.

    Checks the canonical ASCII host; fetch `canonical_url(url)` so the validated
    and the connected names are identical (`safe_fetch` does this).
    Performs a blocking DNS lookup; call via `asyncio.to_thread` from async code.
    """
    host, port = check_url_syntax(url)
    if host in _allowlisted_hosts():
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


class _BoundedDecoder:
    """Decode a gzip/deflate/identity body without ever exceeding `max_bytes`.

    `zlib`'s `max_length` caps each call's output at the remaining budget (+1 to
    detect overflow), so a highly compressible chunk is never materialised in
    full. Deflate falls back to raw deflate (no zlib header), like HTTPX.
    """

    def __init__(self, encoding: str, max_bytes: int) -> None:
        self.max_bytes = max_bytes
        self.size = 0
        self.eof = False
        self._raw_fallback = encoding == "deflate"
        self._d = None
        if encoding in ("gzip", "x-gzip"):
            self._d = zlib.decompressobj(16 + zlib.MAX_WBITS)
        elif encoding == "deflate":
            self._d = zlib.decompressobj(zlib.MAX_WBITS)

    def _emit(self, out: bytes, body: bytearray) -> None:
        self.size += len(out)
        if self.size > self.max_bytes:
            raise UnsafeURLError("response too large")
        body.extend(out)

    def feed(self, data: bytes, body: bytearray) -> None:
        if self.eof or not data:
            return
        if self._d is None:
            self._emit(data, body)
            return
        buf = data
        while buf and not self.eof:
            try:
                out = self._d.decompress(buf, self.max_bytes - self.size + 1)
            except zlib.error as e:
                if self._raw_fallback and self.size == 0:
                    self._raw_fallback = False
                    self._d = zlib.decompressobj(-zlib.MAX_WBITS)
                    continue
                raise UnsafeURLError(f"invalid compressed body: {e}") from None
            self._raw_fallback = False
            self._emit(out, body)
            self.eof = self._d.eof
            buf = self._d.unconsumed_tail
            if not out:
                break

    def finish(self, body: bytearray) -> None:
        if self._d is not None and not self.eof:
            try:
                out = self._d.flush(self.max_bytes - self.size + 1)
            except zlib.error as e:
                raise UnsafeURLError(f"invalid compressed body: {e}") from None
            self._emit(out, body)


def _content_encoding(headers: httpx.Headers) -> str:
    raw = headers.get("content-encoding", "").strip().lower()
    codings = [c.strip() for c in raw.split(",") if c.strip() and c.strip() != "identity"]
    if not codings:
        return "identity"
    if len(codings) == 1 and codings[0] in ("gzip", "x-gzip", "deflate"):
        return codings[0]
    raise UnsafeURLError(f"unsupported content-encoding: {raw}")


@dataclass
class FetchResult:
    url: str  # final URL after redirects (canonical ASCII host)
    status_code: int
    headers: httpx.Headers
    content: bytes  # decoded (gzip/deflate removed), at most max_bytes


async def _fetch(
    url: str, client: httpx.AsyncClient, max_redirects: int, max_bytes: int
) -> FetchResult:
    current = url
    for _ in range(max_redirects + 1):
        await asyncio.to_thread(validate_url, current)
        current = canonical_url(current)  # fetch exactly the host we validated
        async with client.stream(
            "GET",
            current,
            follow_redirects=False,
            headers={"Accept-Encoding": ACCEPT_ENCODING},
        ) as resp:
            if resp.is_redirect:
                location = resp.headers.get("location")
                if not location:
                    raise UnsafeURLError("redirect without Location header")
                current = urljoin(current, location)
                continue
            declared = resp.headers.get("content-length")
            if declared and declared.isdigit() and int(declared) > max_bytes:
                raise UnsafeURLError("response too large")
            decoder = _BoundedDecoder(_content_encoding(resp.headers), max_bytes)
            body = bytearray()
            raw_size = 0
            # Raw (still-encoded) bytes: HTTPX's own decoder would materialise
            # each fully-expanded chunk before we could check its size.
            async for chunk in resp.aiter_raw():
                raw_size += len(chunk)
                if raw_size > max_bytes:
                    raise UnsafeURLError("response too large")
                decoder.feed(chunk, body)
                if decoder.eof:
                    break
            decoder.finish(body)
            return FetchResult(
                url=current,
                status_code=resp.status_code,
                headers=resp.headers,
                content=bytes(body),
            )
    raise UnsafeURLError("too many redirects")


async def safe_fetch(
    url: str,
    *,
    client: httpx.AsyncClient | None = None,
    max_redirects: int = MAX_REDIRECTS,
    max_bytes: int = MAX_RESPONSE_BYTES,
    timeout: httpx.Timeout = DEFAULT_TIMEOUT,
    total_timeout: float = DEFAULT_TOTAL_TIMEOUT,
) -> FetchResult:
    """GET `url`, validating the URL and every redirect hop; cap body size.

    `total_timeout` bounds the whole fetch (DNS, redirects, body) in wall-clock
    time, so a server trickling bytes just under the per-read timeout cannot
    hold the request open indefinitely.
    """
    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(follow_redirects=False, timeout=timeout, trust_env=False)
    try:
        async with asyncio.timeout(total_timeout):
            return await _fetch(url, client, max_redirects, max_bytes)
    except TimeoutError:
        raise UnsafeURLError("fetch exceeded the overall deadline") from None
    finally:
        if owns_client:
            await client.aclose()
