"""SSRF guard for the web_fetch tool. DNS is mocked; no network access."""

import ipaddress

import httpx
import pytest

from src.runtime.tools import web
from src.runtime.tools.web import BlockedURLError, WebFetchTool, is_blocked_ip, safe_fetch


def _dns(mapping: dict[str, list[str]]):
    async def fake_resolve(host: str, port: int) -> list[str]:
        if host not in mapping:
            raise OSError("NXDOMAIN")
        return mapping[host]

    return fake_resolve


@pytest.mark.parametrize(
    "ip",
    [
        "127.0.0.1",
        "10.0.0.5",
        "172.16.3.4",
        "192.168.1.1",
        "169.254.169.254",
        "0.0.0.0",
        "100.64.0.1",  # CGNAT
        "224.0.0.1",
        "240.0.0.1",
        "::1",
        "fe80::1",
        "fd00:ec2::254",
        "fc00::1",
        "::ffff:127.0.0.1",
        "::ffff:169.254.169.254",
        "2002:7f00:0001::1",  # 6to4 wrapping 127.0.0.1
        "ff02::1",
    ],
)
def test_blocked_ips(ip):
    assert is_blocked_ip(ipaddress.ip_address(ip))


@pytest.mark.parametrize("ip", ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"])
def test_public_ips_allowed(ip):
    assert not is_blocked_ip(ipaddress.ip_address(ip))


@pytest.mark.parametrize(
    "url",
    ["file:///etc/passwd", "ftp://example.com/", "gopher://example.com/", "http:///nohost"],
)
async def test_bad_scheme_or_host_rejected(url):
    with pytest.raises(BlockedURLError):
        await web.validate_url(url)


async def test_ip_literal_rejected(monkeypatch):
    monkeypatch.setattr(web, "resolve_host", _dns({}))
    for url in ("http://127.0.0.1/", "http://[::1]:8080/", "http://169.254.169.254/latest"):
        with pytest.raises(BlockedURLError):
            await web.validate_url(url)


async def test_hostname_resolving_to_private_rejected(monkeypatch):
    monkeypatch.setattr(web, "resolve_host", _dns({"evil.example": ["93.184.216.34", "10.0.0.1"]}))
    # Any blocked address in the answer set rejects the host.
    with pytest.raises(BlockedURLError, match="blocked address"):
        await web.validate_url("https://evil.example/")


async def test_public_hostname_pins_ip(monkeypatch):
    monkeypatch.setattr(web, "resolve_host", _dns({"good.example": ["93.184.216.34"]}))
    parsed, ips = await web.validate_url("https://good.example/path")
    assert parsed.host == "good.example"
    assert ips == ["93.184.216.34"]


class _Chunks(httpx.AsyncByteStream):
    """Unbuffered body, like a real socket: safe_fetch reads it via aiter_raw."""

    def __init__(self, data: bytes, size: int = 64 * 1024) -> None:
        self._data, self._size = data, size

    async def __aiter__(self):
        for i in range(0, len(self._data), self._size):
            yield self._data[i : i + self._size]


def _raw(status: int, body: bytes, headers: dict | None = None) -> httpx.Response:
    """A streamed response whose body bytes go out exactly as given (not decoded)."""
    return httpx.Response(status, headers=headers, stream=_Chunks(body))


def _client(handler) -> httpx.AsyncClient:
    def streaming(request: httpx.Request) -> httpx.Response:
        resp = handler(request)
        if isinstance(resp.stream, _Chunks):
            return resp
        # httpx buffers content= bodies up front; re-stream them so
        # safe_fetch's aiter_raw path sees what a socket would give it.
        return _raw(resp.status_code, resp.content, dict(resp.headers))

    return httpx.AsyncClient(transport=httpx.MockTransport(streaming), follow_redirects=False)


async def test_fetch_connects_to_pinned_ip_with_host_header(monkeypatch):
    monkeypatch.setattr(web, "resolve_host", _dns({"good.example": ["93.184.216.34"]}))
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["host"] = request.url.host
        seen["host_header"] = request.headers["host"]
        seen["sni"] = request.extensions.get("sni_hostname")
        return httpx.Response(200, text="<p>hi</p>")

    async with _client(handler) as client:
        resp, body, truncated = await safe_fetch("https://good.example/x", 10, client=client)
    assert resp.status_code == 200 and body == b"<p>hi</p>" and not truncated
    assert seen == {"host": "93.184.216.34", "host_header": "good.example", "sni": "good.example"}


async def test_redirect_to_private_blocked(monkeypatch):
    monkeypatch.setattr(web, "resolve_host", _dns({"good.example": ["93.184.216.34"]}))

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "http://169.254.169.254/latest/meta-data"})

    async with _client(handler) as client:
        with pytest.raises(BlockedURLError):
            await safe_fetch("https://good.example/", 10, client=client)


async def test_redirect_to_internal_hostname_blocked(monkeypatch):
    monkeypatch.setattr(
        web,
        "resolve_host",
        _dns({"good.example": ["93.184.216.34"], "internal.svc": ["10.1.2.3"]}),
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(301, headers={"location": "http://internal.svc/admin"})

    async with _client(handler) as client:
        with pytest.raises(BlockedURLError):
            await safe_fetch("https://good.example/", 10, client=client)


async def test_redirect_loop_capped(monkeypatch):
    monkeypatch.setattr(web, "resolve_host", _dns({"good.example": ["93.184.216.34"]}))
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url)
        return httpx.Response(302, headers={"location": "/again"})

    async with _client(handler) as client:
        with pytest.raises(BlockedURLError, match="Too many redirects"):
            await safe_fetch("https://good.example/", 10, client=client, max_redirects=5)
    assert len(calls) == 6


async def test_safe_redirect_followed(monkeypatch):
    monkeypatch.setattr(
        web, "resolve_host", _dns({"a.example": ["93.184.216.34"], "b.example": ["1.1.1.1"]})
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.headers["host"] == "a.example":
            return httpx.Response(302, headers={"location": "https://b.example/final"})
        return httpx.Response(200, text="done")

    async with _client(handler) as client:
        _, body, _ = await safe_fetch("https://a.example/", 10, client=client)
    assert body == b"done"


async def test_response_size_capped(monkeypatch):
    monkeypatch.setattr(web, "resolve_host", _dns({"big.example": ["93.184.216.34"]}))

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"a" * 10_000)

    async with _client(handler) as client:
        _, body, truncated = await safe_fetch(
            "https://big.example/", 10, client=client, max_bytes=1000
        )
    assert len(body) == 1000 and truncated


async def test_tool_reports_blocked_url(monkeypatch):
    monkeypatch.setattr(web, "resolve_host", _dns({}))
    result = await WebFetchTool().execute({"url": "http://127.0.0.1:8080/"})
    assert result.exit_code == 1
    assert "not allowed" in (result.error or "")


async def test_fetch_falls_back_to_next_validated_address(monkeypatch):
    monkeypatch.setattr(
        web,
        "resolve_host",
        _dns({"dual.example": ["2606:4700:4700::1111", "93.184.216.34"]}),
    )
    tried = []

    def handler(request: httpx.Request) -> httpx.Response:
        tried.append(request.url.host)
        if request.url.host == "2606:4700:4700::1111":
            raise httpx.ConnectError("network unreachable", request=request)
        return httpx.Response(200, text="v4")

    async with _client(handler) as client:
        _, body, _ = await safe_fetch("https://dual.example/", 10, client=client)
    assert body == b"v4"
    assert tried == ["2606:4700:4700::1111", "93.184.216.34"]


async def test_fetch_raises_when_every_address_unreachable(monkeypatch):
    monkeypatch.setattr(web, "resolve_host", _dns({"down.example": ["93.184.216.34", "1.1.1.1"]}))

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    async with _client(handler) as client:
        with pytest.raises(httpx.ConnectError):
            await safe_fetch("https://down.example/", 10, client=client)


async def test_fetch_mixed_answer_set_with_private_ip_rejected(monkeypatch):
    monkeypatch.setattr(web, "resolve_host", _dns({"mixed.example": ["93.184.216.34", "10.0.0.1"]}))
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.host)
        return httpx.Response(200)

    async with _client(handler) as client:
        with pytest.raises(BlockedURLError):
            await safe_fetch("https://mixed.example/", 10, client=client)
    assert calls == []


# --- compressed bodies --------------------------------------------------------


async def test_fetch_requests_identity_encoding(monkeypatch):
    monkeypatch.setattr(web, "resolve_host", _dns({"good.example": ["93.184.216.34"]}))
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["accept_encoding"] = request.headers.get("accept-encoding")
        return httpx.Response(200, content=b"ok")

    async with _client(handler) as client:
        await safe_fetch("https://good.example/", 10, client=client)
    assert seen["accept_encoding"] == "identity"


async def test_gzip_body_decoded(monkeypatch):
    import gzip

    monkeypatch.setattr(web, "resolve_host", _dns({"good.example": ["93.184.216.34"]}))

    def handler(request: httpx.Request) -> httpx.Response:
        return _raw(200, gzip.compress(b"<p>hello</p>"), {"content-encoding": "gzip"})

    async with _client(handler) as client:
        _, body, truncated = await safe_fetch("https://good.example/", 10, client=client)
    assert body == b"<p>hello</p>" and not truncated


async def test_gzip_bomb_never_decodes_past_cap(monkeypatch):
    """A 64 MiB gzip bomb is cut at the cap without decoding it all at once."""
    import gzip

    monkeypatch.setattr(web, "resolve_host", _dns({"bomb.example": ["93.184.216.34"]}))
    bomb = gzip.compress(b"\0" * (64 * 1024 * 1024))
    cap = 1000
    largest = []
    real_decode = web._decode_at_most

    def spy(decoder, chunk, budget):
        out = real_decode(decoder, chunk, budget)
        largest.append(len(out))
        return out

    monkeypatch.setattr(web, "_decode_at_most", spy)

    def handler(request: httpx.Request) -> httpx.Response:
        return _raw(200, bomb, {"content-encoding": "gzip"})

    async with _client(handler) as client:
        _, body, truncated = await safe_fetch(
            "https://bomb.example/", 10, client=client, max_bytes=cap
        )
    assert len(body) == cap and truncated
    assert largest and max(largest) <= cap + 1


def _raw_deflate(data: bytes) -> bytes:
    import zlib

    c = zlib.compressobj(wbits=-zlib.MAX_WBITS)
    return c.compress(data) + c.flush()


@pytest.mark.parametrize("wrapped", [True, False], ids=["zlib-wrapped", "raw"])
async def test_deflate_body_decoded(monkeypatch, wrapped):
    import zlib

    monkeypatch.setattr(web, "resolve_host", _dns({"good.example": ["93.184.216.34"]}))
    payload = b"<p>hello</p>" * 50
    body_bytes = zlib.compress(payload) if wrapped else _raw_deflate(payload)

    def handler(request: httpx.Request) -> httpx.Response:
        return _raw(200, body_bytes, {"content-encoding": "deflate"})

    async with _client(handler) as client:
        _, body, truncated = await safe_fetch("https://good.example/", 10, client=client)
    assert body == payload and not truncated


def test_deflate_decoder_handles_one_byte_chunks():
    import zlib

    payload = b"abc" * 100
    for stream in (zlib.compress(payload), _raw_deflate(payload)):
        decoder = web._DeflateDecoder()
        out = b"".join(web._decode_at_most(decoder, bytes([b]), 10_000) for b in stream)
        assert out == payload


async def test_raw_deflate_bomb_never_decodes_past_cap(monkeypatch):
    monkeypatch.setattr(web, "resolve_host", _dns({"bomb.example": ["93.184.216.34"]}))
    bomb = _raw_deflate(b"\0" * (64 * 1024 * 1024))
    cap = 1000
    largest = []
    real_decode = web._decode_at_most

    def spy(decoder, chunk, budget):
        out = real_decode(decoder, chunk, budget)
        largest.append(len(out))
        return out

    monkeypatch.setattr(web, "_decode_at_most", spy)

    def handler(request: httpx.Request) -> httpx.Response:
        return _raw(200, bomb, {"content-encoding": "deflate"})

    async with _client(handler) as client:
        _, body, truncated = await safe_fetch(
            "https://bomb.example/", 10, client=client, max_bytes=cap
        )
    assert len(body) == cap and truncated
    assert largest and max(largest) <= cap + 1


@pytest.mark.parametrize("encoding", ["br", "zstd", "gzip, br"])
async def test_unboundable_encodings_refused(monkeypatch, encoding):
    monkeypatch.setattr(web, "resolve_host", _dns({"good.example": ["93.184.216.34"]}))

    def handler(request: httpx.Request) -> httpx.Response:
        return _raw(200, b"xx", {"content-encoding": encoding})

    async with _client(handler) as client:
        with pytest.raises(web.UnsupportedEncodingError):
            await safe_fetch("https://good.example/", 10, client=client)


async def test_stalled_dns_is_bounded_by_fetch_timeout(monkeypatch):
    import asyncio

    async def stalled(host: str, port: int) -> list[str]:
        await asyncio.sleep(60)
        return ["93.184.216.34"]

    monkeypatch.setattr(web, "resolve_host", stalled)
    loop = asyncio.get_running_loop()
    start = loop.time()
    with pytest.raises(BlockedURLError, match="Timed out resolving"):
        await safe_fetch("https://slow.example/", 0.2)
    assert loop.time() - start < 5


def test_pinned_client_ignores_env_proxies(monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.invalid:3128")
    monkeypatch.setenv("ALL_PROXY", "http://proxy.invalid:3128")
    client = web._pinned_client(10)
    try:
        assert client._trust_env is False
        assert not client._mounts  # no proxy transports picked up from env
    finally:
        import asyncio

        asyncio.run(client.aclose())


async def test_each_redirect_hop_gets_its_own_client(monkeypatch):
    # Two hostnames on the same IP must not share a pooled (pinned-IP) connection.
    monkeypatch.setattr(
        web, "resolve_host", _dns({"a.example": ["93.184.216.34"], "b.example": ["93.184.216.34"]})
    )
    hosts_per_client: list[list[str]] = []

    def factory() -> httpx.AsyncClient:
        seen: list[str] = []
        hosts_per_client.append(seen)

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request.headers["host"])
            if request.headers["host"] == "a.example":
                return httpx.Response(302, headers={"location": "https://b.example/"})
            return httpx.Response(200, text="ok")

        return _client(handler)

    _, body, _ = await safe_fetch("https://a.example/", 10, client_factory=factory)
    assert body == b"ok"
    assert hosts_per_client == [["a.example"], ["b.example"]]
