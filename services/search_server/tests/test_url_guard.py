from __future__ import annotations

import httpx
import pytest

from search_server.url_guard import UnsafeURLError, safe_fetch, validate_url


class Body(httpx.AsyncByteStream):
    """Unread streaming body (`content=` would be pre-read, unlike the network)."""

    def __init__(self, data: bytes) -> None:
        self.data = data

    async def __aiter__(self):
        yield self.data


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://public.example/x",
        "gopher://public.example/",
        "javascript:alert(1)",
        "data:text/html,hi",
        "//public.example/no-scheme",
        "http://user:pass@public.example/",
        "http://user@public.example/",
        "http:///nohost",
        "http://public.example:99999/",
        "http://" + "a" * 2050 + ".com/",
    ],
)
def test_rejects_bad_scheme_userinfo_syntax(url):
    with pytest.raises(UnsafeURLError):
        validate_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/",
        "http://localhost.example/",  # unresolvable -> rejected
        "http://loopback.example/",
        "http://internal.example/",
        "http://metadata.example/latest/meta-data/",
        "http://169.254.169.254/",
        "http://[fd00:ec2::254]/",
        "http://100.100.100.200/",
        "http://100.64.0.1/",  # CGNAT / shared
        "http://0.0.0.0/",
        "http://224.0.0.1/",
        "http://240.0.0.1/",
        "http://[::1]/",
        "http://[::]/",
        "http://[fe80::1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://[::ffff:169.254.169.254]/",
        "http://[2002:7f00:1::]/",  # 6to4 wrapping 127.0.0.1
        "http://mixed.example/",  # any private A record poisons the host
    ],
)
def test_rejects_non_public_addresses(url):
    with pytest.raises(UnsafeURLError):
        validate_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "http://public.example/page",
        "https://public.example:8443/a?b=c",
        "https://PUBLIC.example./",
        "https://public6.example/",
        "http://93.184.216.34/",
    ],
)
def test_allows_public_addresses(url):
    assert validate_url(url) == url


def test_allowlist_escape_hatch(monkeypatch):
    monkeypatch.setenv("SEARCH_SERVER_URL_ALLOWLIST", "internal.example, other.example")
    assert validate_url("http://internal.example/doc")
    with pytest.raises(UnsafeURLError):  # scheme checks still apply
        validate_url("file://internal.example/etc/passwd")
    with pytest.raises(UnsafeURLError):  # non-listed private host still blocked
        validate_url("http://loopback.example/")


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)


async def test_safe_fetch_public_ok():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=Body(b"hello"))

    async with _client(handler) as c:
        res = await safe_fetch("http://public.example/", client=c)
    assert res.status_code == 200
    assert res.content == b"hello"


async def test_safe_fetch_follows_safe_redirect():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/start":
            return httpx.Response(302, headers={"location": "/end"})
        return httpx.Response(200, stream=Body(b"done"))

    async with _client(handler) as c:
        res = await safe_fetch("http://public.example/start", client=c)
    assert res.url == "http://public.example/end"
    assert res.content == b"done"


@pytest.mark.parametrize(
    "location",
    [
        "http://169.254.169.254/latest/meta-data/",
        "http://internal.example/",
        "http://127.0.0.1:8000/",
        "file:///etc/passwd",
    ],
)
async def test_safe_fetch_rejects_redirect_to_unsafe(location):
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(302, headers={"location": location})

    async with _client(handler) as c:
        with pytest.raises(UnsafeURLError):
            await safe_fetch("http://public.example/", client=c)
    assert seen == ["http://public.example/"]  # unsafe hop never requested


async def test_safe_fetch_redirect_limit():
    def handler(request: httpx.Request) -> httpx.Response:
        n = int(request.url.path.strip("/") or 0)
        return httpx.Response(302, headers={"location": f"/{n + 1}"})

    async with _client(handler) as c:
        with pytest.raises(UnsafeURLError, match="too many redirects"):
            await safe_fetch("http://public.example/", client=c, max_redirects=3)


async def test_safe_fetch_size_cap():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"x" * 1000)

    async with _client(handler) as c:
        with pytest.raises(UnsafeURLError, match="too large"):
            await safe_fetch("http://public.example/", client=c, max_bytes=100)
