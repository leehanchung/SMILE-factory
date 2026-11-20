"""IDNA canonicalisation, overall deadline and bounded decompression."""

from __future__ import annotations

import asyncio
import gzip
import zlib

import httpx
import pytest

from search_server import url_guard
from search_server.url_guard import UnsafeURLError, safe_fetch, validate_url


class Body(httpx.AsyncByteStream):
    """Unread streaming body (`content=` would be pre-read and pre-decoded)."""

    def __init__(self, data: bytes, chunk: int = 4096) -> None:
        self.data, self.chunk = data, chunk

    async def __aiter__(self):
        for i in range(0, len(self.data), self.chunk):
            yield self.data[i : i + self.chunk]


@pytest.fixture
def extra_dns(monkeypatch):
    """Add names on top of the conftest fake resolver."""
    base = url_guard.socket.getaddrinfo
    extra: dict[str, str] = {}

    def resolver(host, port, *args, **kwargs):
        if host in extra:
            return base(extra[host], port, *args, **kwargs)  # IP literal
        return base(host, port, *args, **kwargs)

    monkeypatch.setattr(url_guard.socket, "getaddrinfo", resolver)
    return extra


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)


def _raw_deflate(b: bytes) -> bytes:
    c = zlib.compressobj(wbits=-zlib.MAX_WBITS)
    return c.compress(b) + c.flush()


# --- IDNA canonicalisation -------------------------------------------------


def test_validates_the_idna2008_name_httpx_connects_to(extra_dns):
    # stdlib IDNA 2003 maps faß -> fass; HTTPX (idna pkg) sends xn--fa-hia.
    extra_dns["fass.example"] = "93.184.216.34"
    extra_dns["xn--fa-hia.example"] = "127.0.0.1"
    with pytest.raises(UnsafeURLError):
        validate_url("http://faß.example/")


async def test_safe_fetch_requests_the_validated_ascii_host(extra_dns):
    extra_dns["xn--fa-hia.example"] = "93.184.216.34"
    seen: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.raw_host)
        return httpx.Response(200, stream=Body(b"ok"))

    async with _client(handler) as c:
        res = await safe_fetch("http://faß.example/", client=c)
    assert seen == [b"xn--fa-hia.example"]
    assert res.url == "http://xn--fa-hia.example/"


@pytest.mark.parametrize("url", ["http://a​.example/", "http://exa%41mple.example/"])
def test_rejects_invalid_hostnames(url):
    with pytest.raises(UnsafeURLError):
        validate_url(url)


def test_allowlist_matches_canonical_host(monkeypatch, extra_dns):
    extra_dns["xn--fa-hia.example"] = "10.0.0.5"
    monkeypatch.setenv("SEARCH_SERVER_URL_ALLOWLIST", "faß.example")
    assert validate_url("http://xn--fa-hia.example/")


def test_trailing_dot_host_is_resolved_as_written(extra_dns):
    # `host` may be expanded by resolver search domains while `host.` is
    # absolute; HTTPX connects to `host.`, so that is the name checked.
    extra_dns["dotted.example"] = "93.184.216.34"
    extra_dns["dotted.example."] = "10.0.0.5"
    with pytest.raises(UnsafeURLError, match="non-public"):
        validate_url("http://dotted.example./")
    assert validate_url("http://dotted.example/")


async def test_safe_fetch_trailing_dot_resolves_and_fetches_the_dotted_name(extra_dns):
    extra_dns["dotted.example."] = "93.184.216.34"
    seen: list[bytes] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.raw_host)
        return httpx.Response(200, stream=Body(b"ok"))

    async with _client(handler) as c:
        res = await safe_fetch("http://dotted.example./", client=c)
    assert seen == [b"dotted.example."] and res.content == b"ok"


@pytest.mark.parametrize(
    "entry,url",
    [
        ("internal.example", "http://internal.example./"),
        ("internal.example.", "http://internal.example/"),
    ],
)
def test_allowlist_ignores_trailing_dot(monkeypatch, entry, url):
    monkeypatch.setenv("SEARCH_SERVER_URL_ALLOWLIST", entry)
    assert validate_url(url)


@pytest.mark.parametrize("url", ["http://./", "http://a..example./"])
def test_rejects_empty_or_doubled_dot_hosts(url):
    with pytest.raises(UnsafeURLError):
        validate_url(url)


# --- overall deadline ------------------------------------------------------


async def test_safe_fetch_overall_deadline_bounds_trickling_body():
    class Trickle(httpx.AsyncByteStream):
        async def __aiter__(self):
            while True:  # each chunk arrives well inside any per-read timeout
                await asyncio.sleep(0.01)
                yield b"x"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=Trickle())

    async with _client(handler) as c:
        with pytest.raises(UnsafeURLError, match="deadline"):
            await safe_fetch("http://public.example/", client=c, total_timeout=0.2)


# --- bounded decompression -------------------------------------------------


@pytest.mark.parametrize(
    "encoding,compress",
    [
        ("gzip", gzip.compress),
        ("x-gzip", gzip.compress),
        ("deflate", zlib.compress),
        ("deflate", _raw_deflate),
        ("identity", lambda b: b),
    ],
)
async def test_safe_fetch_decodes_compressed_body(encoding, compress):
    payload = b"hello world " * 100

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["accept-encoding"] == "gzip, deflate"
        return httpx.Response(
            200, stream=Body(compress(payload)), headers={"content-encoding": encoding}
        )

    async with _client(handler) as c:
        res = await safe_fetch("http://public.example/", client=c)
    assert res.content == payload


@pytest.mark.parametrize(
    "encoding,compress",
    [
        ("deflate", zlib.compress),
        ("deflate", _raw_deflate),
        ("gzip", gzip.compress),
    ],
)
async def test_safe_fetch_decodes_one_byte_chunks(encoding, compress):
    """The zlib-vs-raw-deflate choice must survive a header split across chunks."""
    payload = b"hello world " * 100

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, stream=Body(compress(payload), chunk=1), headers={"content-encoding": encoding}
        )

    async with _client(handler) as c:
        res = await safe_fetch("http://public.example/", client=c)
    assert res.content == payload


def test_raw_deflate_fallback_survives_split_header():
    """Feed raw deflate one byte at a time straight into the decoder."""
    payload = b"split header " * 50
    dec = url_guard._BoundedDecoder("deflate", 1 << 20)
    body = bytearray()
    for b in _raw_deflate(payload):
        dec.feed(bytes([b]), body)
    dec.finish(body)
    assert bytes(body) == payload


@pytest.mark.parametrize("encoding,compress", [("gzip", gzip.compress), ("deflate", _raw_deflate)])
async def test_safe_fetch_rejects_decompression_bomb_without_materialising(
    monkeypatch, encoding, compress
):
    bomb = compress(b"\0" * (20 * 1024 * 1024))  # ~20 KiB on the wire
    sizes: list[int] = []
    real_emit = url_guard._BoundedDecoder._emit

    def spy(self, out, body):
        sizes.append(len(out))
        return real_emit(self, out, body)

    monkeypatch.setattr(url_guard._BoundedDecoder, "_emit", spy)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=Body(bomb), headers={"content-encoding": encoding})

    async with _client(handler) as c:
        with pytest.raises(UnsafeURLError, match="too large"):
            await safe_fetch("http://public.example/", client=c, max_bytes=64 * 1024)
    assert len(bomb) < 64 * 1024  # raw cap alone would not catch it
    assert sizes and max(sizes) <= 64 * 1024 + 1  # never decoded more than the budget + 1


async def test_safe_fetch_ignores_trailing_bytes_after_deflate_eof():
    payload = b"done"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            stream=Body(zlib.compress(payload) + b"garbage"),
            headers={"content-encoding": "deflate"},
        )

    async with _client(handler) as c:
        res = await safe_fetch("http://public.example/", client=c)
    assert res.content == payload


@pytest.mark.parametrize("chunk", [4096, 1])
async def test_safe_fetch_decodes_every_gzip_member(chunk):
    # RFC 1952 §2.2: a gzip body may be several concatenated members.
    first, second = b"first member " * 50, b"second member " * 50
    stream = gzip.compress(first) + gzip.compress(second)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, stream=Body(stream, chunk=chunk), headers={"content-encoding": "gzip"}
        )

    async with _client(handler) as c:
        res = await safe_fetch("http://public.example/", client=c)
    assert res.content == first + second


async def test_safe_fetch_caps_multi_member_gzip_total():
    member = gzip.compress(b"a" * 60)
    body_ = member * 3  # 180 decoded bytes in total, 60 per member

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=Body(body_), headers={"content-encoding": "gzip"})

    async with _client(handler) as c:
        with pytest.raises(UnsafeURLError, match="too large"):
            await safe_fetch("http://public.example/", client=c, max_bytes=150)


@pytest.mark.parametrize(
    "tail,match",
    [
        (gzip.compress(b"second " * 50)[:-8], "truncated compressed body"),  # cut 2nd member
        (b"\x1f", "truncated compressed body"),  # only the start of a 2nd header
        (b"garbage", "invalid compressed body"),  # not a gzip member
    ],
)
async def test_safe_fetch_rejects_bad_trailing_gzip_member(tail, match):
    stream = gzip.compress(b"first") + tail

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=Body(stream), headers={"content-encoding": "gzip"})

    async with _client(handler) as c:
        with pytest.raises(UnsafeURLError, match=match):
            await safe_fetch("http://public.example/", client=c)


async def test_safe_fetch_caps_raw_bytes_without_content_length():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=httpx.ByteStream(b"x" * 1000))

    async with _client(handler) as c:
        with pytest.raises(UnsafeURLError, match="too large"):
            await safe_fetch("http://public.example/", client=c, max_bytes=100)


async def test_safe_fetch_rejects_corrupt_gzip():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=Body(b"not gzip"), headers={"content-encoding": "gzip"})

    async with _client(handler) as c:
        with pytest.raises(UnsafeURLError, match="invalid compressed body"):
            await safe_fetch("http://public.example/", client=c)


@pytest.mark.parametrize("encoding", ["br", "zstd", "gzip, gzip", "compress"])
async def test_safe_fetch_rejects_unsupported_encoding(encoding):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=Body(b"x"), headers={"content-encoding": encoding})

    async with _client(handler) as c:
        with pytest.raises(UnsafeURLError, match="content-encoding"):
            await safe_fetch("http://public.example/", client=c)


_TEXT = b"hello world " * 100


@pytest.mark.parametrize(
    "encoding,stream",
    [
        ("gzip", gzip.compress(_TEXT)[:-8]),  # missing gzip trailer
        ("gzip", gzip.compress(_TEXT)[:-20]),  # missing final block
        ("deflate", zlib.compress(_TEXT)[:-6]),
        ("deflate", _raw_deflate(_TEXT)[:-4]),
    ],
)
async def test_safe_fetch_rejects_truncated_compressed_body(encoding, stream):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=Body(stream), headers={"content-encoding": encoding})

    async with _client(handler) as c:
        with pytest.raises(UnsafeURLError, match="truncated compressed body"):
            await safe_fetch("http://public.example/", client=c)


async def test_safe_fetch_allows_empty_body_with_content_encoding():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(204, stream=Body(b""), headers={"content-encoding": "gzip"})

    async with _client(handler) as c:
        res = await safe_fetch("http://public.example/", client=c)
    assert res.status_code == 204 and res.content == b""


@pytest.mark.parametrize("status", [300, 304])
async def test_safe_fetch_returns_3xx_without_location(status):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, stream=Body(b"choices"))

    async with _client(handler) as c:
        res = await safe_fetch("http://public.example/", client=c)
    assert res.status_code == status and res.content == b"choices"


async def test_safe_fetch_does_not_follow_300_with_location():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(
            300, stream=Body(b"pick one"), headers={"location": "http://127.0.0.1/"}
        )

    async with _client(handler) as c:
        res = await safe_fetch("http://public.example/", client=c)
    assert res.status_code == 300 and calls == ["http://public.example/"]


async def test_safe_fetch_caps_gzip_member_count():
    # Empty members decode to nothing, so only a member cap bounds the work.
    body_ = gzip.compress(b"") * (url_guard.MAX_GZIP_MEMBERS + 1)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=Body(body_), headers={"content-encoding": "gzip"})

    async with _client(handler) as c:
        with pytest.raises(UnsafeURLError, match="too many gzip members"):
            await safe_fetch("http://public.example/", client=c)


async def test_safe_fetch_allows_gzip_members_up_to_cap():
    body_ = gzip.compress(b"ab") * url_guard.MAX_GZIP_MEMBERS

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, stream=Body(body_, chunk=1), headers={"content-encoding": "gzip"}
        )

    async with _client(handler) as c:
        res = await safe_fetch("http://public.example/", client=c)
    assert res.content == b"ab" * url_guard.MAX_GZIP_MEMBERS


@pytest.fixture
def stuck_dns(monkeypatch):
    """A resolver that blocks until released; records peak concurrent lookups."""
    import threading

    release = threading.Event()
    state = {"active": 0, "peak": 0}
    lock = threading.Lock()
    base = url_guard.socket.getaddrinfo

    def resolver(host, port, *args, **kwargs):
        if not host.startswith("stuck"):
            return base(host, port, *args, **kwargs)
        with lock:
            state["active"] += 1
            state["peak"] = max(state["peak"], state["active"])
        try:
            release.wait(10)
            return base("public.example", port, *args, **kwargs)
        finally:
            with lock:
                state["active"] -= 1

    monkeypatch.setattr(url_guard.socket, "getaddrinfo", resolver)
    yield state
    release.set()


async def test_stuck_dns_times_out_and_is_bounded(stuck_dns):
    n = url_guard.MAX_DNS_WORKERS * 2
    results = await asyncio.gather(
        *(url_guard.validate_url_async(f"http://stuck{i}.example/", timeout=0.3) for i in range(n)),
        return_exceptions=True,
    )
    assert all(isinstance(r, UnsafeURLError) for r in results)
    assert stuck_dns["peak"] <= url_guard.MAX_DNS_WORKERS
    # The default executor is untouched by the stuck lookups.
    assert await asyncio.wait_for(asyncio.to_thread(lambda: 42), 1) == 42


async def test_validate_url_async_ok_and_unsafe():
    url = "http://public.example/"
    assert await url_guard.validate_url_async(url) == url
    with pytest.raises(UnsafeURLError, match="non-public"):
        await url_guard.validate_url_async("http://internal.example/")
