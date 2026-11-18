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
    monkeypatch.setattr(
        web, "resolve_host", _dns({"evil.example": ["93.184.216.34", "10.0.0.1"]})
    )
    # Any blocked address in the answer set rejects the host.
    with pytest.raises(BlockedURLError, match="blocked address"):
        await web.validate_url("https://evil.example/")


async def test_public_hostname_pins_ip(monkeypatch):
    monkeypatch.setattr(web, "resolve_host", _dns({"good.example": ["93.184.216.34"]}))
    parsed, ips = await web.validate_url("https://good.example/path")
    assert parsed.host == "good.example"
    assert ips == ["93.184.216.34"]


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)


async def test_fetch_connects_to_pinned_ip_with_host_header(monkeypatch):
    monkeypatch.setattr(web, "resolve_host", _dns({"good.example": ["93.184.216.34"]}))
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["host"] = request.url.host
        seen["host_header"] = request.headers["host"]
        seen["sni"] = request.extensions.get("sni_hostname")
        return httpx.Response(200, text="<p>hi</p>")

    async with _client(handler) as client:
        resp, body, truncated = await safe_fetch(
            "https://good.example/x", 10, client=client
        )
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
    monkeypatch.setattr(
        web, "resolve_host", _dns({"down.example": ["93.184.216.34", "1.1.1.1"]})
    )

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    async with _client(handler) as client:
        with pytest.raises(httpx.ConnectError):
            await safe_fetch("https://down.example/", 10, client=client)


async def test_fetch_mixed_answer_set_with_private_ip_rejected(monkeypatch):
    monkeypatch.setattr(
        web, "resolve_host", _dns({"mixed.example": ["93.184.216.34", "10.0.0.1"]})
    )
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.host)
        return httpx.Response(200)

    async with _client(handler) as client:
        with pytest.raises(BlockedURLError):
            await safe_fetch("https://mixed.example/", 10, client=client)
    assert calls == []
