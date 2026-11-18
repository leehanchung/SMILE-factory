"""Web fetching and searching tools."""

import asyncio
import ipaddress
import logging
import os
import socket
import zlib
from collections.abc import Callable
from typing import Any
from urllib.parse import urljoin

import httpx
from bs4 import BeautifulSoup

from . import Tool, ToolResult

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# SSRF guard
# ---------------------------------------------------------------------------

MAX_REDIRECTS = 5
MAX_RESPONSE_BYTES = 5 * 1024 * 1024  # 5 MiB of raw body
ALLOWED_SCHEMES = frozenset({"http", "https"})

# Cloud metadata endpoints (also covered by the link-local / private checks,
# listed explicitly so the intent survives any future refactor).
_METADATA_IPS = frozenset(
    {
        ipaddress.ip_address("169.254.169.254"),
        ipaddress.ip_address("fd00:ec2::254"),
    }
)


class BlockedURLError(ValueError):
    """Raised when a URL targets a disallowed scheme or address."""


class FetchTimeoutError(httpx.TimeoutException):
    """The whole fetch (DNS, every address and hop, body) exceeded its timeout."""


class UnsupportedEncodingError(BlockedURLError):
    """The server used a Content-Encoding we cannot decode with a size bound."""


def _bounded_decoder(content_encoding: str) -> Any:
    """zlib decoder for the response's Content-Encoding (None = identity).

    We ask for ``Accept-Encoding: identity``; a server that compresses anyway
    gets gzip/deflate decoded incrementally with ``max_length`` so a
    compression bomb never decodes past the byte cap. Anything else (br,
    zstd, stacked encodings) is refused rather than decoded unbounded.
    """
    encoding = content_encoding.strip().lower()
    if encoding in ("", "identity"):
        return None
    if encoding in ("gzip", "x-gzip"):
        return zlib.decompressobj(16 + zlib.MAX_WBITS)
    if encoding == "deflate":
        return _DeflateDecoder()
    raise UnsupportedEncodingError(f"Unsupported Content-Encoding '{content_encoding}'")


class _DeflateDecoder:
    """HTTP ``deflate``: zlib-wrapped per RFC 9110, but servers often send raw DEFLATE.

    Starts as a zlib-wrapped decoder; if the 2-byte zlib header turns out to be
    invalid, it restarts on the same bytes as a raw decoder. Same
    ``decompress(data, max_length)`` / ``unconsumed_tail`` surface as zlib's
    decompressobj, so the ``max_length`` bound still applies.
    """

    _HEADER = 2  # bytes needed before zlib can reject a bad wrapper

    def __init__(self) -> None:
        self._decoder = zlib.decompressobj(zlib.MAX_WBITS)
        self._probe = bytearray()  # input seen while the wrapper is unconfirmed

    def decompress(self, data: bytes, max_length: int) -> bytes:
        if len(self._probe) >= self._HEADER:
            return self._decoder.decompress(data, max_length)
        self._probe += data
        try:
            return self._decoder.decompress(data, max_length)
        except zlib.error:
            self._decoder = zlib.decompressobj(-zlib.MAX_WBITS)
            replay, self._probe = bytes(self._probe), bytearray(b"\0" * self._HEADER)
            return self._decoder.decompress(replay, max_length)

    @property
    def unconsumed_tail(self) -> bytes:
        return self._decoder.unconsumed_tail

    @property
    def eof(self) -> bool:
        return self._decoder.eof


def _decode_at_most(decoder: Any, chunk: bytes, budget: int) -> bytes:
    """Decode `chunk`, producing at most `budget + 1` bytes (enough to detect overflow)."""
    out = bytearray()
    data = chunk
    while len(out) <= budget:
        # max_length must stay > 0: zero means "unlimited" to zlib.
        out += decoder.decompress(data, budget + 1 - len(out))
        data = decoder.unconsumed_tail
        if not data:
            break
    return bytes(out)


def is_blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """True for any address that is not safe to fetch from inside the sandbox."""
    if isinstance(ip, ipaddress.IPv6Address):
        # Unwrap IPv4-mapped / 6to4 / Teredo forms so ::ffff:127.0.0.1 etc. are caught.
        if ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        elif ip.sixtofour is not None:
            ip = ip.sixtofour
        elif ip.teredo is not None:
            ip = ip.teredo[1]
    return (
        ip in _METADATA_IPS
        or ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
        or not ip.is_global
    )


async def resolve_host(host: str, port: int) -> list[str]:
    """Resolve host to IP strings (split out so tests can mock DNS)."""
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [info[4][0] for info in infos]


async def validate_url(
    url: str, resolve_timeout: float | None = None
) -> tuple[httpx.URL, list[str]]:
    """Check scheme + resolved addresses; return (url, pinned_ips).

    Every address the host resolves to must be public. All of them are
    returned, in resolver order, so the caller connects only to addresses that
    were checked (prevents DNS-rebinding between check and connect) while still
    falling back past an unreachable one (e.g. IPv6 on an IPv4-only host).
    """
    try:
        parsed = httpx.URL(url)
    except Exception as e:
        raise BlockedURLError(f"Invalid URL: {e}") from e
    if parsed.scheme not in ALLOWED_SCHEMES:
        raise BlockedURLError(f"Scheme '{parsed.scheme}' is not allowed")
    host = parsed.host
    if not host:
        raise BlockedURLError("URL has no host")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)

    try:
        addresses = [ipaddress.ip_address(host)]
    except ValueError:
        if resolve_timeout is not None and resolve_timeout <= 0:
            raise BlockedURLError(f"Timed out before resolving host '{host}'")
        try:
            # DNS runs before client.send(), outside httpx's timeout, so bound it.
            resolved = await asyncio.wait_for(resolve_host(host, port), resolve_timeout)
        except TimeoutError as e:
            raise BlockedURLError(f"Timed out resolving host '{host}'") from e
        except OSError as e:
            raise BlockedURLError(f"Could not resolve host '{host}': {e}") from e
        addresses = []
        for addr in resolved:
            # Strip IPv6 zone index (fe80::1%eth0) before parsing.
            addresses.append(ipaddress.ip_address(addr.split("%", 1)[0]))
    if not addresses:
        raise BlockedURLError(f"Host '{host}' did not resolve")
    for ip in addresses:
        if is_blocked_ip(ip):
            raise BlockedURLError(f"Host '{host}' resolves to a blocked address ({ip})")
    return parsed, list(dict.fromkeys(str(ip) for ip in addresses))


def _pinned_client(timeout: float) -> httpx.AsyncClient:
    """Client for one pinned-IP hop.

    trust_env=False: an env HTTPS_PROXY/ALL_PROXY would tunnel to the pinned IP
    and do TLS against the IP instead of the sni_hostname, and would also
    route around the SSRF pinning.
    """
    return httpx.AsyncClient(
        timeout=httpx.Timeout(timeout, connect=min(timeout, 10.0)),
        follow_redirects=False,
        trust_env=False,
    )


async def safe_fetch(
    url: str,
    timeout: float,
    *,
    max_bytes: int = MAX_RESPONSE_BYTES,
    max_redirects: int = MAX_REDIRECTS,
    client: httpx.AsyncClient | None = None,
    client_factory: Callable[[], httpx.AsyncClient] | None = None,
) -> tuple[httpx.Response, bytes, bool]:
    """GET a URL with SSRF protection; redirects are re-validated hop by hop.

    Each hop gets its own client (unless one is injected via ``client``):
    requests go to a pinned IP, so two hosts on the same IP would otherwise
    share a pooled TLS connection and skip the second host's SNI/cert check.
    ``timeout`` bounds the whole fetch -- DNS, every pinned address, every
    redirect hop and the body read -- not each step separately.
    Returns (final_response, body_bytes, truncated).
    """
    try:
        return await asyncio.wait_for(
            _safe_fetch(
                url,
                timeout,
                max_bytes=max_bytes,
                max_redirects=max_redirects,
                client=client,
                client_factory=client_factory,
            ),
            timeout,
        )
    except TimeoutError as e:
        raise FetchTimeoutError(f"Fetching {url} took longer than {timeout}s") from e


async def _safe_fetch(
    url: str,
    timeout: float,
    *,
    max_bytes: int,
    max_redirects: int,
    client: httpx.AsyncClient | None,
    client_factory: Callable[[], httpx.AsyncClient] | None,
) -> tuple[httpx.Response, bytes, bool]:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    make_client = client_factory or (lambda: _pinned_client(timeout))
    current = url
    for _hop in range(max_redirects + 1):
        parsed, pinned_ips = await validate_url(
            current, resolve_timeout=deadline - loop.time()
        )
        hop_client = client if client is not None else make_client()
        try:
            # Connect to a validated IP; keep Host header + TLS SNI/cert check on the name.
            headers = {
                "Host": parsed.netloc.decode("ascii"),
                # Uncompressed only, so the byte cap below is a real bound.
                "Accept-Encoding": "identity",
            }
            extensions = {"sni_hostname": parsed.host} if parsed.scheme == "https" else {}
            response = None
            for pinned_ip in pinned_ips:
                request = hop_client.build_request(
                    "GET", parsed.copy_with(host=pinned_ip), headers=headers, extensions=extensions
                )
                try:
                    response = await hop_client.send(request, stream=True)
                    break
                except (httpx.ConnectError, httpx.ConnectTimeout):
                    if pinned_ip == pinned_ips[-1]:
                        raise
            assert response is not None
            try:
                if response.is_redirect:
                    location = response.headers.get("location", "")
                    if not location:
                        raise BlockedURLError("Redirect without Location header")
                    current = urljoin(str(parsed), location)
                    continue
                response.raise_for_status()
                decoder = _bounded_decoder(response.headers.get("content-encoding", ""))
                body = bytearray()
                truncated = False
                raw_read = 0
                # aiter_raw + our own bounded decoder: aiter_bytes would let
                # httpx decompress a whole chunk before we could cap it.
                async for raw in response.aiter_raw():
                    raw_read += len(raw)
                    chunk = (
                        raw
                        if decoder is None
                        else _decode_at_most(decoder, raw, max_bytes - len(body))
                    )
                    body.extend(chunk)
                    if len(body) > max_bytes:
                        del body[max_bytes:]
                        truncated = True
                        break
                    if decoder is not None:
                        if decoder.eof:
                            # End of the compressed stream: anything after it
                            # is junk that zlib would only pile into unused_data.
                            break
                        if raw_read > max_bytes:
                            # Compressed input past the cap without producing
                            # as much output: bound the raw bytes too.
                            truncated = True
                            break
                return response, bytes(body), truncated
            finally:
                await response.aclose()
        finally:
            if client is None:
                await hop_client.aclose()
    raise BlockedURLError(f"Too many redirects (max {max_redirects})")


class WebFetchTool(Tool):
    """Fetch and parse web content."""

    name = "web_fetch"
    description = "Fetch and parse content from a URL. Converts HTML to plain text."
    input_schema = {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "URL to fetch",
            },
            "timeout": {
                "type": "integer",
                "description": "Request timeout in seconds (default 30, max 60)",
            },
        },
        "required": ["url"],
    }

    async def execute(self, input: dict[str, Any]) -> ToolResult:
        """Fetch and parse web content."""
        url = input.get("url", "").strip()
        timeout = input.get("timeout", 30)
        timeout = min(60, max(5, int(timeout)))

        if "://" not in url:
            url = "https://" + url

        logger.info(f"Fetching URL: {url}")

        try:
            response, body, truncated = await safe_fetch(url, timeout)
            encoding = response.encoding or "utf-8"
            html = body.decode(encoding, errors="replace")

            # Parse HTML to text
            soup = BeautifulSoup(html, "html.parser")

            # Remove script and style elements
            for script in soup(["script", "style"]):
                script.decompose()

            # Get text
            text = soup.get_text()

            # Clean up whitespace
            lines = (line.strip() for line in text.splitlines())
            text = "\n".join(line for line in lines if line)

            # Limit output size
            if len(text) > 50000:
                text = text[:50000] + "\n... (truncated)"
            elif truncated:
                text += "\n... (truncated: response exceeded size limit)"

            logger.debug(f"Fetched {len(body)} bytes from {url}")
            return ToolResult(output=text)

        except BlockedURLError as e:
            logger.warning(f"Blocked fetch of {url}: {e}")
            return ToolResult(output="", error=f"URL not allowed: {e}", exit_code=1)
        except httpx.HTTPError as e:
            logger.error(f"HTTP error fetching {url}: {e}")
            return ToolResult(output="", error=f"HTTP error: {e}", exit_code=1)
        except Exception as e:
            logger.error(f"Error fetching {url}: {e}", exc_info=True)
            return ToolResult(output="", error=str(e), exit_code=1)


class WebSearchTool(Tool):
    """Search the web."""

    name = "web_search"
    description = "Search the web for information."
    input_schema = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search query",
            },
            "limit": {
                "type": "integer",
                "description": "Number of results to return (default 5, max 20)",
            },
        },
        "required": ["query"],
    }

    async def execute(self, input: dict[str, Any]) -> ToolResult:
        """Search the web."""
        query = input.get("query", "").strip()
        limit = input.get("limit", 5)
        limit = min(20, max(1, int(limit)))

        if not query:
            return ToolResult(output="", error="Query cannot be empty", exit_code=1)

        logger.info(f"Searching for: {query}")

        # Try SearXNG first (if configured)
        searxng_url = os.getenv("SEARXNG_URL")
        if searxng_url:
            result = await self._search_searxng(query, limit, searxng_url)
            if result.exit_code == 0:
                return result

        # Fallback to DuckDuckGo
        return await self._search_duckduckgo(query, limit)

    async def _search_searxng(self, query: str, limit: int, searxng_url: str) -> ToolResult:
        """Search using SearXNG instance.

        Args:
            query: Search query
            limit: Max results
            searxng_url: SearXNG base URL

        Returns:
            ToolResult with search results
        """
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.get(
                    f"{searxng_url}/search",
                    params={
                        "q": query,
                        "format": "json",
                        "limit": limit,
                    },
                )
                response.raise_for_status()
                data = response.json()

                results = []
                for result in data.get("results", [])[:limit]:
                    results.append(
                        f"- {result.get('title', 'No title')}\n"
                        f"  URL: {result.get('url', 'No URL')}\n"
                        f"  {result.get('content', 'No content')}"
                    )

                if not results:
                    return ToolResult(output="No results found", exit_code=0)

                output = "\n\n".join(results)
                logger.debug(f"SearXNG search returned {len(results)} results")
                return ToolResult(output=output)

        except Exception as e:
            logger.warning(f"SearXNG search failed: {e}")
            return ToolResult(output="", error=str(e), exit_code=1)

    async def _search_duckduckgo(self, query: str, limit: int) -> ToolResult:
        """Search using DuckDuckGo HTML scraping.

        Args:
            query: Search query
            limit: Max results

        Returns:
            ToolResult with search results
        """
        try:
            # Use DuckDuckGo lite (simpler HTML)
            search_url = "https://lite.duckduckgo.com/lite/"

            async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
                response = await client.get(
                    search_url,
                    params={"q": query, "kp": "-1"},  # no safe search
                )
                response.raise_for_status()

                soup = BeautifulSoup(response.text, "html.parser")

                # Extract search results from lite version
                results = []
                result_rows = soup.find_all("tr")

                for row in result_rows:
                    cells = row.find_all("td")
                    if len(cells) >= 2:
                        # First cell usually has link, second has description
                        link_cell = cells[0].find("a")
                        if link_cell:
                            title = link_cell.get_text(strip=True)
                            url = link_cell.get("href", "")

                            # DuckDuckGo lite includes actual URLs
                            if url and (url.startswith("http://") or url.startswith("https://")):
                                description = (
                                    cells[1].get_text(strip=True) if len(cells) > 1 else ""
                                )

                                results.append(f"- {title}\n  URL: {url}\n  {description}")

                                if len(results) >= limit:
                                    break

                if not results:
                    return ToolResult(output="No results found", exit_code=0)

                output = "\n\n".join(results[:limit])
                logger.debug(f"DuckDuckGo search returned {len(results)} results")
                return ToolResult(output=output)

        except Exception as e:
            logger.error(f"DuckDuckGo search failed: {e}", exc_info=True)
            return ToolResult(output="", error=str(e), exit_code=1)
