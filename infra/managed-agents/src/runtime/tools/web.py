"""Web fetching and searching tools."""

import asyncio
import ipaddress
import logging
import os
import socket
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


async def validate_url(url: str) -> tuple[httpx.URL, list[str]]:
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
        try:
            resolved = await resolve_host(host, port)
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


async def safe_fetch(
    url: str,
    timeout: float,
    *,
    max_bytes: int = MAX_RESPONSE_BYTES,
    max_redirects: int = MAX_REDIRECTS,
    client: httpx.AsyncClient | None = None,
) -> tuple[httpx.Response, bytes, bool]:
    """GET a URL with SSRF protection; redirects are re-validated hop by hop.

    Returns (final_response, body_bytes, truncated).
    """
    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=min(timeout, 10.0)),
            follow_redirects=False,
        )
    try:
        current = url
        for _hop in range(max_redirects + 1):
            parsed, pinned_ips = await validate_url(current)
            # Connect to a validated IP; keep Host header + TLS SNI/cert check on the name.
            headers = {"Host": parsed.netloc.decode("ascii")}
            extensions = {"sni_hostname": parsed.host} if parsed.scheme == "https" else {}
            response = None
            for pinned_ip in pinned_ips:
                request = client.build_request(
                    "GET", parsed.copy_with(host=pinned_ip), headers=headers, extensions=extensions
                )
                try:
                    response = await client.send(request, stream=True)
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
                body = bytearray()
                truncated = False
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > max_bytes:
                        del body[max_bytes:]
                        truncated = True
                        break
                return response, bytes(body), truncated
            finally:
                await response.aclose()
        raise BlockedURLError(f"Too many redirects (max {max_redirects})")
    finally:
        if owns_client:
            await client.aclose()


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

    async def _search_searxng(
        self, query: str, limit: int, searxng_url: str
    ) -> ToolResult:
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
                                description = cells[1].get_text(strip=True) if len(cells) > 1 else ""

                                results.append(
                                    f"- {title}\n"
                                    f"  URL: {url}\n"
                                    f"  {description}"
                                )

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
